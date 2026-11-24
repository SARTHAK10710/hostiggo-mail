import { PGlite } from '@electric-sql/pglite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GoogleApiError } from '../src/providers/google.js';
import { connectMailbox, drain, harness, session, signup, type Harness } from './helpers.js';

const open: Harness[] = [];
const make = async (env: Record<string, string> = {}) => {
  const h = await harness(env);
  open.push(h);
  return h;
};
afterAll(async () => {
  for (const h of open) await h.close();
});

describe('Phase 6: security', () => {
  it('sends security headers on pages and API responses', async () => {
    const h = await make();
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rate-limits sign-in attempts per IP', async () => {
    const h = await make({ RATE_LIMIT: 'true', AUTH_RATE_LIMIT_MAX: '10' });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'x@example.com', password: 'wrong-password' } });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});

describe('Phase 6: invite-only sign-up', () => {
  it('allows the first account, blocks strangers, and lets invited people join', async () => {
    const h = await make({ ALLOW_SIGNUPS: 'false' });
    const owner = await signup(h, 'Hostiggo'); // first account on the server is always allowed
    const stranger = await h.app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'stranger@example.com', password: 'long-password-1', workspace_name: 'X' } });
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json().error.code).toBe('signups_closed');

    const inv = await owner.req('POST', '/v1/members', { email: 'Teammate@Example.com', role: 'member' });
    expect(inv.status).toBe(201);
    expect(inv.body.invited).toBe(true);
    const token = inv.body.invite_url.split('/invite/')[1];
    expect((await owner.req('GET', '/v1/invites')).body.data).toHaveLength(1);

    const lookup = await h.app.inject({ method: 'GET', url: `/v1/invites/lookup?token=${token}` });
    expect(lookup.json()).toMatchObject({ email: 'teammate@example.com', role: 'member', workspace_name: 'Hostiggo' });

    const wrong = await h.app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'other@example.com', password: 'long-password-1', invite_token: token } });
    expect(wrong.json().error.code).toBe('invite_email_mismatch');

    const join = await h.app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'teammate@example.com', password: 'long-password-1', invite_token: token } });
    expect(join.statusCode).toBe(201);
    expect(join.json().workspace).toMatchObject({ id: owner.workspaceId, role: 'member' });

    const again = await h.app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'teammate2@example.com', password: 'long-password-1', invite_token: token } });
    expect(again.json().error.code).toBe('invite_invalid');
    const members = await owner.req('GET', '/v1/members');
    expect(members.body.data.map((m: any) => m.email)).toContain('teammate@example.com');
  });
});

describe('Phase 6: public legal pages', () => {
  it('serves privacy (with the Google Limited Use disclosure), terms and support', async () => {
    const h = await make({ SUPPORT_EMAIL: 'support@hostiggo.test', COMPANY_NAME: 'Hostiggo' });
    const privacy = await h.app.inject({ method: 'GET', url: '/privacy' });
    expect(privacy.statusCode).toBe(200);
    expect(privacy.body).toContain('Limited Use');
    expect(privacy.body).toContain('Google API Services User Data Policy');
    expect(privacy.body).toContain('gmail.metadata');
    expect(privacy.body).toContain('support@hostiggo.test');
    expect((await h.app.inject({ method: 'GET', url: '/terms' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/support' })).body).toContain('support@hostiggo.test');
  });
});

describe('Phase 6: operations', () => {
  it('shows a failed send with its reason, worker liveness and readiness', async () => {
    const h = await make();
    const a = await signup(h);
    const mb = await connectMailbox(h, a);
    h.google.sendFailures.push(new GoogleApiError(400, 'invalidArgument', 'Recipient address rejected'));
    await a.req('POST', `/v1/mailboxes/${mb}/test`, { to: 'nobody@example.com' });
    await drain(h);

    expect((await h.app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503); // no worker heartbeat yet
    await h.worker.heartbeat();
    const ready = await h.app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks).toMatchObject({ database: 'ok', worker: 'ok' });

    const ops = await a.req('GET', '/v1/ops');
    expect(ops.body.worker_alive).toBe(true);
    expect(ops.body.problem_sends[0]).toMatchObject({ to_email: 'nobody@example.com', status: 'failed', error_code: 'provider_rejected' });
    expect(ops.body.problem_sends[0].last_error).toContain('Recipient address rejected');
    expect(ops.body.operator.workers).toHaveLength(1); // first account = server operator

    // A second, unrelated workspace sees neither the operator section nor the other workspace's sends.
    const b = await signup(h, 'Other');
    const opsB = await b.req('GET', '/v1/ops');
    expect(opsB.body.operator).toBeNull();
    expect(opsB.body.problem_sends).toHaveLength(0);

    // Operator can re-queue a permanently failed background job.
    await h.ctx.db.query(`insert into jobs(type, payload, status, attempts, max_attempts, last_error) values ('mailbox.reconcile', '{}', 'failed', 5, 5, 'boom')`);
    const failed = (await a.req('GET', '/v1/ops')).body.operator.failed_jobs[0];
    expect(failed.last_error).toBe('boom');
    expect((await a.req('POST', `/v1/ops/jobs/${failed.id}/retry`)).body.status).toBe('pending');
    expect((await b.req('POST', `/v1/ops/jobs/${failed.id}/retry`)).status).toBe(403);
  });
});

describe('Phase 6: backups', () => {
  it('snapshots the embedded database and the snapshot restores', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hm-backup-test-'));
    try {
      const h = await make({ BACKUP_DIR: dir, BACKUP_KEEP: '2' });
      const a = await signup(h, 'Backed up');
      const list0 = await a.req('GET', '/v1/ops/backups');
      if (!list0.body.supported) {
        // Running against real Postgres: backups are the database provider's job.
        expect((await a.req('POST', '/v1/ops/backups')).status).toBe(409);
        return;
      }
      for (let i = 0; i < 3; i++) {
        expect((await a.req('POST', '/v1/ops/backups')).status).toBe(201);
        await new Promise((r) => setTimeout(r, 1100)); // distinct timestamps in file names
      }
      const list = (await a.req('GET', '/v1/ops/backups')).body.data;
      expect(list).toHaveLength(2); // BACKUP_KEEP
      const restored = new PGlite({ loadDataDir: new Blob([readFileSync(join(dir, list[0].file))]) });
      await restored.waitReady;
      const ws = await restored.query<{ name: string }>('select name from workspaces');
      expect(ws.rows.map((r) => r.name)).toContain('Backed up');
      await restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

void session;
