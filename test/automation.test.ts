import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hmacHex } from '../src/lib/crypto.js';
import { connectMailbox, DAY, drain, harness, HOUR, signup, type Harness, type Session } from './helpers.js';

let h: Harness;
let s: Session;
let mailboxId: string;
let listId: string;
let welcomeId: string;
let followUpId: string;
let automationId: string;

const sendsFor = async (email: string) =>
  (await h.ctx.db.query(`select * from sends where to_email = $1 and kind <> 'test' order by requested_at`, [email])).rows;

beforeAll(async () => {
  h = await harness();
  s = await signup(h, 'Hostiggo');
  mailboxId = await connectMailbox(h, s, 'hello@hostiggo.test');
  listId = (await s.req('POST', '/v1/lists', { name: 'New customers' })).body.id;
  welcomeId = (await s.req('POST', '/v1/templates', {
    name: 'Welcome', kind: 'marketing',
    subject: 'Welcome, {{ contact.first_name | default: "there" }}!',
    html_body: '<p>Hi {{ contact.first_name }}, thanks for joining <b>Hostiggo</b>.</p>',
    text_body: 'Hi {{ contact.first_name }}, thanks for joining Hostiggo.',
  })).body.id;
  followUpId = (await s.req('POST', '/v1/templates', {
    name: 'Day 1 follow-up', kind: 'marketing', subject: 'Anything we can help with?', text_body: 'Reply to this email and a human will answer.',
  })).body.id;
});
afterAll(() => h.close());

