import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authorize } from '../../auth/index.js';
import type { Ctx } from '../../context.js';
import { one } from '../../db/index.js';
import { normalizeEmail } from '../../lib/email.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { IdParams, Pagination, parse } from '../../lib/http.js';
import { contactContext } from '../../lib/template.js';
import { latestTemplateVersion } from '../templates.js';
import { queueSend, retrySend } from './service.js';

const SEND_COLS = `s.id, s.kind, s.source_type, s.source_id, s.step_key, s.mailbox_id, s.contact_id, s.to_email, s.subject, s.status,
  s.provider, s.provider_message_id, s.provider_thread_id, s.attempts, s.max_attempts, s.error_code, s.last_error, s.next_attempt_at,
  s.requested_at, s.accepted_at, s.finished_at`;

export function sendRoutes(app: FastifyInstance, ctx: Ctx) {
  /**
   * Transactional send API (guide §7): queue one message, return a Hostiggo send id.
   * Pass Idempotency-Key (header or body) so client retries never double-send.
   */
  app.post('/v1/messages/send', async (req, reply) => {
    const a = authorize(req, { role: 'member', scope: 'messages:send' });
    const body = parse(
      z
        .object({
          to: z.string().email(),
          mailbox_id: z.string().uuid().optional(),
          template_id: z.string().uuid().optional(),
          subject: z.string().max(998).optional(),
          html_body: z.string().max(500_000).optional(),
          text_body: z.string().max(200_000).optional(),
          reply_to: z.string().email().optional(),
          variables: z.record(z.string(), z.unknown()).optional(),
          idempotency_key: z.string().min(1).max(200).optional(),
        })
        .refine((b) => b.template_id || (b.subject && (b.html_body || b.text_body)), 'Provide template_id, or subject plus html_body/text_body'),
      req.body,
    );
    const key = (req.headers['idempotency-key'] as string | undefined) ?? body.idempotency_key;
    if (!key) throw badRequest('idempotency_key_required', 'Send an Idempotency-Key header (or idempotency_key) to make retries safe');

    const result = await ctx.db.tx(async (tx) => {
      let mailboxId = body.mailbox_id;
      if (!mailboxId) {
        const m = await one<{ id: string }>(tx, `select id from mailbox_connections where workspace_id = $1 and status = 'active' order by created_at limit 1`, [a.workspaceId]);
        if (!m) throw conflict('no_mailbox', 'Connect a mailbox before sending');
        mailboxId = m.id;
      }
      let templateVersionId: string | null = null;
      if (body.template_id) {
        const v = await latestTemplateVersion(tx, a.workspaceId, body.template_id);
        if (v.kind !== 'transactional') throw badRequest('wrong_template_kind', 'The send API is for transactional templates');
        templateVersionId = v.id;
      }
      const email = normalizeEmail(body.to);
      const contact = await one<any>(tx, `select * from contacts where workspace_id = $1 and email = $2 and deleted_at is null`, [a.workspaceId, email]);
      return queueSend(ctx, tx, {
        workspaceId: a.workspaceId,
        kind: 'transactional',
        sourceType: 'api',
        mailboxId,
        contactId: contact?.id ?? null,
        toEmail: email,
        templateVersionId,
        content: templateVersionId ? null : { subject: body.subject!, html_body: body.html_body, text_body: body.text_body, reply_to: body.reply_to },
        variables: { ...contactContext(contact ?? { email }), ...(body.variables ?? {}) },
        idempotencyKey: `api:${key}`,
      });
    });
    reply.code(result.duplicate ? 200 : 202);
    return { id: result.id, status: result.status, duplicate: result.duplicate };
  });

  // ── Send log ───────────────────────────────────────────────────────
  app.get('/v1/sends', async (req) => {
    const a = authorize(req);
    const q = parse(
      Pagination.extend({
        status: z.string().optional(),
        kind: z.string().regex(/^(transactional|marketing|test)(,(transactional|marketing|test))*$/).optional(),
        source_type: z.enum(['automation', 'campaign', 'api', 'test']).optional(),
        source_id: z.string().uuid().optional(),
        mailbox_id: z.string().uuid().optional(),
        to: z.string().optional(),
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
    const a = authorize(req, { role: 'member' });
    const { id } = parse(IdParams, req.params);
    const r = await ctx.db.query(
      `update sends set status = 'cancelled', error_code = 'cancelled_by_user', last_error = 'Cancelled', finished_at = now()
       where id = $1 and workspace_id = $2 and status = 'queued' returning id`,
      [id, a.workspaceId],
    );
    if (!r.rows[0]) throw conflict('not_cancellable', 'Only queued sends can be cancelled');
    return { id, status: 'cancelled' };
  });
}
