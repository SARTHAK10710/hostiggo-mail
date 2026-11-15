import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { effectiveDailyLimit, warmupCap } from '../src/modules/mailboxes/service.js';
import { looksLikeUnsubscribe } from '../src/modules/replies.js';
import { connectMailbox, DAY, drain, harness, HOUR, signup, type Harness, type Session } from './helpers.js';

const contact = (s: Session, email: string, extra: object = {}) => s.req('POST', '/v1/contacts', { email, ...extra });

describe('security: headers, rate limits, cookie sessions', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({ AUTH_RATE_LIMIT_MAX: '3' });
  });
  afterAll(() => h.close());

  it('sends security headers', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // Dev consent screen -> callback -> dashboard on another origin must stay allowed.
    expect(res.headers['content-security-policy']).toMatch(/form-action 'self' http:\/\/app\.test/);
  });

  it('rate-limits credential attempts with a 429', async () => {
    const attempt = () => h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'nobody@example.com', password: 'wrong-password-1' } });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await attempt()).statusCode);
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3)).toEqual([429, 429]);
    const blocked = await attempt();
    expect(blocked.json().error.code).toBe('rate_limited');
    expect(blocked.headers['retry-after']).toBeTruthy();
  });
});

describe('security: httpOnly session cookie', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  it('sets an httpOnly cookie that authenticates the dashboard, and logout clears it', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'cookie@hostiggo.test', password: 'correct horse battery', workspace_name: 'Cookie Co' },
    });
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^hm_session=hms_/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure'); // API_BASE_URL is https in the harness
    const cookie = setCookie.split(';')[0];

    const me = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('cookie@hostiggo.test');

    // A cookie-authenticated write from a foreign origin is refused; from our own origin it works.
    const evil = await h.app.inject({ method: 'POST', url: '/v1/workspaces', payload: { name: 'x' }, headers: { cookie, origin: 'https://evil.example' } });
    expect(evil.statusCode).toBe(403);
    const ok = await h.app.inject({ method: 'POST', url: '/v1/workspaces', payload: { name: 'Second' }, headers: { cookie, origin: 'http://app.test' } });
    expect(ok.statusCode).toBe(201);

    const out = await h.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('a stale cookie never blocks signing in again', async () => {
    const stale = 'hm_session=hms_expired-or-from-a-reset-database';
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: stale } })).statusCode).toBe(401);
    const login = await h.app.inject({ method: 'POST', url: '/v1/auth/signup', headers: { cookie: stale }, payload: { email: 'again@hostiggo.test', password: 'correct horse battery', workspace_name: 'Again' } });
    expect(login.statusCode).toBe(201);
    expect(String(login.headers['set-cookie'])).toMatch(/^hm_session=hms_/);
    // An explicit bearer token that is wrong is still reported as such.
    const bearer = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer nope' } });
    expect(bearer.json().error.message).toMatch(/expired or invalid/);
  });
});

