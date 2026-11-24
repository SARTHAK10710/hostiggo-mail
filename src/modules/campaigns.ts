import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, authorize } from '../auth/index.js';
import type { Ctx } from '../context.js';
import { one, type Queryable } from '../db/index.js';
import { enqueue } from '../jobs/queue.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { IdParams, parse } from '../lib/http.js';
import { contactContext } from '../lib/template.js';
import { effectiveDailyLimit, marketingShare, sentInLast24h } from './mailboxes/service.js';
import { queueSend } from './sends/service.js';
import { latestTemplateVersion } from './templates.js';

/**
 * Marketing campaigns (guide §1 / §2): small, permission-based audiences with an explicit
 * send review. Large sends belong on an ESP adapter; Gmail campaigns are capped.
 */
async function load(q: Queryable, workspaceId: string, id: string) {
  const c = await one<any>(q, `select * from campaigns where id = $1 and workspace_id = $2`, [id, workspaceId]);
  if (!c) throw notFound('Campaign');
  return c;
}

const AUDIENCE_SQL = `
  select c.id, c.email, c.consent_status,
    exists (select 1 from suppressions s where s.workspace_id = c.workspace_id and s.email = c.email) as suppressed
  from list_memberships lm join contacts c on c.id = lm.contact_id
  where lm.list_id = $1 and lm.workspace_id = $2 and c.deleted_at is null`;

export async function reviewCampaign(ctx: Ctx, q: Queryable, campaign: any) {
  const problems: string[] = [];
  if (!campaign.template_id) problems.push('Choose a template');
  if (!campaign.list_id) problems.push('Choose an audience list');
  if (!campaign.mailbox_id) problems.push('Choose a sending mailbox');
  let template = null;
  if (campaign.template_id) {
    template = await latestTemplateVersion(q, campaign.workspace_id, campaign.template_id).catch(() => null);
    if (!template) problems.push('Template not found');
    else if (template.kind !== 'marketing') problems.push('Campaigns must use a marketing template');
  }
  let mailbox: any = null;
  if (campaign.mailbox_id) {
    mailbox = await one(q, `select id, email, status, health, daily_send_limit, warmup_started_at from mailbox_connections where id = $1 and workspace_id = $2`, [campaign.mailbox_id, campaign.workspace_id]);
    if (!mailbox) problems.push('Mailbox not found');
    else if (mailbox.status !== 'active') problems.push(`Mailbox is ${mailbox.status}`);
    else if (mailbox.health !== 'healthy') problems.push('Mailbox is marked unhealthy (high bounce/complaint rate)');
  }
  const audience = campaign.list_id ? (await q.query<{ id: string; consent_status: string; suppressed: boolean }>(AUDIENCE_SQL, [campaign.list_id, campaign.workspace_id])).rows : [];
  const counts = {
    in_list: audience.length,
    suppressed: audience.filter((c) => c.suppressed).length,
    not_opted_in: audience.filter((c) => !c.suppressed && c.consent_status !== 'opted_in').length,
    eligible: audience.filter((c) => !c.suppressed && c.consent_status === 'opted_in').length,
  };
  const warnings: string[] = [];
  if (counts.eligible === 0 && campaign.list_id) problems.push('No eligible (opted-in, unsuppressed) recipients');
  if (counts.eligible > ctx.config.GMAIL_MAX_CAMPAIGN_RECIPIENTS) {
    problems.push(`Gmail campaigns are capped at ${ctx.config.GMAIL_MAX_CAMPAIGN_RECIPIENTS} recipients; use an ESP adapter for larger sends`);
  }
  let capacity = null;
  if (mailbox) {
    const used = await sentInLast24h(q, mailbox.id, ctx.clock.now());
    const dayLimit = effectiveDailyLimit(mailbox, ctx.clock.now());
    // A campaign only gets the marketing share; the rest stays free for booking emails.
    const limit = marketingShare(ctx, dayLimit);
    capacity = {
      daily_limit: limit, configured_limit: mailbox.daily_send_limit, warming_up: dayLimit < mailbox.daily_send_limit,
      reserved_for_transactional: dayLimit - limit, used_last_24h: used, remaining: Math.max(0, limit - used),
    };
    if (counts.eligible > capacity.remaining) {
      warnings.push(`Only ${capacity.remaining} sends remain in this mailbox's 24h window; the rest will be spread over the following day(s).`);
    }
  }
  return {
    ready: problems.length === 0,
    problems,
    warnings,
    audience: counts,
    capacity,
    template: template ? { id: template.template_id, version: template.version, version_id: template.id, subject: template.subject } : null,
    mailbox: mailbox ? { id: mailbox.id, email: mailbox.email } : null,
  };
}

