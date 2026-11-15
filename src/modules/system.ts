import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { authorize } from '../auth/index.js';
import type { Ctx } from '../context.js';
import { FakeGoogleApi } from '../providers/google.js';
import { isPublicUrl } from './sends/service.js';

/** What the dashboard needs to know about how this server is configured. */
export function systemRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/v1/system', async (req) => {
    authorize(req);
    const c = ctx.config;
    return {
      provider_mode: c.EMAIL_PROVIDER_MODE,
      delivers_real_email: c.EMAIL_PROVIDER_MODE === 'gmail',
      google_configured: !!(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET),
      reply_tracking_enabled: c.GMAIL_REPLY_TRACKING,
      pubsub_configured: !!c.GMAIL_PUBSUB_TOPIC,
      oauth_redirect_uri: `${c.API_BASE_URL}/oauth/google/callback`,
      gmail_default_daily_limit: c.GMAIL_DEFAULT_DAILY_LIMIT,
      gmail_max_campaign_recipients: c.GMAIL_MAX_CAMPAIGN_RECIPIENTS,
      reply_attribution_days: c.REPLY_ATTRIBUTION_DAYS,
      api_base_url: c.API_BASE_URL,
      /** Recipients can only use the web unsubscribe page / one-click if this server is public over https. */
      one_click_unsubscribe: isPublicUrl(c.API_BASE_URL) && c.API_BASE_URL.startsWith('https://'),
      unsubscribe_footer: c.UNSUBSCRIBE_FOOTER,
    };
  });

  // Dev mode only: what would have been delivered, decoded for inspection.
  if (ctx.google instanceof FakeGoogleApi) {
    const fake = ctx.google;
    app.get('/v1/dev/outbox', async (req) => {
      const a = authorize(req);
      const boxes = await ctx.db.query<{ email: string }>(`select lower(email) as email from mailbox_connections where workspace_id = $1`, [a.workspaceId]);
      const mine = new Set(boxes.rows.map((b) => b.email));
      const data = fake.outbox
        .filter((m) => mine.has(m.account.toLowerCase()))
        .slice(-50)
        .reverse()
        .map((m) => ({ id: m.id, thread_id: m.threadId, from: m.account, ...decodeMime(m.mime) }));
      return { data };
    });
  }
}

function header(mime: string, name: string) {
  const m = mime.match(new RegExp(`^${name}: (.*)$`, 'mi'));
  if (!m) return '';
  const v = m[1].trim();
  const enc = v.match(/^=\?UTF-8\?B\?(.*)\?=$/i);
  return enc ? Buffer.from(enc[1], 'base64').toString('utf8') : v;
}

function decodeMime(mime: string) {
  const parts = [...mime.matchAll(/Content-Type: (text\/(?:plain|html));[^\r\n]*\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)];
  const body: Record<string, string> = {};
  for (const p of parts) body[p[1] === 'text/html' ? 'html' : 'text'] = Buffer.from(p[2].replace(/\r\n/g, ''), 'base64').toString('utf8');
  return { to: header(mime, 'To'), subject: header(mime, 'Subject'), date: header(mime, 'Date'), list_unsubscribe: header(mime, 'List-Unsubscribe'), ...body };
}

/** Serve the built dashboard (web/dist) from the API so one URL runs everything. */
export async function serveWebApp(app: FastifyInstance) {
  const dist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (!existsSync(dist + 'index.html')) return false;
  // wildcard: files are looked up per request, so a rebuilt dashboard is served without a restart.
  await app.register(fastifyStatic, { root: dist, wildcard: true });
  app.setNotFoundHandler((req, reply) => {
    const isApi = /^\/(v1|oauth|webhooks|u|health)(\/|$)/.test(req.url);
    if (req.method === 'GET' && !isApi) return reply.sendFile('index.html');
    return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  });
  return true;
}
