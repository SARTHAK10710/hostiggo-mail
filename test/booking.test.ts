import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimJobs, completeJob, enqueue } from '../src/jobs/queue.js';
import { hmacHex } from '../src/lib/crypto.js';
import { addSuppression } from '../src/modules/suppressions.js';
import { connectMailbox, drain, harness, HOUR, signup, type Harness, type Session } from './helpers.js';

/** Booking flow: host has 2 hours to accept; guest and host get emails at each step. */

const open: Harness[] = [];
afterAll(async () => {
  for (const h of open) await h.close();
});

const bookingVars = (id: string) => ({
  booking: { id, url: `https://hostiggo.com/trips/${id}` },
  guest: { first_name: 'Priya', name: 'Priya Sharma', count: '2 guests' },
  host: { first_name: 'Rohan' },
  property: { name: 'Pine View Cottage', city: 'Manali', address: 'Old Manali Road' },
  stay: { check_in: 'Fri 12 Dec 2026', check_out: 'Sun 14 Dec 2026', nights: '2 nights' },
  amount: { total: 'Rs 6,400', payout: 'Rs 5,760' },
  respond_by: '4:30 PM IST',
  links: {
    accept: `https://hostiggo.com/host/bookings/${id}/respond?action=accept&t=abc`,
    reject: `https://hostiggo.com/host/bookings/${id}/respond?action=reject&t=abc`,
    booking: `https://hostiggo.com/host/bookings/${id}`,
    search: 'https://hostiggo.com/search?city=Manali',
  },
  refund: { amount: 'Rs 6,400' },
});

