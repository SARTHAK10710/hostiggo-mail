import type { Ctx } from '../../context.js';
import { one, type Queryable } from '../../db/index.js';
import { enqueue } from '../../jobs/queue.js';
import { signToken } from '../../lib/crypto.js';
import { isValidEmail, normalizeEmail } from '../../lib/email.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { newMessageId } from '../../lib/mime.js';
import { isPublicUrl } from '../../lib/url.js';
import { contactContext, renderMessage } from '../../lib/template.js';
import { ProviderError, providerFor } from '../../providers/index.js';
import { nextCapacityAt, type Mailbox } from '../mailboxes/service.js';
import { HARD_REASONS, suppressionReasons } from '../suppressions.js';
import { emitSendWebhook, webhookEventForEmailEvent } from '../webhooks.js';

export interface SendRow {
  id: string;
  workspace_id: string;
  idempotency_key: string;
  kind: 'transactional' | 'marketing' | 'test';
  source_type: 'automation' | 'campaign' | 'api' | 'test';
  source_id: string | null;
  enrollment_id: string | null;
  step_key: string | null;
  mailbox_id: string | null;
  contact_id: string | null;
  to_email: string;
  template_version_id: string | null;
  variables: Record<string, unknown>;
  content: { subject: string; html_body?: string | null; text_body?: string | null; from_name?: string | null; reply_to?: string | null } | null;
  subject: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  tags: string[];
  metadata: Record<string, unknown>;
}

/** Transactional mail (booking requests, receipts) is claimed before marketing. */
export const sendPriority = (kind: SendRow['kind']) => (kind === 'marketing' ? 0 : 10);

export interface QueueSendInput {
  workspaceId: string;
  kind: SendRow['kind'];
  sourceType: SendRow['source_type'];
  sourceId?: string | null;
  enrollmentId?: string | null;
  stepKey?: string | null;
  mailboxId: string;
  contactId?: string | null;
  toEmail: string;
  templateVersionId?: string | null;
  content?: SendRow['content'];
  variables?: Record<string, unknown>;
  /** Unique per workspace. Re-queuing with the same key returns the original send (no duplicate). */
  idempotencyKey: string;
  runAt?: Date;
  /** e.g. ['booking:HG-1042']; used to find or cancel related sends. */
  tags?: string[];
  /** Echoed back in webhooks. */
  metadata?: Record<string, unknown>;
}

export async function recordEvent(
  q: Queryable,
  e: { workspaceId: string; sendId: string | null; contactId?: string | null; type: string; source: string; providerEventId?: string | null; occurredAt?: Date; metadata?: object },
): Promise<boolean> {
  const r = await q.query(
    `insert into email_events(workspace_id, send_id, contact_id, type, source, provider_event_id, occurred_at, metadata)
     values ($1, $2, $3, $4, $5, $6, coalesce($7, now()), $8) on conflict do nothing`,
    [e.workspaceId, e.sendId, e.contactId ?? null, e.type, e.source, e.providerEventId ?? null, e.occurredAt ?? null, JSON.stringify(e.metadata ?? {})],
  );
  if (r.rowCount > 0 && e.sendId) {
    const event = webhookEventForEmailEvent(e.type);
    if (event) await emitSendWebhook(q, e.workspaceId, e.sendId, event);
  }
  return r.rowCount > 0;
}