/** Job: create one send per eligible recipient (idempotent per campaign+contact). */
export async function dispatchCampaign(ctx: Ctx, campaignId: string) {
  await ctx.db.tx(async (tx) => {
    const c = await one<any>(tx, `select * from campaigns where id = $1 for update`, [campaignId]);
    if (!c || !['scheduled', 'sending'].includes(c.status)) return;
    await tx.query(`update campaigns set status = 'sending', updated_at = now() where id = $1`, [campaignId]);
    const audience = (await tx.query<any>(AUDIENCE_SQL, [c.list_id, c.workspace_id])).rows.filter((r) => !r.suppressed && r.consent_status === 'opted_in');
    for (const r of audience) {
      const contact = await one<any>(tx, `select * from contacts where id = $1`, [r.id]);
      await queueSend(ctx, tx, {
        workspaceId: c.workspace_id,
        kind: 'marketing',
        sourceType: 'campaign',
        sourceId: c.id,
        mailboxId: c.mailbox_id,
        contactId: r.id,
        toEmail: r.email,
        templateVersionId: c.template_version_id,
        variables: contactContext(contact),
        idempotencyKey: `camp:${c.id}:${r.id}`,
      });
    }
    await tx.query(`update campaigns set status = 'sent', sent_at = now(), updated_at = now() where id = $1`, [campaignId]);
    await audit(tx, { workspaceId: c.workspace_id, type: 'system', id: null }, 'campaign.dispatched', { type: 'campaign', id: c.id }, { recipients: audience.length });
  });
}

const CampaignBody = z.object({
  name: z.string().min(1).max(200),
  template_id: z.string().uuid().nullish(),
  list_id: z.string().uuid().nullish(),
  mailbox_id: z.string().uuid().nullish(),
});

