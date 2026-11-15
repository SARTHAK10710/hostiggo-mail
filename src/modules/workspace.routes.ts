import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_KEY_SCOPES, audit, authorize, clearSessionCookie, createApiKey, createSession, extractToken, requireUser, sessionCookie } from '../auth/index.js';
import type { Ctx } from '../context.js';
import { one } from '../db/index.js';
import { hashPassword, sha256, verifyPassword } from '../lib/crypto.js';
import { normalizeEmail } from '../lib/email.js';
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';
import { IdParams, Pagination, parse } from '../lib/http.js';

/** 429 instead of a hang when someone hammers the credential endpoints. */
const authLimit = (ctx: Ctx) => ({
  config: { rateLimit: { max: ctx.config.AUTH_RATE_LIMIT_MAX, timeWindow: ctx.config.AUTH_RATE_LIMIT_WINDOW_SECONDS * 1000, hook: 'preHandler' as const } },
});

const Credentials = z.object({ email: z.string().email(), password: z.string().min(10).max(200) });

/** Phase 1: sign-in, workspaces, membership/roles, API keys, audit log. */
export function workspaceRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/v1/auth/signup', authLimit(ctx), async (req, reply) => {
    const body = parse(
      Credentials.extend({ name: z.string().max(200).optional(), workspace_name: z.string().min(1).max(200) }),
      req.body,
    );
    const email = normalizeEmail(body.email);
    const passwordHash = await hashPassword(body.password);
    const result = await ctx.db.tx(async (tx) => {
      const exists = await one(tx, `select 1 from users where email = $1`, [email]);
      if (exists) throw conflict('email_taken', 'An account with this email already exists');
      const user = await one<{ id: string }>(
        tx,
        `insert into users(email, name, password_hash) values ($1, $2, $3) returning id`,
        [email, body.name ?? null, passwordHash],
      );
      const ws = await one<{ id: string; name: string }>(tx, `insert into workspaces(name) values ($1) returning id, name`, [body.workspace_name]);
      await tx.query(`insert into memberships(workspace_id, user_id, role) values ($1, $2, 'owner')`, [ws!.id, user!.id]);
      await audit(tx, { workspaceId: ws!.id, type: 'user', id: user!.id }, 'workspace.created', { type: 'workspace', id: ws!.id });
      const session = await createSession(ctx, tx, user!.id);
      return { user: { id: user!.id, email, name: body.name ?? null }, workspace: { ...ws, role: 'owner' }, session };
    });
    reply.code(201).header('set-cookie', sessionCookie(ctx, result.session.token, new Date(result.session.expires_at)));
    return result;
  });

  app.post('/v1/auth/login', authLimit(ctx), async (req, reply) => {
    const body = parse(Credentials.extend({ password: z.string().min(1) }), req.body);
    const user = await one<{ id: string; email: string; name: string | null; password_hash: string }>(
      ctx.db,
      `select id, email, name, password_hash from users where email = $1`,
      [normalizeEmail(body.email)],
    );
    // Same error for unknown user / wrong password.
    if (!user || !(await verifyPassword(body.password, user.password_hash))) throw unauthorized('Invalid email or password');
    const session = await createSession(ctx, ctx.db, user.id);
    reply.header('set-cookie', sessionCookie(ctx, session.token, new Date(session.expires_at)));
    return { user: { id: user.id, email: user.email, name: user.name }, session };
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    requireUser(req);
    const token = extractToken(req)!.token;
    await ctx.db.query(`delete from sessions where token_hash = $1`, [sha256(token)]);
    reply.header('set-cookie', clearSessionCookie(ctx)).code(204);
  });

  app.get('/v1/me', async (req) => {
    const p = requireUser(req);
    const workspaces = await ctx.db.query(
      `select w.id, w.name, m.role from memberships m join workspaces w on w.id = m.workspace_id
       where m.user_id = $1 order by m.created_at`,
      [p.userId],
    );
    return { user: { id: p.userId, email: p.email }, active_workspace_id: p.workspaceId, workspaces: workspaces.rows };
  });

  app.post('/v1/workspaces', async (req, reply) => {
    const p = requireUser(req);
    const body = parse(z.object({ name: z.string().min(1).max(200) }), req.body);
    const ws = await ctx.db.tx(async (tx) => {
      const ws = await one<{ id: string; name: string }>(tx, `insert into workspaces(name) values ($1) returning id, name`, [body.name]);
      await tx.query(`insert into memberships(workspace_id, user_id, role) values ($1, $2, 'owner')`, [ws!.id, p.userId]);
      await audit(tx, { workspaceId: ws!.id, type: 'user', id: p.userId }, 'workspace.created', { type: 'workspace', id: ws!.id });
      return ws;
    });
    reply.code(201);
    return { ...ws, role: 'owner' };
  });

  // ── Members ────────────────────────────────────────────────────────
  app.get('/v1/members', async (req) => {
    const a = authorize(req);
    const r = await ctx.db.query(
      `select u.id as user_id, u.email, u.name, m.role, m.created_at from memberships m
       join users u on u.id = m.user_id where m.workspace_id = $1 order by m.created_at`,
      [a.workspaceId],
    );
    return { data: r.rows };
  });

  app.post('/v1/members', async (req, reply) => {
    const a = authorize(req, { role: 'admin' });
    const body = parse(z.object({ email: z.string().email(), role: z.enum(['admin', 'member', 'viewer']) }), req.body);
    const user = await one<{ id: string }>(ctx.db, `select id from users where email = $1`, [normalizeEmail(body.email)]);
    if (!user) throw notFound('User (they must sign up first)');
    await ctx.db.tx(async (tx) => {
      const r = await tx.query(
        `insert into memberships(workspace_id, user_id, role) values ($1, $2, $3) on conflict do nothing`,
        [a.workspaceId, user.id, body.role],
      );
      if (r.rowCount === 0) throw conflict('already_member', 'User is already a member');
      await audit(tx, a, 'member.added', { type: 'user', id: user.id }, { role: body.role });
    });
    reply.code(201);
    return { user_id: user.id, role: body.role };
  });

  app.patch('/v1/members/:id', async (req) => {
    const a = authorize(req, { role: 'admin' });
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ role: z.enum(['admin', 'member', 'viewer']) }), req.body);
    await ctx.db.tx(async (tx) => {
      const m = await one<{ role: string }>(tx, `select role from memberships where workspace_id = $1 and user_id = $2`, [a.workspaceId, id]);
      if (!m) throw notFound('Member');
      if (m.role === 'owner') throw badRequest('owner_immutable', 'The owner role cannot be changed here');
      await tx.query(`update memberships set role = $3 where workspace_id = $1 and user_id = $2`, [a.workspaceId, id, body.role]);
      await audit(tx, a, 'member.role_changed', { type: 'user', id }, { from: m.role, to: body.role });
    });
    return { user_id: id, role: body.role };
  });

  app.delete('/v1/members/:id', async (req, reply) => {
    const a = authorize(req, { role: 'admin' });
    const { id } = parse(IdParams, req.params);
    await ctx.db.tx(async (tx) => {
      const r = await tx.query(`delete from memberships where workspace_id = $1 and user_id = $2 and role <> 'owner'`, [a.workspaceId, id]);
      if (r.rowCount === 0) throw notFound('Removable member');
      await audit(tx, a, 'member.removed', { type: 'user', id });
    });
    reply.code(204);
  });

  // ── API keys ───────────────────────────────────────────────────────
  app.get('/v1/api-keys', async (req) => {
    const a = authorize(req, { role: 'admin' });
    const r = await ctx.db.query(
      `select id, name, prefix, scopes, created_at, last_used_at, revoked_at from api_keys
       where workspace_id = $1 order by created_at desc`,
      [a.workspaceId],
    );
    return { data: r.rows };
  });

  app.post('/v1/api-keys', async (req, reply) => {
    const a = authorize(req, { role: 'admin' });
    const body = parse(
      z.object({ name: z.string().min(1).max(100), scopes: z.array(z.enum(API_KEY_SCOPES)).min(1) }),
      req.body,
    );
    const key = await ctx.db.tx(async (tx) => {
      const key = await createApiKey(tx, a.workspaceId, body.name, body.scopes, a.userId);
      await audit(tx, a, 'api_key.created', { type: 'api_key', id: key.id }, { scopes: body.scopes });
      return key;
    });
    reply.code(201);
    return { ...key, note: 'Store this key now. It will not be shown again.' };
  });

  app.delete('/v1/api-keys/:id', async (req, reply) => {
    const a = authorize(req, { role: 'admin' });
    const { id } = parse(IdParams, req.params);
    await ctx.db.tx(async (tx) => {
      const r = await tx.query(
        `update api_keys set revoked_at = now() where id = $1 and workspace_id = $2 and revoked_at is null`,
        [id, a.workspaceId],
      );
      if (r.rowCount === 0) throw notFound('Active API key');
      await audit(tx, a, 'api_key.revoked', { type: 'api_key', id });
    });
    reply.code(204);
  });

  // ── Audit log ──────────────────────────────────────────────────────
  app.get('/v1/audit-logs', async (req) => {
    const a = authorize(req, { role: 'admin' });
    const { limit, offset } = parse(Pagination, req.query);
    const r = await ctx.db.query(
      `select id, actor_type, actor_id, action, target_type, target_id, metadata, created_at
       from audit_logs where workspace_id = $1 order by id desc limit $2 offset $3`,
      [a.workspaceId, limit, offset],
    );
    return { data: r.rows };
  });
}
