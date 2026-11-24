import pino, { type Logger } from 'pino';
import type { Config } from './config.js';
import { createDb, type Db } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createKeyring, type Keyring } from './lib/crypto.js';
import { createGoogleApi, type GoogleApi } from './providers/google.js';

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** Everything a request handler or background job needs. Built once per process. */
export interface Ctx {
  db: Db;
  config: Config;
  keyring: Keyring;
  clock: Clock;
  google: GoogleApi;
  log: Logger;
  /** Outbound HTTP (webhooks). Tests replace it with a recorder. */
  fetch: typeof fetch;
}

export const LOG_REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  '*.refresh_token',
  '*.access_token',
  '*.password',
  '*.token',
  '*.encrypted_refresh_token',
  '*.html_body',
  '*.text_body',
];

export async function createContext(
  config: Config,
  overrides: Partial<Pick<Ctx, 'clock' | 'google' | 'log' | 'db' | 'fetch'>> = {},
): Promise<Ctx> {
  const log =
    overrides.log ??
    pino({ level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL, redact: LOG_REDACT });
  const db = overrides.db ?? (await createDb(config.DATABASE_URL));
  await migrate(db, (m) => log.info(m));
  return {
    db,
    config,
    keyring: createKeyring(config.encryptionKeys),
    clock: overrides.clock ?? systemClock,
    google: overrides.google ?? createGoogleApi(config),
    log,
    fetch: overrides.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
  };
}
