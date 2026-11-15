import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { one, type Queryable } from '../db/index.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { randomToken, sha256 } from '../lib/crypto.js';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export const API_KEY_SCOPES = ['events:write', 'messages:send', 'contacts:write', 'contacts:read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export type Principal =
  | { kind: 'user'; userId: string; email: string; workspaceId: string | null; role: Role | null }
  | { kind: 'api_key'; keyId: string; workspaceId: string; scopes: string[] };

export interface Actor {
  workspaceId: string;
  type: 'user' | 'api_key';
  id: string;
  userId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

// ── Sessions ─────────────────────────────────────────────────────────
export async function createSession(ctx: Ctx, q: Queryable, userId: string) {
  const token = `hms_${randomToken(32)}`;
  const expires = new Date(ctx.clock.now().getTime() + ctx.config.SESSION_TTL_HOURS * 3600_000);
  await q.query(`insert into sessions(user_id, token_hash, expires_at) values ($1, $2, $3)`, [userId, sha256(token), expires]);
  return { token, expires_at: expires.toISOString() };
}

// ── API keys: shown once, stored as a hash ───────────────────────────
export async function createApiKey(q: Queryable, workspaceId: string, name: string, scopes: string[], createdBy: string | null) {
  const secret = `hm_live_${randomToken(24)}`;
  const prefix = secret.slice(0, 12);
  const row = await one<{ id: string; created_at: Date }>(
    q,
    `insert into api_keys(workspace_id, name, prefix, key_hash, scopes, created_by)
     values ($1, $2, $3, $4, $5, $6) returning id, created_at`,
    [workspaceId, name, prefix, sha256(secret), scopes, createdBy],
  );
  return { id: row!.id, name, prefix, scopes, created_at: row!.created_at, key: secret };
}

/** Resolves the bearer token / API key on a request into a principal (or none). */
export async function resolvePrincipal(ctx: Ctx, req: FastifyRequest): Promise<Principal | undefined> {
  const header = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'];
  const token = typeof apiKeyHeader === 'string' ? apiKeyHeader : header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  if (!token) return undefined;

  if (token.startsWith('hm_live_')) {
    const key = await one<{ id: string; workspace_id: string; scopes: string[] }>(
      ctx.db,
      `update api_keys set last_used_at = now() where key_hash = $1 and revoked_at is null
       returning id, workspace_id, scopes`,
      [sha256(token)],
    );
    if (!key) throw unauthorized('Invalid or revoked API key');
    return { kind: 'api_key', keyId: key.id, workspaceId: key.workspace_id, scopes: key.scopes };
  }

  const session = await one<{ user_id: string; email: string }>(
    ctx.db,
    `select s.user_id, u.email from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > $2`,
    [sha256(token), ctx.clock.now()],
  );
  if (!session) throw unauthorized('Session expired or invalid');

  // Workspace selection: explicit header, or the only workspace the user belongs to.
  const wsHeader = req.headers['x-workspace-id'];
  const requested = typeof wsHeader === 'string' && wsHeader ? wsHeader : null;
  const memberships = (
    await ctx.db.query<{ workspace_id: string; role: Role }>(
      `select workspace_id, role from memberships where user_id = $1 order by created_at`,
      [session.user_id],
    )
  ).rows;
  let membership = requested ? memberships.find((m) => m.workspace_id === requested) : memberships.length === 1 ? memberships[0] : undefined;
  if (requested && !membership) throw forbidden('You are not a member of that workspace');
  return {
    kind: 'user',
    userId: session.user_id,
    email: session.email,
    workspaceId: membership?.workspace_id ?? null,
    role: membership?.role ?? null,
  };
}

/**
 * Authorisation gate used by every tenant route. Users need a minimum role; API keys
 * need an explicit scope (and are rejected on dashboard-only routes that pass no scope).
 */
export function authorize(req: FastifyRequest, need: { role?: Role; scope?: ApiKeyScope } = {}): Actor {
  const p = req.principal;
  if (!p) throw unauthorized();
  if (p.kind === 'api_key') {
    if (!need.scope || !p.scopes.includes(need.scope)) throw forbidden(`API key lacks the ${need.scope ?? 'dashboard'} scope`);
    return { workspaceId: p.workspaceId, type: 'api_key', id: p.keyId, userId: null };
  }
  if (!p.workspaceId || !p.role) throw forbidden('Select a workspace with the X-Workspace-Id header');
  if (ROLE_RANK[p.role] < ROLE_RANK[need.role ?? 'viewer']) throw forbidden(`Requires the ${need.role} role`);
  return { workspaceId: p.workspaceId, type: 'user', id: p.userId, userId: p.userId };
}

export function requireUser(req: FastifyRequest) {
  const p = req.principal;
  if (!p || p.kind !== 'user') throw unauthorized();
  return p;
}

// ── Audit log ────────────────────────────────────────────────────────
export async function audit(
  q: Queryable,
  actor: Pick<Actor, 'workspaceId' | 'type' | 'id'> | { workspaceId: string; type: 'system'; id: string | null },
  action: string,
  target?: { type: string; id: string },
  metadata: Record<string, unknown> = {},
) {
  await q.query(
    `insert into audit_logs(workspace_id, actor_type, actor_id, action, target_type, target_id, metadata)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [actor.workspaceId, actor.type, actor.id, action, target?.type ?? null, target?.id ?? null, JSON.stringify(metadata)],
  );
}