export function campaignRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/v1/campaigns', async (req) => {
    const a = authorize(req);
    const r = await ctx.db.query(
      `select c.id, c.name, c.status, c.scheduled_at, c.sent_at, c.created_at, c.updated_at, l.name as list_name, t.name as template_name,
         (select count(*)::int from sends s where s.source_type = 'campaign' and s.source_id = c.id) as recipients
       from campaigns c left join contact_lists l on l.id = c.list_id left join templates t on t.id = c.template_id
       where c.workspace_id = $1 order by c.created_at desc`,
      [a.workspaceId],
    );
    return { data: r.rows };
  });

  app.post('/v1/campaigns', async (req, reply) => {
    const a = authorize(req, { role: 'member' });
    const body = parse(CampaignBody, req.body);
    const c = await ctx.db.tx(async (tx) => {
      const c = await one<any>(
        tx,
        `insert into campaigns(workspace_id, name, template_id, list_id, mailbox_id) values ($1, $2, $3, $4, $5) returning *`,
        [a.workspaceId, body.name, body.template_id ?? null, body.list_id ?? null, body.mailbox_id ?? null],
      );
      await audit(tx, a, 'campaign.created', { type: 'campaign', id: c.id });
      return c;
    });
    reply.code(201);
    return c;
  });

  app.get('/v1/campaigns/:id', async (req) => {
    const a = authorize(req);
    const { id } = parse(IdParams, req.params);
    return load(ctx.db, a.workspaceId, id);
  });

  app.put('/v1/campaigns/:id', async (req) => {
    const a = authorize(req, { role: 'member' });
    const { id } = parse(IdParams, req.params);
    const body = parse(CampaignBody.partial(), req.body);
    return ctx.db.tx(async (tx) => {
      const c = await load(tx, a.workspaceId, id);
      if (c.status !== 'draft') throw conflict('not_draft', 'Only draft campaigns can be edited');
      return one(
        tx,
        `update campaigns set name = coalesce($2, name), template_id = coalesce($3, template_id), list_id = coalesce($4, list_id),
           mailbox_id = coalesce($5, mailbox_id), updated_at = now() where id = $1 returning *`,
        [id, body.name ?? null, body.template_id ?? null, body.list_id ?? null, body.mailbox_id ?? null],
      );
    });
  });

  /** Send review: who is eligible, who is excluded and why, and mailbox capacity. */
  app.get('/v1/campaigns/:id/review', async (req) => {
    const a = authorize(req);
    const { id } = parse(IdParams, req.params);
    const c = await load(ctx.db, a.workspaceId, id);
    return reviewCampaign(ctx, ctx.db, c);
  });

  /**
   * Send now or schedule. `confirm_recipients` must equal the reviewed eligible count, so
   * nobody sends to an audience they haven't looked at.
   */
  app.post('/v1/campaigns/:id/send', async (req) => {
    const a = authorize(req, { role: 'member' });
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ confirm_recipients: z.number().int().min(1), scheduled_at: z.string().datetime().optional() }), req.body);
    return ctx.db.tx(async (tx) => {
      const c = await load(tx, a.workspaceId, id);
      if (c.status !== 'draft') throw conflict('not_draft', `Campaign is ${c.status}`);
      const review = await reviewCampaign(ctx, tx, c);
      if (!review.ready) throw badRequest('campaign_not_ready', 'Campaign failed send review', review.problems);
      if (body.confirm_recipients !== review.audience.eligible) {
        throw conflict('review_mismatch', `Audience changed: ${review.audience.eligible} eligible recipients now. Review again before sending.`, review.audience);
      }
      const now = ctx.clock.now();
      const at = body.scheduled_at ? new Date(body.scheduled_at) : now;
      if (at < new Date(now.getTime() - 60_000)) throw badRequest('in_the_past', 'scheduled_at is in the past');
      await tx.query(
        `update campaigns set status = 'scheduled', scheduled_at = $2, template_version_id = $3, review = $4, reviewed_by = $5, reviewed_at = now(), updated_at = now()
         where id = $1`,
        [id, at, review.template!.version_id, JSON.stringify(review), a.userId],
      );
      await enqueue(tx, 'campaign.dispatch', { campaignId: id }, { runAt: at, uniqueKey: `campaign:${id}` });
      await audit(tx, a, 'campaign.scheduled', { type: 'campaign', id }, { recipients: review.audience.eligible, scheduled_at: at.toISOString() });
      return { id, status: 'scheduled', scheduled_at: at, recipients: review.audience.eligible };
    });
  });

  app.post('/v1/campaigns/:id/cancel', async (req) => {
    const a = authorize(req, { role: 'member' });
    const { id } = parse(IdParams, req.params);
    return ctx.db.tx(async (tx) => {
      const c = await load(tx, a.workspaceId, id);
      if (!['draft', 'scheduled', 'sending', 'sent'].includes(c.status)) throw conflict('invalid_state', `Campaign is ${c.status}`);
      await tx.query(`update campaigns set status = 'cancelled', updated_at = now() where id = $1`, [id]);
      const cancelled = await tx.query(
        `update sends set status = 'cancelled', error_code = 'campaign_cancelled', last_error = 'Campaign was cancelled', finished_at = now()
         where source_type = 'campaign' and source_id = $1 and status = 'queued'`,
        [id],
      );
      await audit(tx, a, 'campaign.cancelled', { type: 'campaign', id }, { cancelled_sends: cancelled.rowCount });
      return { id, status: 'cancelled', cancelled_sends: cancelled.rowCount };
    });
  });
}
