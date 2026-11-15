import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GoogleApiError } from '../src/providers/google.js';
import { connectMailbox, drain, harness, HOUR, signup, type Harness, type Session } from './helpers.js';

let h: Harness;
let a: Session;
let b: Session;

beforeAll(async () => {
  h = await harness();
  a = await signup(h, 'Workspace A');
  b = await signup(h, 'Workspace B');
});
afterAll(() => h.close());

describe('Phase 1: workspaces, auth, isolation', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/contacts' });
    expect(res.statusCode).toBe(401);
  });

  it('logs in with password and rejects a wrong one', async () => {
    const me = await a.req('GET', '/v1/me');
    const ok = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: me.body.user.email, password: 'correct horse battery' } });
    expect(ok.statusCode).toBe(200);
    const bad = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: me.body.user.email, password: 'wrong password!!' } });
    expect(bad.statusCode).toBe(401);
  });

  it('a user only sees their own workspace data', async () => {
    const created = await a.req('POST', '/v1/contacts', { email: 'private@a.test' });
    expect(created.status).toBe(201);
    const bList = await b.req('GET', '/v1/contacts');
    expect(bList.body.data.map((c: any) => c.email)).not.toContain('private@a.test');
    const cross = await b.req('GET', `/v1/contacts/${created.body.id}`);
    expect(cross.status).toBe(404);
    // Pointing the header at someone else's workspace is refused.
    const spoof = await b.req('GET', '/v1/contacts', undefined, { 'x-workspace-id': a.workspaceId });
    expect(spoof.status).toBe(403);
  });

  it('API keys are shown once, hashed at rest, scoped, and revocable', async () => {
    const k = await a.req('POST', '/v1/api-keys', { name: 'backend', scopes: ['events:write'] });
    expect(k.status).toBe(201);
    expect(k.body.key).toMatch(/^hm_live_/);
    const stored = await h.ctx.db.query(`select key_hash from api_keys where id = $1`, [k.body.id]);
    expect(stored.rows[0].key_hash).not.toContain(k.body.key);
    const list = await a.req('GET', '/v1/api-keys');
    expect(JSON.stringify(list.body)).not.toContain(k.body.key);

    const noScope = await h.app.inject({ method: 'POST', url: '/v1/contacts', headers: { authorization: `Bearer ${k.body.key}` }, payload: { email: 'x@y.test' } });
    expect(noScope.statusCode).toBe(403);
    await a.req('DELETE', `/v1/api-keys/${k.body.id}`);
    const revoked = await h.app.inject({ method: 'POST', url: '/v1/events', headers: { authorization: `Bearer ${k.body.key}` }, payload: {} });
    expect(revoked.statusCode).toBe(401);
  });

  it('records an audit log', async () => {
    const log = await a.req('GET', '/v1/audit-logs');
    expect(log.body.data.map((e: any) => e.action)).toEqual(expect.arrayContaining(['workspace.created', 'api_key.created', 'api_key.revoked']));
  });
});

