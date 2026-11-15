import { audit, type Actor } from '../../auth/index.js';
import type { Ctx } from '../../context.js';
import { one, type Queryable } from '../../db/index.js';
import { enqueue } from '../../jobs/queue.js';
import { sendAlert } from '../../lib/alerts.js';
import { randomToken, signToken, verifyToken } from '../../lib/crypto.js';
import { normalizeEmail } from '../../lib/email.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { GMAIL_METADATA_SCOPE, GMAIL_SEND_SCOPE, GoogleApiError, IDENTITY_SCOPES } from '../../providers/google.js';

export interface Mailbox {
  id: string;
  workspace_id: string;
  provider: string;
  email: string;
  display_name: string | null;
  encrypted_refresh_token: string | null;
  scopes: string[];
  status: 'active' | 'reauth_required' | 'error' | 'disconnected';
  health: 'healthy' | 'unhealthy';
  last_error: string | null;
  daily_send_limit: number;
  warmup_started_at: Date | null;
  history_id: string | null;
  watch_expires_at: Date | null;
  watch_renewed_at: Date | null;
  last_synced_at: Date | null;
}

/** Columns safe to return to the dashboard (never the token). */
export const MAILBOX_PUBLIC_COLS = `id, provider, email, display_name, scopes, status, health, last_error, daily_send_limit, warmup_started_at,
  watch_expires_at, last_synced_at, created_at, updated_at, disconnected_at`;

/** Warm-up schedule: 20/day in week 1, doubling every 7 days, never above the mailbox's own daily limit. */
export const WARMUP_START = 20;

export function warmupCap(startedAt: Date | string | null | undefined, now: Date): number | null {
  if (!startedAt) return null;
  const days = Math.max(0, Math.floor((now.getTime() - new Date(startedAt).getTime()) / 86_400_000));
  return WARMUP_START * 2 ** Math.min(Math.floor(days / 7), 20);
}

export function effectiveDailyLimit(m: { daily_send_limit: number; warmup_started_at?: Date | string | null }, now: Date): number {
  const cap = warmupCap(m.warmup_started_at, now);
  return cap === null ? m.daily_send_limit : Math.min(m.daily_send_limit, cap);
}

/** Adds today's allowed volume (lower than the configured limit while warming up) to a mailbox row. */
export function withLimits<T extends { daily_send_limit: number; warmup_started_at?: Date | string | null }>(m: T, now: Date) {
  const effective = effectiveDailyLimit(m, now);
  return { ...m, effective_daily_limit: effective, warming_up: effective < m.daily_send_limit };
}

export const hasReplyScope = (m: Pick<Mailbox, 'scopes'>) => m.scopes.includes(GMAIL_METADATA_SCOPE);

export function requestedScopes(ctx: Ctx) {
  // Least privilege: send-only unless reply tracking is switched on.
  return [...IDENTITY_SCOPES, GMAIL_SEND_SCOPE, ...(ctx.config.GMAIL_REPLY_TRACKING ? [GMAIL_METADATA_SCOPE] : [])];
}

export async function getMailbox(q: Queryable, workspaceId: string, id: string): Promise<Mailbox> {
  const m = await one<Mailbox>(q, `select * from mailbox_connections where id = $1 and workspace_id = $2`, [id, workspaceId]);
  if (!m) throw notFound('Mailbox');
  return m;
}

