import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDb, type Db } from './index.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

/** Applies pending *.sql migrations in filename order. Each file runs once, in its own transaction. */
export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<string[]> {
  await db.exec(`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set(
    (await db.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(MIGRATIONS_DIR + file, 'utf8');
    await db.exec(`begin;\n${sql}\ninsert into schema_migrations(name) values ('${file.replace(/'/g, "''")}');\ncommit;`);
    log(`applied migration ${file}`);
    ran.push(file);
  }
  return ran;
}

// CLI: `npm run migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { loadConfig } = await import('../config.js');
  const config = loadConfig();
  const db = await createDb(config.DATABASE_URL);
  const ran = await migrate(db, console.log);
  console.log(ran.length ? `Done (${ran.length} applied).` : 'Database is up to date.');
  await db.close();
}
