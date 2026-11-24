import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authorize } from '../auth/index.js';
import type { Ctx } from '../context.js';
import { one, type Queryable } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { IdParams, parse } from '../lib/http.js';
import { contactContext, extractVariables, renderMessage } from '../lib/template.js';
import { BOOKING_TEMPLATES } from './bookingTemplates.js';
import { isPublicUrl, queueSend } from './sends/service.js';

export interface TemplateVersion {
  id: string;
  template_id: string;
  version: number;
  subject: string;
  html_body: string | null;
  text_body: string | null;
  from_name: string | null;
  reply_to: string | null;
  variables: string[];
}

const Content = z
  .object({
    subject: z.string().min(1).max(998),
    html_body: z.string().max(500_000).nullish(),
    text_body: z.string().max(200_000).nullish(),
    from_name: z.string().max(200).nullish(),
    reply_to: z.string().email().nullish(),
  })
  .refine((c) => c.html_body || c.text_body, 'Provide html_body and/or text_body');

/** Lowercase name the API can send by, e.g. "booking_request_host". */
export const Slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,62}$/, 'Use 2-63 lowercase letters, digits, - or _');

export async function getTemplateVersion(q: Queryable, workspaceId: string, versionId: string): Promise<TemplateVersion> {
  const v = await one<TemplateVersion>(q, `select * from template_versions where id = $1 and workspace_id = $2`, [versionId, workspaceId]);
  if (!v) throw notFound('Template version');
  return v;
}

type CurrentVersion = TemplateVersion & { kind: string; slug: string | null; sample_variables: Record<string, unknown> };

/** Latest version of a template, used when publishing automations / scheduling campaigns. */
export async function latestTemplateVersion(q: Queryable, workspaceId: string, templateId: string) {
  const v = await one<CurrentVersion>(
    q,
    `select v.*, t.kind, t.slug, t.sample_variables from templates t join template_versions v on v.template_id = t.id and v.version = t.current_version
     where t.id = $1 and t.workspace_id = $2 and t.archived_at is null`,
    [templateId, workspaceId],
  );
  if (!v) throw notFound(`Template ${templateId}`);
  return v;
}

/** Same, looked up by slug (what API callers use). */
export async function latestTemplateVersionBySlug(q: Queryable, workspaceId: string, slug: string) {
  const v = await one<CurrentVersion>(
    q,
    `select v.*, t.kind, t.slug, t.sample_variables from templates t join template_versions v on v.template_id = t.id and v.version = t.current_version
     where t.slug = $1 and t.workspace_id = $2 and t.archived_at is null`,
    [slug, workspaceId],
  );
  if (!v) throw notFound(`Template "${slug}"`);
  return v;
}

function slugConflict(err: unknown): never {
  if ((err as { code?: string }).code === '23505') throw conflict('slug_taken', 'Another template already uses that API name');
  throw err;
}