/** Persist a send in the durable ledger and enqueue delivery. Idempotent on idempotencyKey. */
export async function queueSend(ctx: Ctx, q: Queryable, input: QueueSendInput): Promise<SendRow & { duplicate: boolean }> {
  const to = normalizeEmail(input.toEmail);
  if (!isValidEmail(to)) throw badRequest('invalid_email', `Invalid recipient ${input.toEmail}`);
  const mailbox = await one<{ status: string }>(q, `select status from mailbox_connections where id = $1 and workspace_id = $2`, [input.mailboxId, input.workspaceId]);
  if (!mailbox) throw notFound('Mailbox');
  if (mailbox.status === 'disconnected') throw conflict('mailbox_disconnected', 'That mailbox is disconnected');

  const inserted = await one<SendRow>(
    q,
    `insert into sends(workspace_id, idempotency_key, kind, source_type, source_id, enrollment_id, step_key, mailbox_id, contact_id,
       to_email, template_version_id, content, variables, subject, next_attempt_at, requested_at, tags, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     on conflict (workspace_id, idempotency_key) do nothing returning *`,
    [input.workspaceId, input.idempotencyKey, input.kind, input.sourceType, input.sourceId ?? null, input.enrollmentId ?? null, input.stepKey ?? null,
      input.mailboxId, input.contactId ?? null, to, input.templateVersionId ?? null, input.content ? JSON.stringify(input.content) : null,
      JSON.stringify(input.variables ?? {}), input.content?.subject ?? null, input.runAt ?? null, ctx.clock.now(),
      input.tags ?? [], JSON.stringify(input.metadata ?? {})],
  );
  if (!inserted) {
    const existing = await one<SendRow>(q, `select * from sends where workspace_id = $1 and idempotency_key = $2`, [input.workspaceId, input.idempotencyKey]);
    return { ...existing!, duplicate: true };
  }
  await recordEvent(q, { workspaceId: input.workspaceId, sendId: inserted.id, contactId: input.contactId, type: 'requested', source: 'system' });
  await enqueue(q, 'send.process', { sendId: inserted.id }, { runAt: input.runAt ?? ctx.clock.now(), uniqueKey: `send:${inserted.id}`, maxAttempts: 3, priority: sendPriority(input.kind) });
  return { ...inserted, duplicate: false };
}

export function unsubscribeUrl(ctx: Ctx, workspaceId: string, email: string, sendId: string) {
  const token = signToken({ w: workspaceId, e: email, s: sendId }, ctx.config.APP_SECRET, 'unsubscribe');
  return `${ctx.config.API_BASE_URL}/u/${token}`;
}

export { isPublicUrl } from '../../lib/url.js';

/**
 * Unsubscribe targets for a marketing send. A mailto: target always works; the web page is only
 * offered when the server is publicly reachable, and one-click only over https (what Gmail requires).
 */
export function unsubscribeTargets(ctx: Ctx, workspaceId: string, toEmail: string, sendId: string, mailboxEmail: string) {
  const mailto = `mailto:${mailboxEmail}?subject=unsubscribe`;
  if (!isPublicUrl(ctx.config.API_BASE_URL)) {
    return { render: { unsubscribeMailto: mailto }, header: { urls: [mailto], oneClick: false } };
  }
  const url = unsubscribeUrl(ctx, workspaceId, toEmail, sendId);
  return { render: { unsubscribeUrl: url }, header: { urls: [mailto, url], oneClick: url.startsWith('https://') } };
}

type Decision =
  | { action: 'send' }
  | { action: 'final'; status: 'failed' | 'suppressed' | 'cancelled'; code: string; message: string }
  | { action: 'hold'; code: string; message: string } // stays queued, re-enqueued by resume
  | { action: 'defer'; code: string; message: string; until: Date };

async function mailboxHealthy(ctx: Ctx, q: Queryable, mailbox: Mailbox): Promise<boolean> {
  const since = new Date(ctx.clock.now().getTime() - 7 * 86_400_000);
  const r = await one<{ sent: number; bounced: number; complained: number }>(
    q,
    `select count(*)::int as sent,
       count(*) filter (where exists (select 1 from email_events e where e.send_id = s.id and e.type = 'bounced'))::int as bounced,
       count(*) filter (where exists (select 1 from email_events e where e.send_id = s.id and e.type = 'complained'))::int as complained
     from sends s where s.mailbox_id = $1 and s.accepted_at > $2 and s.kind <> 'test'`,
    [mailbox.id, since],
  );
  if (!r || r.sent < 20) return true;
  const healthy = r.bounced / r.sent <= ctx.config.MAX_BOUNCE_RATE && r.complained / r.sent <= ctx.config.MAX_COMPLAINT_RATE;
  const health = healthy ? 'healthy' : 'unhealthy';
  if (health !== mailbox.health) await q.query(`update mailbox_connections set health = $2, updated_at = now() where id = $1`, [mailbox.id, health]);
  return healthy;
}