describe('config', () => {
  const base = { NODE_ENV: 'production', APP_SECRET: 'x'.repeat(40), TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`, DATABASE_URL: 'postgres://u:p@h/db' };

  it('refuses plain-http URLs in production', () => {
    expect(() => loadConfig({ ...base, API_BASE_URL: 'http://mail.example.com', APP_BASE_URL: 'https://mail.example.com' })).toThrow(/https/);
    expect(() => loadConfig({ ...base, API_BASE_URL: 'https://mail.example.com', APP_BASE_URL: 'https://mail.example.com' })).not.toThrow();
  });

  it('reads secrets from *_FILE paths (secret managers mount secrets as files)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hm-secrets-'));
    writeFileSync(join(dir, 'app_secret'), `${'s'.repeat(40)}\n`);
    const cfg = loadConfig({ ...base, APP_SECRET: undefined, APP_SECRET_FILE: join(dir, 'app_secret'), API_BASE_URL: 'https://m.example.com', APP_BASE_URL: 'https://m.example.com' });
    expect(cfg.APP_SECRET).toBe('s'.repeat(40));
  });
});

describe('mailbox warm-up (SPAM-FIX step 3)', () => {
  it('ramps 20 -> 40 -> 80 per week and never exceeds the mailbox limit', () => {
    const start = new Date('2030-01-01T00:00:00Z');
    const at = (days: number) => new Date(start.getTime() + days * DAY);
    expect(warmupCap(null, at(0))).toBeNull();
    expect([0, 6, 7, 13, 14, 21].map((d) => warmupCap(start, at(d)))).toEqual([20, 20, 40, 40, 80, 160]);
    expect(effectiveDailyLimit({ daily_send_limit: 400, warmup_started_at: start }, at(0))).toBe(20);
    expect(effectiveDailyLimit({ daily_send_limit: 30, warmup_started_at: start }, at(21))).toBe(30);
    expect(effectiveDailyLimit({ daily_send_limit: 400, warmup_started_at: null }, at(0))).toBe(400);
  });

  it('starts new mailboxes in warm-up when WARMUP_DEFAULT is on, and can be toggled', async () => {
    const h = await harness({ WARMUP_DEFAULT: 'true' });
    const s = await signup(h);
    const id = await connectMailbox(h, s, 'warm@hostiggo.test');
    const dash = () => s.req('GET', '/v1/deliverability').then((r) => r.body.mailboxes.find((m: any) => m.id === id));
    expect(await dash()).toMatchObject({ daily_send_limit: 400, effective_daily_limit: 20, warming_up: true });
    h.clock.advance(8 * DAY);
    expect(await dash()).toMatchObject({ effective_daily_limit: 40, warming_up: true });
    // The dashboard's mailbox list (not just the deliverability report) must carry the effective limit.
    const list = await s.req('GET', '/v1/mailboxes');
    expect(list.body.data.find((m: any) => m.id === id)).toMatchObject({ daily_send_limit: 400, effective_daily_limit: 40, warming_up: true });
    const off = await s.req('PATCH', `/v1/mailboxes/${id}`, { warmup: false });
    expect(off.body.warmup_started_at).toBeNull();
    expect(await dash()).toMatchObject({ effective_daily_limit: 400, warming_up: false });
    await h.close();
  });

  it('defers sends beyond the warm-up cap', async () => {
    const h = await harness({ WARMUP_DEFAULT: 'true' });
    const s = await signup(h);
    const mb = await connectMailbox(h, s, 'cap@hostiggo.test');
    const list = (await s.req('POST', '/v1/lists', { name: 'L' })).body.id;
    const tpl = (await s.req('POST', '/v1/templates', { name: 'M', kind: 'marketing', subject: 'Hi', text_body: 'Hello' })).body.id;
    for (let i = 0; i < 25; i++) await contact(s, `p${i}@example.com`, { consent_status: 'opted_in', consent_source: 'form', list_ids: [list] });
    const c = (await s.req('POST', '/v1/campaigns', { name: 'C', template_id: tpl, list_id: list, mailbox_id: mb })).body;
    const review = await s.req('GET', `/v1/campaigns/${c.id}/review`);
    expect(review.body.capacity).toMatchObject({ daily_limit: 20, configured_limit: 400, warming_up: true, remaining: 20 });
    expect((await s.req('POST', `/v1/campaigns/${c.id}/send`, { confirm_recipients: 25 })).status).toBe(200);
    await drain(h);
    const accepted = (await h.ctx.db.query(`select count(*)::int as n from sends where status = 'accepted'`)).rows[0].n;
    expect(accepted).toBe(20);
    const deferred = (await h.ctx.db.query(`select count(*)::int as n from sends where status = 'queued' and error_code = 'rate_limited'`)).rows[0].n;
    expect(deferred).toBe(5);
    await h.close();
  });
});

describe('unsubscribe by reply (IMPROVE 2.1)', () => {
  it('only treats a message that is just "unsubscribe" as an opt-out', () => {
    expect(looksLikeUnsubscribe('unsubscribe', undefined)).toBe(true);
    expect(looksLikeUnsubscribe('Re: UNSUBSCRIBE', undefined)).toBe(true);
    expect(looksLikeUnsubscribe('Re: Welcome', 'Please stop emailing me. Thanks')).toBe(true);
    expect(looksLikeUnsubscribe('Re: Welcome', 'Please stop emailing me about the other thing')).toBe(false);
    expect(looksLikeUnsubscribe('Re: Welcome', 'Stop emailing me!')).toBe(true);
    expect(looksLikeUnsubscribe('Re: Welcome', 'unsubscribe On Mon, 7 Jan 2030 at 09:00, Hostiggo <hello@hostiggo.test> wrote: Hi')).toBe(true);
    expect(looksLikeUnsubscribe('Stop by tomorrow?', 'Can you stop by at 3?')).toBe(false);
    expect(looksLikeUnsubscribe('Remove the old invoice', undefined)).toBe(false);
  });

  it('suppresses the sender, opts them out, and ignores strangers and ordinary replies', async () => {
    const h = await harness();
    const s = await signup(h);
    await connectMailbox(h, s, 'hello@hostiggo.test');
    await contact(s, 'bye@example.com', { consent_status: 'opted_in', consent_source: 'form' });
    await contact(s, 'busy@example.com', { consent_status: 'opted_in', consent_source: 'form' });

    h.clock.advance(HOUR);
    h.google.receive({ threadId: 't-bye', headers: { From: 'Bye <bye@example.com>', Subject: 'unsubscribe' } });
    h.google.receive({ threadId: 't-busy', headers: { From: 'busy@example.com', Subject: 'Stop by tomorrow?' }, snippet: 'Can you stop by at 3?' });
    h.google.receive({ threadId: 't-stranger', headers: { From: 'stranger@example.net', Subject: 'unsubscribe' } });
    const push = await h.app.inject({
      method: 'POST', url: '/webhooks/google/pubsub?token=pubsub-test-token',
      payload: { message: { data: Buffer.from(JSON.stringify({ emailAddress: 'hello@hostiggo.test', historyId: 99999 })).toString('base64'), messageId: '1' } },
    });
    expect(push.statusCode).toBe(204);
    await drain(h);

    const sup = (await h.ctx.db.query(`select email, reason from suppressions order by email`)).rows;
    expect(sup).toEqual([{ email: 'bye@example.com', reason: 'unsubscribed' }]);
    const c = (await s.req('GET', '/v1/contacts?search=bye')).body.data[0];
    expect(c.consent_status).toBe('opted_out');
    const classes = (await h.ctx.db.query(`select from_email, classification from inbound_messages order by from_email`)).rows;
    expect(classes).toEqual([
      { from_email: 'busy@example.com', classification: 'unmatched' },
      { from_email: 'bye@example.com', classification: 'unsubscribe' },
      { from_email: 'stranger@example.net', classification: 'unmatched' },
    ]);
    await h.close();
  });
});

describe('automations: enroll existing list members (IMPROVE 3.1)', () => {
  it('enrolls current members only when asked, and only into this automation', async () => {
    const h = await harness();
    const s = await signup(h);
    const mailboxId = await connectMailbox(h, s, 'hello@hostiggo.test');
    const list = (await s.req('POST', '/v1/lists', { name: 'Members' })).body.id;
    const tpl = (await s.req('POST', '/v1/templates', { name: 'W', kind: 'marketing', subject: 'Welcome', text_body: 'Hello' })).body.id;
    await contact(s, 'early@example.com', { consent_status: 'opted_in', consent_source: 'form', list_ids: [list] });
    await contact(s, 'nope@example.com', { list_ids: [list] }); // not opted in: never enrolled in marketing

    const def = { trigger: { type: 'list_joined', list_id: list }, mailbox_id: mailboxId, message_kind: 'marketing', steps: [{ id: 'e1', type: 'email', template_id: tpl }] };
    const make = async (name: string) => (await s.req('POST', '/v1/automations', { name, definition: def })).body.id as string;
    const withFlag = await make('With existing');
    const without = await make('Without');

    const plain = await s.req('POST', `/v1/automations/${without}/publish`);
    expect(plain.body.enrolled_existing).toBe(0);
    await drain(h);
    expect((await h.ctx.db.query(`select count(*)::int as n from sends`)).rows[0].n).toBe(0);

    const pub = await s.req('POST', `/v1/automations/${withFlag}/publish`, { enroll_existing: true });
    expect(pub.status).toBe(200);
    expect(pub.body.enrolled_existing).toBe(1);
    await drain(h);
    const sends = (await h.ctx.db.query(`select to_email, source_id from sends`)).rows;
    expect(sends).toEqual([{ to_email: 'early@example.com', source_id: withFlag }]);
    await h.close();
  });
});

describe('contacts: bulk actions (IMPROVE 3.2)', () => {
  let h: Harness;
  let s: Session;
  let ids: string[];
  let list: string;
  beforeAll(async () => {
    h = await harness();
    s = await signup(h);
    list = (await s.req('POST', '/v1/lists', { name: 'Bulk' })).body.id;
    ids = [];
    for (const e of ['a@example.com', 'b@example.com', 'c@example.com']) ids.push((await contact(s, e)).body.id);
    await contact(s, 'gone@example.com');
    await s.req('POST', '/v1/suppressions', { email: 'gone@example.com', reason: 'unsubscribed' });
    ids.push((await s.req('GET', '/v1/contacts?search=gone')).body.data[0].id);
  });
  afterAll(() => h.close());

  it('opts many in at once, skipping people who unsubscribed, and requires a source', async () => {
    const noSource = await s.req('POST', '/v1/contacts/bulk', { contact_ids: ids, action: 'opt_in' });
    expect(noSource.body.error.code).toBe('consent_source_required');
    const r = await s.req('POST', '/v1/contacts/bulk', { contact_ids: ids, action: 'opt_in', consent_source: 'Event sign-up sheet' });
    expect(r.body).toMatchObject({ processed: 3, skipped: 1 });
    const rows = (await s.req('GET', '/v1/contacts?consent_status=opted_in')).body;
    expect(rows.total).toBe(3);
    expect(rows.data[0].consent_source).toBe('Event sign-up sheet');
    // Doing it again changes nothing.
    expect((await s.req('POST', '/v1/contacts/bulk', { contact_ids: ids, action: 'opt_in', consent_source: 'x' })).body).toMatchObject({ processed: 0, skipped: 4 });
  });

  it('adds to and removes from a list, then deletes', async () => {
    expect((await s.req('POST', '/v1/contacts/bulk', { contact_ids: ids.slice(0, 3), action: 'add_to_list', list_id: list })).body).toMatchObject({ processed: 3, skipped: 0 });
    expect((await s.req('GET', `/v1/contacts?list_id=${list}`)).body.total).toBe(3);
    expect((await s.req('POST', '/v1/contacts/bulk', { contact_ids: ids.slice(0, 2), action: 'remove_from_list', list_id: list })).body.processed).toBe(2);
    expect((await s.req('GET', `/v1/contacts?list_id=${list}`)).body.total).toBe(1);
    expect((await s.req('POST', '/v1/contacts/bulk', { contact_ids: ids.slice(0, 2), action: 'delete' })).body.processed).toBe(2);
    expect((await s.req('GET', '/v1/contacts')).body.total).toBe(2);
  });

  it('is not available to API keys or viewers', async () => {
    const key = (await s.req('POST', '/v1/api-keys', { name: 'k', scopes: ['contacts:write'] })).body.key;
    const res = await h.app.inject({ method: 'POST', url: '/v1/contacts/bulk', headers: { 'x-api-key': key }, payload: { contact_ids: ids, action: 'delete' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('data-subject export and erase (IMPROVE 4.7)', () => {
  it('exports everything held about a person, then erases it while keeping the opt-out', async () => {
    const h = await harness();
    const s = await signup(h);
    const mb = await connectMailbox(h, s, 'hello@hostiggo.test');
    const list = (await s.req('POST', '/v1/lists', { name: 'People' })).body.id;
    const tpl = (await s.req('POST', '/v1/templates', { name: 'W', kind: 'marketing', subject: 'Hi', text_body: 'Hello' })).body.id;
    const created = await contact(s, 'subject@example.com', { first_name: 'Sam', consent_status: 'opted_in', consent_source: 'form', list_ids: [list] });
    const id = created.body.id;
    await contact(s, 'other@example.com', { consent_status: 'opted_in', consent_source: 'form', list_ids: [list] });
    const c = (await s.req('POST', '/v1/campaigns', { name: 'C', template_id: tpl, list_id: list, mailbox_id: mb })).body;
    await s.req('POST', `/v1/campaigns/${c.id}/send`, { confirm_recipients: 2 });
    await drain(h);
    await s.req('POST', '/v1/suppressions', { email: 'subject@example.com', reason: 'unsubscribed' });

    const exp = await s.req('GET', `/v1/contacts/${id}/export`);
    expect(exp.status).toBe(200);
    expect(exp.body.contact).toMatchObject({ email: 'subject@example.com', first_name: 'Sam' });
    expect(exp.body.lists.map((l: any) => l.name)).toEqual(['People']);
    expect(exp.body.sends).toHaveLength(1);
    expect(exp.body.suppressions.map((x: any) => x.reason)).toEqual(['unsubscribed']);
    expect(exp.headers['content-disposition']).toContain('attachment');

    const del = await s.req('DELETE', `/v1/contacts/${id}/erase`);
    expect(del.status).toBe(204);
    const q = async (sql: string, p: unknown[] = []) => (await h.ctx.db.query(sql, p)).rows;
    expect(await q(`select 1 from contacts where email = 'subject@example.com'`)).toHaveLength(0);
    expect(await q(`select 1 from sends where to_email = 'subject@example.com'`)).toHaveLength(0);
    expect(await q(`select 1 from list_memberships where contact_id = $1`, [id])).toHaveLength(0);
    // The other person is untouched, and the opt-out survives so we never email them again.
    expect(await q(`select 1 from sends where to_email = 'other@example.com'`)).toHaveLength(1);
    expect(await q(`select 1 from suppressions where email = 'subject@example.com'`)).toHaveLength(1);
    // The audit trail records the erase without the address.
    const audit = await q(`select metadata, target_id from audit_logs where action = 'contact.erased'`);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('subject@example.com');
    expect((await s.req('GET', `/v1/contacts/${id}/export`)).status).toBe(404);

    // Erasing again with suppressions=erase fully forgets a different person.
    const again = await contact(s, 'forget@example.com');
    await s.req('POST', '/v1/suppressions', { email: 'forget@example.com', reason: 'manual' });
    expect((await s.req('DELETE', `/v1/contacts/${again.body.id}/erase?suppressions=erase`)).status).toBe(204);
    expect(await q(`select 1 from suppressions where email = 'forget@example.com'`)).toHaveLength(0);
    await h.close();
  });

  it('is admin-only', async () => {
    const h = await harness();
    const s = await signup(h);
    const id = (await contact(s, 'x@example.com')).body.id;
    const key = (await s.req('POST', '/v1/api-keys', { name: 'k', scopes: ['contacts:read', 'contacts:write'] })).body.key;
    const res = await h.app.inject({ method: 'DELETE', url: `/v1/contacts/${id}/erase`, headers: { 'x-api-key': key } });
    expect(res.statusCode).toBe(403);
    await h.close();
  });
});
