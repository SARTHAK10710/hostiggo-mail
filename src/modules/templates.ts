import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authorize } from '../auth/index.js';
import type { Ctx } from '../context.js';
import { one, type Queryable } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { IdParams, parse } from '../lib/http.js';
import { contactContext, extractVariables, renderMessage } from '../lib/template.js';
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

export async function getTemplateVersion(q: Queryable, workspaceId: string, versionId: string): Promise<TemplateVersion> {
  const v = await one<TemplateVersion>(q, `select * from template_versions where id = $1 and workspace_id = $2`, [versionId, workspaceId]);
  if (!v) throw notFound('Template version');
  return v;
}

/** Latest version of a template, used when publishing automations / scheduling campaigns. */
export async function latestTemplateVersion(q: Queryable, workspaceId: string, templateId: string) {
  const v = await one<TemplateVersion & { kind: string }>(
    q,
    `select v.*, t.kind from templates t join template_versions v on v.template_id = t.id and v.version = t.current_version
     where t.id = $1 and t.workspace_id = $2 and t.archived_at is null`,
    [templateId, workspaceId],
  );
  if (!v) throw notFound(`Template ${templateId}`);
  return v;
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
      `select t.id, t.name, t.kind, t.current_version, t.created_at, t.updated_at, t.archived_at, v.subject, v.variables
       from templates t left join template_versions v on v.template_id = t.id and v.version = t.current_version
       where t.workspace_id = $1 and ($2::text is null or t.kind = $2) and (t.archived_at is not null) = $3
       order by t.updated_at desc`,
      [a.workspaceId, q.kind ?? null, q.archived === 'true'],
    );
    return { data: r.rows };
  });

  app.post('/v1/templates', async (req, reply) => {
    const a = authorize(req, { role: 'member' });
    const body = parse(z.object({ name: z.string().min(1).max(200), kind: z.enum(['transactional', 'marketing']) }).and(Content), req.body);
    const result = await ctx.db.tx(async (tx) => {
      const t = await one<{ id: string }>(tx, `insert into templates(workspace_id, name, kind) values ($1, $2, $3) returning id`, [a.workspaceId, body.name, body.kind]);
      const v = await createVersion(tx, a.workspaceId, t!.id, body, a.userId);
      await audit(tx, a, 'template.created', { type: 'template', id: t!.id });
      return { id: t!.id, name: body.name, kind: body.kind, current_version: 1, version: v };
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
    const body = parse(z.object({ name: z.string().min(1).max(200).optional() }).and(Content), req.body);
    return ctx.db.tx(async (tx) => {
      if (body.name) await tx.query(`update templates set name = $3 where id = $1 and workspace_id = $2`, [id, a.workspaceId, body.name]);
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
    const rendered = renderMessage(v, { ...contactContext(contact), ...(body.variables ?? {}) }, { ...preview, footer: ctx.config.UNSUBSCRIBE_FOOTER });
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
        variables: { ...contactContext(SAMPLE_CONTACT), ...(body.variables ?? {}) },
        idempotencyKey: `test:${id}:${Date.now()}`,
      }),
    );
    if (!send) throw badRequest('not_queued', 'Test send could not be queued');
    reply.code(202);
    return send;
  });
}
