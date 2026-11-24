import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authorize, type Actor } from '../../auth/index.js';
import type { Ctx } from '../../context.js';
import { one, type Tx } from '../../db/index.js';
import { enqueue } from '../../jobs/queue.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { IdParams, Pagination, parse } from '../../lib/http.js';
import { contactContext } from '../../lib/template.js';
import { queueSend } from '../sends/service.js';
import { latestTemplateVersion } from '../templates.js';
import { DefinitionSchema, type Definition } from './definition.js';
import { fireTrigger } from './triggers.js';

async function load(tx: { query: Tx['query'] }, workspaceId: string, id: string) {
  const a = await one<any>(tx, `select * from automations where id = $1 and workspace_id = $2`, [id, workspaceId]);
  if (!a) throw notFound('Automation');
  return a;
}

/** Strict validation run at publish time. Returns the pinned template versions per email step. */
async function validateForPublish(tx: Tx, workspaceId: string, d: Definition) {
  const problems: string[] = [];
  if (!d.trigger) problems.push('Choose a trigger');
  if (d.trigger?.type === 'list_joined' && !(await one(tx, `select 1 from contact_lists where id = $1 and workspace_id = $2`, [d.trigger.list_id, workspaceId]))) {
    problems.push('Trigger list does not exist');
  }
  if (!d.mailbox_id) problems.push('Choose a sending mailbox');
  else {
    const m = await one<{ status: string }>(tx, `select status from mailbox_connections where id = $1 and workspace_id = $2`, [d.mailbox_id, workspaceId]);
    if (!m) problems.push('Mailbox not found');
    else if (m.status !== 'active') problems.push(`Mailbox is ${m.status}; reconnect it first`);
  }
  if (!d.steps.some((s) => s.type === 'email')) problems.push('Add at least one email step');
  const pinned = new Map<string, string>();
  for (const s of d.steps) {
    if (s.type !== 'email') continue;
    try {
      const v = await latestTemplateVersion(tx, workspaceId, s.template_id);
      if (v.kind !== d.message_kind) problems.push(`Step ${s.id}: ${v.kind} template used in a ${d.message_kind} automation`);
      pinned.set(s.id, v.id);
    } catch {
      problems.push(`Step ${s.id}: template not found or archived`);
    }
  }
  if (problems.length) throw badRequest('automation_invalid', 'Automation cannot be published yet', problems);
  return pinned;
}

async function setStatus(ctx: Ctx, a: Actor, id: string, from: string[], to: string) {
  return ctx.db.tx(async (tx) => {
    const auto = await load(tx, a.workspaceId, id);
    if (!from.includes(auto.status)) throw conflict('invalid_state', `Cannot change a ${auto.status} automation to ${to}`);
    await tx.query(`update automations set status = $2, updated_at = now() where id = $1`, [id, to]);
    await audit(tx, a, `automation.${to}`, { type: 'automation', id });
    return auto;
  });
}

