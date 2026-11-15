import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),

  /** Public URL of this API (used for OAuth redirect + unsubscribe links). */
  API_BASE_URL: z.string().url().default('http://localhost:4000'),
  /** URL of the dashboard frontend (OAuth callback redirects land here). */
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  /** postgres://... for real Postgres, or "pglite:<dir>" / "pglite:memory" for embedded dev DB. */
  DATABASE_URL: z.string().default('pglite:./.data/pglite'),
  /** Run the background worker inside the API process (required with pglite). */
  RUN_WORKER_IN_PROCESS: bool,

  /** HMAC secret for sessions-adjacent signing (unsubscribe links, OAuth state). */
  APP_SECRET: z.string().min(32).default('dev-only-insecure-secret-change-me-please-0000'),
  /** Comma list of "keyId:base64(32 bytes)". First entry encrypts; all entries can decrypt. */
  TOKEN_ENCRYPTION_KEYS: z.string().default('dev:ZGV2LW9ubHktMzItYnl0ZS1rZXktZG8tbm90LXVzZSE='),
  SESSION_TTL_HOURS: z.coerce.number().default(24 * 14),

  /** Email delivery adapter for mailboxes: "gmail" in real use, "fake" for local dev without Google. */
  EMAIL_PROVIDER_MODE: z.enum(['gmail', 'fake']).default('fake'),

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  /** Request the narrow read scope needed for reply tracking (gmail.metadata). */
  GMAIL_REPLY_TRACKING: bool,
  /** projects/<project>/topics/<topic> for Gmail watch. Empty disables watch. */
  GMAIL_PUBSUB_TOPIC: z.string().default(''),
  /** Expected audience of the Pub/Sub push OIDC token. */
  PUBSUB_AUDIENCE: z.string().default(''),
  /** Service-account email Pub/Sub signs push tokens as. */
  PUBSUB_SERVICE_ACCOUNT_EMAIL: z.string().default(''),
  /** Dev fallback: shared ?token= on the push endpoint when OIDC is not configured. */
  PUBSUB_VERIFICATION_TOKEN: z.string().default(''),
  /** Conservative per-mailbox cap; Gmail documents 500 (consumer) / 2,000 (Workspace) per day. */
  GMAIL_DEFAULT_DAILY_LIMIT: z.coerce.number().default(400),
  /** Hard ceiling on a single marketing campaign sent through Gmail. */
  GMAIL_MAX_CAMPAIGN_RECIPIENTS: z.coerce.number().default(300),

  /** Shared secrets for /webhooks/provider/:name, as "name:secret,name2:secret2". */
  PROVIDER_WEBHOOK_SECRETS: z.string().default(''),

  /** Reply attribution window shown on dashboards (days). */
  REPLY_ATTRIBUTION_DAYS: z.coerce.number().default(7),
  /** Append a visible "unsubscribe" line to marketing emails (the List-Unsubscribe header is always sent). */
  UNSUBSCRIBE_FOOTER: z
    .string()
    .optional()
    .transform((v) => !(v === 'false' || v === '0')),
  /** Pause marketing sends from a mailbox when its 7d bounce rate exceeds this (with >= 20 sends). */
  MAX_BOUNCE_RATE: z.coerce.number().default(0.05),
  MAX_COMPLAINT_RATE: z.coerce.number().default(0.003),

  WORKER_POLL_MS: z.coerce.number().default(1000),
  WORKER_CONCURRENCY: z.coerce.number().default(4),
});

export type Config = z.infer<typeof EnvSchema> & {
  encryptionKeys: { id: string; key: Buffer }[];
  providerWebhookSecrets: Record<string, string>;
  corsOrigins: string[];
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.parse(env);
  const encryptionKeys = parsed.TOKEN_ENCRYPTION_KEYS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      if (idx < 1) throw new Error('TOKEN_ENCRYPTION_KEYS entries must look like keyId:base64key');
      const key = Buffer.from(entry.slice(idx + 1), 'base64');
      if (key.length !== 32) throw new Error(`Encryption key ${entry.slice(0, idx)} must be 32 bytes`);
      return { id: entry.slice(0, idx), key };
    });
  if (encryptionKeys.length === 0) throw new Error('At least one TOKEN_ENCRYPTION_KEYS entry is required');

  const providerWebhookSecrets: Record<string, string> = {};
  for (const entry of parsed.PROVIDER_WEBHOOK_SECRETS.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf(':');
    if (idx > 0) providerWebhookSecrets[entry.slice(0, idx)] = entry.slice(idx + 1);
  }

  if (parsed.NODE_ENV === 'production') {
    if (parsed.APP_SECRET.startsWith('dev-only')) throw new Error('Set APP_SECRET in production');
    if (encryptionKeys.some((k) => k.id === 'dev')) throw new Error('Set TOKEN_ENCRYPTION_KEYS in production');
    if (parsed.DATABASE_URL.startsWith('pglite')) throw new Error('Use a real Postgres DATABASE_URL in production');
  }

  return {
    ...parsed,
    RUN_WORKER_IN_PROCESS: parsed.RUN_WORKER_IN_PROCESS || parsed.DATABASE_URL.startsWith('pglite'),
    encryptionKeys,
    providerWebhookSecrets,
    corsOrigins: parsed.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  };
}
