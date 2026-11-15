import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { resolvePrincipal } from './auth/index.js';
import type { Ctx } from './context.js';
import { AppError } from './lib/errors.js';
import { analyticsRoutes } from './modules/analytics.js';
import { automationRoutes } from './modules/automations/routes.js';
import { campaignRoutes } from './modules/campaigns.js';
import { importRoutes } from './modules/contacts/imports.js';
import { privacyRoutes } from './modules/contacts/privacy.js';
import { contactRoutes } from './modules/contacts/routes.js';
import { eventRoutes } from './modules/events.js';
import { mailboxRoutes } from './modules/mailboxes/routes.js';
import { providerWebhookRoutes } from './modules/providerWebhooks.js';
import { replyWebhookRoutes } from './modules/replies.js';
import { sendRoutes } from './modules/sends/routes.js';
import { suppressionRoutes } from './modules/suppressions.js';
import { templateRoutes } from './modules/templates.js';
import { unsubscribeRoutes } from './modules/unsubscribe.js';
import { workspaceRoutes } from './modules/workspace.routes.js';
import { serveWebApp, systemRoutes } from './modules/system.js';

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log,
    // One log line per request drowns real warnings; opt in with REQUEST_LOGGING=true.
    logController: new LogController({ disableRequestLogging: !ctx.config.REQUEST_LOGGING }),
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
    // Signed unsubscribe tokens in /u/:token are longer than the 100-char default.
    routerOptions: { maxParamLength: 2048 },
  }) as unknown as FastifyInstance;

  const prod = ctx.config.NODE_ENV === 'production';
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        // Forms may redirect on to the dashboard (e.g. the dev consent screen -> callback -> APP_BASE_URL).
        formAction: ["'self'", new URL(ctx.config.APP_BASE_URL).origin, ...ctx.config.corsOrigins],
        // Forcing https would break the http://localhost dev setup.
        upgradeInsecureRequests: prod ? [] : null,
      },
    },
    strictTransportSecurity: prod,
  });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctxInfo) => new AppError(429, 'rate_limited', `Too many attempts. Try again in ${Math.ceil(ctxInfo.ttl / 1000)}s.`),
  });

  await app.register(cors, {
    origin: ctx.config.corsOrigins,
    credentials: true,
    allowedHeaders: ['authorization', 'content-type', 'x-workspace-id', 'idempotency-key', 'x-api-key'],
  });

  // Keep the raw JSON body for webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new AppError(400, 'invalid_json', 'Body is not valid JSON'), undefined);
    }
  });
  // Form posts: unsubscribe confirmation + RFC 8058 one-click.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.addHook('onRequest', async (req) => {
    req.principal = await resolvePrincipal(ctx, req);
  });

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ error: { code: (err as { code?: string }).code ?? 'bad_request', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  app.get('/health', async () => {
    await ctx.db.query('select 1');
    return { ok: true, provider_mode: ctx.config.EMAIL_PROVIDER_MODE };
  });

  workspaceRoutes(app, ctx);
  mailboxRoutes(app, ctx);
  suppressionRoutes(app, ctx);
  contactRoutes(app, ctx);
  privacyRoutes(app, ctx);
  importRoutes(app, ctx);
  templateRoutes(app, ctx);
  sendRoutes(app, ctx);
  automationRoutes(app, ctx);
  campaignRoutes(app, ctx);
  eventRoutes(app, ctx);
  unsubscribeRoutes(app, ctx);
  replyWebhookRoutes(app, ctx);
  providerWebhookRoutes(app, ctx);
  analyticsRoutes(app, ctx);
  systemRoutes(app, ctx);
  await serveWebApp(app);

  return app;
}