/** Re-check consent, suppression, mailbox health and rate limits immediately before every send. */
async function decide(ctx: Ctx, q: Queryable, send: SendRow, mailbox: Mailbox | undefined): Promise<Decision> {
  if (!mailbox || mailbox.status === 'disconnected') return { action: 'final', status: 'cancelled', code: 'mailbox_disconnected', message: 'Mailbox is disconnected' };
  if (mailbox.status !== 'active') return { action: 'final', status: 'failed', code: 'mailbox_auth', message: mailbox.last_error ?? 'Mailbox needs to be reconnected' };

  const reasons = await suppressionReasons(q, send.workspace_id, send.to_email);
  if (reasons.some((r) => HARD_REASONS.includes(r))) {
    return { action: 'final', status: 'suppressed', code: `suppressed_${reasons.find((r) => HARD_REASONS.includes(r))}`, message: 'Recipient address bounced or complained previously' };
  }

  if (send.contact_id) {
    const c = await one<{ deleted_at: Date | null; consent_status: string }>(q, `select deleted_at, consent_status from contacts where id = $1`, [send.contact_id]);
    if (!c || c.deleted_at) return { action: 'final', status: 'cancelled', code: 'contact_deleted', message: 'Contact was deleted' };
    if (send.kind === 'marketing' && c.consent_status !== 'opted_in') {
      return { action: 'final', status: 'suppressed', code: 'no_consent', message: 'Contact has not opted in to marketing email' };
    }
  } else if (send.kind === 'marketing') {
    return { action: 'final', status: 'suppressed', code: 'no_consent', message: 'Marketing sends require a contact with consent' };
  }
  if (send.kind === 'marketing' && reasons.length > 0) {
    return { action: 'final', status: 'suppressed', code: `suppressed_${reasons[0]}`, message: 'Recipient is suppressed' };
  }

  if (send.source_type === 'automation' && send.enrollment_id) {
    const e = await one<{ state: string; automation_status: string }>(
      q,
      `select e.state, a.status as automation_status from enrollments e join automations a on a.id = e.automation_id where e.id = $1`,
      [send.enrollment_id],
    );
    if (!e || e.state === 'exited') return { action: 'final', status: 'cancelled', code: 'enrollment_exited', message: 'Contact left the automation' };
    if (e.automation_status === 'paused') return { action: 'hold', code: 'automation_paused', message: 'Automation is paused' };
    if (e.automation_status === 'archived') return { action: 'final', status: 'cancelled', code: 'automation_archived', message: 'Automation was archived' };
  }
  if (send.source_type === 'campaign' && send.source_id) {
    const c = await one<{ status: string }>(q, `select status from campaigns where id = $1`, [send.source_id]);
    if (c?.status === 'cancelled') return { action: 'final', status: 'cancelled', code: 'campaign_cancelled', message: 'Campaign was cancelled' };
  }

  if (send.kind === 'marketing' && !(await mailboxHealthy(ctx, q, mailbox))) {
    return { action: 'final', status: 'failed', code: 'mailbox_unhealthy', message: 'Marketing paused for this mailbox: bounce or complaint rate is too high' };
  }

  // Per-mailbox daily cap (Gmail limits are per user and shared with their other mail clients).
  const now = ctx.clock.now();
  const used = await one<{ n: number }>(
    q,
    `select count(*)::int as n from sends where mailbox_id = $1 and id <> $3 and (accepted_at > $2 or status = 'sending')`,
    [mailbox.id, new Date(now.getTime() - 86_400_000), send.id],
  );
  // Marketing never uses the reserved share, so a campaign can't block a host's booking request.
  const limit = send.kind === 'marketing'
    ? Math.floor(mailbox.daily_send_limit * (1 - ctx.config.TRANSACTIONAL_RESERVE_PERCENT / 100))
    : mailbox.daily_send_limit;
  if ((used?.n ?? 0) >= limit) {
    const what = limit === mailbox.daily_send_limit ? `Mailbox daily limit (${limit})` : `Marketing share of the daily limit (${limit} of ${mailbox.daily_send_limit})`;
    return { action: 'defer', code: 'rate_limited', message: `${what} reached; will send when capacity frees up`, until: await nextCapacityAt(q, mailbox.id, now) };
  }
  return { action: 'send' };
}

