import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { createWorker } from './jobs/worker.js';

const config = loadConfig();
const ctx = await createContext(config);
const app = await buildApp(ctx);
const worker = config.RUN_WORKER_IN_PROCESS ? createWorker(ctx) : null;

await app.listen({ port: config.PORT, host: config.HOST });
worker?.start();
ctx.log.info(
  { provider: config.EMAIL_PROVIDER_MODE, db: ctx.db.kind, inProcessWorker: !!worker },
  `Hostiggo Mail API on ${config.API_BASE_URL}`,
);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    await app.close();
    await worker?.stop();
    await ctx.db.close();
    process.exit(0);
  });
}