describe('Phase 4: automations', () => {
  it('saves a draft and refuses to publish an incomplete one', async () => {
    const r = await s.req('POST', '/v1/automations', { name: 'Welcome sequence', definition: { steps: [] } });
    expect(r.status).toBe(201);
    automationId = r.body.id;
    const pub = await s.req('POST', `/v1/automations/${automationId}/publish`);
    expect(pub.status).toBe(400);
    expect(pub.body.error.details).toEqual(expect.arrayContaining(['Choose a trigger', 'Choose a sending mailbox', 'Add at least one email step']));
  });

  it('publishes an immutable version with template versions pinned', async () => {
    const def = {
      trigger: { type: 'list_joined', list_id: listId },
      mailbox_id: mailboxId,
      message_kind: 'marketing',
      steps: [
        { id: 'welcome', type: 'email', template_id: welcomeId },
        { id: 'wait1', type: 'wait', amount: 1, unit: 'days' },
        { id: 'followup', type: 'email', template_id: followUpId },
      ],
    };
    expect((await s.req('PUT', `/v1/automations/${automationId}`, { definition: def })).status).toBe(200);
    const pub = await s.req('POST', `/v1/automations/${automationId}/publish`);
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ status: 'active', version: 1 });
    const detail = await s.req('GET', `/v1/automations/${automationId}`);
    expect(detail.body.published.steps.filter((x: any) => x.type === 'email').every((x: any) => x.template_version_id)).toBe(true);
    expect(detail.body.has_unpublished_changes).toBe(false);
  });

  it('test-sends every email step without counting it in metrics', async () => {
    const t = await s.req('POST', `/v1/automations/${automationId}/test`, { to: 'qa@hostiggo.test' });
    expect(t.body.sends).toHaveLength(2);
    await drain(h);
    const subjects = h.google.outbox.filter((m) => m.mime.includes('To: qa@hostiggo.test')).map((m) => m.mime.match(/^Subject: (.*)$/m)![1]);
    expect(subjects).toEqual(['Welcome, Test!', 'Anything we can help with?']);
  });

  it('does not enroll contacts without marketing consent', async () => {
    const c = await s.req('POST', '/v1/contacts', { email: 'noconsent@example.com', list_ids: [listId] });
    expect(c.status).toBe(201);
    await drain(h);
    expect(await sendsFor('noconsent@example.com')).toHaveLength(0);
  });

  it('a test contact enters once and receives each configured step once', async () => {
    await s.req('POST', '/v1/contacts', {
      email: 'guest@example.com', first_name: 'Priya', consent_status: 'opted_in', consent_source: 'checkout opt-in', list_ids: [listId],
    });
    await drain(h);
    let sends = await sendsFor('guest@example.com');
    expect(sends.map((x) => [x.step_key, x.status])).toEqual([['welcome', 'accepted']]);
    expect(sends[0].subject).toBe('Welcome, Priya!');
    const mime = h.google.outbox.find((m) => m.mime.includes('To: guest@example.com'))!.mime;
    expect(mime).toMatch(/^List-Unsubscribe: <mailto:hello@hostiggo\.test\?subject=unsubscribe>, <https:\/\/api\.test\/u\//m);
    expect(mime).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);

    // Leaving and re-joining the list does not re-enter (default re-entry policy: once).
    const contactId = sends[0].contact_id;
    await s.req('DELETE', `/v1/lists/${listId}/contacts/${contactId}`);
    await s.req('POST', `/v1/lists/${listId}/contacts`, { contact_ids: [contactId] });
    await drain(h);

    h.clock.advance(12 * HOUR);
    await drain(h);
    expect(await sendsFor('guest@example.com')).toHaveLength(1); // still waiting

    h.clock.advance(13 * HOUR);
    await drain(h);
    await drain(h); // replays are harmless
    sends = await sendsFor('guest@example.com');
    expect(sends.map((x) => [x.step_key, x.status])).toEqual([['welcome', 'accepted'], ['followup', 'accepted']]);
    const enr = (await s.req('GET', `/v1/automations/${automationId}/enrollments`)).body.data.filter((e: any) => e.email === 'guest@example.com');
    expect(enr).toHaveLength(1);
    expect(enr[0].state).toBe('completed');
  });

  it('pause is immediate for future steps; resume does not replay completed sends', async () => {
    await s.req('POST', '/v1/contacts', {
      email: 'paused@example.com', consent_status: 'opted_in', consent_source: 'form', list_ids: [listId],
    });
    await drain(h);
    expect(await sendsFor('paused@example.com')).toHaveLength(1);
    expect((await s.req('POST', `/v1/automations/${automationId}/pause`)).status).toBe(200);
    h.clock.advance(2 * DAY);
    await drain(h);
    expect(await sendsFor('paused@example.com')).toHaveLength(1);
    // New list joiners while paused are not enrolled.
    await s.req('POST', '/v1/contacts', { email: 'late@example.com', consent_status: 'opted_in', consent_source: 'form', list_ids: [listId] });
    expect((await s.req('POST', `/v1/automations/${automationId}/resume`)).status).toBe(200);
    await drain(h);
    const sends = await sendsFor('paused@example.com');
    expect(sends.map((x) => x.step_key)).toEqual(['welcome', 'followup']);
  });

  it('existing enrollments stay on their version when a new version is published', async () => {
    await s.req('POST', '/v1/contacts', { email: 'v1@example.com', consent_status: 'opted_in', consent_source: 'form', list_ids: [listId] });
    await drain(h);
    const detail = await s.req('GET', `/v1/automations/${automationId}`);
    const def = { ...detail.body.draft_definition, steps: [...detail.body.draft_definition.steps, { id: 'wait2', type: 'wait', amount: 2, unit: 'days' }, { id: 'last', type: 'email', template_id: followUpId }] };
    await s.req('PUT', `/v1/automations/${automationId}`, { definition: def });
    expect((await s.req('POST', `/v1/automations/${automationId}/publish`)).body.version).toBe(2);
    h.clock.advance(5 * DAY);
    await drain(h);
    expect((await sendsFor('v1@example.com')).map((x) => x.step_key)).toEqual(['welcome', 'followup']);
  });

  it('unsubscribe link: GET confirms only, POST suppresses and exits the sequence', async () => {
    await s.req('POST', '/v1/contacts', { email: 'unsub@example.com', consent_status: 'opted_in', consent_source: 'form', list_ids: [listId] });
    await drain(h);
    const mime = h.google.outbox.find((m) => m.mime.includes('To: unsub@example.com'))!.mime;
    const url = mime.match(/<https:\/\/api\.test(\/u\/[^>]+)>/)![1];
    const get = await h.app.inject({ method: 'GET', url });
    expect(get.body).toContain('<form method="post">');
    expect((await s.req('GET', '/v1/suppressions?email=unsub@example.com')).body.data).toHaveLength(0);
    const post = await h.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(post.statusCode).toBe(200);
    expect((await s.req('GET', '/v1/suppressions?email=unsub@example.com')).body.data[0].reason).toBe('unsubscribed');
    h.clock.advance(5 * DAY);
    await drain(h);
    expect((await sendsFor('unsub@example.com')).map((x) => x.step_key)).toEqual(['welcome']);
    const enr = (await s.req('GET', `/v1/automations/${automationId}/enrollments?state=exited`)).body.data.find((e: any) => e.email === 'unsub@example.com');
    expect(enr.exit_reason).toBe('unsubscribed');
    // A tampered token is rejected.
    const bad = await h.app.inject({ method: 'POST', url: url.slice(0, -3) + 'abc' });
    expect(bad.statusCode).toBe(400);
  });

  it('product events trigger event-based automations once per idempotency key', async () => {
    const tx = (await s.req('POST', '/v1/templates', { name: 'Receipt', kind: 'transactional', subject: 'Booking {{ booking_id }} confirmed', text_body: 'Thanks!' })).body.id;
    const auto = (await s.req('POST', '/v1/automations', {
      name: 'Booking confirmation',
      definition: { trigger: { type: 'event', event_name: 'booking.confirmed' }, mailbox_id: mailboxId, message_kind: 'transactional', reentry: 'after_exit', steps: [{ id: 'receipt', type: 'email', template_id: tx }] },
    })).body.id;
    expect((await s.req('POST', `/v1/automations/${auto}/publish`)).status).toBe(200);
    const key = (await s.req('POST', '/v1/api-keys', { name: 'app', scopes: ['events:write'] })).body.key;
    const post = (k: string) => h.app.inject({ method: 'POST', url: '/v1/events', headers: { authorization: `Bearer ${key}` }, payload: { name: 'booking.confirmed', email: 'buyer@example.com', create_contact: true, idempotency_key: k } });
    expect((await post('evt-1')).statusCode).toBe(202);
    expect((await post('evt-1')).json().duplicate).toBe(true);
    await drain(h);
    const sends = await sendsFor('buyer@example.com');
    expect(sends).toHaveLength(1);
    expect(sends[0].kind).toBe('transactional');
  });
});

