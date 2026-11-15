import type { Queryable } from '../db/index.js';

/**
 * Durable Postgres job queue (FOR UPDATE SKIP LOCKED). Jobs are enqueued inside the
 * same transaction as the state change that requires them, so "persist next step,
 * then acknowledge" holds even if a worker crashes.
 */
export interface JobRow {
  id: number;
  type: string;
  payload: any;
  unique_key: string | null;
  run_at: Date;
  attempts: number;
  max_attempts: number;
}

export interface EnqueueOptions {
  runAt?: Date;
  /** Only one *pending* job per key; re-enqueue moves it earlier if needed. */
  uniqueKey?: string;
  maxAttempts?: number;
}

export async function enqueue(q: Queryable, type: string, payload: object, opts: EnqueueOptions = {}) {
  const runAt = opts.runAt ?? new Date();
  if (opts.uniqueKey) {
    await q.query(
      `insert into jobs(type, payload, unique_key, run_at, max_attempts)
       values ($1, $2, $3, $4, $5)
       on conflict (unique_key) where status = 'pending' and unique_key is not null
       do update set run_at = least(jobs.run_at, excluded.run_at), updated_at = now()`,
      [type, JSON.stringify(payload), opts.uniqueKey, runAt, opts.maxAttempts ?? 5],
    );
  } else {
    await q.query(`insert into jobs(type, payload, run_at, max_attempts) values ($1, $2, $3, $4)`, [
      type,
      JSON.stringify(payload),
      runAt,
      opts.maxAttempts ?? 5,
    ]);
  }
}

export async function claimJobs(q: Queryable, workerId: string, now: Date, limit: number): Promise<JobRow[]> {
  const r = await q.query<JobRow>(
    `update jobs set status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1, updated_at = now()
     where id in (
       select id from jobs where status = 'pending' and run_at <= $2
       order by run_at, id limit $3 for update skip locked)
     returning id, type, payload, unique_key, run_at, attempts, max_attempts`,
    [workerId, now, limit],
  );
  return r.rows;
}

export async function completeJob(q: Queryable, id: number) {
  await q.query(`update jobs set status = 'done', locked_at = null, updated_at = now() where id = $1`, [id]);
}

/** Thrown by handlers to ask for a retry at a specific time without counting as an error. */
export class RetryLater extends Error {
  constructor(public readonly runAt: Date, reason = 'deferred') {
    super(reason);
  }
}

export async function failJob(q: Queryable, job: JobRow, err: unknown, now: Date) {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof RetryLater) {
    await q.query(
      `update jobs set status = 'pending', run_at = $2, attempts = greatest(attempts - 1, 0),
         locked_at = null, last_error = $3, updated_at = now() where id = $1`,
      [job.id, err.runAt, message],
    );
    return;
  }
  if (job.attempts >= job.max_attempts) {
    await q.query(
      `update jobs set status = 'failed', locked_at = null, last_error = $2, updated_at = now() where id = $1`,
      [job.id, message.slice(0, 2000)],
    );
    return;
  }
  const backoffMs = Math.min(60 * 60_000, 2 ** job.attempts * 15_000); // 30s, 1m, 2m, ... cap 1h
  await q.query(
    `update jobs set status = 'pending', run_at = $2, locked_at = null, last_error = $3, updated_at = now() where id = $1`,
    [job.id, new Date(now.getTime() + backoffMs), message.slice(0, 2000)],
  );
}

/** Jobs stuck in "running" (worker died) go back to pending. */
export async function recoverStaleJobs(q: Queryable, olderThanMinutes = 10) {
  await q.query(
    `update jobs set status = 'pending', locked_at = null, updated_at = now(), last_error = 'recovered after worker timeout'
     where status = 'running' and locked_at < now() - make_interval(mins => $1)`,
    [olderThanMinutes],
  );
}
