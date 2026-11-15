import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authorize } from '../auth/index.js';
import type { Ctx } from '../context.js';
import { one, type Queryable } from '../db/index.js';
import { notFound } from '../lib/errors.js';
import { IdParams, parse } from '../lib/http.js';
import { hasReplyScope } from './mailboxes/service.js';
import { isPublicUrl } from './sends/service.js';

/**
 * Reply rate definition (guide §5), shown with its parts so it can't be misread:
 *   numerator   = unique recipients with >= 1 human reply within `window_days` of the send
 *   denominator = unique recipients whose send was accepted by the provider and did not bounce
 * Excluded: test sends, bounce notices, auto-replies/out-of-office, internal mail (never recorded as replies).
 * Gmail gives no delivery receipt, so "delivered" here means accepted-and-not-bounced.
 */
export const REPLY_RATE_DEFINITION =
  'Unique recipients who sent at least one human reply within the attribution window, divided by unique recipients whose message was accepted and did not bounce. Excludes test sends, bounces, auto-replies and internal mail.';

const EVENT_TYPES = ['accepted', 'delivered', 'bounced', 'complained', 'opened', 'clicked', 'replied', 'unsubscribed', 'failed', 'suppressed'];

async function replyRate(q: Queryable, scopeSql: string, params: unknown[], windowDays: number, now: Date) {
  const w = params.length + 1;
  const n = params.length + 2;
  const r = await q.query<{ step_key: string | null; grouped: number; denominator: number; numerator: number; open_window: number }>(
    `with s as (
       select s.id, s.to_email, coalesce(s.step_key, '') as step_key, s.accepted_at,
         exists (select 1 from email_events e where e.send_id = s.id and e.type = 'bounced') as bounced,
         exists (select 1 from email_events e where e.send_id = s.id and e.type = 'replied'
                 and e.occurred_at >= s.accepted_at and e.occurred_at <= s.accepted_at + make_interval(days => $${w})) as replied
       from sends s where ${scopeSql} and s.kind <> 'test' and s.status = 'accepted')
     select step_key, grouping(step_key)::int as grouped,
       count(distinct to_email) filter (where not bounced)::int as denominator,
       count(distinct to_email) filter (where not bounced and replied)::int as numerator,
       count(*) filter (where accepted_at > $${n}::timestamptz - make_interval(days => $${w}))::int as open_window
     from s group by rollup(step_key)`,
    [...params, windowDays, now],
  );
  const shape = (row?: { denominator: number; numerator: number; open_window: number }) => ({
    rate: row && row.denominator > 0 ? row.numerator / row.denominator : null,
    numerator: row?.numerator ?? 0,
    denominator: row?.denominator ?? 0,
    window_days: windowDays,
    sends_still_in_window: row?.open_window ?? 0,
    event_source: 'gmail_sync',
  });
  const total = r.rows.find((x) => x.grouped === 1);
  const byStep: Record<string, ReturnType<typeof shape>> = {};
  for (const row of r.rows.filter((x) => x.grouped === 0)) byStep[row.step_key ?? ''] = shape(row);
  return { total: shape(total), byStep };
}

async function eventCounts(q: Queryable, scopeSql: string, params: unknown[]) {
  const ev = await q.query<{ step_key: string; type: string; n: number }>(
    `select coalesce(s.step_key, '') as step_key, e.type, count(distinct s.id)::int as n
     from sends s join email_events e on e.send_id = s.id
     where ${scopeSql} and s.kind <> 'test' group by 1, 2`,
    params,
  );
  const st = await q.query<{ step_key: string; status: string; n: number }>(
    `select coalesce(s.step_key, '') as step_key, s.status, count(*)::int as n from sends s where ${scopeSql} and s.kind <> 'test' group by 1, 2`,
    params,
  );
  const blank = () => ({ ...Object.fromEntries(EVENT_TYPES.map((t) => [t, 0])), requested: 0, status: {} as Record<string, number> });
  const out: Record<string, ReturnType<typeof blank>> = {};
  // 'requested' comes from send statuses below (every send has exactly one), not from events.
  for (const row of ev.rows) if (row.type !== 'requested') ((out[row.step_key] ??= blank()) as any)[row.type] = row.n;
  for (const row of st.rows) {
    const b = (out[row.step_key] ??= blank());
    b.status[row.status] = row.n;
    b.requested += row.n;
  }
  return out;
}

