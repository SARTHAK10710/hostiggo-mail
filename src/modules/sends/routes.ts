import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authorize } from '../../auth/index.js';
import type { Ctx } from '../../context.js';
import { one, type Queryable } from '../../db/index.js';
import { normalizeEmail } from '../../lib/email.js';
import { badRequest, conflict, AppError, notFound } from '../../lib/errors.js';
import { IdParams, Pagination, parse } from '../../lib/http.js';
import { contactContext, renderMessage } from '../../lib/template.js';
import { latestTemplateVersion, latestTemplateVersionBySlug, Slug } from '../templates.js';
import { queueSend, retrySend } from './service.js';

const SEND_COLS = `s.id, s.kind, s.source_type, s.source_id, s.step_key, s.mailbox_id, s.contact_id, s.to_email, s.subject, s.status,
  s.provider, s.provider_message_id, s.provider_thread_id, s.attempts, s.max_attempts, s.error_code, s.last_error, s.next_attempt_at,
  s.requested_at, s.accepted_at, s.finished_at, s.tags, s.metadata`;

const Tag = z.string().min(1).max(100).regex(/^[\w.:@/-]+$/, 'Tags may use letters, digits and . : @ / - _');

/** One message for POST /v1/messages/send and each item of POST /v1/messages/batch. */
const MessageBody = z
  .object({
    to: z.string().email(),
    mailbox_id: z.string().uuid().optional(),
    template_id: z.string().uuid().optional(),
    /** Template slug, e.g. "booking_request_host". */
    template: Slug.optional(),
    subject: z.string().max(998).optional(),
    html_body: z.string().max(500_000).optional(),
    text_body: z.string().max(200_000).optional(),
    reply_to: z.string().email().optional(),
    variables: z.record(z.string(), z.unknown()).optional(),
    idempotency_key: z.string().min(1).max(200).optional(),
    /** Send later (ISO 8601). Cancel before then with POST /v1/sends/cancel. Up to 30 days ahead. */
    send_at: z.string().datetime({ offset: true }).optional(),
    tags: z.array(Tag).max(10).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    /** By default a template variable with no value and no default rejects the request. */
    allow_missing_variables: z.boolean().optional(),
  })
  .refine((b) => !(b.template_id && b.template), 'Use template or template_id, not both')
  .refine((b) => b.template_id || b.template || (b.subject && (b.html_body || b.text_body)), 'Provide template (or template_id), or subject plus html_body/text_body');

type MessageInput = z.infer<typeof MessageBody>;

const MAX_SCHEDULE_MS = 30 * 86_400_000;

/** Validate one API message and turn it into a queued send (inside the caller's transaction). */
async function queueApiMessage(ctx: Ctx, tx: Queryable, workspaceId: string, body: MessageInput, key: string, index?: number) {
  const at = (msg: string) => (index === undefined ? msg : `messages[${index}]: ${msg}`);
  let mailboxId = body.mailbox_id;
  if (!mailboxId) {
    const m = await one<{ id: string }>(tx, `select id from mailbox_connections where workspace_id = $1 and status = 'active' order by created_at limit 1`, [workspaceId]);
    if (!m) throw conflict('no_mailbox', 'Connect a mailbox before sending');
    mailboxId = m.id;
  }
  let version: Awaited<ReturnType<typeof latestTemplateVersion>> | null = null;
  if (body.template_id) version = await latestTemplateVersion(tx, workspaceId, body.template_id);
  else if (body.template) version = await latestTemplateVersionBySlug(tx, workspaceId, body.template);
  if (version && version.kind !== 'transactional') throw badRequest('wrong_template_kind', at('The send API is for transactional templates'));

  let runAt: Date | undefined;
  if (body.send_at) {
    const t = new Date(body.send_at);
    const now = ctx.clock.now();
    if (t.getTime() - now.getTime() > MAX_SCHEDULE_MS) throw badRequest('send_at_too_far', at('send_at can be at most 30 days ahead'));
    if (t > now) runAt = t;
  }

  const email = normalizeEmail(body.to);
  const contact = await one<any>(tx, `select * from contacts where workspace_id = $1 and email = $2 and deleted_at is null`, [workspaceId, email]);
  const variables = { ...contactContext(contact ?? { email }), ...(body.variables ?? {}) };
  const content = version ? null : { subject: body.subject!, html_body: body.html_body, text_body: body.text_body, reply_to: body.reply_to };

  // A booking email with a blank date or a dead Accept button is worse than no email: refuse it now,
  // while the caller can still fix it, instead of failing later in the background.
  if (!body.allow_missing_variables) {
    const { missing } = renderMessage(version ?? content!, variables);
    if (missing.length) {
      throw new AppError(422, 'missing_variables', at(`Missing values for: ${missing.join(', ')}`), { missing });
    }
  }

  return queueSend(ctx, tx, {
    workspaceId,
    kind: 'transactional',
    sourceType: 'api',
    mailboxId,
    contactId: contact?.id ?? null,
    toEmail: email,
    templateVersionId: version?.id ?? null,
    content,
    variables,
    idempotencyKey: `api:${key}`,
    runAt,
    tags: [...new Set(body.tags ?? [])],
    metadata: body.metadata,
  });
}

