import type { Ctx } from '../context.js';

/**
 * Operational alerts (mailbox needs reconnecting, mailbox paused for poor health) are posted to
 * ALERT_WEBHOOK_URL as `{ "text": "..." }`, which Slack, Discord (append /slack) and most chat tools accept.
 * Fire-and-forget: an alerting problem must never break sending.
 */
export function sendAlert(ctx: Ctx, text: string): void {
  const url = ctx.config.ALERT_WEBHOOK_URL;
  if (!url) return;
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: `[Hostiggo Mail] ${text}` }),
    signal: AbortSignal.timeout(5000),
  }).catch((err) => ctx.log.warn({ err: (err as Error).message }, 'alert webhook failed'));
}
