import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authorize } from '../../auth/index.js';
import type { Ctx } from '../../context.js';
import { one } from '../../db/index.js';
import { AppError, notFound } from '../../lib/errors.js';
import { escapeHtml } from '../../lib/template.js';
import { IdParams, parse } from '../../lib/http.js';
import { FakeGoogleApi } from '../../providers/google.js';
import { enqueue } from '../../jobs/queue.js';
import { queueSend } from '../sends/service.js';
import { MAILBOX_PUBLIC_COLS, completeConnect, disconnect, getMailbox, hasReplyScope, sentInLast24h, startConnect } from './service.js';

export function mailboxRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/v1/mailboxes', async (req) => {
    const a = authorize(req);
    const r = await ctx.db.query(
      `select ${MAILBOX_PUBLIC_COLS} from mailbox_connections where workspace_id = $1 order by status = 'disconnected', created_at`,
      [a.workspaceId],
    );
    const now = ctx.clock.now();
    const data = await Promise.all(
      r.rows.map(async (m: any) => ({ ...m, reply_tracking: hasReplyScope(m), sent_last_24h: await sentInLast24h(ctx.db, m.id, now) })),
    );
    return { data };
  });

  app.get('/v1/mailboxes/:id', async (req) => {
    const a = authorize(req);
    const { id } = parse(IdParams, req.params);
    const m = await one<any>(ctx.db, `select ${MAILBOX_PUBLIC_COLS} from mailbox_connections where id = $1 and workspace_id = $2`, [id, a.workspaceId]);
    if (!m) throw notFound('Mailbox');
    return { ...m, reply_tracking: hasReplyScope(m), sent_last_24h: await sentInLast24h(ctx.db, id, ctx.clock.now()) };
  });

  /** Step 1 of connect: returns Google's consent URL; the frontend redirects the browser there. */
  app.post('/v1/mailboxes/google/authorize', async (req) => {
    const a = authorize(req, { role: 'admin' });
    const body = parse(z.object({ login_hint: z.string().email().optional() }), req.body);
    return startConnect(ctx, a, body.login_hint);
  });

  /** Step 2: Google redirects here; we store the encrypted refresh token and bounce back to the dashboard. */
  app.get('/oauth/google/callback', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const back = new URL('/settings/mailboxes', ctx.config.APP_BASE_URL);
    if (q.error || !q.code || !q.state) {
      back.searchParams.set('error', q.error ?? 'missing_code');
      return reply.redirect(back.toString());
    }
    try {
      const m = await completeConnect(ctx, q.code, q.state);
      back.searchParams.set('connected', m.id);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'google oauth callback failed');
      back.searchParams.set('error', err instanceof AppError ? err.code : 'connect_failed');
    }
    return reply.redirect(back.toString());
  });

  // Local development only: a stand-in consent screen when EMAIL_PROVIDER_MODE=fake.
  if (ctx.google instanceof FakeGoogleApi) {
    const fake = ctx.google;
    app.get('/oauth/google/fake-consent', async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      if (q.email) {
        const code = fake.issueCode(q.email, (q.scope ?? '').split(' '));
        const cb = new URL('/oauth/google/callback', ctx.config.API_BASE_URL);
        cb.searchParams.set('code', code);
        cb.searchParams.set('state', q.state ?? '');
        return reply.redirect(cb.toString());
      }
      reply.type('text/html');
      return `<!doctype html><meta charset="utf-8"><title>Fake Google consent</title>
<body style="font-family:system-ui;max-width:480px;margin:60px auto">
<h2>Fake Google consent (dev mode)</h2><p>Scopes requested:</p><pre style="white-space:pre-wrap">${escapeHtml(q.scope ?? '')}</pre>
<form method="get"><input type="hidden" name="state" value="${escapeHtml(q.state ?? '')}"><input type="hidden" name="scope" value="${escapeHtml(q.scope ?? '')}">
<label>Gmail address <input name="email" type="email" required value="${escapeHtml(q.login_hint ?? 'sender@example.com')}"></label>
<button>Allow</button></form></body>`;
    });
  }

  app.patch('/v1/mailboxes/:id', async (req) => {
    const a = authorize(req, { role: 'admin' });
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ display_name: z.string().max(200).nullish(), daily_send_limit: z.number().int().min(1).max(2000).optional() }), req.body);
    await getMailbox(ctx.db, a.workspaceId, id);
    return ctx.db.tx(async (tx) => {
      const m = await one(
        tx,
        `update mailbox_connections set display_name = coalesce($3, display_name), daily_send_limit = coalesce($4, daily_send_limit), updated_at = now()
         where id = $1 and workspace_id = $2 returning ${MAILBOX_PUBLIC_COLS}`,
        [id, a.workspaceId, body.display_name ?? null, body.daily_send_limit ?? null],
      );
      await audit(tx, a, 'mailbox.updated', { type: 'mailbox', id }, body);
      return m;
    });
  });

  app.post('/v1/mailboxes/:id/disconnect', async (req) => {
    const a = authorize(req, { role: 'admin' });
    const { id } = parse(IdParams, req.params);
    await disconnect(ctx, a, id);
    return { id, status: 'disconnected' };
  });

  /** Look for new replies/bounces now instead of waiting for the periodic sync. */
  app.post('/v1/mailboxes/:id/sync', async (req, reply) => {
    const a = authorize(req, { role: 'member' });
    const { id } = parse(IdParams, req.params);
    const m = await getMailbox(ctx.db, a.workspaceId, id);
    if (!hasReplyScope(m)) {
      throw new AppError(409, 'reply_tracking_off', 'This mailbox was connected without permission to read replies. Turn on GMAIL_REPLY_TRACKING and reconnect it.');
    }
    await enqueue(ctx.db, 'mailbox.sync', { mailboxId: id }, { uniqueKey: `sync:${id}` });
    reply.code(202);
    return { id, queued: true };
  });

  /** Send a plain test email from this mailbox (Phase 2 completion signal). */
  app.post('/v1/mailboxes/:id/test', async (req, reply) => {
    const a = authorize(req, { role: 'member' });
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ to: z.string().email() }), req.body);
    const m = await getMailbox(ctx.db, a.workspaceId, id);
    const send = await ctx.db.tx((tx) =>
      queueSend(ctx, tx, {
        workspaceId: a.workspaceId,
        kind: 'test',
        sourceType: 'test',
        mailboxId: id,
        toEmail: body.to,
        content: {
          subject: 'Hostiggo Mail test message',
          text_body: `This is a test message from Hostiggo Mail, sent through ${m.email}.\n\nIf you received it, the mailbox connection works.`,
        },
        idempotencyKey: `mailbox-test:${id}:${Date.now()}`,
      }),
    );
    reply.code(202);
    return { id: send.id, status: send.status };
  });
}
