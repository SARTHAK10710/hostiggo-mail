/** True when recipients on the internet could open links on this host (not localhost / private LAN). */
export function isPublicUrl(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.replace(/^\[|\]$/g, '');
    return !(
      h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1' ||
      /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      /^169\.254\./.test(h) || /^f[cd][0-9a-f]{2}:/i.test(h) || /^fe80:/i.test(h)
    );
  } catch {
    return false;
  }
}
