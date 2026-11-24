import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { Ctx } from '../context.js';
import { runEnrollment } from '../modules/automations/engine.js';
import { scheduledBackup } from '../modules/backups.js';
import { dispatchCampaign } from '../modules/campaigns.js';
import { commitImportJob } from '../modules/contacts/imports.js';
import { reconcileMailboxes, renewWatches, syncMailbox } from '../modules/replies.js';
import { markStaleSends, processSend } from '../modules/sends/service.js';
import { claimJobs, completeJob, enqueue, failJob, recoverStaleJobs, type JobRow } from './queue.js';

type Handler = (ctx: Ctx, payload: any) => Promise<void>;

export const handlers: Record<string, Handler> = {
  'send.process': (ctx, p) => processSend(ctx, p.sendId),
  'enrollment.run': (ctx, p) => runEnrollment(ctx, p.enrollmentId),
  'campaign.dispatch': (ctx, p) => dispatchCampaign(ctx, p.campaignId),
  'import.commit': (ctx, p) => commitImportJob(ctx, p.importId),
  'mailbox.sync': (ctx, p) => syncMailbox(ctx, p.mailboxId),
  'mailbox.reconcile': (ctx) => reconcileMailboxes(ctx),
  'mailbox.renew_watches': (ctx) => renewWatches(ctx),
  'maintenance.tick': (ctx) => maintenance(ctx),
  'maintenance.backup': (ctx) => scheduledBackup(ctx),
};

/** Recurring tasks, enqueued with a pending-unique key so many workers don't duplicate them. */
const PERIODIC: { type: string; everyMs: number }[] = [
  { type: 'maintenance.tick', everyMs: 5 * 60_000 },
  // Without Gmail push (Pub/Sub) this is how replies are found, so keep it fairly frequent.
  { type: 'mailbox.reconcile', everyMs: 5 * 60_000 },
  { type: 'mailbox.renew_watches', everyMs: 6 * 3600_000 },
  // Checks hourly; only snapshots when the newest backup is older than BACKUP_EVERY_HOURS.
  { type: 'maintenance.backup', everyMs: 3600_000 },
];

async function maintenance(ctx: Ctx) {
  const now = ctx.clock.now();
  await recoverStaleJobs(ctx.db);
  await markStaleSends(ctx);
  // Heal enrollments whose wake-up job went missing.
  const orphans = await ctx.db.query<{ id: string }>(
    `select e.id from enrollments e join automations a on a.id = e.automation_id
     where e.state = 'active' and a.status = 'active' and e.next_run_at < $1
       and not exists (select 1 from jobs j where j.unique_key = 'enr:' || e.id and j.status in ('pending','running'))
     limit 500`,
    [new Date(now.getTime() - 5 * 60_000)],
  );
  for (const o of orphans.rows) await enqueue(ctx.db, 'enrollment.run', { enrollmentId: o.id }, { uniqueKey: `enr:${o.id}` });
  // Retention: drop ad-hoc API message bodies 30 days after the send finished; prune old finished jobs.
  await ctx.db.query(`update sends set content = null where content is not null and finished_at < $1`, [new Date(now.getTime() - 30 * 86_400_000)]);
  await ctx.db.query(`delete from jobs where status = 'done' and updated_at < $1`, [new Date(now.getTime() - 7 * 86_400_000)]);
  await ctx.db.query(`delete from oauth_states where expires_at < $1`, [now]);
  await ctx.db.query(`delete from sessions where expires_at < $1`, [now]);
  await ctx.db.query(`delete from worker_heartbeats where last_seen < $1`, [new Date(now.getTime() - 86_400_000)]);
}

export interface Worker {
  start(): void;
  stop(): Promise<void>;
  heartbeat(): Promise<void>;
  /** Process every job that is due right now (tests / scripts). Returns jobs processed. */
  drain(maxRounds?: number): Promise<number>;
}

export function createWorker(ctx: Ctx, opts: { pollMs?: number; concurrency?: number; periodic?: boolean } = {}): Worker {
  const workerId = `w-${process.pid}-${randomBytes(3).toString('hex')}`;
  const pollMs = opts.pollMs ?? ctx.config.WORKER_POLL_MS;
  // PGlite is single-connection; run jobs one at a time there.
  const concurrency = ctx.db.kind === 'pglite' ? 1 : (opts.concurrency ?? ctx.config.WORKER_CONCURRENCY);
  const lastPeriodic = new Map<string, number>();
  let running = false;
  let loop: Promise<void> | null = null;
  let done = 0;
  let failed = 0;
  let lastBeat = 0;

  /** Liveness record for the Operations page and /health/ready. */
  async function heartbeat() {
    lastBeat = Date.now();
    await ctx.db.query(
      `insert into worker_heartbeats(worker_id, hostname, pid, last_seen, jobs_done, jobs_failed) values ($1, $2, $3, $4, $5, $6)
       on conflict (worker_id) do update set last_seen = excluded.last_seen, jobs_done = excluded.jobs_done, jobs_failed = excluded.jobs_failed`,
      [workerId, hostname(), process.pid, ctx.clock.now(), done, failed],
    );
  }

  async function runJob(job: JobRow) {
    const handler = handlers[job.type];
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(ctx, job.payload);
      await completeJob(ctx.db, job.id);
      done += 1;
    } catch (err) {
      failed += 1;
      ctx.log.warn({ jobId: job.id, type: job.type, attempt: job.attempts, err: (err as Error).message }, 'job failed');
      try {
        await failJob(ctx.db, job, err, ctx.clock.now());
      } catch (e) {
        // A newer pending job with the same unique key exists; this one is superseded.
        if ((e as { code?: string }).code === '23505') {
          await ctx.db.query(`update jobs set status = 'done', last_error = 'superseded', updated_at = now() where id = $1`, [job.id]);
        } else throw e;
      }
    }
  }

  async function schedulePeriodic() {
    const now = Date.now();
    for (const p of PERIODIC) {
      if (now - (lastPeriodic.get(p.type) ?? 0) < p.everyMs) continue;
      lastPeriodic.set(p.type, now);
      await enqueue(ctx.db, p.type, {}, { uniqueKey: `cron:${p.type}`, maxAttempts: 1 });
    }
  }

  async function tick(): Promise<number> {
    const jobs = await claimJobs(ctx.db, workerId, ctx.clock.now(), concurrency);
    if (concurrency === 1) for (const j of jobs) await runJob(j);
    else await Promise.all(jobs.map(runJob));
    return jobs.length;
  }

  return {
    start() {
      if (running) return;
      running = true;
      loop = (async () => {
        while (running) {
          try {
            if (opts.periodic !== false) await schedulePeriodic();
            if (Date.now() - lastBeat > 30_000) await heartbeat();
            const n = await tick();
            if (n === 0) await new Promise((r) => setTimeout(r, pollMs));
          } catch (err) {
            ctx.log.error({ err: (err as Error).message }, 'worker loop error');
            await new Promise((r) => setTimeout(r, pollMs * 5));
          }
        }
      })();
      ctx.log.info({ workerId, concurrency }, 'worker started');
    },
    async stop() {
      running = false;
      await loop;
      await ctx.db.query(`delete from worker_heartbeats where worker_id = $1`, [workerId]).catch(() => {});
    },
    heartbeat,
    async drain(maxRounds = 200) {
      let total = 0;
      for (let i = 0; i < maxRounds; i++) {
        const n = await tick();
        if (n === 0) break;
        total += n;
      }
      return total;
    },
  };
}
