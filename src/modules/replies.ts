import type { FastifyInstance } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Ctx } from '../context.js';
import { one } from '../db/index.js';
import { enqueue } from '../jobs/queue.js';
import { safeEqual } from '../lib/crypto.js';
import { normalizeEmail, parseAddress } from '../lib/email.js';
import { GoogleApiError, type GmailMessageMeta } from '../providers/google.js';
import { getAccessToken, hasReplyScope, startReplyTracking, type Mailbox } from './mailboxes/service.js';
import { recordEvent } from './sends/service.js';
import { addSuppression } from './suppressions.js';

/**
 * Phase 5: reply-aware analytics through Gmail push notifications + history sync.
 * Notifications are only a prompt to sync; correctness comes from the history cursor,
 * idempotent processing (inbound_messages unique per Gmail id) and periodic reconciliation.
 */
const HEADERS = ['From', 'To', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References', 'Auto-Submitted', 'Precedence',
  'X-Autoreply', 'X-Autorespond', 'X-Auto-Response-Suppress', 'X-Failed-Recipients', 'Content-Type', 'Return-Path'];

const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export type Classification = 'reply' | 'auto_reply' | 'bounce' | 'internal' | 'unmatched';

function headerMap(meta: GmailMessageMeta): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of meta.payload?.headers ?? []) out[h.name.toLowerCase()] = h.value;
  return out;
}

const messageIds = (v: string | undefined) => [...(v ?? '').matchAll(/<([^>]+)>/g)].map((m) => m[1]);

export function looksLikeBounce(h: Record<string, string>, from: string | null) {
  return (
    /^(mailer-daemon|postmaster)@/i.test(from ?? '') ||
    /multipart\/report/i.test(h['content-type'] ?? '') ||
    !!h['x-failed-recipients']
  );
}

export function looksAutomatic(h: Record<string, string>) {
  const autoSubmitted = (h['auto-submitted'] ?? '').toLowerCase();
  return (
    (autoSubmitted !== '' && autoSubmitted !== 'no') ||
    /^(auto_reply|bulk|junk|list)$/i.test((h['precedence'] ?? '').trim()) ||
    'x-autoreply' in h ||
    'x-autorespond' in h ||
    /^(auto(matic)?[ -]?reply|out of (the )?office|autoreply|abwesenheit|absence)/i.test((h['subject'] ?? '').trim())
  );
}

