import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { one } from '../db/index.js';
import { verifyToken } from '../lib/crypto.js';
import { escapeHtml } from '../lib/template.js';
import { recordEvent } from './sends/service.js';
import { addSuppression } from './suppressions.js';

interface UnsubToken {
  w: string;
  e: string;
  s: string;
}

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:440px;margin:12vh auto;padding:0 16px;color:#111827;line-height:1.5}
button{background:#111827;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}</style></head>
<body><h1 style="font-size:22px">${escapeHtml(title)}</h1>${body}</body></html>`;

/**
 * Public unsubscribe endpoints. GET shows a confirmation (link scanners prefetch GETs, so
 * GET never unsubscribes); POST performs it, which also serves RFC 8058 one-click.
 */
export function unsubscribeRoutes(app: FastifyInstance, ctx: Ctx) {
  const verify = (token: string) => verifyToken<UnsubToken>(token, ctx.config.APP_SECRET, 'unsubscribe');

  app.get('/u/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    reply.type('text/html').header('cache-control', 'no-store');
    const t = verify(token);
    if (!t) return reply.code(400).send(page('Link not valid', '<p>This unsubscribe link is invalid or incomplete.</p>'));
    const ws = await one<{ name: string }>(ctx.db, `select name from workspaces where id = $1`, [t.w]);
    return page(
      'Unsubscribe',
      `<p>Stop marketing email from <strong>${escapeHtml(ws?.name ?? 'this sender')}</strong> to <strong>${escapeHtml(t.e)}</strong>?</p>
       <form method="post"><button type="submit">Unsubscribe</button></form>`,
    );
  });

  app.post('/u/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const t = verify(token);
    if (!t) return reply.code(400).type('text/html').send(page('Link not valid', '<p>This unsubscribe link is invalid.</p>'));
    await ctx.db.tx(async (tx) => {
      const r = await addSuppression(tx, t.w, t.e, 'unsubscribed', 'unsubscribe_link');
      const send = await one<{ id: string; contact_id: string | null }>(tx, `select id, contact_id from sends where id = $1 and workspace_id = $2`, [t.s, t.w]);
      if (r.created && send) {
        await recordEvent(tx, { workspaceId: t.w, sendId: send.id, contactId: send.contact_id, type: 'unsubscribed', source: 'unsubscribe_link', providerEventId: `unsub:${send.id}` });
      }
    });
    // One-click clients POST with List-Unsubscribe=One-Click and only need a 2xx.
    return reply.type('text/html').send(page("You're unsubscribed", '<p>You will no longer receive marketing email from this sender. Transactional messages about your account may still be sent.</p>'));
  });
}
