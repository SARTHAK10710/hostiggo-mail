// Restore the embedded (PGlite) database from a backup made by Hostiggo Mail.
// Stop the server first (Ctrl+C), then:  npm run restore -- backups/hostiggo-mail-YYYYMMDD-HHMMSS.tar.gz
// The current database is moved aside (not deleted) so you can undo.
import { PGlite } from '@electric-sql/pglite';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error('Usage: npm run restore -- <path to backup .tar.gz>');
  process.exit(1);
}
const url = process.env.DATABASE_URL ?? 'pglite:./.data/pglite';
if (!url.startsWith('pglite')) {
  console.error('DATABASE_URL is not the embedded database; restore Postgres with your provider or pg_restore.');
  process.exit(1);
}
const dataDir = resolve(url.replace(/^pglite:?/, '') || './.data/pglite');
try {
  const res = await fetch('http://localhost:' + (process.env.PORT ?? 4000) + '/health', { signal: AbortSignal.timeout(1500) });
  if (res.ok) {
    console.error('The server is still running. Stop it with Ctrl+C first.');
    process.exit(1);
  }
} catch {
  /* not running: good */
}
if (existsSync(dataDir)) {
  const aside = `${dataDir}-before-restore-${Date.now()}`;
  renameSync(dataDir, aside);
  console.log(`Current database moved to ${aside}`);
}
const blob = new Blob([readFileSync(file)]);
const db = new PGlite(dataDir, { loadDataDir: blob });
await db.waitReady;
const r = await db.query('select count(*)::int as n from users');
await db.close();
console.log(`Restored ${file} -> ${dataDir} (${r.rows[0].n} user accounts). Start the server with npm start.`);