/** Job handler: deliver one queued send. */
export async function processSend(ctx: Ctx, sendId: string): Promise<void> {
  // Claim + checks under a per-mailbox advisory lock so concurrent workers respect the daily cap.
  const claimed = await ctx.db.tx(async (tx) => {
    const send = await one<SendRow>(tx, `select * from sends where id = $1 and status = 'queued' for update skip locked`, [sendId]);
    if (!send) return null;
    if (send.mailbox_id) await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [send.mailbox_id]);
    const mailbox = send.mailbox_id ? await one<Mailbox>(tx, `select * from mailbox_connections where id = $1`, [send.mailbox_id]) : undefined;
    const d = await decide(ctx, tx, send, mailbox);
    if (d.action === 'final') {
      await tx.query(`update sends set status = $2, error_code = $3, last_error = $4, finished_at = now() where id = $1`, [send.id, d.status, d.code, d.message]);
      await recordEvent(tx, { workspaceId: send.workspace_id, sendId: send.id, contactId: send.contact_id, type: d.status === 'suppressed' ? 'suppressed' : 'failed', source: 'system', metadata: { code: d.code } });
      return null;
    }
    if (d.action === 'hold') {
      await tx.query(`update sends set error_code = $2, last_error = $3 where id = $1`, [send.id, d.code, d.message]);
      return null;
    }
    if (d.action === 'defer') {
      await tx.query(`update sends set error_code = $2, last_error = $3, next_attempt_at = $4 where id = $1`, [send.id, d.code, d.message, d.until]);
      await enqueue(tx, 'send.process', { sendId: send.id }, { runAt: d.until, uniqueKey: `send:${send.id}`, maxAttempts: 3, priority: sendPriority(send.kind) });
      return null;
    }
    await tx.query(`update sends set status = 'sending', sending_at = now(), attempts = attempts + 1, error_code = null, last_error = null where id = $1`, [send.id]);
    return { send: { ...send, attempts: send.attempts + 1 }, mailbox: mailbox! };
  });
  if (!claimed) return;
  const { send, mailbox } = claimed;

  // Render (template version pinned at queue time, or ad-hoc API content).
  const unsub = send.kind === 'marketing' ? unsubscribeTargets(ctx, send.workspace_id, send.to_email, send.id, mailbox.email) : null;
  let rendered;
  let fromName: string | null = mailbox.display_name;
  let replyTo: string | null = null;
  try {
    const content = send.template_version_id
      ? await one<any>(ctx.db, `select subject, html_body, text_body, from_name, reply_to from template_versions where id = $1`, [send.template_version_id])
      : send.content;
    if (!content) throw new Error('Message content is missing');
    fromName = content.from_name || fromName;
    replyTo = content.reply_to ?? null;
    const contact = send.contact_id ? await one<any>(ctx.db, `select * from contacts where id = $1`, [send.contact_id]) : null;
    rendered = renderMessage(content, { ...contactContext(contact ?? { email: send.to_email }), ...send.variables }, unsub ? { ...unsub.render, footer: ctx.config.UNSUBSCRIBE_FOOTER } : {});
    if (!rendered.subject) throw new Error('Subject rendered empty');
  } catch (err) {
    await finishFailed(ctx, send, 'render_failed', `Could not render message: ${(err as Error).message}`);
    return;
  }

  const domain = mailbox.email.split('@')[1] ?? 'hostiggo.mail';
  try {
    const result = await providerFor(mailbox).send(ctx, mailbox, {
      from: { email: mailbox.email, name: fromName },
      to: send.to_email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      replyTo,
      messageId: newMessageId(domain),
      listUnsubscribe: unsub?.header ?? null,
      headers: { 'X-Hostiggo-Send-Id': send.id },
    });
    await ctx.db.tx(async (tx) => {
      await tx.query(
        `update sends set status = 'accepted', provider = $2, provider_message_id = $3, provider_thread_id = $4, rfc822_message_id = $5,
           subject = $6, accepted_at = $7, finished_at = $7, next_attempt_at = null where id = $1`,
        [send.id, mailbox.provider, result.providerMessageId, result.threadId, result.rfc822MessageId, rendered.subject, ctx.clock.now()],
      );
      // "accepted by provider" is not "delivered".
      await recordEvent(tx, { workspaceId: send.workspace_id, sendId: send.id, contactId: send.contact_id, type: 'accepted', source: `${mailbox.provider}_api`, providerEventId: result.providerMessageId });
    });
  } catch (err) {
    const pe = err instanceof ProviderError ? err : new ProviderError('rejected', 'internal_error', (err as Error).message);
    if (pe.kind === 'transient' && send.attempts < send.max_attempts) {
      const delay = Math.min(6 * 3600_000, 2 ** send.attempts * 60_000); // 2m, 4m, 8m, ...
      const at = new Date(ctx.clock.now().getTime() + delay);
      await ctx.db.tx(async (tx) => {
        await tx.query(`update sends set status = 'queued', error_code = $2, last_error = $3, next_attempt_at = $4 where id = $1`, [send.id, pe.code, pe.message, at]);
        await enqueue(tx, 'send.process', { sendId: send.id }, { runAt: at, uniqueKey: `send:${send.id}`, maxAttempts: 3, priority: sendPriority(send.kind) });
      });
      return;
    }
    if (pe.kind === 'ambiguous') {
      // Never auto-retry when we can't tell whether Gmail accepted it: that's how duplicates happen.
      await ctx.db.tx(async (tx) => {
        await tx.query(`update sends set status = 'unknown', error_code = $2, last_error = $3, finished_at = now() where id = $1`, [send.id, pe.code, pe.message]);
        await emitSendWebhook(tx, send.workspace_id, send.id, 'send.unknown');
      });
      return;
    }
    await finishFailed(ctx, send, pe.code, pe.message);
  }
}

