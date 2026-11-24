import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createContext, type Ctx } from '../src/context.js';
import { createDb } from '../src/db/index.js';
import { createWorker, type Worker } from '../src/jobs/worker.js';
import { FakeGoogleApi } from '../src/providers/google.js';

export class TestClock {
  // Ahead of real time so jobs enqueued with wall-clock "now" are already due.
  t = new Date('2030-01-07T09:00:00Z').getTime();
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export interface Harness {
  app: FastifyInstance;
  ctx: Ctx;
  google: FakeGoogleApi;
  clock: TestClock;
  worker: Worker;
  close(): Promise<void>;
}

/**
 * TEST_DATABASE_URL=postgres://user:pass@host:port/postgres runs the suite against real Postgres:
 * each harness gets its own throwaway database. Default: in-memory PGlite.
 */
async function freshDatabaseUrl(): Promise<{ url: string; drop: () => Promise<void> }> {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) return { url: 'pglite:memory', drop: async () => {} };
  const name = `hm_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  await client.query(`create database ${name} encoding 'UTF8' template template0`);
  await client.end();
  const u = new URL(admin);
  u.pathname = `/${name}`;
  return {
    url: u.toString(),
    drop: async () => {
      const c = new pg.Client({ connectionString: admin });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}

export async function harness(env: Record<string, string> = {}): Promise<Harness> {
  const fresh = await freshDatabaseUrl();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: fresh.url,
    EMAIL_PROVIDER_MODE: 'fake',
    GMAIL_REPLY_TRACKING: 'true',
    PUBSUB_VERIFICATION_TOKEN: 'pubsub-test-token',
    PROVIDER_WEBHOOK_SECRETS: 'acme-esp:whsec_test',
    API_BASE_URL: 'https://api.test',
    APP_BASE_URL: 'http://app.test',
    RATE_LIMIT: 'false',
    ...env,
  });
  const clock = new TestClock();
  const db = await createDb(config.DATABASE_URL);
  const google = new FakeGoogleApi(config);
  google.now = clock.now;
  const ctx = await createContext(config, { db, clock, google });
  const app = await buildApp(ctx);
  const worker = createWorker(ctx, { periodic: false });
  return {
    app,
    ctx,
    google,
    clock,
    worker,
    async close() {
      await app.close();
      await db.close();
      await fresh.drop();
    },
  };
}

export interface Session {
  token: string;
  workspaceId: string;
  userId: string;
  req(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; text: string; headers: any }>;
}

let counter = 0;
export async function signup(h: Harness, name = 'Acme'): Promise<Session> {
  counter += 1;
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email: `owner${counter}@hostiggo.test`, password: 'correct horse battery', workspace_name: name },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.body}`);
  const b = res.json();
  return session(h, b.session.token, b.workspace.id, b.user.id);
}

export function session(h: Harness, token: string, workspaceId: string, userId = ''): Session {
  return {
    token,
    workspaceId,
    userId,
    async req(method, url, body, headers = {}) {
      const res = await h.app.inject({
        method: method as any,
        url,
        payload: body as any,
        headers: { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId, ...headers },
      });
      let parsed: any = undefined;
      try {
        parsed = res.json();
      } catch {
        /* non-json */
      }
      return { status: res.statusCode, body: parsed, text: res.body, headers: res.headers };
    },
  };
}

/** Full fake OAuth round trip; returns the mailbox id. */
export async function connectMailbox(h: Harness, s: Session, email = 'team@hostiggo.test') {
  const start = await s.req('POST', '/v1/mailboxes/google/authorize', {});
  if (start.status !== 200) throw new Error(`authorize failed: ${start.text}`);
  const url = new URL(start.body.url);
  const code = h.google.issueCode(email, url.searchParams.get('scope')!.split(' '));
  const cb = await h.app.inject({ method: 'GET', url: `/oauth/google/callback?code=${code}&state=${encodeURIComponent(url.searchParams.get('state')!)}` });
  const loc = new URL(cb.headers.location as string);
  const id = loc.searchParams.get('connected');
  if (!id) throw new Error(`connect failed: ${loc}`);
  return id;
}

export async function drain(h: Harness) {
  return h.worker.drain();
}