async function processMessage(ctx: Ctx, mailbox: Mailbox, accessToken: string, gmailId: string, internalEmails: Set<string>) {
  const seen = await one(ctx.db, `select 1 from inbound_messages where mailbox_id = $1 and provider_message_id = $2`, [mailbox.id, gmailId]);
  if (seen) return;
  let meta: GmailMessageMeta;
  try {
    meta = await ctx.google.getMessageMetadata(accessToken, gmailId, HEADERS);
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) return; // deleted before we looked
    throw err;
  }
  const labels = meta.labelIds ?? [];
  if (labels.includes('SENT') && !labels.includes('INBOX')) return; // our own outgoing mail
  if (labels.includes('SPAM') || labels.includes('DRAFT')) return;

  const h = headerMap(meta);
  const from = parseAddress(h['from']);
  const receivedAt = meta.internalDate ? new Date(Number(meta.internalDate)) : ctx.clock.now();
  const refs = [...messageIds(h['in-reply-to']), ...messageIds(h['references'])];

  // Candidate sends: referenced by Message-ID first, then same Gmail thread.
  const byRef = refs.length
    ? (await ctx.db.query<any>(
        `select * from sends where mailbox_id = $1 and status = 'accepted' and rfc822_message_id = any($2) order by accepted_at desc`,
        [mailbox.id, refs],
      )).rows
    : [];
  const byThread = (await ctx.db.query<any>(
    `select * from sends where mailbox_id = $1 and status = 'accepted' and provider_thread_id = $2 order by accepted_at desc`,
    [mailbox.id, meta.threadId],
  )).rows;

  let classification: Classification = 'unmatched';
  let send: any = null;

  await ctx.db.tx(async (tx) => {
    if (looksLikeBounce(h, from)) {
      classification = 'bounce';
      const failed = (h['x-failed-recipients'] ?? '').split(',').map(normalizeEmail).filter(Boolean);
      send = byRef[0] ?? byThread[0] ?? null;
      if (!send && failed.length) {
        send = await one(
          tx,
          `select * from sends where mailbox_id = $1 and to_email = any($2) and status = 'accepted' and accepted_at > $3 order by accepted_at desc limit 1`,
          [mailbox.id, failed, new Date(receivedAt.getTime() - 3 * 86_400_000)],
        );
      }
      const bouncedAddress = failed[0] ?? send?.to_email;
      if (send) {
        await recordEvent(tx, { workspaceId: mailbox.workspace_id, sendId: send.id, contactId: send.contact_id, type: 'bounced', source: 'gmail_sync', providerEventId: gmailId, occurredAt: receivedAt });
      }
      if (bouncedAddress) await addSuppression(tx, mailbox.workspace_id, bouncedAddress, 'bounced', `gmail_bounce:${gmailId}`);
    } else if (from && internalEmails.has(from)) {
      classification = 'internal';
    } else if (looksAutomatic(h)) {
      classification = 'auto_reply';
      send = byRef[0] ?? byThread.find((s) => s.to_email === from) ?? null;
    } else {
      send = byRef.find((s) => s.rfc822_message_id === messageIds(h['in-reply-to'])[0]) ?? byRef[0] ?? byThread.find((s) => s.to_email === from) ?? null;
      // A subject match is never enough: we need a thread/Message-ID link and the recipient as sender (or an explicit reference).
      if (send && (send.to_email === from || byRef.includes(send))) {
        classification = 'reply';
        await recordEvent(tx, {
          workspaceId: mailbox.workspace_id,
          sendId: send.id,
          contactId: send.contact_id,
          type: 'replied',
          source: 'gmail_sync',
          providerEventId: gmailId,
          occurredAt: receivedAt,
          metadata: { from },
        });
      } else {
        send = null;
      }
    }
    await tx.query(
      `insert into inbound_messages(workspace_id, mailbox_id, provider_message_id, thread_id, from_email, classification, send_id, received_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing`,
      [mailbox.workspace_id, mailbox.id, gmailId, meta.threadId, from, classification, send?.id ?? null, receivedAt],
    );
  });
}

