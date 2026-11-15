/**
 * Tiny API client for the Hostiggo Mail backend (same origin; Vite proxies in dev).
 * The session itself lives in an httpOnly cookie set by the server, so scripts on the page can never read it.
 * Only the selected workspace id is remembered here.
 */
const WS_KEY = 'hm.workspace';
const LEGACY_TOKEN_KEY = 'hm.session';

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

// Older versions kept the bearer token in localStorage; remove it so it can't be stolen later.
write(LEGACY_TOKEN_KEY, null);

export const session = {
  get workspaceId() {
    return read(WS_KEY);
  },
  setWorkspace(id: string | null) {
    write(WS_KEY, id);
  },
  clear() {
    write(WS_KEY, null);
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  /** Human-friendly text including validation details. */
  get full() {
    if (Array.isArray(this.details) && this.details.length) {
      const items = this.details.map((d: any) => (typeof d === 'string' ? d : d.path ? `${d.path}: ${d.message}` : JSON.stringify(d)));
      return `${this.message}: ${items.join('; ')}`;
    }
    return this.message;
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (session.workspaceId) headers['x-workspace-id'] = session.workspaceId;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, credentials: 'same-origin', body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON (csv) */
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/v1/auth/')) onUnauthorized();
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return data as T;
}

/** Authenticated file download (CSV error reports). */
export async function download(path: string, filename: string) {
  const headers: Record<string, string> = {};
  if (session.workspaceId) headers['x-workspace-id'] = session.workspaceId;
  const res = await fetch(path, { headers, credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, 'download_failed', 'Download failed');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
