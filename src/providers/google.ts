import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';

/**
 * Thin client over the Google OAuth + Gmail REST endpoints we use. Kept as an interface
 * so local dev ("fake" mode) and tests can run the full flow without Google.
 */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
/** Narrowest scope that can read headers/thread ids for reply detection + receive watch/history. */
export const GMAIL_METADATA_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
export const IDENTITY_SCOPES = ['openid', 'email', 'profile'];

export interface TokenSet {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token?: string;
}

export interface GmailHeader {
  name: string;
  value: string;
}
export interface GmailMessageMeta {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  /** Short plain-text preview Gmail returns even for format=metadata. */
  snippet?: string;
  payload?: { headers?: GmailHeader[]; mimeType?: string };
}
export interface GmailHistoryPage {
  history?: { id: string; messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[] }[];
  historyId: string;
  nextPageToken?: string;
}

export class GoogleApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
    message: string,
  ) {
    super(message);
  }
  /** Network errors, 429 and 5xx are worth retrying; everything else is permanent. */
  get transient() {
    return this.status === 0 || this.status === 429 || this.status >= 500 || this.reason === 'rateLimitExceeded' || this.reason === 'userRateLimitExceeded';
  }
  get authRevoked() {
    return this.reason === 'invalid_grant' || this.status === 401;
  }
}

export interface GoogleApi {
  authorizeUrl(params: { state: string; scopes: string[]; loginHint?: string }): string;
  exchangeCode(code: string): Promise<TokenSet>;
  refreshAccessToken(refreshToken: string): Promise<TokenSet>;
  revokeToken(token: string): Promise<void>;
  /** Decodes the id_token returned directly by the token endpoint (trusted TLS channel). */
  decodeIdToken(idToken: string): { sub: string; email: string; name?: string };
  getProfile(accessToken: string): Promise<{ emailAddress: string; historyId: string }>;
  sendMessage(accessToken: string, raw: string, threadId?: string): Promise<{ id: string; threadId: string }>;
  getMessageMetadata(accessToken: string, id: string, headers: string[]): Promise<GmailMessageMeta>;
  listHistory(accessToken: string, startHistoryId: string, pageToken?: string): Promise<GmailHistoryPage>;
  listMessages(
    accessToken: string,
    opts: { labelIds?: string[]; pageToken?: string; maxResults?: number },
  ): Promise<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>;
  watch(accessToken: string, topicName: string): Promise<{ historyId: string; expiration: string }>;
  stopWatch(accessToken: string): Promise<void>;
}

export function createGoogleApi(config: Config): GoogleApi {
  return config.EMAIL_PROVIDER_MODE === 'gmail' ? new HttpGoogleApi(config) : new FakeGoogleApi(config);
}

