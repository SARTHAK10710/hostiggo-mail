/**
 * Tiny, safe merge-field renderer.
 *   {{ contact.first_name }}
 *   {{ contact.first_name | default: "there" }}
 *   {{ unsubscribe_url }}
 * No code execution, no loops. Values are HTML-escaped in HTML bodies.
 */
const TAG = /\{\{\s*([a-zA-Z_][\w.]*)\s*(?:\|\s*default:\s*"((?:[^"\\]|\\.)*)"\s*)?\}\}/g;

export function extractVariables(...sources: (string | null | undefined)[]): string[] {
  const vars = new Set<string>();
  for (const src of sources) {
    if (!src) continue;
    for (const m of src.matchAll(TAG)) vars.add(m[1]);
  }
  return [...vars].sort();
}

function lookup(ctx: Record<string, unknown>, path: string): unknown {
  let cur: unknown = ctx;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderString(
  template: string,
  ctx: Record<string, unknown>,
  mode: 'html' | 'text' | 'header',
  missing?: Set<string>,
): string {
  return template.replace(TAG, (_m, path: string, def?: string) => {
    let value = lookup(ctx, path);
    if (value == null || value === '') {
      if (def !== undefined) value = def.replace(/\\(.)/g, '$1');
      else {
        missing?.add(path);
        value = '';
      }
    }
    const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (mode === 'html') return escapeHtml(str);
    if (mode === 'header') return str.replace(/[\r\n]+/g, ' ');
    return str;
  });
}

export interface TemplateContent {
  subject: string;
  html_body?: string | null;
  text_body?: string | null;
}

export interface RenderedMessage {
  subject: string;
  html: string | null;
  text: string | null;
  missing: string[];
}

export function renderMessage(
  content: TemplateContent,
  ctx: Record<string, unknown>,
  /** unsubscribeUrl: public web link. unsubscribeMailto: fallback when the server isn't reachable from the internet. */
  opts: { unsubscribeUrl?: string; unsubscribeMailto?: string; footer?: boolean } = {},
): RenderedMessage {
  const missing = new Set<string>();
  const unsubLink = opts.unsubscribeUrl ?? opts.unsubscribeMailto;
  const fullCtx = unsubLink ? { ...ctx, unsubscribe_url: unsubLink } : ctx;
  const subject = renderString(content.subject, fullCtx, 'header', missing).trim();
  let html = content.html_body ? renderString(content.html_body, fullCtx, 'html', missing) : null;
  let text = content.text_body ? renderString(content.text_body, fullCtx, 'text', missing) : null;
  if (!html && !text) text = '';

  // Marketing mail carries a visible unsubscribe path unless the operator turned the footer off.
  if (opts.footer === false) {
    // {{ unsubscribe_url }} placed in the template by hand still works.
  } else if (opts.unsubscribeUrl) {
    const url = opts.unsubscribeUrl;
    if (html && !html.includes(escapeHtml(url))) {
      const footer = `<p style="font-size:12px;color:#6b7280;margin-top:24px">Don't want these emails? <a href="${escapeHtml(url)}">Unsubscribe</a>.</p>`;
      html = html.includes('</body>') ? html.replace('</body>', `${footer}</body>`) : html + footer;
    }
    if (text !== null && !text.includes(url)) text = `${text}\n\n--\nUnsubscribe: ${url}\n`;
  } else if (opts.unsubscribeMailto) {
    // No public unsubscribe page: ask for a reply instead of linking to an address recipients can't open.
    const mailto = opts.unsubscribeMailto;
    if (html && !html.includes(escapeHtml(mailto))) {
      const footer = `<p style="font-size:12px;color:#6b7280;margin-top:24px">Don't want these emails? <a href="${escapeHtml(mailto)}">Reply with "unsubscribe"</a> and we'll stop.</p>`;
      html = html.includes('</body>') ? html.replace('</body>', `${footer}</body>`) : html + footer;
    }
    if (text !== null && !/unsubscribe/i.test(text)) text = `${text}\n\n--\nDon't want these emails? Reply with "unsubscribe" and we'll stop.\n`;
  }
  return { subject, html, text, missing: [...missing].filter((m) => m !== 'unsubscribe_url') };
}

/** Context object exposed to templates for a contact. */
export function contactContext(contact: {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  custom_fields?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    contact: {
      email: contact.email,
      first_name: contact.first_name ?? '',
      last_name: contact.last_name ?? '',
      full_name: [contact.first_name, contact.last_name].filter(Boolean).join(' '),
      ...(contact.custom_fields ?? {}),
    },
  };
}
