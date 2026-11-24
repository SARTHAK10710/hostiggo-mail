// Runs the full test suite against a real, throwaway PostgreSQL server (not PGlite).
// Usage: npm run test:pg
import EmbeddedPostgres from 'embedded-postgres';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hm-pg-'));
const port = 54329;
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {} });
let code = 1;
try {
  await pg.initialise();
  await pg.start();
  const r = spawnSync('npx', ['vitest', 'run'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, TEST_DATABASE_URL: `postgres://postgres:postgres@localhost:${port}/postgres` },
  });
  code = r.status ?? 1;
} finally {
  await pg.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