export function automationRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/v1/automations', async (req) => {
    const a = authorize(req);
    const r = await ctx.db.query(
      `select a.id, a.name, a.status, a.created_at, a.updated_at, v.version as published_version, v.published_at,
         a.draft_definition->'trigger' as trigger,
         (select count(*)::int from enrollments e where e.automation_id = a.id and e.state = 'active') as active_enrollments,
         (select count(*)::int from enrollments e where e.automation_id = a.id) as total_enrollments
       from automations a left join automation_versions v on v.id = a.current_version_id
       where a.workspace_id = $1 and a.status <> 'archived' order by a.updated_at desc`,
      [a.workspaceId],
    );
    return { data: r.rows };
  });

  const createOrUpdate = async (a: Actor, body: { id?: string; name?: string; definition?: unknown }) => {
    const definition = DefinitionSchema.parse(body.definition ?? {});
    return ctx.db.tx(async (tx) => {
      if (body.id) {
        const auto = await load(tx, a.workspaceId, body.id);
        if (auto.status === 'archived') throw conflict('archived', 'Archived automations cannot be edited');
        const row = await one(
          tx,
          `update automations set name = coalesce($2, name), draft_definition = $3, updated_at = now() where id = $1 returning *`,
          [body.id, body.name ?? null, JSON.stringify(definition)],
        );
        await audit(tx, a, 'automation.draft_saved', { type: 'automation', id: body.id });
        return row;
      }
      if (!body.name) throw badRequest('name_required', 'name is required');
      const row = await one<any>(
        tx,
        `insert into automations(workspace_id, name, draft_definition) values ($1, $2, $3) returning *`,
        [a.workspaceId, body.name, JSON.stringify(definition)],
      );
      await audit(tx, a, 'automation.created', { type: 'automation', id: row.id });
      return row;
    });
  };

  const DraftBody = z.object({ name: z.string().min(1).max(200).optional(), definition: z.unknown().optional() });

  /** Create a draft, or update one when `id` is supplied (guide: POST /v1/automations). */
  app.post('/v1/automations', async (req, reply) => {
    const a = authorize(req, { role: 'member' });
    const body = parse(DraftBody.extend({ id: z.string().uuid().optional() }), req.body);
    const defCheck = DefinitionSchema.safeParse(body.definition ?? {});
    if (!defCheck.success) throw badRequest('validation_error', 'Invalid automation definition', defCheck.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const row = await createOrUpdate(a, body);
    reply.code(body.id ? 200 : 201);
    return row;
  });

  app.put('/v1/automations/:id', async (req) => {
    const a = authorize(req, { role: 'member' });
    const { id } = parse(IdParams, req.params);
    const body = parse(DraftBody, req.body);
    const defCheck = DefinitionSchema.safeParse(body.definition ?? {});
    if (!defCheck.success) throw badRequest('validation_error', 'Invalid automation definition', defCheck.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    return createOrUpdate(a, { ...body, id });
  });

  app.get('/v1/automations/:id', async (req) => {
    const a = authorize(req);
    const { id } = parse(IdParams, req.params);
    const auto = await load(ctx.db, a.workspaceId, id);
    const versions = await ctx.db.query(
      `select id, version, published_at, published_by from automation_versions where automation_id = $1 order by version desc`,
      [id],
    );
    let published = null;
    if (auto.current_version_id) {
      const v = await one<any>(ctx.db, `select * from automation_versions where id = $1`, [auto.current_version_id]);
      const steps = await ctx.db.query(
        `select step_key, position, type, config, template_version_id from automation_steps where version_id = $1 order by position`,
        [auto.current_version_id],
      );
      published = { ...v, steps: steps.rows };
    }
    const hasUnpublishedChanges = published ? JSON.stringify(stripPinned(published.definition)) !== JSON.stringify(auto.draft_definition) : true;
    return { ...auto, published, versions: versions.rows, has_unpublished_changes: hasUnpublishedChanges };
  });

  /** Validate and freeze the draft into a new immutable version. Existing enrollments stay on their version. */
  app.post('/v1/automations/:id/publish', async (req) => {
    const a = authorize(req, { role: 'member' });
    const { id } = parse(IdParams, req.params);
    const opts = parse(z.object({ enroll_existing: z.boolean().default(false) }), req.body ?? {});
    return ctx.db.tx(async (tx) => {
      const auto = await load(tx, a.workspaceId, id);
      if (auto.status === 'archived') throw conflict('archived', 'Archived automations cannot be published');
      const d = DefinitionSchema.parse(auto.draft_definition);
      const pinned = await validateForPublish(tx, a.workspaceId, d);
      const next = await one<{ n: number }>(tx, `select coalesce(max(version), 0)::int + 1 as n from automation_versions where automation_id = $1`, [id]);
      const definition = { ...d, steps: d.steps.map((s) => (s.type === 'email' ? { ...s, template_version_id: pinned.get(s.id) } : s)) };
      const v = await one<{ id: string; version: number }>(
        tx,
        `insert into automation_versions(automation_id, workspace_id, version, definition, published_by) values ($1, $2, $3, $4, $5) returning id, version`,
        [id, a.workspaceId, next!.n, JSON.stringify(definition), a.userId],
      );
      for (const [position, s] of d.steps.entries()) {
        await tx.query(
          `insert into automation_steps(version_id, workspace_id, step_key, position, type, config, template_version_id) values ($1, $2, $3, $4, $5, $6, $7)`,
          [v!.id, a.workspaceId, s.id, position, s.type, JSON.stringify(s), s.type === 'email' ? pinned.get(s.id) : null],
        );
      }
      const status = auto.status === 'paused' ? 'paused' : 'active';
      await tx.query(`update automations set current_version_id = $2, status = $3, updated_at = now() where id = $1`, [id, v!.id, status]);
      // Optionally enroll people who were already in the trigger list before this was published.
      let enrolled_existing = 0;
      if (opts.enroll_existing && status === 'active' && d.trigger?.type === 'list_joined') {
        const members = await tx.query<{ contact_id: string }>(
          `select lm.contact_id from list_memberships lm join contacts c on c.id = lm.contact_id
           where lm.list_id = $1 and lm.workspace_id = $2 and c.deleted_at is null order by lm.added_at`,
          [d.trigger.list_id, a.workspaceId],
        );
        const now = ctx.clock.now();
        for (const m of members.rows) {
          const created = await fireTrigger(tx, a.workspaceId, { type: 'list_joined', list_id: d.trigger.list_id }, m.contact_id,
            `list:${d.trigger.list_id}:${m.contact_id}:existing:${v!.id}`, now, { onlyAutomationId: id });
          enrolled_existing += created.length;
        }
      }
      await audit(tx, a, 'automation.published', { type: 'automation', id }, { version: v!.version, enrolled_existing });
      return { id, status, version: v!.version, version_id: v!.id, enrolled_existing };
    });
  });

  app.post('/v1/automations/:id/pause', async (req) => {
    const a = authorize(req, { role: 'member' });
    const { id } = parse(IdParams, req.params);
    await setStatus(ctx, a, id, ['active'], 'paused');
    return { id, status: 'paused' };
  });

  /** Resume continues where each contact stopped; completed sends are never replayed. */
  app.post('/v1/automations/:id/resume', async (req) => {
    const a = authorize(req, { role: 'member' });
    const { id } = parse(IdParams, req.params);
    const now = ctx.clock.now();
    await ctx.db.tx(async (tx) => {
      const auto = await load(tx, a.workspaceId, id);
      if (auto.status !== 'paused') throw conflict('invalid_state', `Automation is ${auto.status}`);
      await tx.query(`update automations set status = 'active', updated_at = now() where id = $1`, [id]);
      const due = await tx.query<{ id: string; next_run_at: Date | null }>(
        `select id, next_run_at from enrollments where automation_id = $1 and state = 'active'`,
        [id],
      );
      for (const e of due.rows) {
        const runAt = e.next_run_at && new Date(e.next_run_at) > now ? new Date(e.next_run_at) : now;
        await enqueue(tx, 'enrollment.run', { enrollmentId: e.id }, { runAt, uniqueKey: `enr:${e.id}` });
      }
      const held = await tx.query<{ id: string }>(
        `select id from sends where source_type = 'automation' and source_id = $1 and status = 'queued' and error_code = 'automation_paused'`,
        [id],
      );
      for (const s of held.rows) await enqueue(tx, 'send.process', { sendId: s.id }, { runAt: now, uniqueKey: `send:${s.id}`, maxAttempts: 3 });
      await audit(tx, a, 'automation.resumed', { type: 'automation', id }, { enrollments: due.rows.length });
    });
    return { id, status: 'active' };
  });

  /** Stop: everyone exits, queued sends are cancelled. Irreversible (publish a copy to restart). */
  app.post('/v1/automations/:id/archive', async (req) => {
    const a = authorize(req, { role: 'member' });
    const { id } = parse(IdParams, req.params);
    return ctx.db.tx(async (tx) => {
      const auto = await load(tx, a.workspaceId, id);
      if (auto.status === 'archived') return { id, status: 'archived' };
      await tx.query(`update automations set status = 'archived', updated_at = now() where id = $1`, [id]);
      const exited = await tx.query(
        `update enrollments set state = 'exited', exit_reason = 'automation_archived', next_run_at = null, finished_at = now(), updated_at = now()
         where automation_id = $1 and state = 'active'`,
        [id],
      );
      const cancelled = await tx.query(
        `update sends set status = 'cancelled', error_code = 'automation_archived', last_error = 'Automation was archived', finished_at = now()
         where source_type = 'automation' and source_id = $1 and status = 'queued'`,
        [id],
      );
      await audit(tx, a, 'automation.archived', { type: 'automation', id }, { exited: exited.rowCount, cancelled_sends: cancelled.rowCount });
      return { id, status: 'archived', exited_enrollments: exited.rowCount, cancelled_sends: cancelled.rowCount };
    });
  });

  /** Send every email step of the current draft to a test address now (kind=test, not counted in metrics). */
  app.post('/v1/automations/:id/test', async (req, reply) => {
    const a = authorize(req, { role: 'member' });
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ to: z.string().email(), contact_id: z.string().uuid().optional() }), req.body);
    const auto = await load(ctx.db, a.workspaceId, id);
    const d = DefinitionSchema.parse(auto.draft_definition);
    if (!d.mailbox_id) throw badRequest('mailbox_required', 'Choose a mailbox first');
    const contact = body.contact_id
      ? await one<any>(ctx.db, `select * from contacts where id = $1 and workspace_id = $2`, [body.contact_id, a.workspaceId])
      : { email: body.to, first_name: 'Test', last_name: 'Recipient', custom_fields: {} };
    if (!contact) throw notFound('Contact');
    const stamp = Date.now();
    const sends = await ctx.db.tx(async (tx) => {
      const out = [];
      for (const s of d.steps) {
        if (s.type !== 'email') continue;
        const v = await latestTemplateVersion(tx, a.workspaceId, s.template_id);
        const send = await queueSend(ctx, tx, {
          workspaceId: a.workspaceId,
          kind: 'test',
          sourceType: 'test',
          sourceId: id,
          stepKey: s.id,
          mailboxId: d.mailbox_id!,
          toEmail: body.to,
          templateVersionId: v.id,
          variables: contactContext(contact),
          idempotencyKey: `automation-test:${id}:${s.id}:${stamp}`,
        });
        out.push({ step_id: s.id, send_id: send.id });
      }
      return out;
    });
    reply.code(202);
    return { sends };
  });

  app.get('/v1/automations/:id/enrollments', async (req) => {
    const a = authorize(req);
    const { id } = parse(IdParams, req.params);
    const q = parse(Pagination.extend({ state: z.enum(['active', 'completed', 'exited']).optional() }), req.query);
    await load(ctx.db, a.workspaceId, id);
    const r = await ctx.db.query(
      `select e.id, e.contact_id, c.email, e.state, e.current_position, e.next_run_at, e.exit_reason, e.entered_at, e.finished_at, v.version
       from enrollments e join contacts c on c.id = e.contact_id join automation_versions v on v.id = e.version_id
       where e.automation_id = $1 and e.workspace_id = $2 and ($3::text is null or e.state = $3)
       order by e.entered_at desc limit $4 offset $5`,
      [id, a.workspaceId, q.state ?? null, q.limit, q.offset],
    );
    return { data: r.rows };
  });
}

function stripPinned(def: any) {
  return { ...def, steps: (def.steps ?? []).map(({ template_version_id: _t, ...s }: any) => s) };
}
