import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authorize } from '../auth/index.js';
import type { Ctx } from '../context.js';
import { one, type Queryable } from '../db/index.js';
import { enqueue } from '../jobs/queue.js';
import { hmacHex, randomToken } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { IdParams, parse } from '../lib/http.js';
import { isPublicUrl } from '../lib/url.js';

/**
 * Outbound webhooks: Hostiggo Mail tells the caller's backend (e.g. the Hostiggo website) what
 * happened to a transactional send, so it can react (fall back to SMS when a host's booking email
 * fails, show "email delivered" in an admin panel, ...).
 *
 * Each request is signed:  Hostiggo-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 */
export const WEBHOOK_EVENTS = [
  'send.accepted',
  'send.failed',
  'send.suppressed',
  'send.bounced',
  'send.complained',
  'send.replied',
  'send.unknown',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number] | 'ping';

/** The "something went wrong" set: what a website needs to trigger a fallback. */
export const DEFAULT_WEBHOOK_EVENTS: WebhookEvent[] = ['send.failed', 'send.suppressed', 'send.bounced', 'send.unknown'];

const EVENT_FOR_TYPE: Record<string, WebhookEvent> = {
  accepted: 'send.accepted',
  failed: 'send.failed',
  suppressed: 'send.suppressed',
  bounced: 'send.bounced',
  complained: 'send.complained',
  replied: 'send.replied',
};

const MAX_DELIVERY_ATTEMPTS = 8; // ~1 hour of retries with the queue's exponential backoff

export function webhookEventForEmailEvent(type: string): WebhookEvent | null {
  return EVENT_FOR_TYPE[type] ?? null;
}

/**
 * Queue a webhook for every endpoint subscribed to `event`. Runs inside the caller's transaction,
 * so a webhook is only promised when the state change it describes is committed. Transactional
 * sends only: marketing volume would flood the caller with events it doesn't need.
 */
export async function emitSendWebhook(q: Queryable, workspaceId: string, sendId: string, event: WebhookEvent) {
  const endpoints = await q.query<{ id: string }>(
    `select id from webhook_endpoints where workspace_id = $1 and disabled_at is null and $2 = any(events)`,
    [workspaceId, event],
  );
  if (endpoints.rows.length === 0) return;
  const send = await one<any>(
    q,
    `select s.id, s.kind, s.to_email, s.status, s.error_code, s.last_error, s.idempotency_key, s.tags, s.metadata, s.subject,
       s.requested_at, s.accepted_at, t.slug as template
     from sends s left join template_versions v on v.id = s.template_version_id left join templates t on t.id = v.template_id
     where s.id = $1`,
    [sendId],
  );
  if (!send || send.kind !== 'transactional') return;
  const data = {
    send_id: send.id,
    to: send.to_email,
    status: send.status,
    error_code: send.error_code,
    error: send.last_error,
    idempotency_key: String(send.idempotency_key).replace(/^api:/, ''),
    template: send.template,
    subject: send.subject,
    tags: send.tags,
    metadata: send.metadata,
    requested_at: send.requested_at,
    accepted_at: send.accepted_at,
  };
  for (const ep of endpoints.rows) await queueDelivery(q, workspaceId, ep.id, event, data);
}

async function queueDelivery(q: Queryable, workspaceId: string, endpointId: string, event: WebhookEvent, data: object) {
  const d = await one<{ id: string; created_at: Date }>(
    q,
    `insert into webhook_deliveries(workspace_id, endpoint_id, event, payload) values ($1, $2, $3, '{}') returning id, created_at`,
    [workspaceId, endpointId, event],
  );
  const payload = { id: d!.id, type: event, created_at: d!.created_at, data };
  await q.query(`update webhook_deliveries set payload = $2 where id = $1`, [d!.id, JSON.stringify(payload)]);
  await enqueue(q, 'webhook.deliver', { deliveryId: d!.id }, { uniqueKey: `whd:${d!.id}`, maxAttempts: MAX_DELIVERY_ATTEMPTS + 2, priority: 5 });
  return d!.id;
}

