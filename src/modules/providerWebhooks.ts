import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { one } from '../db/index.js';
import { hmacHex, safeEqual } from '../lib/crypto.js';
import { recordEvent } from './sends/service.js';
import { addSuppression } from './suppressions.js';

/**
 * POST /webhooks/provider/:name — delivery/bounce/complaint/click/reply events from an ESP.
 * Each provider gets a shared secret (PROVIDER_WEBHOOK_SECRETS) and signs the raw body:
 *   X-Hostiggo-Signature: sha256=<hex hmac of raw body>
 * Provider-specific adapters can translate their native payloads into this normalized shape.
 */
const EventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(['delivered', 'bounced', 'complained', 'opened', 'clicked', 'replied']),
  provider_message_id: z.string().min(1),
  occurred_at: z.string().datetime().optional(),
  bounce_type: z.enum(['hard', 'soft']).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const Payload = z.object({ events: z.array(EventSchema).min(1).max(1000) });

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export function providerWebhookRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/webhooks/provider/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const secret = ctx.config.providerWebhookSecrets[name];
    const sig = String(req.headers['x-hostiggo-signature'] ?? '');
    if (!secret || !req.rawBody || !safeEqual(sig, `sha256=${hmacHex(secret, req.rawBody)}`)) {
      return reply.code(401).send({ error: 'invalid_signature' });
    }
    const parsed = Payload.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });

    let applied = 0;
    let unmatched = 0;
    for (const e of parsed.data.events) {
      const send = await one<{ id: string; workspace_id: string; contact_id: string | null; to_email: string }>(
        ctx.db,
        `select id, workspace_id, contact_id, to_email from sends where provider = $1 and provider_message_id = $2`,
        [name, e.provider_message_id],
      );
      if (!send) {
        unmatched += 1;
        continue;
      }
      await ctx.db.tx(async (tx) => {
        const created = await recordEvent(tx, {
          workspaceId: send.workspace_id,
          sendId: send.id,
          contactId: send.contact_id,
          type: e.type,
          source: `provider:${name}`,
          providerEventId: e.id,
          occurredAt: e.occurred_at ? new Date(e.occurred_at) : undefined,
          metadata: { ...(e.metadata ?? {}), ...(e.bounce_type ? { bounce_type: e.bounce_type } : {}) },
        });
        if (!created) return;
        applied += 1;
        if (e.type === 'complained') await addSuppression(tx, send.workspace_id, send.to_email, 'complained', `provider:${name}`);
        if (e.type === 'bounced' && e.bounce_type !== 'soft') await addSuppression(tx, send.workspace_id, send.to_email, 'bounced', `provider:${name}`);
      });
    }
    return { applied, unmatched };
  });
}