async function finishFailed(ctx: Ctx, send: SendRow, code: string, message: string) {
  await ctx.db.tx(async (tx) => {
    await tx.query(`update sends set status = 'failed', error_code = $2, last_error = $3, finished_at = now(), next_attempt_at = null where id = $1`, [send.id, code, message.slice(0, 1000)]);
    await recordEvent(tx, { workspaceId: send.workspace_id, sendId: send.id, contactId: send.contact_id, type: 'failed', source: 'system', metadata: { code } });
  });
}

/** Manual retry of a failed / unknown send (operator decision; resets the attempt budget). */
export async function retrySend(ctx: Ctx, q: Queryable, workspaceId: string, sendId: string) {
  const s = await one<SendRow>(
    q,
    `update sends set status = 'queued', attempts = 0, error_code = null, last_error = null, finished_at = null, next_attempt_at = null
     where id = $1 and workspace_id = $2 and status in ('failed','unknown') returning *`,
    [sendId, workspaceId],
  );
  if (!s) throw conflict('not_retryable', 'Only failed or unknown sends can be retried');
  await enqueue(q, 'send.process', { sendId }, { runAt: ctx.clock.now(), uniqueKey: `send:${sendId}`, maxAttempts: 3, priority: sendPriority(s.kind) });
  return s;
}

/** Sends stuck in "sending" (worker died mid-call) become "unknown" instead of being re-sent blindly. */
export async function markStaleSends(ctx: Ctx) {
  await ctx.db.query(
    `update sends set status = 'unknown', error_code = 'outcome_unknown',
       last_error = 'Worker stopped while sending; check the mailbox Sent folder before retrying', finished_at = now()
     where status = 'sending' and sending_at < $1`,
    [new Date(ctx.clock.now().getTime() - 15 * 60_000)],
  );
}