export function signWebhook(secret: string, timestamp: number, body: string) {
  return `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${body}`)}`;
}

/** Job handler: POST one delivery. Throws (so the queue retries with backoff) until attempts run out. */
export async function deliverWebhook(ctx: Ctx, deliveryId: string) {
  const d = await one<any>(
    ctx.db,
    `select d.*, e.url, e.encrypted_secret, e.disabled_at from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id where d.id = $1`,
    [deliveryId],
  );
  if (!d || d.status !== 'pending') return;
  if (d.disabled_at) {
    await ctx.db.query(`update webhook_deliveries set status = 'failed', last_error = 'Endpoint was removed' where id = $1`, [d.id]);
    return;
  }
  const body = JSON.stringify(d.payload);
  const t = Math.floor(ctx.clock.now().getTime() / 1000);
  const attempt = d.attempts + 1;
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await ctx.fetch(d.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'HostiggoMail-Webhooks/1',
        'hostiggo-event': d.event,
        'hostiggo-delivery': d.id,
        'hostiggo-signature': signWebhook(ctx.keyring.decrypt(d.encrypted_secret), t, body),
      },
      body,
    });
    status = res.status;
    if (!res.ok) error = `Endpoint answered HTTP ${res.status}`;
  } catch (err) {
    error = (err as Error).message || 'Request failed';
  }
  if (!error) {
    await ctx.db.query(
      `update webhook_deliveries set status = 'delivered', attempts = $2, response_status = $3, last_error = null, delivered_at = $4 where id = $1`,
      [d.id, attempt, status, ctx.clock.now()],
    );
    return;
  }
  const final = attempt >= MAX_DELIVERY_ATTEMPTS;
  await ctx.db.query(
    `update webhook_deliveries set status = $2, attempts = $3, response_status = $4, last_error = $5 where id = $1`,
    [d.id, final ? 'failed' : 'pending', attempt, status, error.slice(0, 500)],
  );
  if (!final) throw new Error(`webhook delivery ${d.id} failed: ${error}`);
}

const EndpointBody = z.object({
  url: z.string().url().max(2000),
  description: z.string().max(200).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
});

export function webhookRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/v1/webhooks', async (req) => {
    const a = authorize(req, { role: 'admin' });
    const r = await ctx.db.query(
      `select e.id, e.url, e.description, e.events, e.created_at,
         (select count(*)::int from webhook_deliveries d where d.endpoint_id = e.id and d.status = 'delivered' and d.created_at > now() - interval '7 days') as delivered_7d,
         (select count(*)::int from webhook_deliveries d where d.endpoint_id = e.id and d.status = 'failed' and d.created_at > now() - interval '7 days') as failed_7d,
         (select count(*)::int from webhook_deliveries d where d.endpoint_id = e.id and d.status = 'pending') as pending
       from webhook_endpoints e where e.workspace_id = $1 and e.disabled_at is null order by e.created_at`,
      [a.workspaceId],
    );
    return { data: r.rows, events: WEBHOOK_EVENTS, default_events: DEFAULT_WEBHOOK_EVENTS };
  });

  /** The signing secret is returned once, here. */
  app.post('/v1/webhooks', async (req, reply) => {
    const a = authorize(req, { role: 'admin' });
    const body = parse(EndpointBody, req.body);
    const url = new URL(body.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('invalid_url', 'Webhook URL must be http(s)');
    if (ctx.config.NODE_ENV === 'production' && (url.protocol !== 'https:' || !isPublicUrl(body.url))) {
      throw badRequest('invalid_url', 'In production the webhook URL must be a public https address');
    }
    const secret = `whsec_${randomToken(24)}`;
    const ep = await ctx.db.tx(async (tx) => {
      const row = await one<any>(
        tx,
        `insert into webhook_endpoints(workspace_id, url, description, events, encrypted_secret, created_by)
         values ($1, $2, $3, $4, $5, $6) returning id, url, description, events, created_at`,
        [a.workspaceId, body.url, body.description ?? null, body.events ?? DEFAULT_WEBHOOK_EVENTS, ctx.keyring.encrypt(secret), a.userId],
      );
      await audit(tx, a, 'webhook.created', { type: 'webhook', id: row.id }, { url: body.url });
      return row;
    });
    reply.code(201);
    return { ...ep, secret };
  });

  app.delete('/v1/webhooks/:id', async (req) => {
    const a = authorize(req, { role: 'admin' });
    const { id } = parse(IdParams, req.params);
    return ctx.db.tx(async (tx) => {
      const r = await tx.query(`update webhook_endpoints set disabled_at = now() where id = $1 and workspace_id = $2 and disabled_at is null returning id`, [id, a.workspaceId]);
      if (!r.rows[0]) throw notFound('Webhook');
      await audit(tx, a, 'webhook.removed', { type: 'webhook', id });
      return { id, removed: true };
    });
  });

  /** Sends a signed "ping" so the receiving code can be checked end to end. */
  app.post('/v1/webhooks/:id/test', async (req, reply) => {
    const a = authorize(req, { role: 'admin' });
    const { id } = parse(IdParams, req.params);
    const ep = await one(ctx.db, `select id from webhook_endpoints where id = $1 and workspace_id = $2 and disabled_at is null`, [id, a.workspaceId]);
    if (!ep) throw notFound('Webhook');
    const deliveryId = await ctx.db.tx((tx) => queueDelivery(tx, a.workspaceId, id, 'ping', { message: 'Hello from Hostiggo Mail' }));
    reply.code(202);
    return { delivery_id: deliveryId };
  });

  app.get('/v1/webhooks/:id/deliveries', async (req) => {
    const a = authorize(req, { role: 'admin' });
    const { id } = parse(IdParams, req.params);
    const r = await ctx.db.query(
      `select id, event, status, attempts, response_status, last_error, created_at, delivered_at, payload
       from webhook_deliveries where endpoint_id = $1 and workspace_id = $2 order by created_at desc limit 50`,
      [id, a.workspaceId],
    );
    return { data: r.rows };
  });
}
