import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { createWorker } from './jobs/worker.js';

// Standalone background worker (sends, delays, Gmail sync, imports, watch renewal).
// Needs a real Postgres DATABASE_URL; with PGlite the worker runs inside the API process.
const config = loadConfig();
if (config.DATABASE_URL.startsWith('pglite')) {
  console.error('The standalone worker needs Postgres. With PGlite, `npm run dev` already runs the worker in-process.');
  process.exit(1);
}
const ctx = await createContext(config);
const worker = createWorker(ctx);
worker.start();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    await worker.stop();
    await ctx.db.close();
    process.exit(0);
  });
}
