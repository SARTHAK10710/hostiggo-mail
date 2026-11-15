import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authorize } from '../../auth/index.js';
import type { Ctx } from '../../context.js';
import { one, type Queryable } from '../../db/index.js';
import { notFound } from '../../lib/errors.js';
import { IdParams, parse } from '../../lib/http.js';

/**
 * Data-subject tools (GDPR/DPDP): export everything held about one address, and erase it.
 * Soft-deleting a contact (the normal dashboard "delete") keeps the row so history stays consistent;
 * erase removes the personal data itself.
 */
export function privacyRoutes(app: FastifyInstance, ctx: Ctx) {
  async function findContact(q: Queryable, workspaceId: string, id: string) {
    const c = await one<any>(q, `select * from contacts where id = $1 and workspace_id = $2`, [id, workspaceId]);
    if (!c) throw notFound('Contact');
    return c;
  }

  app.get('/v1/contacts/:id/export', async (req, reply) => {
    const a = authorize(req, { role: 'admin' });
    const { id } = parse(IdParams, req.params);
    const contact = await findContact(ctx.db, a.workspaceId, id);
    const w = a.workspaceId;
    const [lists, suppressions, sends, events, enrollments, productEvents, inbound, imports] = await Promise.all([
      ctx.db.query(`select l.name, lm.added_at, lm.source from list_memberships lm join contact_lists l on l.id = lm.list_id where lm.contact_id = $1 and lm.workspace_id = $2`, [id, w]),
      ctx.db.query(`select reason, source, created_at from suppressions where workspace_id = $1 and email = $2`, [w, contact.email]),
      ctx.db.query(`select id, kind, source_type, subject, status, requested_at, accepted_at, error_code from sends where contact_id = $1 and workspace_id = $2 order by requested_at`, [id, w]),
      ctx.db.query(`select type, source, occurred_at, send_id from email_events where contact_id = $1 and workspace_id = $2 order by occurred_at`, [id, w]),
      ctx.db.query(`select e.id, a.name as automation, e.state, e.exit_reason, e.entered_at, e.finished_at from enrollments e join automations a on a.id = e.automation_id where e.contact_id = $1 and e.workspace_id = $2`, [id, w]),
      ctx.db.query(`select name, properties, received_at from product_events where contact_id = $1 and workspace_id = $2 order by received_at`, [id, w]),
      ctx.db.query(`select classification, received_at from inbound_messages where workspace_id = $1 and from_email = $2 order by received_at`, [w, contact.email]),
      ctx.db.query(
        `select i.filename, r.row_number, r.raw from contact_import_rows r join contact_imports i on i.id = r.import_id where i.workspace_id = $1 and r.email = $2`,
        [w, contact.email],
      ),
    ]);
    await audit(ctx.db, a, 'contact.exported', { type: 'contact', id });
    reply.header('content-disposition', `attachment; filename="contact-${id}.json"`);
    return {
      exported_at: ctx.clock.now().toISOString(),
      contact: {
        id: contact.id, email: contact.email, first_name: contact.first_name, last_name: contact.last_name, custom_fields: contact.custom_fields,
        consent_status: contact.consent_status, consent_source: contact.consent_source, consent_at: contact.consent_at,
        import_source: contact.import_source, created_at: contact.created_at, deleted_at: contact.deleted_at,
      },
      lists: lists.rows,
      suppressions: suppressions.rows,
      sends: sends.rows,
      events: events.rows,
      enrollments: enrollments.rows,
      product_events: productEvents.rows,
      inbound_messages: inbound.rows,
      import_rows: imports.rows,
    };
  });

  /**
   * Permanently erases the contact and everything that identifies them. By default the address is kept on the
   * suppression list (as a bare email, so we never mail someone who opted out again); pass
   * `suppressions=erase` to remove that too when the person explicitly asks.
   */
  app.delete('/v1/contacts/:id/erase', async (req, reply) => {
    const a = authorize(req, { role: 'admin' });
    const { id } = parse(IdParams, req.params);
    const q = parse(z.object({ suppressions: z.enum(['keep', 'erase']).default('keep') }), req.query);
    await ctx.db.tx(async (tx) => {
      const contact = await findContact(tx, a.workspaceId, id);
      const w = a.workspaceId;
      await tx.query(`delete from email_events where workspace_id = $1 and contact_id = $2`, [w, id]);
      await tx.query(`delete from sends where workspace_id = $1 and (contact_id = $2 or to_email = $3)`, [w, id, contact.email]);
      await tx.query(`delete from enrollments where workspace_id = $1 and contact_id = $2`, [w, id]);
      await tx.query(`delete from product_events where workspace_id = $1 and contact_id = $2`, [w, id]);
      await tx.query(`delete from inbound_messages where workspace_id = $1 and from_email = $2`, [w, contact.email]);
      await tx.query(
        `delete from contact_import_rows r using contact_imports i where i.id = r.import_id and i.workspace_id = $1 and (r.email = $2 or r.contact_id = $3)`,
        [w, contact.email, id],
      );
      if (q.suppressions === 'erase') await tx.query(`delete from suppressions where workspace_id = $1 and email = $2`, [w, contact.email]);
      await tx.query(`delete from contacts where id = $1 and workspace_id = $2`, [id, w]); // list_memberships cascade
      // The audit entry deliberately holds no email address.
      await audit(tx, a, 'contact.erased', { type: 'contact', id }, { suppressions: q.suppressions });
    });
    reply.code(204);
  });
}
