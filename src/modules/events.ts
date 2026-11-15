import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authorize } from '../auth/index.js';
import type { Ctx } from '../context.js';
import { one } from '../db/index.js';
import { normalizeEmail } from '../lib/email.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/http.js';
import { fireTrigger } from './automations/triggers.js';
import { upsertContact } from './contacts/service.js';

/** POST /v1/events — authenticated product events that can trigger automations. */
export function eventRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/v1/events', async (req, reply) => {
    const a = authorize(req, { role: 'member', scope: 'events:write' });
    const body = parse(
      z
        .object({
          name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/, 'event names: letters, digits, _ . : -'),
          email: z.string().email().optional(),
          contact_id: z.string().uuid().optional(),
          properties: z.record(z.string(), z.unknown()).default({}),
          idempotency_key: z.string().min(1).max(200),
          /** Create the contact (consent unknown) if the email is new. */
          create_contact: z.boolean().default(false),
          first_name: z.string().max(200).optional(),
          last_name: z.string().max(200).optional(),
        })
        .refine((b) => b.email || b.contact_id, 'Provide email or contact_id'),
      req.body,
    );
    const result = await ctx.db.tx(async (tx) => {
      const now = ctx.clock.now();
      let contactId = body.contact_id ?? null;
      if (!contactId && body.email) {
        const email = normalizeEmail(body.email);
        const c = await one<{ id: string }>(tx, `select id from contacts where workspace_id = $1 and email = $2 and deleted_at is null`, [a.workspaceId, email]);
        if (c) contactId = c.id;
        else if (body.create_contact) {
          const { contact } = await upsertContact(tx, a.workspaceId, { email, first_name: body.first_name, last_name: body.last_name }, { onDuplicate: 'skip', importSource: `event:${body.name}`, now });
          contactId = contact.id;
        }
      } else if (contactId && !(await one(tx, `select 1 from contacts where id = $1 and workspace_id = $2`, [contactId, a.workspaceId]))) {
        throw notFound('Contact');
      }
      if (!contactId) throw badRequest('unknown_contact', 'No contact with that email; pass create_contact: true to create one');

      const ev = await one<{ id: string }>(
        tx,
        `insert into product_events(workspace_id, name, contact_id, properties, idempotency_key) values ($1, $2, $3, $4, $5)
         on conflict (workspace_id, idempotency_key) do nothing returning id`,
        [a.workspaceId, body.name, contactId, JSON.stringify(body.properties), body.idempotency_key],
      );
      if (!ev) return { duplicate: true, enrollments: [] as string[], contact_id: contactId };
      const enrollments = await fireTrigger(tx, a.workspaceId, { type: 'event', event_name: body.name }, contactId, `event:${ev.id}`, now);
      return { duplicate: false, event_id: ev.id, contact_id: contactId, enrollments };
    });
    reply.code(result.duplicate ? 200 : 202);
    return result;
  });
}
