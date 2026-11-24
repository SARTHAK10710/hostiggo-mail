import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authorize } from '../../auth/index.js';
import type { Ctx } from '../../context.js';
import { one } from '../../db/index.js';
import { normalizeEmail } from '../../lib/email.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { IdParams, Pagination, parse } from '../../lib/http.js';
import { addToLists, softDeleteContact, upsertContact } from './service.js';

const ContactBody = z.object({
  email: z.string().min(3).max(254),
  first_name: z.string().max(200).nullish(),
  last_name: z.string().max(200).nullish(),
  custom_fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  consent_status: z.enum(['opted_in', 'unknown']).optional(),
  consent_source: z.string().max(200).nullish(),
  consent_at: z.string().datetime().nullish(),
  list_ids: z.array(z.string().uuid()).max(50).optional(),
});

const CONTACT_COLS = `c.id, c.email, c.first_name, c.last_name, c.custom_fields, c.consent_status, c.consent_source, c.consent_at,
  c.import_source, c.created_at, c.updated_at,
  coalesce((select array_agg(s.reason order by s.reason) from suppressions s where s.workspace_id = c.workspace_id and s.email = c.email), '{}') as suppressions`;

export function contactRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/v1/contacts', async (req) => {
    const a = authorize(req, { scope: 'contacts:read' });
    const q = parse(
      Pagination.extend({
        search: z.string().max(200).optional(),
        list_id: z.string().uuid().optional(),
        consent_status: z.enum(['opted_in', 'unknown', 'opted_out']).optional(),
        suppressed: z.enum(['true', 'false']).optional(),
      }),
      req.query,
    );
    const where = [`c.workspace_id = $1`, `c.deleted_at is null`];
    const params: unknown[] = [a.workspaceId];
    if (q.search) {
      params.push(`%${q.search.toLowerCase()}%`);
      where.push(`(c.email like $${params.length} or lower(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) like $${params.length})`);
    }
    if (q.list_id) {
      params.push(q.list_id);
      where.push(`exists (select 1 from list_memberships lm where lm.contact_id = c.id and lm.list_id = $${params.length})`);
    }
    if (q.consent_status) {
      params.push(q.consent_status);
      where.push(`c.consent_status = $${params.length}`);
    }
    if (q.suppressed) {
      where.push(`${q.suppressed === 'true' ? '' : 'not '}exists (select 1 from suppressions s where s.workspace_id = c.workspace_id and s.email = c.email)`);
    }
    const total = await one<{ n: number }>(ctx.db, `select count(*)::int as n from contacts c where ${where.join(' and ')}`, params);
    params.push(q.limit, q.offset);
    const r = await ctx.db.query(
      `select ${CONTACT_COLS} from contacts c where ${where.join(' and ')}
       order by c.created_at desc limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return { data: r.rows, total: total?.n ?? 0 };
  });

  app.post('/v1/contacts', async (req, reply) => {
    const a = authorize(req, { role: 'member', scope: 'contacts:write' });
    const body = parse(ContactBody.extend({ on_duplicate: z.enum(['skip', 'update']).default('skip') }), req.body);
    const result = await ctx.db.tx(async (tx) => {
      const now = ctx.clock.now();
      const { contact, outcome } = await upsertContact(tx, a.workspaceId, body, {
        onDuplicate: body.on_duplicate,
        importSource: a.type === 'api_key' ? `api:${a.id}` : 'dashboard',
        now,
      });
      if (body.list_ids?.length) await addToLists(tx, a.workspaceId, contact.id, body.list_ids, a.type === 'api_key' ? 'api' : 'dashboard', now);
      if (outcome !== 'unchanged') await audit(tx, a, `contact.${outcome}`, { type: 'contact', id: contact.id });
      return { contact, outcome };
    });
    reply.code(result.outcome === 'created' ? 201 : 200);
    return { ...result.contact, outcome: result.outcome, duplicate: result.outcome !== 'created' };
  });

  /** Dashboard bulk actions: opt in (with a consent source), add to / remove from a list, delete. */
  app.post('/v1/contacts/bulk', async (req) => {
    const a = authorize(req, { role: 'member' });
    const body = parse(
      z.object({
        contact_ids: z.array(z.string().uuid()).min(1).max(1000),
        action: z.enum(['opt_in', 'add_to_list', 'remove_from_list', 'delete']),
        list_id: z.string().uuid().optional(),
        consent_source: z.string().min(1).max(200).optional(),
      }),
      req.body,
    );
    if (body.action === 'opt_in' && !body.consent_source?.trim()) throw badRequest('consent_source_required', 'consent_source is required when marking contacts as opted in');
    if ((body.action === 'add_to_list' || body.action === 'remove_from_list') && !body.list_id) throw badRequest('list_required', 'list_id is required');
    return ctx.db.tx(async (tx) => {
      const found = await tx.query<{ id: string; email: string }>(
        `select id, email from contacts where workspace_id = $1 and deleted_at is null and id = any($2)`,
        [a.workspaceId, body.contact_ids],
      );
      const now = ctx.clock.now();
      let processed = 0;
      let skipped = body.contact_ids.length - found.rows.length;
      if (body.action === 'remove_from_list') {
        const r = await tx.query(`delete from list_memberships where workspace_id = $1 and list_id = $2 and contact_id = any($3)`, [a.workspaceId, body.list_id, found.rows.map((c) => c.id)]);
        processed = r.rowCount;
        skipped += found.rows.length - processed;
      } else {
        for (const c of found.rows) {
          if (body.action === 'opt_in') {
            try {
              const { outcome } = await upsertContact(tx, a.workspaceId, { email: c.email, consent_status: 'opted_in', consent_source: body.consent_source }, { onDuplicate: 'update', now });
              if (outcome === 'unchanged') skipped += 1;
              else processed += 1;
            } catch (err) {
              // People who unsubscribed stay unsubscribed; everything else is a real error.
              if (err instanceof AppError && err.code === 'consent_conflict') skipped += 1;
              else throw err;
            }
          } else if (body.action === 'add_to_list') {
            const added = await addToLists(tx, a.workspaceId, c.id, [body.list_id!], 'dashboard', now);
            if (added) processed += 1;
            else skipped += 1;
          } else {
            await softDeleteContact(tx, a.workspaceId, c.id);
            processed += 1;
          }
        }
      }
      await audit(tx, a, `contact.bulk_${body.action}`, undefined, { requested: body.contact_ids.length, processed, skipped, list_id: body.list_id });
      return { action: body.action, requested: body.contact_ids.length, processed, skipped };
    });
  });

  app.get('/v1/contacts/:id', async (req) => {
    const a = authorize(req, { scope: 'contacts:read' });
    const { id } = parse(IdParams, req.params);
    const contact = await one(ctx.db, `select ${CONTACT_COLS} from contacts c where c.id = $1 and c.workspace_id = $2 and c.deleted_at is null`, [id, a.workspaceId]);
    if (!contact) throw notFound('Contact');
    const [lists, enrollments, sends] = await Promise.all([
      ctx.db.query(
        `select l.id, l.name, lm.added_at, lm.source from list_memberships lm join contact_lists l on l.id = lm.list_id
         where lm.contact_id = $1 and lm.workspace_id = $2 order by lm.added_at`,
        [id, a.workspaceId],
      ),
      ctx.db.query(
        `select e.id, e.automation_id, a.name as automation_name, e.state, e.current_position, e.next_run_at, e.exit_reason, e.entered_at, e.finished_at
         from enrollments e join automations a on a.id = e.automation_id where e.contact_id = $1 and e.workspace_id = $2 order by e.entered_at desc limit 50`,
        [id, a.workspaceId],
      ),
      ctx.db.query(
        `select id, kind, source_type, subject, status, error_code, requested_at, accepted_at from sends
         where contact_id = $1 and workspace_id = $2 order by requested_at desc limit 50`,
        [id, a.workspaceId],
      ),
    ]);
    return { ...contact, lists: lists.rows, enrollments: enrollments.rows, recent_sends: sends.rows };
  });

  app.patch('/v1/contacts/:id', async (req) => {
    const a = authorize(req, { role: 'member', scope: 'contacts:write' });
    const { id } = parse(IdParams, req.params);
    const body = parse(ContactBody.omit({ email: true, list_ids: true }), req.body);
    return ctx.db.tx(async (tx) => {
      const c = await one<{ email: string }>(tx, `select email from contacts where id = $1 and workspace_id = $2 and deleted_at is null`, [id, a.workspaceId]);
      if (!c) throw notFound('Contact');
      const { contact, outcome } = await upsertContact(tx, a.workspaceId, { ...body, email: c.email }, { onDuplicate: 'update', now: ctx.clock.now() });
      if (outcome !== 'unchanged') await audit(tx, a, 'contact.updated', { type: 'contact', id });
      return contact;
    });
  });

  app.delete('/v1/contacts/:id', async (req, reply) => {
    const a = authorize(req, { role: 'member', scope: 'contacts:write' });
    const { id } = parse(IdParams, req.params);
    await ctx.db.tx(async (tx) => {
      await softDeleteContact(tx, a.workspaceId, id);
      await audit(tx, a, 'contact.deleted', { type: 'contact', id });
    });
    reply.code(204);
  });

  // ── Lists ──────────────────────────────────────────────────────────
  app.get('/v1/lists', async (req) => {
    const a = authorize(req, { scope: 'contacts:read' });
    const r = await ctx.db.query(
      `select l.id, l.name, l.description, l.created_at,
         (select count(*)::int from list_memberships lm join contacts c on c.id = lm.contact_id
          where lm.list_id = l.id and c.deleted_at is null) as member_count
       from contact_lists l where l.workspace_id = $1 order by l.created_at`,
      [a.workspaceId],
    );
    return { data: r.rows };
  });

  app.post('/v1/lists', async (req, reply) => {
    const a = authorize(req, { role: 'member', scope: 'contacts:write' });
    const body = parse(z.object({ name: z.string().min(1).max(200), description: z.string().max(1000).nullish() }), req.body);
    const list = await ctx.db.tx(async (tx) => {
      const exists = await one(tx, `select 1 from contact_lists where workspace_id = $1 and name = $2`, [a.workspaceId, body.name]);
      if (exists) throw conflict('list_exists', 'A list with that name already exists');
      const list = await one<{ id: string }>(
        tx,
        `insert into contact_lists(workspace_id, name, description) values ($1, $2, $3) returning *`,
        [a.workspaceId, body.name, body.description ?? null],
      );
      await audit(tx, a, 'list.created', { type: 'list', id: list!.id });
      return list;
    });
    reply.code(201);
    return list;
  });

  app.patch('/v1/lists/:id', async (req) => {
    const a = authorize(req, { role: 'member' });
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ name: z.string().min(1).max(200).optional(), description: z.string().max(1000).nullish() }), req.body);
    const list = await one(
      ctx.db,
      `update contact_lists set name = coalesce($3, name), description = coalesce($4, description)
       where id = $1 and workspace_id = $2 returning *`,
      [id, a.workspaceId, body.name ?? null, body.description ?? null],
    );
    if (!list) throw notFound('List');
    return list;
  });

  app.delete('/v1/lists/:id', async (req, reply) => {
    const a = authorize(req, { role: 'admin' });
    const { id } = parse(IdParams, req.params);
    await ctx.db.tx(async (tx) => {
      const used = await one(
        tx,
        `select 1 from automations a join automation_versions v on v.id = a.current_version_id
         where a.workspace_id = $1 and a.status in ('active','paused') and v.definition->'trigger'->>'list_id' = $2`,
        [a.workspaceId, id],
      );
      if (used) throw conflict('list_in_use', 'This list triggers a live automation; archive it first');
      const r = await tx.query(`delete from contact_lists where id = $1 and workspace_id = $2`, [id, a.workspaceId]);
      if (r.rowCount === 0) throw notFound('List');
      await audit(tx, a, 'list.deleted', { type: 'list', id });
    });
    reply.code(204);
  });

  app.post('/v1/lists/:id/contacts', async (req) => {
    const a = authorize(req, { role: 'member', scope: 'contacts:write' });
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({ contact_ids: z.array(z.string().uuid()).max(1000).optional(), emails: z.array(z.string()).max(1000).optional() }),
      req.body,
    );
    return ctx.db.tx(async (tx) => {
      const ids = new Set(body.contact_ids ?? []);
      if (body.emails?.length) {
        const r = await tx.query<{ id: string }>(
          `select id from contacts where workspace_id = $1 and deleted_at is null and email = any($2)`,
          [a.workspaceId, body.emails.map(normalizeEmail)],
        );
        r.rows.forEach((row) => ids.add(row.id));
      }
      const valid = await tx.query<{ id: string }>(
        `select id from contacts where workspace_id = $1 and deleted_at is null and id = any($2)`,
        [a.workspaceId, [...ids]],
      );
      let added = 0;
      for (const row of valid.rows) added += await addToLists(tx, a.workspaceId, row.id, [id], a.type === 'api_key' ? 'api' : 'dashboard', ctx.clock.now());
      return { added, not_found: ids.size - valid.rows.length };
    });
  });

  app.delete('/v1/lists/:id/contacts/:contactId', async (req, reply) => {
    const a = authorize(req, { role: 'member', scope: 'contacts:write' });
    const p = parse(z.object({ id: z.string().uuid(), contactId: z.string().uuid() }), req.params);
    const r = await ctx.db.query(`delete from list_memberships where list_id = $1 and contact_id = $2 and workspace_id = $3`, [
      p.id,
      p.contactId,
      a.workspaceId,
    ]);
    if (r.rowCount === 0) throw notFound('List membership');
    reply.code(204);
  });
}