export function analyticsRoutes(app: FastifyInstance, ctx: Ctx) {
  const Window = z.object({ window_days: z.coerce.number().int().min(1).max(90).default(ctx.config.REPLY_ATTRIBUTION_DAYS) });

  app.get('/v1/automations/:id/analytics', async (req) => {
    const a = authorize(req);
    const { id } = parse(IdParams, req.params);
    const { window_days } = parse(Window, req.query);
    const auto = await one<any>(ctx.db, `select id, draft_definition from automations where id = $1 and workspace_id = $2`, [id, a.workspaceId]);
    if (!auto) throw notFound('Automation');
    const scope = `s.workspace_id = $1 and s.source_type = 'automation' and s.source_id = $2`;
    const [counts, replies, enrollments] = await Promise.all([
      eventCounts(ctx.db, scope, [a.workspaceId, id]),
      replyRate(ctx.db, scope, [a.workspaceId, id], window_days, ctx.clock.now()),
      ctx.db.query(
        `select state, coalesce(exit_reason, '') as exit_reason, count(*)::int as n from enrollments where automation_id = $1 and workspace_id = $2 group by 1, 2`,
        [id, a.workspaceId],
      ),
    ]);
    const stepIds: string[] = (auto.draft_definition.steps ?? []).filter((s: any) => s.type === 'email').map((s: any) => s.id);
    const allKeys = [...new Set([...stepIds, ...Object.keys(counts)])];
    return {
      automation_id: id,
      reply_rate: replies.total,
      reply_rate_definition: REPLY_RATE_DEFINITION,
      open_tracking_note: 'Open tracking is not enabled; opens would be estimates because clients block or prefetch images.',
      steps: allKeys.map((k) => ({ step_id: k, counts: counts[k] ?? null, reply_rate: replies.byStep[k] ?? null })),
      enrollments: enrollments.rows,
    };
  });

  app.get('/v1/campaigns/:id/analytics', async (req) => {
    const a = authorize(req);
    const { id } = parse(IdParams, req.params);
    const { window_days } = parse(Window, req.query);
    const c = await one(ctx.db, `select id from campaigns where id = $1 and workspace_id = $2`, [id, a.workspaceId]);
    if (!c) throw notFound('Campaign');
    const scope = `s.workspace_id = $1 and s.source_type = 'campaign' and s.source_id = $2`;
    const [counts, replies] = await Promise.all([eventCounts(ctx.db, scope, [a.workspaceId, id]), replyRate(ctx.db, scope, [a.workspaceId, id], window_days, ctx.clock.now())]);
    return { campaign_id: id, counts: counts[''] ?? null, reply_rate: replies.total, reply_rate_definition: REPLY_RATE_DEFINITION };
  });

  /** Dashboard overview for the last N days. */
  app.get('/v1/analytics/overview', async (req) => {
    const a = authorize(req);
    const q = parse(Window.extend({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    const since = new Date(ctx.clock.now().getTime() - q.days * 86_400_000);
    const scope = `s.workspace_id = $1 and s.requested_at >= $2`;
    const [counts, replies, byKind, daily] = await Promise.all([
      eventCounts(ctx.db, scope, [a.workspaceId, since]),
      replyRate(ctx.db, scope, [a.workspaceId, since], q.window_days, ctx.clock.now()),
      ctx.db.query(
        `select kind, status, count(*)::int as n from sends s where ${scope} group by 1, 2 order by 1, 2`,
        [a.workspaceId, since],
      ),
      ctx.db.query(
        `select date_trunc('day', s.requested_at) as day, count(*)::int as requested,
           count(*) filter (where s.status = 'accepted')::int as accepted,
           count(*) filter (where s.status = 'failed')::int as failed
         from sends s where ${scope} and s.kind <> 'test' group by 1 order by 1`,
        [a.workspaceId, since],
      ),
    ]);
    const totals: Record<string, number> = {};
    for (const step of Object.values(counts)) {
      for (const [k, v] of Object.entries(step)) if (typeof v === 'number') totals[k] = (totals[k] ?? 0) + v;
    }
    return { days: q.days, totals, reply_rate: replies.total, reply_rate_definition: REPLY_RATE_DEFINITION, by_kind: byKind.rows, daily: daily.rows };
  });

  /** Deliverability: connection health, bounce/complaint/suppression visibility, setup checklist. */
  app.get('/v1/deliverability', async (req) => {
    const a = authorize(req);
    const now = ctx.clock.now();
    const since = new Date(now.getTime() - 30 * 86_400_000);
    const [mailboxes, rates, suppressions, failures] = await Promise.all([
      ctx.db.query<any>(
        `select m.id, m.email, m.status, m.health, m.scopes, m.last_error, m.daily_send_limit, m.watch_expires_at, m.last_synced_at,
           (select count(*)::int from sends s where s.mailbox_id = m.id and s.accepted_at > $2) as sent_last_24h
         from mailbox_connections m where m.workspace_id = $1 and m.status <> 'disconnected' order by m.created_at`,
        [a.workspaceId, new Date(now.getTime() - 86_400_000)],
      ),
      one<{ accepted: number; bounced: number; complained: number; unsubscribed: number; failed: number }>(
        ctx.db,
        `select count(*) filter (where s.status = 'accepted')::int as accepted,
           count(*) filter (where exists (select 1 from email_events e where e.send_id = s.id and e.type = 'bounced'))::int as bounced,
           count(*) filter (where exists (select 1 from email_events e where e.send_id = s.id and e.type = 'complained'))::int as complained,
           count(*) filter (where exists (select 1 from email_events e where e.send_id = s.id and e.type = 'unsubscribed'))::int as unsubscribed,
           count(*) filter (where s.status = 'failed')::int as failed
         from sends s where s.workspace_id = $1 and s.requested_at >= $2 and s.kind <> 'test'`,
        [a.workspaceId, since],
      ),
      ctx.db.query(`select reason, count(*)::int as n from suppressions where workspace_id = $1 group by reason`, [a.workspaceId]),
      ctx.db.query(
        `select error_code, count(*)::int as n, max(requested_at) as last_seen from sends
         where workspace_id = $1 and requested_at >= $2 and status in ('failed','unknown') group by error_code order by n desc limit 10`,
        [a.workspaceId, since],
      ),
    ]);
    const r = rates!;
    const bounceRate = r.accepted ? r.bounced / r.accepted : 0;
    const complaintRate = r.accepted ? r.complained / r.accepted : 0;
    const live = mailboxes.rows;
    const topicConfigured = !!ctx.config.GMAIL_PUBSUB_TOPIC;
    const oneClickUnsubscribe = isPublicUrl(ctx.config.API_BASE_URL) && ctx.config.API_BASE_URL.startsWith('https://');
    const checklist = [
      { key: 'mailbox_connected', label: 'A sending mailbox is connected', ok: live.some((m) => m.status === 'active') },
      { key: 'mailbox_auth', label: 'No mailbox needs reconnecting', ok: !live.some((m) => m.status === 'reauth_required' || m.status === 'error') },
      { key: 'reply_tracking', label: 'Reply tracking permission granted', ok: live.some((m) => hasReplyScope(m)) },
      {
        key: 'watch_active',
        label: topicConfigured ? 'Gmail push notifications active' : 'Gmail push notifications (Pub/Sub topic not configured; using periodic sync)',
        ok: topicConfigured ? live.filter(hasReplyScope).every((m) => m.watch_expires_at && new Date(m.watch_expires_at) > now) : true,
      },
      { key: 'bounce_rate', label: 'Bounce rate under 2% (30 days)', ok: bounceRate < 0.02, value: bounceRate },
      { key: 'complaint_rate', label: 'Complaint rate under 0.1% (30 days)', ok: complaintRate < 0.001, value: complaintRate },
      { key: 'mailbox_health', label: 'No mailbox paused for poor health', ok: !live.some((m) => m.health === 'unhealthy') },
      !ctx.config.UNSUBSCRIBE_FOOTER
        ? { key: 'unsubscribe', label: 'Visible unsubscribe line is turned off (UNSUBSCRIBE_FOOTER=false); only the hidden List-Unsubscribe header is sent', ok: false }
        : oneClickUnsubscribe
        ?{ key: 'unsubscribe', label: 'Marketing email carries a visible unsubscribe link + one-click header', ok: true }
        : {
            key: 'unsubscribe',
            label: isPublicUrl(ctx.config.API_BASE_URL)
              ? 'One-click unsubscribe needs an https API_BASE_URL (reply-to-unsubscribe is used meanwhile)'
              : 'Server is not publicly reachable: emails ask people to reply "unsubscribe" (handle these by hand). Host it on a public https URL for one-click unsubscribe.',
            ok: false,
          },
      { key: 'domain_auth', label: 'SPF/DKIM/DMARC for a custom sending domain (needed once an ESP adapter is added)', ok: null },
    ];
    return {
      mailboxes: live.map(({ scopes, ...m }) => ({ ...m, reply_tracking: hasReplyScope({ scopes }) })),
      last_30_days: { ...r, bounce_rate: bounceRate, complaint_rate: complaintRate },
      suppressions: Object.fromEntries(suppressions.rows.map((s: any) => [s.reason, s.n])),
      top_failures: failures.rows,
      checklist,
      note: 'Provider acceptance is not inbox placement. Gmail does not report delivery or opens.',
    };
  });
}