/** Job: pull mailbox history since the stored cursor and attribute replies/bounces. */
export async function syncMailbox(ctx: Ctx, mailboxId: string) {
  const mailbox = await one<Mailbox>(ctx.db, `select * from mailbox_connections where id = $1`, [mailboxId]);
  if (!mailbox || mailbox.status !== 'active' || !hasReplyScope(mailbox)) return;
  const at = await getAccessToken(ctx, mailbox);
  if (!mailbox.history_id) {
    await startReplyTracking(ctx, mailbox);
    return;
  }
  const internal = new Set(
    (await ctx.db.query<{ email: string }>(
      `select lower(email) as email from mailbox_connections where workspace_id = $1
       union select u.email from memberships m join users u on u.id = m.user_id where m.workspace_id = $1`,
      [mailbox.workspace_id],
    )).rows.map((r) => r.email),
  );

  const ids = new Set<string>();
  // First sync after tracking starts: history only covers mail from now on, so also scan the
  // recent inbox once to pick up replies that arrived before tracking was switched on.
  if (!mailbox.last_synced_at) {
    const recent = await ctx.google.listMessages(at, { labelIds: ['INBOX'], maxResults: 100 });
    for (const m of recent.messages ?? []) ids.add(m.id);
  }
  let latestHistoryId = mailbox.history_id;
  try {
    let pageToken: string | undefined;
    do {
      const page = await ctx.google.listHistory(at, mailbox.history_id, pageToken);
      for (const h of page.history ?? []) for (const m of h.messagesAdded ?? []) ids.add(m.message.id);
      latestHistoryId = page.historyId ?? latestHistoryId;
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (err) {
    if (!(err instanceof GoogleApiError && err.status === 404)) throw err;
    // Cursor too old (history is retained for a limited time): rescan recent inbox, then reset the cursor.
    ctx.log.warn({ mailboxId }, 'gmail history cursor expired; running full inbox reconciliation');
    const recent = await ctx.google.listMessages(at, { labelIds: ['INBOX'], maxResults: 200 });
    for (const m of recent.messages ?? []) ids.add(m.id);
    latestHistoryId = (await ctx.google.getProfile(at)).historyId;
  }

  for (const id of ids) await processMessage(ctx, mailbox, at, id, internal);
  await ctx.db.query(
    `update mailbox_connections set history_id = $2, last_synced_at = now(), updated_at = now()
     where id = $1 and (history_id is null or history_id::numeric < $2::numeric)`,
    [mailboxId, latestHistoryId],
  );
  await ctx.db.query(`update mailbox_connections set last_synced_at = now() where id = $1`, [mailboxId]);
}

/** Daily: renew Gmail watches well before the 7-day expiry. */
export async function renewWatches(ctx: Ctx) {
  if (!ctx.config.GMAIL_PUBSUB_TOPIC) return;
  const due = await ctx.db.query<Mailbox>(
    `select * from mailbox_connections where status = 'active' and $1 = any(scopes)
       and (watch_renewed_at is null or watch_renewed_at < $2 or watch_expires_at < $3)`,
    ['https://www.googleapis.com/auth/gmail.metadata', new Date(ctx.clock.now().getTime() - 20 * 3600_000), new Date(ctx.clock.now().getTime() + 2 * 86_400_000)],
  );
  for (const m of due.rows) {
    try {
      await startReplyTracking(ctx, m);
    } catch (err) {
      ctx.log.warn({ mailboxId: m.id, err: (err as Error).message }, 'watch renewal failed');
      await ctx.db.query(`update mailbox_connections set last_error = $2, updated_at = now() where id = $1`, [m.id, `Watch renewal failed: ${(err as Error).message}`]);
    }
  }
}

/** Periodic safety net for delayed/dropped notifications. */
export async function reconcileMailboxes(ctx: Ctx) {
  const r = await ctx.db.query<{ id: string }>(
    `select id from mailbox_connections where status = 'active' and $1 = any(scopes)`,
    ['https://www.googleapis.com/auth/gmail.metadata'],
  );
  for (const m of r.rows) await enqueue(ctx.db, 'mailbox.sync', { mailboxId: m.id }, { uniqueKey: `sync:${m.id}` });
}

export function replyWebhookRoutes(app: FastifyInstance, ctx: Ctx) {
  /** Pub/Sub push endpoint: verify, enqueue a sync, acknowledge fast. */
  app.post('/webhooks/google/pubsub', async (req, reply) => {
    const ok = await verifyPubsub(ctx, req.headers.authorization, (req.query as any)?.token);
    if (!ok) return reply.code(401).send({ error: 'unauthorized' });
    const body = req.body as { message?: { data?: string; messageId?: string } } | undefined;
    let data: { emailAddress?: string; historyId?: string | number } = {};
    try {
      data = JSON.parse(Buffer.from(body?.message?.data ?? '', 'base64').toString('utf8'));
    } catch {
      return reply.code(204).send(); // malformed: ack so Pub/Sub doesn't redeliver forever
    }
    if (!data.emailAddress) return reply.code(204).send();
    const boxes = await ctx.db.query<{ id: string }>(
      `select id from mailbox_connections where lower(email) = $1 and status = 'active'`,
      [normalizeEmail(data.emailAddress)],
    );
    for (const b of boxes.rows) await enqueue(ctx.db, 'mailbox.sync', { mailboxId: b.id }, { uniqueKey: `sync:${b.id}` });
    return reply.code(204).send();
  });
}

async function verifyPubsub(ctx: Ctx, authorization: string | undefined, token: string | undefined): Promise<boolean> {
  const c = ctx.config;
  if (c.PUBSUB_AUDIENCE && c.PUBSUB_SERVICE_ACCOUNT_EMAIL && authorization?.startsWith('Bearer ')) {
    try {
      const { payload } = await jwtVerify(authorization.slice(7), googleJwks, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: c.PUBSUB_AUDIENCE,
      });
      return payload.email === c.PUBSUB_SERVICE_ACCOUNT_EMAIL && payload.email_verified === true;
    } catch {
      return false;
    }
  }
  if (c.PUBSUB_VERIFICATION_TOKEN && token) return safeEqual(token, c.PUBSUB_VERIFICATION_TOKEN);
  return false;
}