// ───────────────────────── Real implementation ─────────────────────────
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class HttpGoogleApi implements GoogleApi {
  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get redirectUri() {
    return `${this.config.API_BASE_URL}/oauth/google/callback`;
  }

  authorizeUrl({ state, scopes, loginHint }: { state: string; scopes: string[]; loginHint?: string }) {
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', this.config.GOOGLE_CLIENT_ID);
    u.searchParams.set('redirect_uri', this.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', scopes.join(' '));
    u.searchParams.set('access_type', 'offline'); // refresh token
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('include_granted_scopes', 'false');
    u.searchParams.set('state', state);
    if (loginHint) u.searchParams.set('login_hint', loginHint);
    return u.toString();
  }

  private async tokenRequest(body: Record<string, string>): Promise<TokenSet> {
    const res = await this.call('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.GOOGLE_CLIENT_ID,
        client_secret: this.config.GOOGLE_CLIENT_SECRET,
        ...body,
      }).toString(),
    });
    return res as TokenSet;
  }

  exchangeCode(code: string) {
    return this.tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: this.redirectUri });
  }

  refreshAccessToken(refreshToken: string) {
    return this.tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  }

  async revokeToken(token: string) {
    await this.call('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    }).catch((err) => {
      // Already-revoked tokens return 400 invalid_token; that's the state we want.
      if (!(err instanceof GoogleApiError && err.status === 400)) throw err;
    });
  }

  decodeIdToken(idToken: string) {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return { sub: String(payload.sub), email: String(payload.email), name: payload.name };
  }

  private async call(url: string, init: RequestInit & { accessToken?: string } = {}): Promise<any> {
    const headers = new Headers(init.headers);
    if (init.accessToken) headers.set('authorization', `Bearer ${init.accessToken}`);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new GoogleApiError(0, 'network', `Google request failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    const json = text ? safeJson(text) : {};
    if (!res.ok) {
      const reason = json?.error?.errors?.[0]?.reason ?? json?.error?.status ?? (typeof json?.error === 'string' ? json.error : 'error');
      const message = json?.error?.message ?? json?.error_description ?? `Google API returned ${res.status}`;
      throw new GoogleApiError(res.status, reason, message);
    }
    return json;
  }

  getProfile(accessToken: string) {
    return this.call(`${GMAIL}/profile`, { accessToken });
  }

  sendMessage(accessToken: string, raw: string, threadId?: string) {
    return this.call(`${GMAIL}/messages/send`, {
      method: 'POST',
      accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
    });
  }

  getMessageMetadata(accessToken: string, id: string, headers: string[]) {
    const u = new URL(`${GMAIL}/messages/${encodeURIComponent(id)}`);
    u.searchParams.set('format', 'metadata');
    for (const h of headers) u.searchParams.append('metadataHeaders', h);
    return this.call(u.toString(), { accessToken });
  }

  listHistory(accessToken: string, startHistoryId: string, pageToken?: string) {
    const u = new URL(`${GMAIL}/history`);
    u.searchParams.set('startHistoryId', startHistoryId);
    u.searchParams.set('historyTypes', 'messageAdded');
    u.searchParams.set('maxResults', '500');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    return this.call(u.toString(), { accessToken });
  }

  listMessages(accessToken: string, opts: { labelIds?: string[]; pageToken?: string; maxResults?: number }) {
    const u = new URL(`${GMAIL}/messages`);
    for (const l of opts.labelIds ?? []) u.searchParams.append('labelIds', l);
    u.searchParams.set('maxResults', String(opts.maxResults ?? 100));
    if (opts.pageToken) u.searchParams.set('pageToken', opts.pageToken);
    return this.call(u.toString(), { accessToken });
  }

  watch(accessToken: string, topicName: string) {
    return this.call(`${GMAIL}/watch`, {
      method: 'POST',
      accessToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topicName, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' }),
    });
  }

  async stopWatch(accessToken: string) {
    await this.call(`${GMAIL}/stop`, { method: 'POST', accessToken });
  }
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}

// ───────────────────────── Fake implementation ─────────────────────────
/**
 * In-memory stand-in for Google used in local development (EMAIL_PROVIDER_MODE=fake)
 * and tests. The OAuth "consent screen" is a local route that immediately redirects
 * back with a code; sent mail is kept in `outbox` and can receive simulated replies.
 */
export class FakeGoogleApi implements GoogleApi {
  outbox: { id: string; threadId: string; raw: string; mime: string; account: string }[] = [];
  inbox: GmailMessageMeta[] = [];
  historyCounter = 1000;
  history: { id: string; messageId: string; threadId: string }[] = [];
  /** Queue of errors to throw from the next sendMessage calls (tests). */
  sendFailures: GoogleApiError[] = [];
  watchCalls = 0;
  now: () => Date = () => new Date();
  revoked: string[] = [];
  private codes = new Map<string, { email: string; scopes: string[] }>();
  private tokens = new Map<string, string>(); // token -> email

  constructor(private readonly config: Config) {}

  authorizeUrl({ state, scopes, loginHint }: { state: string; scopes: string[]; loginHint?: string }) {
    const u = new URL(`${this.config.API_BASE_URL}/oauth/google/fake-consent`);
    u.searchParams.set('state', state);
    u.searchParams.set('scope', scopes.join(' '));
    if (loginHint) u.searchParams.set('login_hint', loginHint);
    return u.toString();
  }

  /** Simulates the user clicking "Allow" on the consent screen. */
  issueCode(email: string, scopes: string[]) {
    const code = `fake-code-${randomBytes(6).toString('hex')}`;
    this.codes.set(code, { email, scopes });
    return code;
  }

  async exchangeCode(code: string): Promise<TokenSet> {
    const grant = this.codes.get(code);
    if (!grant) throw new GoogleApiError(400, 'invalid_grant', 'Bad code');
    this.codes.delete(code);
    // The email is encoded in the token so dev mailboxes survive a server restart.
    const refresh = `fake-refresh-${Buffer.from(grant.email).toString('base64url')}.${randomBytes(8).toString('hex')}`;
    this.tokens.set(refresh, grant.email);
    const idPayload = Buffer.from(JSON.stringify({ sub: `sub-${grant.email}`, email: grant.email, name: grant.email.split('@')[0] })).toString('base64url');
    return {
      access_token: `fake-access-${grant.email}`,
      refresh_token: refresh,
      expires_in: 3600,
      scope: grant.scopes.join(' '),
      id_token: `x.${idPayload}.y`,
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<TokenSet> {
    const encoded = refreshToken.match(/^fake-refresh-([A-Za-z0-9_-]+)\./)?.[1];
    const email = this.tokens.get(refreshToken) ?? (encoded ? Buffer.from(encoded, 'base64url').toString('utf8') : undefined);
    if (!email || this.revoked.includes(refreshToken)) throw new GoogleApiError(400, 'invalid_grant', 'Token has been expired or revoked.');
    return { access_token: `fake-access-${email}`, expires_in: 3600, scope: '' };
  }

  async revokeToken(token: string) {
    this.revoked.push(token);
  }

  decodeIdToken(idToken: string) {
    return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
  }

  private accountOf(accessToken: string) {
    return accessToken.replace('fake-access-', '');
  }

  async getProfile(accessToken: string) {
    return { emailAddress: this.accountOf(accessToken), historyId: String(this.historyCounter) };
  }

  async sendMessage(accessToken: string, raw: string, threadId?: string) {
    const failure = this.sendFailures.shift();
    if (failure) throw failure;
    const id = `msg-${randomBytes(6).toString('hex')}`;
    const tid = threadId ?? `thr-${randomBytes(6).toString('hex')}`;
    const mime = Buffer.from(raw, 'base64url').toString('utf8');
    this.outbox.push({ id, threadId: tid, raw, mime, account: this.accountOf(accessToken) });
    return { id, threadId: tid };
  }

  async getMessageMetadata(_at: string, id: string, headers: string[]): Promise<GmailMessageMeta> {
    const sent = this.outbox.find((m) => m.id === id);
    if (sent) {
      const mid = sent.mime.match(/^Message-ID: (.*)$/im)?.[1] ?? '';
      return { id, threadId: sent.threadId, labelIds: ['SENT'], payload: { headers: [{ name: 'Message-ID', value: mid.trim() }] } };
    }
    const msg = this.inbox.find((m) => m.id === id);
    if (!msg) throw new GoogleApiError(404, 'notFound', 'Message not found');
    const wanted = new Set(headers.map((h) => h.toLowerCase()));
    return { ...msg, payload: { ...msg.payload, headers: (msg.payload?.headers ?? []).filter((h) => wanted.has(h.name.toLowerCase())) } };
  }

  /** Test helper: deliver an inbound message into the connected mailbox. */
  receive(msg: { threadId: string; headers: Record<string, string>; labelIds?: string[]; mimeType?: string; snippet?: string }) {
    const id = `in-${randomBytes(6).toString('hex')}`;
    this.inbox.push({
      id,
      threadId: msg.threadId,
      labelIds: msg.labelIds ?? ['INBOX', 'UNREAD'],
      internalDate: String(this.now().getTime()),
      snippet: msg.snippet,
      payload: { mimeType: msg.mimeType ?? 'text/plain', headers: Object.entries(msg.headers).map(([name, value]) => ({ name, value })) },
    });
    this.historyCounter += 1;
    this.history.push({ id: String(this.historyCounter), messageId: id, threadId: msg.threadId });
    return id;
  }

  async listHistory(_at: string, startHistoryId: string): Promise<GmailHistoryPage> {
    const start = Number(startHistoryId);
    if (start < 100) throw new GoogleApiError(404, 'notFound', 'Requested entity was not found.');
    const items = this.history.filter((h) => Number(h.id) > start);
    return {
      historyId: String(this.historyCounter),
      history: items.map((h) => ({
        id: h.id,
        messagesAdded: [{ message: { id: h.messageId, threadId: h.threadId, labelIds: ['INBOX'] } }],
      })),
    };
  }

  async listMessages() {
    return { messages: this.inbox.map((m) => ({ id: m.id, threadId: m.threadId })) };
  }

  async watch() {
    this.watchCalls += 1;
    return { historyId: String(this.historyCounter), expiration: String(Date.now() + 7 * 86_400_000) };
  }

  async stopWatch() {}
}