describe('Phase 2: Gmail connection', () => {
  let mailboxId: string;

  it('connects through OAuth, stores the refresh token encrypted and never returns it', async () => {
    mailboxId = await connectMailbox(h, a, 'Team@Hostiggo.test');
    const row = (await h.ctx.db.query(`select * from mailbox_connections where id = $1`, [mailboxId])).rows[0];
    expect(row.email).toBe('team@hostiggo.test');
    expect(row.encrypted_refresh_token).toMatch(/^v1\./);
    expect(row.encrypted_refresh_token).not.toContain('fake-refresh');
    expect(row.scopes).toEqual(expect.arrayContaining(['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.metadata']));
    const api = await a.req('GET', `/v1/mailboxes/${mailboxId}`);
    expect(api.body.reply_tracking).toBe(true);
    expect(JSON.stringify(api.body)).not.toMatch(/refresh|v1\./);
  });

  it('only requests send scope when reply tracking is off (least privilege)', async () => {
    const h2 = await harness({ GMAIL_REPLY_TRACKING: 'false' });
    const s = await signup(h2);
    const start = await s.req('POST', '/v1/mailboxes/google/authorize', {});
    expect(start.body.scopes).not.toContain('https://www.googleapis.com/auth/gmail.metadata');
    await h2.close();
  });

  it('rejects a replayed OAuth state', async () => {
    const start = await a.req('POST', '/v1/mailboxes/google/authorize', {});
    const url = new URL(start.body.url);
    const state = url.searchParams.get('state')!;
    const code1 = h.google.issueCode('other@hostiggo.test', url.searchParams.get('scope')!.split(' '));
    await h.app.inject({ method: 'GET', url: `/oauth/google/callback?code=${code1}&state=${encodeURIComponent(state)}` });
    const code2 = h.google.issueCode('evil@hostiggo.test', url.searchParams.get('scope')!.split(' '));
    const replay = await h.app.inject({ method: 'GET', url: `/oauth/google/callback?code=${code2}&state=${encodeURIComponent(state)}` });
    expect(replay.headers.location).toContain('error=state_expired');
  });

  it('sends a test email that shows in the send log as accepted', async () => {
    const t = await a.req('POST', `/v1/mailboxes/${mailboxId}/test`, { to: 'me@example.com' });
    expect(t.status).toBe(202);
    await drain(h);
    const send = await a.req('GET', `/v1/sends/${t.body.id}`);
    expect(send.body.status).toBe('accepted');
    expect(send.body.provider_message_id).toBeTruthy();
    expect(send.body.events.map((e: any) => e.type)).toEqual(['requested', 'accepted']);
    const mime = h.google.outbox.at(-1)!.mime;
    expect(mime).toMatch(/^From: .*team@hostiggo\.test/m);
    expect(mime).toMatch(/^To: me@example\.com/m);
  });

  it('retries transient Gmail errors with backoff, then succeeds', async () => {
    h.google.sendFailures.push(new GoogleApiError(503, 'backendError', 'Service unavailable'));
    const t = await a.req('POST', `/v1/mailboxes/${mailboxId}/test`, { to: 'retry@example.com' });
    await drain(h);
    let send = await a.req('GET', `/v1/sends/${t.body.id}`);
    expect(send.body.status).toBe('queued');
    expect(send.body.error_code).toBe('provider_transient');
    expect(send.body.next_attempt_at).toBeTruthy();
    h.clock.advance(HOUR);
    await drain(h);
    send = await a.req('GET', `/v1/sends/${t.body.id}`);
    expect(send.body.status).toBe('accepted');
    expect(send.body.attempts).toBe(2);
  });

  it('never auto-retries an ambiguous network failure (no duplicate sends)', async () => {
    h.google.sendFailures.push(new GoogleApiError(0, 'network', 'socket hang up'));
    const t = await a.req('POST', `/v1/mailboxes/${mailboxId}/test`, { to: 'ambiguous@example.com' });
    await drain(h);
    const send = await a.req('GET', `/v1/sends/${t.body.id}`);
    expect(send.body.status).toBe('unknown');
    expect(send.body.error_code).toBe('outcome_unknown');
    const retry = await a.req('POST', `/v1/sends/${t.body.id}/retry`);
    expect(retry.status).toBe(200);
    await drain(h);
    expect((await a.req('GET', `/v1/sends/${t.body.id}`)).body.status).toBe('accepted');
  });

  it('gives a clear, permanent failure for rejected messages', async () => {
    h.google.sendFailures.push(new GoogleApiError(400, 'invalidArgument', 'Invalid To header'));
    const t = await a.req('POST', `/v1/mailboxes/${mailboxId}/test`, { to: 'bad@example.com' });
    await drain(h);
    const send = await a.req('GET', `/v1/sends/${t.body.id}`);
    expect(send.body.status).toBe('failed');
    expect(send.body.error_code).toBe('provider_rejected');
    expect(send.body.last_error).toContain('Invalid To header');
  });

  it('respects the per-mailbox daily limit and defers the overflow', async () => {
    await a.req('PATCH', `/v1/mailboxes/${mailboxId}`, { daily_send_limit: 3 }); // 3 sends already accepted in this window
    const t = await a.req('POST', `/v1/mailboxes/${mailboxId}/test`, { to: 'overflow@example.com' });
    await drain(h);
    let send = await a.req('GET', `/v1/sends/${t.body.id}`);
    expect(send.body.status).toBe('queued');
    expect(send.body.error_code).toBe('rate_limited');
    h.clock.advance(25 * HOUR);
    await drain(h);
    send = await a.req('GET', `/v1/sends/${t.body.id}`);
    expect(send.body.status).toBe('accepted');
    await a.req('PATCH', `/v1/mailboxes/${mailboxId}`, { daily_send_limit: 400 });
  });

  it('disconnect revokes the token, deletes it, and cancels queued sends', async () => {
    const other = await connectMailbox(h, a, 'temp@hostiggo.test');
    await a.req('PATCH', `/v1/mailboxes/${other}`, { daily_send_limit: 1 });
    await a.req('POST', `/v1/mailboxes/${other}/test`, { to: 'one@example.com' });
    await drain(h);
    const pending = await a.req('POST', `/v1/mailboxes/${other}/test`, { to: 'two@example.com' });
    await drain(h); // deferred by rate limit -> still queued
    const revokedBefore = h.google.revoked.length;
    const d = await a.req('POST', `/v1/mailboxes/${other}/disconnect`);
    expect(d.status).toBe(200);
    expect(h.google.revoked.length).toBe(revokedBefore + 1);
    const row = (await h.ctx.db.query(`select status, encrypted_refresh_token from mailbox_connections where id = $1`, [other])).rows[0];
    expect(row).toEqual({ status: 'disconnected', encrypted_refresh_token: null });
    const s = await a.req('GET', `/v1/sends/${pending.body.id}`);
    expect(s.body.status).toBe('cancelled');
    expect(s.body.error_code).toBe('mailbox_disconnected');
  });

  it('marks a mailbox for reauth when Google revokes access', async () => {
    const m = await connectMailbox(h, a, 'revoked@hostiggo.test');
    const enc = (await h.ctx.db.query(`select encrypted_refresh_token from mailbox_connections where id = $1`, [m])).rows[0].encrypted_refresh_token;
    h.google.revoked.push(h.ctx.keyring.decrypt(enc));
    const { forgetAccessToken } = await import('../src/modules/mailboxes/service.js');
    forgetAccessToken(m);
    const t = await a.req('POST', `/v1/mailboxes/${m}/test`, { to: 'x@example.com' });
    await drain(h);
    const send = await a.req('GET', `/v1/sends/${t.body.id}`);
    expect(send.body.status).toBe('failed');
    expect(send.body.error_code).toBe('mailbox_auth');
    expect((await a.req('GET', `/v1/mailboxes/${m}`)).body.status).toBe('reauth_required');
  });
});
