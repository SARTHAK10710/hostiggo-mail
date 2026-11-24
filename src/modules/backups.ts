import type { FastifyInstance } from 'fastify';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { audit, authorize, requireUser } from '../auth/index.js';
import type { Ctx } from '../context.js';
import { AppError, forbidden } from '../lib/errors.js';
import { isOperator } from './ops.js';

/**
 * Local backups of the embedded (PGlite) database. A snapshot is taken inside the running server
 * (PGlite is single-process), written as a .tar.gz, and only the newest BACKUP_KEEP are kept.
 * Restore with `npm run restore -- <file>` while the server is stopped.
 * With real Postgres, use the provider's backups (Supabase does daily backups) or pg_dump.
 */
const PREFIX = 'hostiggo-mail-';

export function backupDir(ctx: Ctx) {
  return resolve(ctx.config.BACKUP_DIR);
}

export function listBackups(ctx: Ctx) {
  const dir = backupDir(ctx);
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(PREFIX) && f.endsWith('.tar.gz'))
      .map((f) => {
        const st = statSync(join(dir, f));
        return { file: f, bytes: st.size, created_at: st.mtime };
      })
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  } catch {
    return [];
  }
}

export async function takeBackup(ctx: Ctx): Promise<{ file: string; bytes: number } | null> {
  if (!ctx.db.dump) return null; // real Postgres: handled by the database provider
  const dir = backupDir(ctx);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const file = `${PREFIX}${stamp}.tar.gz`;
  const blob = await ctx.db.dump();
  const buf = Buffer.from(await blob.arrayBuffer());
  writeFileSync(join(dir, file), buf);
  for (const old of listBackups(ctx).slice(Math.max(1, ctx.config.BACKUP_KEEP))) rmSync(join(dir, old.file), { force: true });
  ctx.log.info({ file, bytes: buf.length }, 'database backup written');
  return { file, bytes: buf.length };
}

/** Periodic job: snapshot when the newest backup is older than BACKUP_EVERY_HOURS. */
export async function scheduledBackup(ctx: Ctx) {
  if (!ctx.db.dump || ctx.config.BACKUP_EVERY_HOURS <= 0) return;
  const newest = listBackups(ctx)[0];
  if (newest && Date.now() - newest.created_at.getTime() < ctx.config.BACKUP_EVERY_HOURS * 3600_000) return;
  await takeBackup(ctx);
}

export function backupRoutes(app: FastifyInstance, ctx: Ctx) {
  const operatorOnly = async (req: Parameters<typeof requireUser>[0]) => {
    const a = authorize(req, { role: 'admin' });
    if (!(await isOperator(ctx, requireUser(req).userId))) throw forbidden('Only the server operator can manage backups');
    return a;
  };

  app.get('/v1/ops/backups', async (req) => {
    await operatorOnly(req);
    return {
      supported: !!ctx.db.dump,
      directory: backupDir(ctx),
      every_hours: ctx.config.BACKUP_EVERY_HOURS,
      keep: ctx.config.BACKUP_KEEP,
      data: listBackups(ctx),
      note: ctx.db.dump ? undefined : 'Using real Postgres: rely on your database provider\'s backups (e.g. Supabase daily backups) or pg_dump.',
    };
  });

  app.post('/v1/ops/backups', async (req, reply) => {
    const a = await operatorOnly(req);
    const r = await takeBackup(ctx);
    if (!r) throw new AppError(409, 'backups_not_supported', 'Backups here are only for the embedded database; use your Postgres provider\'s backups.');
    await audit(ctx.db, a, 'ops.backup_taken', { type: 'backup', id: r.file }, { bytes: r.bytes });
    reply.code(201);
    return r;
  });
}