describe('Phase 2/7: transactional send API', () => {
  it('queues one message per idempotency key', async () => {
    const key = (await s.req('POST', '/v1/api-keys', { name: 'tx', scopes: ['messages:send'] })).body.key;
    const send = () =>
      h.app.inject({
        method: 'POST', url: '/v1/messages/send',
        headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'order-991' },
        payload: { to: 'receipt@example.com', subject: 'Your receipt', text_body: 'Paid ₹4,200. Thank you!' },
      });
    const r1 = await send();
    const r2 = await send();
    expect(r1.statusCode).toBe(202);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().id).toBe(r1.json().id);
    const noKey = await h.app.inject({ method: 'POST', url: '/v1/messages/send', headers: { authorization: `Bearer ${key}` }, payload: { to: 'a@b.test', subject: 'x', text_body: 'y' } });
    expect(noKey.json().error.code).toBe('idempotency_key_required');
    await drain(h);
    expect((await sendsFor('receipt@example.com')).map((x) => x.status)).toEqual(['accepted']);
  });
});

describe('Phase 5: reply analytics', () => {
  it('attributes a human reply once, ignores auto-replies, and reports numerator/denominator/window', async () => {
    await s.req('POST', '/v1/contacts', { email: 'replier@example.com', consent_status: 'opted_in', consent_source: 'form', list_ids: [listId] });
    await s.req('POST', '/v1/contacts', { email: 'ooo@example.com', consent_status: 'opted_in', consent_source: 'form', list_ids: [listId] });
    await drain(h);
    const [send] = await sendsFor('replier@example.com');
    const [oooSend] = await sendsFor('ooo@example.com');

    h.clock.advance(2 * HOUR);
    h.google.receive({ threadId: send.provider_thread_id, headers: { From: 'Replier <replier@example.com>', Subject: 'Re: Welcome', 'In-Reply-To': `<${send.rfc822_message_id}>` } });
    h.google.receive({ threadId: oooSend.provider_thread_id, headers: { From: 'ooo@example.com', Subject: 'Automatic reply: Welcome', 'Auto-Submitted': 'auto-replied' } });
    // Subject match alone (different thread, no references) must not count.
    h.google.receive({ threadId: 'unrelated-thread', headers: { From: 'stranger@example.com', Subject: 'Re: Welcome, there!' } });

    const push = (token: string) =>
      h.app.inject({
        method: 'POST', url: `/webhooks/google/pubsub?token=${token}`,
        payload: { message: { data: Buffer.from(JSON.stringify({ emailAddress: 'hello@hostiggo.test', historyId: 99999 })).toString('base64'), messageId: '1' } },
      });
    expect((await push('wrong')).statusCode).toBe(401);
    expect((await push('pubsub-test-token')).statusCode).toBe(204);
    await drain(h);
    expect((await push('pubsub-test-token')).statusCode).toBe(204); // duplicate notification
    await drain(h);

    const replies = (await h.ctx.db.query(`select * from email_events where type = 'replied'`)).rows;
    expect(replies).toHaveLength(1);
    expect(replies[0].send_id).toBe(send.id);
    const inbound = (await h.ctx.db.query(`select classification from inbound_messages order by classification`)).rows.map((r) => r.classification);
    expect(inbound).toEqual(['auto_reply', 'reply', 'unmatched']);

    const stats = await s.req('GET', `/v1/automations/${automationId}/analytics?window_days=7`);
    expect(stats.body.reply_rate.numerator).toBe(1);
    expect(stats.body.reply_rate.denominator).toBeGreaterThanOrEqual(2);
    expect(stats.body.reply_rate.window_days).toBe(7);
    expect(stats.body.reply_rate.event_source).toBe('gmail_sync');
    expect(stats.body.reply_rate_definition).toContain('Excludes test sends');
    const welcome = stats.body.steps.find((x: any) => x.step_id === 'welcome');
    expect(welcome.counts.replied).toBe(1);
  });

  it('detects bounces, suppresses the address, and blocks later sends to it', async () => {
    await s.req('POST', '/v1/contacts', { email: 'dead@example.com', consent_status: 'opted_in', consent_source: 'form', list_ids: [listId] });
    await drain(h);
    const [send] = await sendsFor('dead@example.com');
    h.google.receive({
      threadId: send.provider_thread_id,
      headers: { From: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', Subject: 'Delivery Status Notification (Failure)', 'X-Failed-Recipients': 'dead@example.com', 'Content-Type': 'multipart/report; report-type=delivery-status' },
    });
    await h.app.inject({ method: 'POST', url: '/webhooks/google/pubsub?token=pubsub-test-token', payload: { message: { data: Buffer.from(JSON.stringify({ emailAddress: 'hello@hostiggo.test' })).toString('base64') } } });
    await drain(h);
    expect((await s.req('GET', '/v1/suppressions?email=dead@example.com')).body.data[0].reason).toBe('bounced');
    const enr = (await s.req('GET', `/v1/automations/${automationId}/enrollments?state=exited`)).body.data.find((e: any) => e.email === 'dead@example.com');
    expect(enr.exit_reason).toBe('bounced');
    // Even transactional mail is blocked to a hard-bounced address.
    const r = await s.req('POST', '/v1/messages/send', { to: 'dead@example.com', subject: 'x', text_body: 'y' }, { 'idempotency-key': 'b1' });
    await drain(h);
    expect((await s.req('GET', `/v1/sends/${r.body.id}`)).body).toMatchObject({ status: 'suppressed', error_code: 'suppressed_bounced' });
    const dash = await s.req('GET', '/v1/deliverability');
    expect(dash.body.suppressions.bounced).toBe(1);
    expect(dash.body.checklist.find((c: any) => c.key === 'reply_tracking').ok).toBe(true);
  });
});

describe('Marketing campaigns', () => {
  it('requires an explicit review that matches the eligible audience', async () => {
    const vip = (await s.req('POST', '/v1/lists', { name: 'VIP' })).body.id;
    await s.req('POST', '/v1/contacts', { email: 'vip1@example.com', consent_status: 'opted_in', consent_source: 'form', list_ids: [vip] });
    await s.req('POST', '/v1/contacts', { email: 'vip2@example.com', list_ids: [vip] }); // no consent
    await s.req('POST', `/v1/lists/${vip}/contacts`, { emails: ['unsub@example.com'] }); // suppressed
    const c = (await s.req('POST', '/v1/campaigns', { name: 'Monsoon offers', template_id: followUpId, list_id: vip, mailbox_id: mailboxId })).body;
    const review = await s.req('GET', `/v1/campaigns/${c.id}/review`);
    expect(review.body.audience).toEqual({ in_list: 3, suppressed: 1, not_opted_in: 1, eligible: 1 });
    expect(review.body.ready).toBe(true);
    const wrong = await s.req('POST', `/v1/campaigns/${c.id}/send`, { confirm_recipients: 3 });
    expect(wrong.body.error.code).toBe('review_mismatch');
    const ok = await s.req('POST', `/v1/campaigns/${c.id}/send`, { confirm_recipients: 1 });
    expect(ok.body.status).toBe('scheduled');
    await drain(h);
    expect((await sendsFor('vip1@example.com')).map((x) => x.status)).toEqual(['accepted']);
    expect(await sendsFor('vip2@example.com')).toHaveLength(0);
    expect((await s.req('GET', `/v1/campaigns/${c.id}`)).body.status).toBe('sent');
  });
});

describe('Provider webhooks', () => {
  it('verifies the signature and applies events idempotently', async () => {
    const [send] = await sendsFor('vip1@example.com');
    await h.ctx.db.query(`update sends set provider = 'acme-esp' where id = $1`, [send.id]);
    const body = JSON.stringify({ events: [{ id: 'evt_1', type: 'complained', provider_message_id: send.provider_message_id }] });
    const post = (sig: string) => h.app.inject({ method: 'POST', url: '/webhooks/provider/acme-esp', headers: { 'content-type': 'application/json', 'x-hostiggo-signature': sig }, payload: body });
    expect((await post('sha256=bad')).statusCode).toBe(401);
    const good = `sha256=${hmacHex('whsec_test', body)}`;
    expect((await post(good)).json()).toEqual({ applied: 1, unmatched: 0 });
    expect((await post(good)).json()).toEqual({ applied: 0, unmatched: 0 });
    expect((await s.req('GET', '/v1/suppressions?email=vip1@example.com')).body.data[0].reason).toBe('complained');
  });
});

describe('Analytics totals', () => {
  it('counts each send once as requested', async () => {
    // requested_at defaults to the DB's wall clock; move it inside the test clock's window.
    await h.ctx.db.query(`update sends set requested_at = $1`, [h.clock.now()]);
    const o = await s.req('GET', '/v1/analytics/overview?days=30');
    const sendRows = (await h.ctx.db.query(`select count(*)::int as n from sends where kind <> 'test'`)).rows[0].n;
    expect(o.body.totals.requested).toBe(sendRows);
    expect(o.body.totals.accepted).toBeLessThanOrEqual(o.body.totals.requested);
  });
});

describe('Unsubscribe on a local (non-public) server', () => {
  it('uses reply-to-unsubscribe instead of localhost links', async () => {
    const h2 = await harness({ API_BASE_URL: 'http://localhost:4000' });
    const s2 = await signup(h2);
    const mb = await connectMailbox(h2, s2, 'local@hostiggo.test');
    const list = (await s2.req('POST', '/v1/lists', { name: 'L' })).body.id;
    const tpl = (await s2.req('POST', '/v1/templates', { name: 'M', kind: 'marketing', subject: 'Hi', html_body: '<p>Hello</p>', text_body: 'Hello' })).body.id;
    await s2.req('POST', '/v1/contacts', { email: 'r@example.com', consent_status: 'opted_in', consent_source: 'form', list_ids: [list] });
    const c = (await s2.req('POST', '/v1/campaigns', { name: 'C', template_id: tpl, list_id: list, mailbox_id: mb })).body;
    expect((await s2.req('POST', `/v1/campaigns/${c.id}/send`, { confirm_recipients: 1 })).status).toBe(200);
    await drain(h2);
    const mime = h2.google.outbox.at(-1)!.mime;
    expect(mime).toMatch(/^List-Unsubscribe: <mailto:local@hostiggo\.test\?subject=unsubscribe>\r?$/m);
    expect(mime).not.toMatch(/List-Unsubscribe-Post/);
    expect(mime).not.toContain('localhost');
    const decoded = [...mime.matchAll(/\r\n\r\n([A-Za-z0-9+/=\r\n]{20,})/g)].map((m) => Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8')).join('\n');
    expect(decoded).toContain('Reply with "unsubscribe"');
    expect(decoded).not.toContain('localhost');
    const sys = await s2.req('GET', '/v1/system');
    expect(sys.body.one_click_unsubscribe).toBe(false);
    await h2.close();
  });
});

describe('Reply tracking switched on later', () => {
  it('counts a reply that arrived before the first sync, and the sync button works', async () => {
    const h4 = await harness();
    const s4 = await signup(h4);
    const mb = await connectMailbox(h4, s4, 'late@hostiggo.test');
    const r = await s4.req('POST', '/v1/messages/send', { to: 'friend@example.com', subject: 'Hello', text_body: 'Hi!' }, { 'idempotency-key': 'k1' });
    await drain(h4);
    const send = (await h4.ctx.db.query(`select * from sends where id = $1`, [r.body.id])).rows[0];
    h4.google.receive({ threadId: send.provider_thread_id, headers: { From: 'friend@example.com', Subject: 'Re: Hello' } });
    // Simulate tracking that starts after the reply: cursor already past it, never synced.
    await h4.ctx.db.query(`update mailbox_connections set history_id = $2, last_synced_at = null where id = $1`, [mb, String(h4.google.historyCounter)]);
    expect((await s4.req('POST', `/v1/mailboxes/${mb}/sync`)).status).toBe(202);
    await drain(h4);
    const replies = (await h4.ctx.db.query(`select send_id from email_events where type = 'replied'`)).rows;
    expect(replies.map((x) => x.send_id)).toEqual([send.id]);
    await h4.close();
  });
});

describe('Unsubscribe footer setting', () => {
  it('UNSUBSCRIBE_FOOTER=false drops the visible line but keeps the header', async () => {
    const h3 = await harness({ API_BASE_URL: 'http://localhost:4000', UNSUBSCRIBE_FOOTER: 'false' });
    const s3 = await signup(h3);
    const mb = await connectMailbox(h3, s3, 'nofooter@hostiggo.test');
    const list = (await s3.req('POST', '/v1/lists', { name: 'L' })).body.id;
    const tpl = (await s3.req('POST', '/v1/templates', { name: 'M', kind: 'marketing', subject: 'Hi', html_body: '<p>Hello</p>', text_body: 'Hello' })).body.id;
    await s3.req('POST', '/v1/contacts', { email: 'r@example.com', consent_status: 'opted_in', consent_source: 'form', list_ids: [list] });
    const c = (await s3.req('POST', '/v1/campaigns', { name: 'C', template_id: tpl, list_id: list, mailbox_id: mb })).body;
    await s3.req('POST', `/v1/campaigns/${c.id}/send`, { confirm_recipients: 1 });
    await drain(h3);
    const mime = h3.google.outbox.at(-1)!.mime;
    expect(mime).toMatch(/^List-Unsubscribe: <mailto:nofooter@hostiggo\.test\?subject=unsubscribe>/m);
    const decoded = [...mime.matchAll(/\r\n\r\n([A-Za-z0-9+/=\r\n]{8,})/g)].map((m) => Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8')).join('\n');
    expect(decoded).toContain('Hello');
    expect(decoded.toLowerCase()).not.toContain('unsubscribe');
    expect((await s3.req('GET', '/v1/system')).body.unsubscribe_footer).toBe(false);
    await h3.close();
  });
});