/** Decoded text of every base64 body part in a raw MIME message. */
function bodyText(mime: string) {
  return [...mime.matchAll(/Content-Transfer-Encoding: base64\r\n(?:[^\r\n]+\r\n)*\r\n([A-Za-z0-9+/=\r\n]+)/g)]
    .map((m) => Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8'))
    .join('\n');
}

async function setup(env: Record<string, string> = {}) {
  const h = await harness(env);
  open.push(h);
  const s = await signup(h, 'Hostiggo');
  const mailboxId = await connectMailbox(h, s, 'bookings@hostiggo.test');
  const key = (await s.req('POST', '/v1/api-keys', { name: 'website', scopes: ['messages:send'] })).body.key as string;
  const api = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const r = await h.app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${key}`, ...headers } });
    return { status: r.statusCode, body: r.json() };
  };
  return { h, s, mailboxId, api };
}

describe('Booking emails: starter templates', () => {
  let h: Harness;
  let s: Session;
  beforeAll(async () => ({ h, s } = await setup()));

  it('installs the 8 booking templates once, each with sample data that fills every field', async () => {
    const first = await s.req('POST', '/v1/templates/starter/booking');
    expect(first.status).toBe(201);
    expect(first.body.created).toHaveLength(8);
    const again = await s.req('POST', '/v1/templates/starter/booking');
    expect(again.status).toBe(200);
    expect(again.body.created).toEqual([]);

    const pack = (await s.req('GET', '/v1/templates/starter/booking')).body.data;
    expect(pack.every((t: any) => t.template_id)).toBe(true);
    for (const t of pack) {
      const p = await s.req('POST', `/v1/templates/${t.template_id}/preview`, {});
      expect(p.body.missing, t.slug).toEqual([]);
      expect(p.body.html, t.slug).not.toContain('{{');
      expect(p.body.text, t.slug).not.toContain('{{');
    }
    const list = (await s.req('GET', '/v1/templates?kind=transactional')).body.data;
    expect(list.map((t: any) => t.slug)).toContain('booking_request_host');
  });

  it('lets a template be renamed for the API, and refuses a name already in use', async () => {
    const t = (await s.req('POST', '/v1/templates', { name: 'Receipt', kind: 'transactional', slug: 'receipt', subject: 'Receipt', text_body: 'Thanks' })).body;
    expect(t.slug).toBe('receipt');
    const clash = await s.req('PUT', `/v1/templates/${t.id}`, { slug: 'booking_request_host', subject: 'Receipt', text_body: 'Thanks' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('slug_taken');
  });
});

describe('Booking emails: the accept flow', () => {
  it('sends request + receipt, schedules a host reminder, cancels it when the host accepts', async () => {
    const { h, s, api } = await setup();
    await s.req('POST', '/v1/templates/starter/booking');
    const vars = bookingVars('HG-1042');
    const tags = ['booking:HG-1042'];
    const metadata = { booking_id: 'HG-1042' };
    const remindAt = new Date(h.clock.now().getTime() + 90 * 60_000).toISOString();

    const created = {
      messages: [
        { to: 'host@example.com', template: 'booking_request_host', variables: vars, idempotency_key: 'HG-1042:host-request', tags, metadata },
        { to: 'guest@example.com', template: 'booking_received_guest', variables: vars, idempotency_key: 'HG-1042:guest-received', tags, metadata },
        { to: 'host@example.com', template: 'booking_reminder_host', variables: vars, idempotency_key: 'HG-1042:host-reminder', tags, metadata, send_at: remindAt },
      ],
    };
    const r = await api('POST', '/v1/messages/batch', created);
    expect(r.status).toBe(202);
    expect(r.body.data).toHaveLength(3);
    expect(new Date(r.body.data[2].send_at).toISOString()).toBe(remindAt);

    await drain(h);
    const byTag = async () => (await api('GET', '/v1/sends?tag=booking:HG-1042')).body.data as any[];
    const status = (rows: any[], key: string) => rows.find((x) => x.subject?.includes(key) || x.to_email === key)?.status;
    let rows = await byTag();
    expect(rows.map((x) => x.status).sort()).toEqual(['accepted', 'accepted', 'queued']);

    // The host email carries the guest, dates and both buttons.
    const hostMail = h.google.outbox.find((m) => m.mime.includes('To: host@example.com'))!;
    const hostBody = bodyText(hostMail.mime);
    expect(hostBody).toContain('Priya Sharma');
    expect(hostBody).toContain('Fri 12 Dec 2026');
    expect(hostBody).toContain('https://hostiggo.com/host/bookings/HG-1042/respond?action=accept&amp;t=abc');
    expect(hostBody).toContain('respond?action=reject&t=abc'); // plain-text part
    const guestBody = bodyText(h.google.outbox.find((m) => m.mime.includes('To: guest@example.com'))!.mime);
    expect(guestBody).toContain('4:30 PM IST');

    // A retry of the whole call (website timeout) sends nothing twice.
    const retry = await api('POST', '/v1/messages/batch', created);
    expect(retry.status).toBe(200);
    expect(retry.body.data.every((x: any) => x.duplicate)).toBe(true);

    // 30 minutes later the host accepts: drop the reminder, confirm to both.
    h.clock.advance(30 * 60_000);
    const cancel = await api('POST', '/v1/sends/cancel', { tag: 'booking:HG-1042' });
    expect(cancel.body.cancelled).toBe(1);
    const confirmed = await api('POST', '/v1/messages/batch', {
      messages: [
        { to: 'guest@example.com', template: 'booking_confirmed_guest', variables: vars, idempotency_key: 'HG-1042:guest-confirmed', tags },
        { to: 'host@example.com', template: 'booking_confirmed_host', variables: vars, idempotency_key: 'HG-1042:host-confirmed', tags },
      ],
    });
    expect(confirmed.status).toBe(202);
    await drain(h);

    // Past the reminder time: it must never go out.
    h.clock.advance(2 * HOUR);
    await drain(h);
    rows = await byTag();
    expect(rows).toHaveLength(5);
    expect(rows.filter((x) => x.status === 'accepted')).toHaveLength(4);
    expect(rows.find((x) => x.status === 'cancelled')).toMatchObject({ error_code: 'cancelled_by_api', to_email: 'host@example.com' });
    expect(h.google.outbox.filter((m) => /Subject: Reminder/.test(m.mime))).toHaveLength(0);
    expect(status(rows, 'guest@example.com')).toBe('accepted');
  });

  it('refuses an email with missing details, and a bad batch queues nothing', async () => {
    const { h, s, api } = await setup();
    await s.req('POST', '/v1/templates/starter/booking');
    const vars: any = bookingVars('HG-7');
    delete vars.links.accept;
    delete vars.stay.check_in;
    const bad = await api('POST', '/v1/messages/send', { to: 'host@example.com', template: 'booking_request_host', variables: vars }, { 'idempotency-key': 'HG-7:host' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('missing_variables');
    expect(bad.body.error.details.missing).toEqual(expect.arrayContaining(['links.accept', 'stay.check_in']));

    const batch = await api('POST', '/v1/messages/batch', {
      messages: [
        { to: 'guest@example.com', template: 'booking_received_guest', variables: bookingVars('HG-7'), idempotency_key: 'HG-7:guest' },
        { to: 'host@example.com', template: 'booking_request_host', variables: vars, idempotency_key: 'HG-7:host' },
      ],
    });
    expect(batch.status).toBe(422);
    expect(batch.body.error.message).toContain('messages[1]');
    const all = await h.ctx.db.query(`select count(*)::int as n from sends`);
    expect(all.rows[0].n).toBe(0);

    const unknown = await api('POST', '/v1/messages/send', { to: 'a@example.com', template: 'no_such_template' }, { 'idempotency-key': 'x' });
    expect(unknown.status).toBe(404);
    const far = await api('POST', '/v1/messages/send', { to: 'a@example.com', subject: 'x', text_body: 'y', send_at: '2031-06-01T00:00:00Z' }, { 'idempotency-key': 'y' });
    expect(far.body.error.code).toBe('send_at_too_far');
  });
});

describe('Booking emails: never starved by marketing', () => {
  it('claims transactional jobs before marketing jobs that were queued earlier', async () => {
    const { h } = await setup();
    const now = h.clock.now();
    await enqueue(h.ctx.db, 'test.low', {}, { runAt: new Date(now.getTime() - 60_000) });
    await enqueue(h.ctx.db, 'test.high', {}, { runAt: now, priority: 10 });
    const [first] = await claimJobs(h.ctx.db, 'w', now, 1);
    expect(first.type).toBe('test.high');
    await completeJob(h.ctx.db, first.id);
    await h.ctx.db.query(`delete from jobs where type like 'test.%'`);
  });

  it('keeps part of the daily limit for booking emails', async () => {
    const { h, s, mailboxId, api } = await setup({ TRANSACTIONAL_RESERVE_PERCENT: '40' });
    await h.ctx.db.query(`update mailbox_connections set daily_send_limit = 5 where id = $1`, [mailboxId]);
    const list = (await s.req('POST', '/v1/lists', { name: 'Newsletter' })).body.id;
    for (let i = 0; i < 5; i++) {
      await s.req('POST', '/v1/contacts', { email: `fan${i}@example.com`, consent_status: 'opted_in', consent_source: 'form', list_ids: [list] });
    }
    const tpl = (await s.req('POST', '/v1/templates', { name: 'Offers', kind: 'marketing', subject: 'Winter offers', text_body: 'Hello' })).body.id;
    const c = (await s.req('POST', '/v1/campaigns', { name: 'Winter', template_id: tpl, list_id: list, mailbox_id: mailboxId })).body;
    expect((await s.req('POST', `/v1/campaigns/${c.id}/send`, { confirm_recipients: 5 })).body.status).toBe('scheduled');
    await drain(h);
    const marketing = (await h.ctx.db.query(`select status, error_code from sends where kind = 'marketing'`)).rows;
    expect(marketing.filter((x) => x.status === 'accepted')).toHaveLength(3); // 60% of 5
    expect(marketing.filter((x) => x.status === 'queued').every((x) => x.error_code === 'rate_limited')).toBe(true);

    const r = await api('POST', '/v1/messages/send', { to: 'host@example.com', subject: 'New booking request', text_body: 'Please respond' }, { 'idempotency-key': 'HG-9:host' });
    await drain(h);
    expect((await api('GET', `/v1/sends/${r.body.id}`)).body.status).toBe('accepted');
  });
});

describe('Booking emails: webhooks to the website', () => {
  it('posts a signed event when a booking email cannot be delivered, and retries a failing endpoint', async () => {
    const { h, s, api } = await setup();
    await s.req('POST', '/v1/templates/starter/booking');
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    let answer = 200;
    h.ctx.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init.headers, body: init.body });
      return new Response('ok', { status: answer });
    }) as typeof fetch;

    const ep = await s.req('POST', '/v1/webhooks', { url: 'https://hostiggo.test/api/mail-events', description: 'Website' });
    expect(ep.status).toBe(201);
    expect(ep.body.secret).toMatch(/^whsec_/);
    expect(ep.body.events).toEqual(['send.failed', 'send.suppressed', 'send.bounced', 'send.unknown']);
    expect((await s.req('GET', '/v1/webhooks')).body.data[0]).not.toHaveProperty('secret');

    await addSuppression(h.ctx.db, s.workspaceId, 'bounced-host@example.com', 'bounced', 'test');
    const vars = bookingVars('HG-55');
    await api('POST', '/v1/messages/batch', {
      messages: [
        { to: 'bounced-host@example.com', template: 'booking_request_host', variables: vars, idempotency_key: 'HG-55:host', tags: ['booking:HG-55'], metadata: { booking_id: 'HG-55' } },
        { to: 'guest@example.com', template: 'booking_received_guest', variables: vars, idempotency_key: 'HG-55:guest', tags: ['booking:HG-55'] },
      ],
    });
    await drain(h);

    // Only the problem is reported: the guest email's "accepted" isn't subscribed.
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe('https://hostiggo.test/api/mail-events');
    const [, t, v1] = call.headers['hostiggo-signature'].match(/^t=(\d+),v1=([0-9a-f]+)$/)!;
    expect(v1).toBe(hmacHex(ep.body.secret, `${t}.${call.body}`));
    const event = JSON.parse(call.body);
    expect(event.type).toBe('send.suppressed');
    expect(event.data).toMatchObject({
      to: 'bounced-host@example.com',
      status: 'suppressed',
      error_code: 'suppressed_bounced',
      template: 'booking_request_host',
      idempotency_key: 'HG-55:host',
      tags: ['booking:HG-55'],
      metadata: { booking_id: 'HG-55' },
    });

    // A failing endpoint is retried with backoff, then succeeds.
    answer = 500;
    const ping = await s.req('POST', `/v1/webhooks/${ep.body.id}/test`);
    expect(ping.status).toBe(202);
    await drain(h);
    let deliveries = (await s.req('GET', `/v1/webhooks/${ep.body.id}/deliveries`)).body.data;
    expect(deliveries[0]).toMatchObject({ event: 'ping', status: 'pending', attempts: 1, response_status: 500 });
    answer = 200;
    h.clock.advance(5 * 60_000);
    await drain(h);
    deliveries = (await s.req('GET', `/v1/webhooks/${ep.body.id}/deliveries`)).body.data;
    expect(deliveries[0]).toMatchObject({ event: 'ping', status: 'delivered', attempts: 2 });

    expect((await s.req('DELETE', `/v1/webhooks/${ep.body.id}`)).body.removed).toBe(true);
    expect((await s.req('GET', '/v1/webhooks')).body.data).toHaveLength(0);
  });
});
