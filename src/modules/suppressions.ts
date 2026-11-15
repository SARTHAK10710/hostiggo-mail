import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authorize } from '../auth/index.js';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db/index.js';
import { isValidEmail, normalizeEmail } from '../lib/email.js';
import { badRequest, notFound } from '../lib/errors.js';
import { Pagination, parse } from '../lib/http.js';

export type SuppressionReason = 'unsubscribed' | 'bounced' | 'complained' | 'manual';

/** Reasons that block *every* message, including transactional mail (the address is dead or complained). */
export const HARD_REASONS: SuppressionReason[] = ['bounced', 'complained'];

export async function suppressionReasons(q: Queryable, workspaceId: string, email: string): Promise<SuppressionReason[]> {
  const r = await q.query<{ reason: SuppressionReason }>(
    `select reason from suppressions where workspace_id = $1 and email = $2`,
    [workspaceId, normalizeEmail(email)],
  );
  return r.rows.map((x) => x.reason);
}

/**
 * Suppress an address workspace-wide. Side effects (in the same transaction):
 * contact consent -> opted_out for unsubscribes, active automation enrollments exit,
 * queued marketing sends to the address are cancelled.
 */
export async function addSuppression(
  q: Queryable,
  workspaceId: string,
  rawEmail: string,
  reason: SuppressionReason,
  source: string,
) {
  const email = normalizeEmail(rawEmail);
  const ins = await q.query(
    `insert into suppressions(workspace_id, email, reason, source) values ($1, $2, $3, $4)
     on conflict (workspace_id, email, reason) do nothing`,
    [workspaceId, email, reason, source],
  );
  if (reason === 'unsubscribed' || reason === 'complained') {
    await q.query(
      `update contacts set consent_status = 'opted_out', consent_source = $3, consent_at = now(), updated_at = now()
       where workspace_id = $1 and email = $2`,
      [workspaceId, email, `${reason}:${source}`],
    );
  }
  const hard = HARD_REASONS.includes(reason);
  // Bounces/complaints end every sequence; unsubscribes end marketing sequences only.
  await q.query(
    `update enrollments e set state = 'exited', exit_reason = $3, finished_at = now(), updated_at = now(), next_run_at = null
     from contacts c, automation_versions v
     where e.contact_id = c.id and v.id = e.version_id and c.workspace_id = $1 and c.email = $2
       and e.state = 'active' and e.workspace_id = $1
       and ($4 or v.definition->>'message_kind' = 'marketing')`,
    [workspaceId, email, reason, hard],
  );
  await q.query(
    `update sends set status = 'suppressed', error_code = $3, last_error = 'Recipient is suppressed', finished_at = now()
     where workspace_id = $1 and to_email = $2 and status = 'queued' and (kind = 'marketing' or $4)`,
    [workspaceId, email, `suppressed_${reason}`, hard],
  );
  return { email, reason, created: ins.rowCount > 0 };
}

export function suppressionRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/v1/suppressions', async (req) => {
    const a = authorize(req);
    const q = parse(Pagination.extend({ email: z.string().optional(), reason: z.string().optional() }), req.query);
    const r = await ctx.db.query(
      `select id, email, reason, source, created_at from suppressions
       where workspace_id = $1 and ($2::text is null or email = $2) and ($3::text is null or reason = $3)
       order by created_at desc limit $4 offset $5`,
      [a.workspaceId, q.email ? normalizeEmail(q.email) : null, q.reason ?? null, q.limit, q.offset],
    );
    return { data: r.rows };
  });

  app.post('/v1/suppressions', async (req, reply) => {
    const a = authorize(req, { role: 'member' });
    const body = parse(z.object({ email: z.string(), reason: z.enum(['unsubscribed', 'manual']).default('manual') }), req.body);
    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) throw badRequest('invalid_email', 'Invalid email address');
    const result = await ctx.db.tx(async (tx) => {
      const r = await addSuppression(tx, a.workspaceId, email, body.reason, `dashboard:${a.id}`);
      await audit(tx, a, 'suppression.added', { type: 'email', id: email }, { reason: body.reason });
      return r;
    });
    reply.code(201);
    return result;
  });

  // Removing a suppression is an explicit, audited admin action. Bounces/complaints should rarely be lifted.
  app.delete('/v1/suppressions/:id', async (req, reply) => {
    const a = authorize(req, { role: 'admin' });
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await ctx.db.tx(async (tx) => {
      const r = await tx.query<{ email: string; reason: string }>(
        `delete from suppressions where id = $1 and workspace_id = $2 returning email, reason`,
        [id, a.workspaceId],
      );
      if (!r.rows[0]) throw notFound('Suppression');
      await audit(tx, a, 'suppression.removed', { type: 'email', id: r.rows[0].email }, { reason: r.rows[0].reason });
    });
    reply.code(204);
  });
}
