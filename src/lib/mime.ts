import { randomBytes } from 'node:crypto';

export interface MimeInput {
  from: { email: string; name?: string | null };
  to: string;
  subject: string;
  html?: string | null;
  text?: string | null;
  replyTo?: string | null;
  messageId: string; // without angle brackets
  inReplyTo?: string | null;
  references?: string | null;
  /** mailto: and/or https: targets. One-click (RFC 8058) is only valid with an https target. */
  listUnsubscribe?: { urls: string[]; oneClick: boolean } | null;
  extraHeaders?: Record<string, string>;
}

const needsEncoding = (s: string) => /[^\x20-\x7e]/.test(s);

/** RFC 2047 encoded-word for non-ASCII header values. */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ');
  if (!needsEncoding(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

function formatAddress(email: string, name?: string | null): string {
  if (!name) return email;
  const safe = name.replace(/[\r\n"\\]/g, '');
  return needsEncoding(safe) ? `${encodeHeader(safe)} <${email}>` : `"${safe}" <${email}>`;
}

function base64Lines(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

function assertHeaderSafe(v: string, name: string) {
  if (/[\r\n]/.test(v)) throw new Error(`Header ${name} contains a line break`);
}

/** Build an RFC 5322 message. Bodies are base64 encoded so any UTF-8 content is safe. */
export function buildMime(input: MimeInput): string {
  assertHeaderSafe(input.to, 'To');
  assertHeaderSafe(input.from.email, 'From');
  const headers: string[] = [
    `From: ${formatAddress(input.from.email, input.from.name)}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${input.messageId}>`,
    'MIME-Version: 1.0',
  ];
  if (input.replyTo) {
    assertHeaderSafe(input.replyTo, 'Reply-To');
    headers.push(`Reply-To: ${input.replyTo}`);
  }
  if (input.inReplyTo) headers.push(`In-Reply-To: <${input.inReplyTo}>`);
  if (input.references) headers.push(`References: ${input.references}`);
  if (input.listUnsubscribe?.urls.length) {
    for (const u of input.listUnsubscribe.urls) assertHeaderSafe(u, 'List-Unsubscribe');
    headers.push(`List-Unsubscribe: ${input.listUnsubscribe.urls.map((u) => `<${u}>`).join(', ')}`);
    if (input.listUnsubscribe.oneClick) headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  }
  for (const [k, v] of Object.entries(input.extraHeaders ?? {})) {
    assertHeaderSafe(k + v, k);
    headers.push(`${k}: ${v}`);
  }

  const html = input.html ?? null;
  const text = input.text ?? null;
  let body: string;
  if (html && text) {
    const boundary = `hm_${randomBytes(12).toString('hex')}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(text),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(html),
      `--${boundary}--`,
      '',
    ].join('\r\n');
  } else {
    headers.push(`Content-Type: ${html ? 'text/html' : 'text/plain'}; charset="UTF-8"`);
    headers.push('Content-Transfer-Encoding: base64');
    body = base64Lines(html ?? text ?? '') + '\r\n';
  }
  return headers.join('\r\n') + '\r\n\r\n' + body;
}

/** Gmail API `raw` field: base64url of the full RFC 822 message. */
export const toGmailRaw = (mime: string) => Buffer.from(mime, 'utf8').toString('base64url');

export const newMessageId = (domain: string) => `${randomBytes(16).toString('hex')}@${domain}`;