async function createVersion(q: Queryable, workspaceId: string, templateId: string, c: z.infer<typeof Content>, userId: string | null) {
  const t = await one<{ current_version: number }>(
    q,
    `update templates set current_version = current_version + 1, updated_at = now() where id = $1 and workspace_id = $2 returning current_version`,
    [templateId, workspaceId],
  );
  if (!t) throw notFound('Template');
  return one<TemplateVersion>(
    q,
    `insert into template_versions(template_id, workspace_id, version, subject, html_body, text_body, from_name, reply_to, variables, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
    [templateId, workspaceId, t.current_version, c.subject, c.html_body ?? null, c.text_body ?? null, c.from_name ?? null, c.reply_to ?? null,
      extractVariables(c.subject, c.html_body, c.text_body), userId],
  );
}

const SAMPLE_CONTACT = { email: 'jane@example.com', first_name: 'Jane', last_name: 'Doe', custom_fields: { company: 'Example Co' } };

export function templateRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/v1/templates', async (req) => {
    const a = authorize(req);
    const q = parse(z.object({ kind: z.enum(['transactional', 'marketing']).optional(), archived: z.enum(['true', 'false']).default('false') }), req.query);
    const r = await ctx.db.query(
      `select t.id, t.name, t.slug, t.kind, t.current_version, t.created_at, t.updated_at, t.archived_at, t.sample_variables, v.subject, v.variables
       from templates t left join template_versions v on v.template_id = t.id and v.version = t.current_version
       where t.workspace_id = $1 and ($2::text is null or t.kind = $2) and (t.archived_at is not null) = $3
       order by t.updated_at desc`,
      [a.workspaceId, q.kind ?? null, q.archived === 'true'],
    );
    return { data: r.rows };
  });

  app.post('/v1/templates', async (req, reply) => {
    const a = authorize(req, { role: 'member' });
    const body = parse(z.object({ name: z.string().min(1).max(200), kind: z.enum(['transactional', 'marketing']), slug: Slug.nullish() }).and(Content), req.body);
    const result = await ctx.db.tx(async (tx) => {
      const t = await one<{ id: string }>(
        tx, `insert into templates(workspace_id, name, kind, slug) values ($1, $2, $3, $4) returning id`, [a.workspaceId, body.name, body.kind, body.slug ?? null],
      ).catch(slugConflict);
      const v = await createVersion(tx, a.workspaceId, t!.id, body, a.userId);
      await audit(tx, a, 'template.created', { type: 'template', id: t!.id });
      return { id: t!.id, name: body.name, slug: body.slug ?? null, kind: body.kind, current_version: 1, version: v };
    });
    reply.code(201);
    return result;
  });

  app.get('/v1/templates/:id', async (req) => {
    const a = authorize(req);
    const { id } = parse(IdParams, req.params);
    const t = await one<any>(ctx.db, `select * from templates where id = $1 and workspace_id = $2`, [id, a.workspaceId]);
    if (!t) throw notFound('Template');
    const versions = await ctx.db.query(
      `select id, version, subject, created_at, created_by from template_versions where template_id = $1 order by version desc`,
      [id],
    );
    const current = await latestTemplateVersion(ctx.db, a.workspaceId, id).catch(() => null);
    return { ...t, current, versions: versions.rows };
  });

  /** Saving content always creates a new immutable version; published automations keep their pinned one. */
  app.put('/v1/templates/:id', async (req) => {
    const a = authorize(req, { role: 'member' });
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ name: z.string().min(1).max(200).optional(), slug: Slug.nullish() }).and(Content), req.body);
    return ctx.db.tx(async (tx) => {
      if (body.name) await tx.query(`update templates set name = $3 where id = $1 and workspace_id = $2`, [id, a.workspaceId, body.name]);
      if (body.slug !== undefined) {
        await tx.query(`update templates set slug = $3 where id = $1 and workspace_id = $2`, [id, a.workspaceId, body.slug]).catch(slugConflict);
      }
      const v = await createVersion(tx, a.workspaceId, id, body, a.userId);
      await audit(tx, a, 'template.version_created', { type: 'template', id }, { version: v!.version });
      return v;
    });
  });

  app.post('/v1/templates/:id/archive', async (req) => {
    const a = authorize(req, { role: 'member' });
    const { id } = parse(IdParams, req.params);
    const r = await ctx.db.query(`update templates set archived_at = now() where id = $1 and workspace_id = $2 returning id`, [id, a.workspaceId]);
    if (!r.rows[0]) throw notFound('Template');
    return { id, archived: true };
  });

  /** The booking email starter pack: what it contains and which templates are already installed. */
  app.get('/v1/templates/starter/booking', async (req) => {
    const a = authorize(req);
    const r = await ctx.db.query<{ id: string; slug: string }>(
      `select id, slug from templates where workspace_id = $1 and slug = any($2) and archived_at is null`,
      [a.workspaceId, BOOKING_TEMPLATES.map((t) => t.slug)],
    );
    const have = new Map(r.rows.map((t) => [t.slug, t.id]));
    return { data: BOOKING_TEMPLATES.map((t) => ({ slug: t.slug, name: t.name, when: t.when, template_id: have.get(t.slug) ?? null })) };
  });

  /** Installs any booking templates the workspace doesn't have yet (never overwrites edits). */
  app.post('/v1/templates/starter/booking', async (req, reply) => {
    const a = authorize(req, { role: 'member' });
    const created = await ctx.db.tx(async (tx) => {
      const out: string[] = [];
      for (const t of BOOKING_TEMPLATES) {
        const exists = await one(tx, `select id from templates where workspace_id = $1 and slug = $2 and archived_at is null`, [a.workspaceId, t.slug]);
        if (exists) continue;
        const row = await one<{ id: string }>(
          tx,
          `insert into templates(workspace_id, name, kind, slug, sample_variables) values ($1, $2, 'transactional', $3, $4) returning id`,
          [a.workspaceId, t.name, t.slug, JSON.stringify(t.sample_variables)],
        );
        await createVersion(tx, a.workspaceId, row!.id, { subject: t.subject, html_body: t.html_body, text_body: t.text_body, from_name: null, reply_to: null }, a.userId);
        out.push(t.slug);
      }
      if (out.length) await audit(tx, a, 'template.starter_installed', undefined, { pack: 'booking', slugs: out });
      return out;
    });
    reply.code(created.length ? 201 : 200);
    return { created, skipped: BOOKING_TEMPLATES.map((t) => t.slug).filter((x) => !created.includes(x)) };
  });

  /** Render with sample or real contact data, without sending. */
  app.post('/v1/templates/:id/preview', async (req) => {
    const a = authorize(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ contact_id: z.string().uuid().optional(), variables: z.record(z.string(), z.unknown()).optional() }), req.body);
    const v = await latestTemplateVersion(ctx.db, a.workspaceId, id);
    let contact: any = SAMPLE_CONTACT;
    if (body.contact_id) {
      contact = await one(ctx.db, `select * from contacts where id = $1 and workspace_id = $2`, [body.contact_id, a.workspaceId]);
      if (!contact) throw notFound('Contact');
    }
    const preview = v.kind !== 'marketing' ? {}
      : isPublicUrl(ctx.config.API_BASE_URL) ? { unsubscribeUrl: `${ctx.config.API_BASE_URL}/u/preview` }
      : { unsubscribeMailto: 'mailto:your-mailbox?subject=unsubscribe' };
    const rendered = renderMessage(v, { ...contactContext(contact), ...v.sample_variables, ...(body.variables ?? {}) }, { ...preview, footer: ctx.config.UNSUBSCRIBE_FOOTER });
    return { version: v.version, ...rendered };
  });

  /** Send a test of the current version to an arbitrary address (marked kind=test, excluded from metrics). */
  app.post('/v1/templates/:id/test', async (req, reply) => {
    const a = authorize(req, { role: 'member' });
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ to: z.string().email(), mailbox_id: z.string().uuid(), variables: z.record(z.string(), z.unknown()).optional() }), req.body);
    const v = await latestTemplateVersion(ctx.db, a.workspaceId, id);
    const send = await ctx.db.tx((tx) =>
      queueSend(ctx, tx, {
        workspaceId: a.workspaceId,
        kind: 'test',
        sourceType: 'test',
        sourceId: id,
        mailboxId: body.mailbox_id,
        toEmail: body.to,
        templateVersionId: v.id,
        variables: { ...contactContext(SAMPLE_CONTACT), ...v.sample_variables, ...(body.variables ?? {}) },
        idempotencyKey: `test:${id}:${Date.now()}`,
      }),
    );
    if (!send) throw badRequest('not_queued', 'Test send could not be queued');
    reply.code(202);
    return send;
  });
}