const sendResult = (r: { id: string; status: string; duplicate: boolean; next_attempt_at?: Date | null; tags?: string[] }) => ({
  id: r.id,
  status: r.status,
  duplicate: r.duplicate,
  send_at: r.next_attempt_at ?? null,
  tags: r.tags ?? [],
});

export function sendRoutes(app: FastifyInstance, ctx: Ctx) {
  /**
   * Transactional send API (guide §7): queue one message, return a Hostiggo send id.
   * Pass Idempotency-Key (header or body) so client retries never double-send.
   */
  app.post('/v1/messages/send', async (req, reply) => {
    const a = authorize(req, { role: 'member', scope: 'messages:send' });
    const body = parse(MessageBody, req.body);
    const key = (req.headers['idempotency-key'] as string | undefined) ?? body.idempotency_key;
    if (!key) throw badRequest('idempotency_key_required', 'Send an Idempotency-Key header (or idempotency_key) to make retries safe');
    const result = await ctx.db.tx((tx) => queueApiMessage(ctx, tx, a.workspaceId, body, key));
    reply.code(result.duplicate ? 200 : 202);
    return sendResult(result);
  });

  /**
   * Several messages in one all-or-nothing call (e.g. the host request and the guest receipt for
   * one booking). Every message needs its own idempotency_key.
   */
  app.post('/v1/messages/batch', async (req, reply) => {
    const a = authorize(req, { role: 'member', scope: 'messages:send' });
    const body = parse(z.object({ messages: z.array(MessageBody).min(1).max(50) }), req.body);
    if (body.messages.some((m) => !m.idempotency_key)) throw badRequest('idempotency_key_required', 'Each message in a batch needs an idempotency_key');
    const keys = body.messages.map((m) => m.idempotency_key!);
    if (new Set(keys).size !== keys.length) throw badRequest('duplicate_idempotency_key', 'Each message in a batch needs a different idempotency_key');
    const results = await ctx.db.tx(async (tx) => {
      const out = [];
      for (const [i, m] of body.messages.entries()) out.push(await queueApiMessage(ctx, tx, a.workspaceId, m, m.idempotency_key!, i));
      return out;
    });
    reply.code(results.every((r) => r.duplicate) ? 200 : 202);
    return { data: results.map(sendResult) };
  });

  /**
   * Cancel queued sends (including scheduled ones) by tag or idempotency key, e.g. the host
   * reminder once the host has answered. Sends already handed to Gmail can't be recalled.
   */
  app.post('/v1/sends/cancel', async (req) => {
    const a = authorize(req, { role: 'member', scope: 'messages:send' });
    const body = parse(
      z.object({ tag: Tag.optional(), idempotency_key: z.string().min(1).max(200).optional() })
        .refine((b) => b.tag || b.idempotency_key, 'Provide tag or idempotency_key'),
      req.body,
    );
    const where = [`workspace_id = $1`, `status = 'queued'`];
    const params: unknown[] = [a.workspaceId];
    if (body.tag) {
      params.push(body.tag);
      where.push(`$${params.length} = any(tags)`);
    }
    if (body.idempotency_key) {
      params.push(`api:${body.idempotency_key}`);
      where.push(`idempotency_key = $${params.length}`);
    }
    const r = await ctx.db.query<{ id: string }>(
      `update sends set status = 'cancelled', error_code = 'cancelled_by_api', last_error = 'Cancelled before sending', finished_at = now(), next_attempt_at = null
       where ${where.join(' and ')} returning id`,
      params,
    );
    return { cancelled: r.rows.length, ids: r.rows.map((x) => x.id) };
  });

  // ── Send log ───────────────────────────────────────────────────────
  app.get('/v1/sends', async (req) => {
    const a = authorize(req, { scope: 'messages:send' });
    const q = parse(
      Pagination.extend({
        status: z.string().optional(),
        kind: z.string().regex(/^(transactional|marketing|test)(,(transactional|marketing|test))*$/).optional(),
        source_type: z.enum(['automation', 'campaign', 'api', 'test']).optional(),
        source_id: z.string().uuid().optional(),
        mailbox_id: z.string().uuid().optional(),
        to: z.string().optional(),
        tag: z.string().max(100).optional(),
      }),
      req.query,
    );
    const where = ['s.workspace_id = $1'];
    const params: unknown[] = [a.workspaceId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.status) add('s.status = ?', q.status);
    if (q.kind) add('s.kind = any(?)', q.kind.split(','));
    if (q.source_type) add('s.source_type = ?', q.source_type);
    if (q.source_id) add('s.source_id = ?', q.source_id);
    if (q.mailbox_id) add('s.mailbox_id = ?', q.mailbox_id);
    if (q.to) add('s.to_email = ?', normalizeEmail(q.to));
    if (q.tag) add('? = any(s.tags)', q.tag);
    params.push(q.limit, q.offset);
    const r = await ctx.db.query(
      `select ${SEND_COLS},
         exists (select 1 from email_events e where e.send_id = s.id and e.type = 'replied') as replied,
         exists (select 1 from email_events e where e.send_id = s.id and e.type = 'bounced') as bounced
       from sends s where ${where.join(' and ')} order by s.requested_at desc limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return { data: r.rows };
  });

  app.get('/v1/sends/:id', async (req) => {
    const a = authorize(req, { scope: 'messages:send' });
    const { id } = parse(IdParams, req.params);
    const send = await one(ctx.db, `select ${SEND_COLS} from sends s where s.id = $1 and s.workspace_id = $2`, [id, a.workspaceId]);
    if (!send) throw notFound('Send');
    const events = await ctx.db.query(
      `select type, source, occurred_at, metadata from email_events where send_id = $1 order by occurred_at, type`,
      [id],
    );
    return { ...send, events: events.rows };
  });

  app.post('/v1/sends/:id/retry', async (req) => {
    const a = authorize(req, { role: 'member' });
    const { id } = parse(IdParams, req.params);
    return ctx.db.tx(async (tx) => {
      const s = await retrySend(ctx, tx, a.workspaceId, id);
      await audit(tx, a, 'send.retried', { type: 'send', id });
      return { id: s.id, status: s.status };
    });
  });

  app.post('/v1/sends/:id/cancel', async (req) => {
    const a = authorize(req, { role: 'member', scope: 'messages:send' });
    const { id } = parse(IdParams, req.params);
    const r = await ctx.db.query(
      `update sends set status = 'cancelled', error_code = 'cancelled_by_user', last_error = 'Cancelled', finished_at = now(), next_attempt_at = null
       where id = $1 and workspace_id = $2 and status = 'queued' returning id`,
      [id, a.workspaceId],
    );
    if (!r.rows[0]) throw conflict('not_cancellable', 'Only queued sends can be cancelled');
    return { id, status: 'cancelled' };
  });
}
