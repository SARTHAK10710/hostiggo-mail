/** Normalise an address for duplicate checks: trim whitespace, lower-case. */
export function normalizeEmail(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/^mailto:/i, '')
    .toLowerCase();
}

// Pragmatic validation: one @, no spaces, dotted domain with a 2+ letter TLD.
const EMAIL_RE = /^[^\s@"<>(),;:\\[\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email) && !email.includes('..');
}

/** Extract a bare address from a header value like `"Jane" <jane@x.com>`. */
export function parseAddress(header: string | undefined | null): string | null {
  if (!header) return null;
  const angle = header.match(/<([^>]+)>/);
  const candidate = normalizeEmail(angle ? angle[1] : header.split(',')[0]);
  return candidate.includes('@') ? candidate : null;
}
