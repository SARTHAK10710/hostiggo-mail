import type { Ctx } from '../context.js';
import { buildMime, toGmailRaw } from '../lib/mime.js';
import { getAccessToken, hasReplyScope, type Mailbox } from '../modules/mailboxes/service.js';
import { GoogleApiError } from './google.js';

/**
 * Provider-neutral "send message" interface (guide §2 scale path). Gmail is the first
 * adapter; a bulk ESP adapter can be added later without touching contacts, templates,
 * automations or analytics.
 */
export interface OutgoingMessage {
  from: { email: string; name?: string | null };
  to: string;
  subject: string;
  html: string | null;
  text: string | null;
  replyTo?: string | null;
  messageId: string;
  listUnsubscribe?: { urls: string[]; oneClick: boolean } | null;
  headers?: Record<string, string>;
}

export interface SendResult {
  providerMessageId: string;
  threadId: string | null;
  rfc822MessageId: string | null;
}

export type ProviderErrorKind = 'transient' | 'auth' | 'rejected' | 'ambiguous';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface EmailProvider {
  readonly name: string;
  send(ctx: Ctx, mailbox: Mailbox, msg: OutgoingMessage): Promise<SendResult>;
}

export const gmailProvider: EmailProvider = {
  name: 'gmail',
  async send(ctx, mailbox, msg) {
    let accessToken: string;
    try {
      accessToken = await getAccessToken(ctx, mailbox);
    } catch (err) {
      throw toProviderError(err);
    }
    const mime = buildMime({ ...msg, extraHeaders: msg.headers });
    let res: { id: string; threadId: string };
    try {
      res = await ctx.google.sendMessage(accessToken, toGmailRaw(mime));
    } catch (err) {
      throw toProviderError(err);
    }
    // Gmail may rewrite Message-ID; read back the real header when we hold the metadata scope.
    let rfc822 = msg.messageId;
    if (hasReplyScope(mailbox)) {
      try {
        const meta = await ctx.google.getMessageMetadata(accessToken, res.id, ['Message-ID']);
        const h = meta.payload?.headers?.find((x) => x.name.toLowerCase() === 'message-id')?.value;
        if (h) rfc822 = h.replace(/^<|>$/g, '');
      } catch {
        /* best effort */
      }
    }
    return { providerMessageId: res.id, threadId: res.threadId, rfc822MessageId: rfc822 };
  },
};

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof GoogleApiError) {
    if (err.status === 0) return new ProviderError('ambiguous', 'outcome_unknown', `Network error talking to Gmail; the message may or may not have been sent (${err.message})`);
    if (err.authRevoked) return new ProviderError('auth', 'mailbox_auth', 'Gmail access was revoked or expired. Reconnect the mailbox.');
    if (err.transient) return new ProviderError('transient', 'provider_transient', `Gmail temporarily refused the message: ${err.message}`);
    if (err.status === 403 && /limit|quota/i.test(err.message + err.reason)) {
      return new ProviderError('transient', 'provider_quota', `Gmail sending limit reached: ${err.message}`);
    }
    return new ProviderError('rejected', 'provider_rejected', `Gmail rejected the message: ${err.message}`);
  }
  const anyErr = err as { code?: string; message?: string };
  if (anyErr?.code === 'mailbox_disconnected') return new ProviderError('auth', 'mailbox_disconnected', 'Mailbox is disconnected');
  return new ProviderError('rejected', 'internal_error', anyErr?.message ?? String(err));
}

const providers: Record<string, EmailProvider> = { gmail: gmailProvider };

export function providerFor(mailbox: Pick<Mailbox, 'provider'>): EmailProvider {
  const p = providers[mailbox.provider];
  if (!p) throw new ProviderError('rejected', 'unknown_provider', `No adapter for provider ${mailbox.provider}`);
  return p;
}
