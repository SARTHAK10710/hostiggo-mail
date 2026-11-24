import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_KEY_SCOPES, audit, authorize, createApiKey, createSession, requireUser } from '../auth/index.js';
import type { Ctx } from '../context.js';
import { one } from '../db/index.js';
import { hashPassword, sha256, verifyPassword } from '../lib/crypto.js';
import { normalizeEmail } from '../lib/email.js';
import { AppError, badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';
import { randomToken } from '../lib/crypto.js';
import { IdParams, Pagination, parse } from '../lib/http.js';

const Credentials = z.object({ email: z.string().email(), password: z.string().min(10).max(200) });

/** Brute-force protection for sign-in / sign-up / invite lookups (per IP). */
const AUTH_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } };

/** Phase 1: sign-in, workspaces, membership/roles, API keys, audit log. */
export function workspaceRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/v1/auth/signup', { config: AUTH_RATE_LIMIT }, async (req, reply) => {
    const body = parse(
      Credentials.extend({
        name: z.string().max(200).optional(),
        workspace_name: z.string().min(1).max(200).optional(),
        invite_token: z.string().min(10).max(200).optional(),
      }),
      req.body,
    );
    const email = normalizeEmail(body.email);
    const passwordHash = await hashPassword(body.password);
    const result = await ctx.db.tx(async (tx) => {
      const exists = await one(tx, `select 1 from users where email = $1`, [email]);
      if (exists) throw conflict('email_taken', 'An account with this email already exists');

      // Invited sign-up joins the inviting workspace; otherwise a new workspace is created.
      let invite: { id: string; workspace_id: string; role: string; email: string } | undefined;
      if (body.invite_token) {
        invite = await one(
          tx,
          `select id, workspace_id, role, email from invites
           where token_hash = $1 and accepted_at is null and revoked_at is null and expires_at > $2 for update`,
          [sha256(body.invite_token), ctx.clock.now()],
        );
        if (!invite) throw badRequest('invite_invalid', 'This invitation is invalid, used or expired. Ask for a new one.');
        if (invite.email !== email) throw badRequest('invite_email_mismatch', `This invitation is for ${invite.email}`);
      } else {
        const anyUser = await one(tx, `select 1 from users limit 1`);
        if (!ctx.config.ALLOW_SIGNUPS && anyUser) {
          throw new AppError(403, 'signups_closed', 'Sign-up is invite-only on this server. Ask a workspace admin for an invitation.');
        }
        if (!body.workspace_name) throw badRequest('workspace_name_required', 'workspace_name is required');
      }

      const user = await one<{ id: string }>(
        tx,
        `insert into users(email, name, password_hash) values ($1, $2, $3) returning id`,
        [email, body.name ?? null, passwordHash],
      );
      let ws: { id: string; name: string };
      let role: string;
      if (invite) {
        ws = (await one<{ id: string; name: string }>(tx, `select id, name from workspaces where id = $1`, [invite.workspace_id]))!;
        role = invite.role;
        await tx.query(`insert into memberships(workspace_id, user_id, role) values ($1, $2, $3)`, [ws.id, user!.id, role]);
        await tx.query(`update invites set accepted_at = now() where id = $1`, [invite.id]);
        await audit(tx, { workspaceId: ws.id, type: 'user', id: user!.id }, 'invite.accepted', { type: 'user', id: user!.id }, { role });
      } else {
        ws = (await one<{ id: string; name: string }>(tx, `insert into workspaces(name) values ($1) returning id, name`, [body.workspace_name]))!;
        role = 'owner';
        await tx.query(`insert into memberships(workspace_id, user_id, role) values ($1, $2, 'owner')`, [ws.id, user!.id]);
        await audit(tx, { workspaceId: ws.id, type: 'user', id: user!.id }, 'workspace.created', { type: 'workspace', id: ws.id });
      }
      const session = await createSession(ctx, tx, user!.id);
      return { user: { id: user!.id, email, name: body.name ?? null }, workspace: { ...ws, role }, session };
    });
    reply.code(201);
    return result;
  });

  /** Public: what an invitation link is for (shown on the join screen). */
  app.get('/v1/invites/lookup', { config: AUTH_RATE_LIMIT }, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.query);
    const inv = await one<{ email: string; role: string; workspace_name: string }>(
      ctx.db,
      `select i.email, i.role, w.name as workspace_name from invites i join workspaces w on w.id = i.workspace_id
       where i.token_hash = $1 and i.accepted_at is null and i.revoked_at is null and i.expires_at > $2`,
      [sha256(token), ctx.clock.now()],
    );
    if (!inv) throw notFound('Invitation');
    return inv;
  });

  app.get('/v1/auth/config', async () => ({ allow_signups: ctx.config.ALLOW_SIGNUPS }));

  app.post('/v1/auth/login', { config: AUTH_RATE_LIMIT }, async (req) => {
    const body = parse(Credentials.extend({ password: z.string().min(1) }), req.body);
    const user = await one<{ id: string; email: string; name: string | null; password_hash: string }>(
      ctx.db,
      `select id, email, name, password_hash from users where email = $1`,
      [normalizeEmail(body.email)],
    );
    // Same error for unknown user / wrong password.
    if (!user || !(await verifyPassword(body.password, user.password_hash))) throw unauthorized('Invalid email or password');
    const session = await createSession(ctx, ctx.db, user.id);
    return { user: { id: user.id, email: user.email, name: user.name }, session };
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    requireUser(req);
    const token = req.headers.authorization!.slice(7).trim();
    await ctx.db.query(`delete from sessions where token_hash = $1`, [sha256(token)]);
    reply.code(204);
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
    const email = normalizeEmail(body.email);
    const user = await one<{ id: string }>(ctx.db, `select id from users where email = $1`, [email]);
    if (!user) {
      // No account yet: create a 7-day invitation link the admin shares with them.
      const token = randomToken(24);
      const invite = await ctx.db.tx(async (tx) => {
        await tx.query(
          `update invites set revoked_at = now() where workspace_id = $1 and email = $2 and accepted_at is null and revoked_at is null`,
          [a.workspaceId, email],
        );
        const inv = await one<{ id: string; expires_at: Date }>(
          tx,
          `insert into invites(workspace_id, email, role, token_hash, invited_by, expires_at) values ($1, $2, $3, $4, $5, $6)
           returning id, expires_at`,
          [a.workspaceId, email, body.role, sha256(token), a.userId, new Date(ctx.clock.now().getTime() + 7 * 86_400_000)],
        );
        await audit(tx, a, 'invite.created', { type: 'invite', id: inv!.id }, { email, role: body.role });
        return inv!;
      });
      reply.code(201);
      return { invited: true, invite_id: invite.id, email, role: body.role, expires_at: invite.expires_at, invite_url: `${ctx.config.APP_BASE_URL}/invite/${token}` };
    }
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

  app.get('/v1/invites', async (req) => {
    const a = authorize(req, { role: 'admin' });
    const r = await ctx.db.query(
      `select id, email, role, expires_at, created_at from invites
       where workspace_id = $1 and accepted_at is null and revoked_at is null and expires_at > $2 order by created_at desc`,
      [a.workspaceId, ctx.clock.now()],
    );
    return { data: r.rows };
  });

  app.delete('/v1/invites/:id', async (req, reply) => {
    const a = authorize(req, { role: 'admin' });
    const { id } = parse(IdParams, req.params);
    await ctx.db.tx(async (tx) => {
      const r = await tx.query(`update invites set revoked_at = now() where id = $1 and workspace_id = $2 and accepted_at is null and revoked_at is null`, [id, a.workspaceId]);
      if (r.rowCount === 0) throw notFound('Pending invitation');
      await audit(tx, a, 'invite.revoked', { type: 'invite', id });
    });
    reply.code(204);
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