// ── OAuth connect ────────────────────────────────────────────────────
export async function startConnect(ctx: Ctx, actor: Actor, loginHint?: string) {
  if (!actor.userId) throw badRequest('user_required', 'A signed-in user must connect a mailbox');
  if (ctx.config.EMAIL_PROVIDER_MODE === 'gmail' && !ctx.config.GOOGLE_CLIENT_ID) {
    throw new AppError(503, 'google_not_configured', 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured');
  }
  const nonce = randomToken(18);
  await ctx.db.query(
    `insert into oauth_states(nonce, workspace_id, user_id, expires_at) values ($1, $2, $3, $4)`,
    [nonce, actor.workspaceId, actor.userId, new Date(ctx.clock.now().getTime() + 10 * 60_000)],
  );
  const state = signToken({ n: nonce }, ctx.config.APP_SECRET, 'google-oauth');
  const scopes = requestedScopes(ctx);
  return { url: ctx.google.authorizeUrl({ state, scopes, loginHint }), scopes };
}

export async function completeConnect(ctx: Ctx, code: string, state: string): Promise<Mailbox> {
  const parsed = verifyToken<{ n: string }>(state, ctx.config.APP_SECRET, 'google-oauth');
  if (!parsed) throw badRequest('invalid_state', 'OAuth state is invalid');
  // Single use: delete the nonce as we read it.
  const st = await one<{ workspace_id: string; user_id: string; expires_at: Date }>(
    ctx.db,
    `delete from oauth_states where nonce = $1 returning workspace_id, user_id, expires_at`,
    [parsed.n],
  );
  if (!st || new Date(st.expires_at) < ctx.clock.now()) throw badRequest('state_expired', 'OAuth request expired; start again');

  const tokens = await ctx.google.exchangeCode(code);
  const granted = tokens.scope.split(/\s+/);
  if (!granted.includes(GMAIL_SEND_SCOPE)) {
    throw badRequest('scope_missing', 'Permission to send email was not granted. Reconnect and allow sending.');
  }
  if (!tokens.refresh_token) throw badRequest('no_refresh_token', 'Google did not return a refresh token; reconnect and approve access');
  if (!tokens.id_token) throw badRequest('no_identity', 'Google did not return the account identity');
  const identity = ctx.google.decodeIdToken(tokens.id_token);
  const email = normalizeEmail(identity.email);
  const encrypted = ctx.keyring.encrypt(tokens.refresh_token);
  const gmailScopes = granted.filter((s) => s.includes('/auth/gmail.'));

  const mailbox = await ctx.db.tx(async (tx) => {
    const existing = await one<{ id: string }>(
      tx,
      `select id from mailbox_connections where workspace_id = $1 and lower(email) = $2 and status <> 'disconnected'`,
      [st.workspace_id, email],
    );
    let row: Mailbox | undefined;
    if (existing) {
      row = await one<Mailbox>(
        tx,
        `update mailbox_connections set encrypted_refresh_token = $2, scopes = $3, status = 'active', last_error = null,
           provider_account_id = $4, connected_by = $5, updated_at = now() where id = $1 returning *`,
        [existing.id, encrypted, gmailScopes, identity.sub, st.user_id],
      );
    } else {
      row = await one<Mailbox>(
        tx,
        `insert into mailbox_connections(workspace_id, provider, provider_account_id, email, display_name,
           encrypted_refresh_token, scopes, daily_send_limit, connected_by, warmup_started_at)
         values ($1, 'gmail', $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
        [st.workspace_id, identity.sub, email, identity.name ?? null, encrypted, gmailScopes, ctx.config.GMAIL_DEFAULT_DAILY_LIMIT, st.user_id,
          ctx.config.WARMUP_DEFAULT ? ctx.clock.now() : null],
      );
    }
    await audit(tx, { workspaceId: st.workspace_id, type: 'user', id: st.user_id }, existing ? 'mailbox.reconnected' : 'mailbox.connected',
      { type: 'mailbox', id: row!.id }, { email, scopes: gmailScopes });
    return row!;
  });
  tokenCache.set(mailbox.id, { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 });

  if (hasReplyScope(mailbox)) {
    await startReplyTracking(ctx, mailbox).catch((err) => {
      ctx.log.warn({ mailboxId: mailbox.id, err: (err as Error).message }, 'could not start reply tracking');
    });
    // Look for replies right away instead of waiting for the periodic sync.
    await enqueue(ctx.db, 'mailbox.sync', { mailboxId: mailbox.id }, { uniqueKey: `sync:${mailbox.id}` });
  }
  return mailbox;
}

// ── Access tokens (short-lived, in memory only) ──────────────────────
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function getAccessToken(ctx: Ctx, mailbox: Mailbox): Promise<string> {
  const cached = tokenCache.get(mailbox.id);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  if (!mailbox.encrypted_refresh_token || mailbox.status === 'disconnected') {
    throw new AppError(409, 'mailbox_disconnected', 'Mailbox is disconnected');
  }
  try {
    const t = await ctx.google.refreshAccessToken(ctx.keyring.decrypt(mailbox.encrypted_refresh_token));
    tokenCache.set(mailbox.id, { token: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 });
    return t.access_token;
  } catch (err) {
    if (err instanceof GoogleApiError && err.authRevoked) {
      await markMailbox(ctx.db, mailbox.id, 'reauth_required', 'Google access was revoked or expired. Reconnect this mailbox.');
      await audit(ctx.db, { workspaceId: mailbox.workspace_id, type: 'system', id: null }, 'mailbox.auth_lost', { type: 'mailbox', id: mailbox.id });
      sendAlert(ctx, `Mailbox ${mailbox.email} lost Google access and must be reconnected. Sending from it is paused.`);
    }
    throw err;
  }
}

export function forgetAccessToken(mailboxId: string) {
  tokenCache.delete(mailboxId);
}

export async function markMailbox(q: Queryable, id: string, status: Mailbox['status'], error: string | null) {
  await q.query(`update mailbox_connections set status = $2, last_error = $3, updated_at = now() where id = $1`, [id, status, error]);
}

// ── Reply tracking: Gmail watch + history cursor ────────────────────
export async function startReplyTracking(ctx: Ctx, mailbox: Mailbox) {
  const at = await getAccessToken(ctx, mailbox);
  if (ctx.config.GMAIL_PUBSUB_TOPIC) {
    const w = await ctx.google.watch(at, ctx.config.GMAIL_PUBSUB_TOPIC);
    await ctx.db.query(
      `update mailbox_connections set history_id = coalesce(history_id, $2), watch_expires_at = $3, watch_renewed_at = now(),
         updated_at = now() where id = $1`,
      [mailbox.id, w.historyId, new Date(Number(w.expiration))],
    );
  } else {
    // No Pub/Sub topic: rely on periodic reconciliation polling from the current cursor.
    const profile = await ctx.google.getProfile(at);
    await ctx.db.query(`update mailbox_connections set history_id = coalesce(history_id, $2), updated_at = now() where id = $1`, [
      mailbox.id,
      profile.historyId,
    ]);
  }
}

// ── Disconnect: stop watch, revoke + forget token, cancel queued sends ─
export async function disconnect(ctx: Ctx, actor: Actor, id: string) {
  const mailbox = await getMailbox(ctx.db, actor.workspaceId, id);
  if (mailbox.status === 'disconnected') return;
  if (mailbox.encrypted_refresh_token) {
    const refresh = ctx.keyring.decrypt(mailbox.encrypted_refresh_token);
    if (hasReplyScope(mailbox)) {
      try {
        await ctx.google.stopWatch(await getAccessToken(ctx, mailbox));
      } catch (err) {
        ctx.log.warn({ mailboxId: id, err: (err as Error).message }, 'stop watch failed during disconnect');
      }
    }
    try {
      await ctx.google.revokeToken(refresh);
    } catch (err) {
      ctx.log.warn({ mailboxId: id, err: (err as Error).message }, 'token revoke failed; token deleted locally anyway');
    }
  }
  forgetAccessToken(id);
  await ctx.db.tx(async (tx) => {
    await tx.query(
      `update mailbox_connections set status = 'disconnected', encrypted_refresh_token = null, watch_expires_at = null,
         history_id = null, disconnected_at = now(), updated_at = now() where id = $1`,
      [id],
    );
    const cancelled = await tx.query(
      `update sends set status = 'cancelled', error_code = 'mailbox_disconnected', last_error = 'Mailbox was disconnected before sending',
         finished_at = now() where mailbox_id = $1 and status = 'queued'`,
      [id],
    );
    // Automations that send from this mailbox can't continue; pause them so nobody silently drops out.
    const paused = await tx.query(
      `update automations a set status = 'paused', updated_at = now() from automation_versions v
       where v.id = a.current_version_id and a.workspace_id = $1 and a.status = 'active' and v.definition->>'mailbox_id' = $2`,
      [actor.workspaceId, id],
    );
    await audit(tx, actor, 'mailbox.disconnected', { type: 'mailbox', id }, {
      email: mailbox.email,
      cancelled_sends: cancelled.rowCount,
      paused_automations: paused.rowCount,
    });
  });
}

/** How many messages this mailbox accepted in the trailing 24h (shared with the user's other clients!). */
export async function sentInLast24h(q: Queryable, mailboxId: string, now: Date): Promise<number> {
  const r = await one<{ n: number }>(
    q,
    `select count(*)::int as n from sends where mailbox_id = $1 and accepted_at > $2`,
    [mailboxId, new Date(now.getTime() - 86_400_000)],
  );
  return r?.n ?? 0;
}

/** When the oldest send inside the 24h window ages out (next capacity). */
export async function nextCapacityAt(q: Queryable, mailboxId: string, now: Date): Promise<Date> {
  const r = await one<{ t: Date | null }>(
    q,
    `select min(accepted_at) as t from sends where mailbox_id = $1 and accepted_at > $2`,
    [mailboxId, new Date(now.getTime() - 86_400_000)],
  );
  const oldest = r?.t ? new Date(r.t) : now;
  return new Date(Math.max(now.getTime() + 60_000, oldest.getTime() + 86_400_000 + 1000));
}
