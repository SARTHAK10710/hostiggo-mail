import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authorize, requireUser } from '../auth/index.js';
import type { Ctx } from '../context.js';
import { one } from '../db/index.js';
import { forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/http.js';

/**
 * Operations: everything an operator needs to diagnose a failed or stuck send.
 * Workspace admins see their workspace's sends/mailboxes; the server operator additionally sees
 * the global job queue and worker processes (jobs are not tenant-scoped).
 */
const WORKER_STALE_MS = 2 * 60_000;

/** Operators: OPERATOR_EMAILS, or (if unset) the first account created on this server. */
export async function isOperator(ctx: Ctx, userId: string): Promise<boolean> {
  const list = (process.env.OPERATOR_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const u = await one<{ email: string; first: boolean }>(
    ctx.db,
    `select email, id = (select id from users order by created_at, id limit 1) as first from users where id = $1`,
    [userId],
  );
  if (!u) return false;
  return list.length ? list.includes(u.email) : u.first;
}

async function workerStatus(ctx: Ctx) {
  const now = ctx.clock.now();
  const r = await ctx.db.query<{ worker_id: string; hostname: string; pid: number; started_at: Date; last_seen: Date; jobs_done: number; jobs_failed: number }>(
    `select worker_id, hostname, pid, started_at, last_seen, jobs_done, jobs_failed from worker_heartbeats
     where last_seen > $1 order by last_seen desc`,
    [new Date(now.getTime() - 24 * 3600_000)],
  );
  const workers = r.rows.map((w) => ({ ...w, alive: now.getTime() - new Date(w.last_seen).getTime() < WORKER_STALE_MS }));
  return { workers, alive: workers.some((w) => w.alive) };
}

export function opsRoutes(app: FastifyInstance, ctx: Ctx) {
  /** Readiness for uptime monitors: database reachable + a live worker + queue not badly backed up. */
  app.get('/health/ready', async (_req, reply) => {
    const checks: Record<string, unknown> = {};
    try {
      await ctx.db.query('select 1');
      checks.database = 'ok';
    } catch (err) {
      checks.database = (err as Error).message;
    }
    const w = await workerStatus(ctx).catch(() => ({ alive: false }));
    checks.worker = w.alive ? 'ok' : 'no heartbeat in the last 2 minutes';
    const backlog = await one<{ n: number; oldest: Date | null }>(
      ctx.db,
      `select count(*)::int as n, min(run_at) as oldest from jobs where status = 'pending' and run_at < $1`,
      [new Date(ctx.clock.now().getTime() - 5 * 60_000)],
    ).catch(() => undefined);
    checks.overdue_jobs = backlog?.n ?? 'unknown';
    const ok = checks.database === 'ok' && w.alive && (backlog?.n ?? 0) < 1000;
    reply.code(ok ? 200 : 503);
    return { ok, checks };
  });

  app.get('/v1/ops', async (req) => {
    const a = authorize(req, { role: 'admin' });
    const now = ctx.clock.now();
    const week = new Date(now.getTime() - 7 * 86_400_000);
    const [w, problems, stuck, deferred, mailboxes, counts] = await Promise.all([
      workerStatus(ctx),
      ctx.db.query(
        `select id, kind, source_type, to_email, subject, status, error_code, last_error, attempts, requested_at, finished_at
         from sends where workspace_id = $1 and status in ('failed','unknown') and requested_at > $2
         order by requested_at desc limit 50`,
        [a.workspaceId, week],
      ),
      ctx.db.query(
        `select id, to_email, subject, status, error_code, last_error, requested_at, next_attempt_at from sends
         where workspace_id = $1 and status in ('queued','sending') and requested_at < $2
           and coalesce(error_code, '') not in ('rate_limited', 'automation_paused')
         order by requested_at limit 50`,
        [a.workspaceId, new Date(now.getTime() - 15 * 60_000)],
      ),
      ctx.db.query<{ error_code: string; n: number; next_at: Date | null }>(
        `select error_code, count(*)::int as n, min(next_attempt_at) as next_at from sends
         where workspace_id = $1 and status = 'queued' and error_code in ('rate_limited','automation_paused','provider_transient','provider_quota')
         group by error_code`,
        [a.workspaceId],
      ),
      ctx.db.query(
        `select id, email, status, health, last_error, last_synced_at from mailbox_connections
         where workspace_id = $1 and status <> 'disconnected' and (status <> 'active' or health <> 'healthy' or last_error is not null)`,
        [a.workspaceId],
      ),
      one<{ failed: number; unknown: number; queued: number; accepted: number }>(
        ctx.db,
        `select count(*) filter (where status = 'failed')::int as failed, count(*) filter (where status = 'unknown')::int as unknown,
           count(*) filter (where status in ('queued','sending'))::int as queued, count(*) filter (where status = 'accepted')::int as accepted
         from sends where workspace_id = $1 and requested_at > $2`,
        [a.workspaceId, week],
      ),
    ]);

    const p = requireUser(req);
    let operator = null;
    if (await isOperator(ctx, p.userId)) {
      const [queue, failedJobs] = await Promise.all([
        ctx.db.query(
          `select type, status, count(*)::int as n, min(run_at) as oldest_run_at from jobs
           where status in ('pending','running','failed') group by type, status order by type, status`,
        ),
        ctx.db.query(
          `select id, type, payload, attempts, max_attempts, last_error, updated_at from jobs where status = 'failed'
           order by updated_at desc limit 30`,
        ),
      ]);
      operator = { workers: w.workers, queue: queue.rows, failed_jobs: failedJobs.rows };
    }

    return {
      worker_alive: w.alive,
      last_7_days: counts,
      problem_sends: problems.rows,
      stuck_sends: stuck.rows,
      deferred: deferred.rows,
      mailbox_issues: mailboxes.rows,
      operator,
    };
  });

  /** Operator: put a permanently failed background job back in the queue. */
  app.post('/v1/ops/jobs/:id/retry', async (req) => {
    const a = authorize(req, { role: 'admin' });
    const p = requireUser(req);
    if (!(await isOperator(ctx, p.userId))) throw forbidden('Only the server operator can retry background jobs');
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const r = await ctx.db.query(
      `update jobs set status = 'pending', attempts = 0, run_at = $2, last_error = null, updated_at = now()
       where id = $1 and status = 'failed' returning id`,
      [id, ctx.clock.now()],
    );
    if (!r.rows[0]) throw notFound('Failed job');
    await audit(ctx.db, a, 'ops.job_retried', { type: 'job', id: String(id) });
    return { id, status: 'pending' };
  });
}
