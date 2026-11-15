import { X, Loader2 } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ApiError } from './api';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ── Formatting ───────────────────────────────────────────────────────
export const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US'));
export const pct = (n: number | null | undefined, digits = 1) => (n == null || Number.isNaN(n) ? '—' : `${(n * 100).toFixed(digits)}%`);
export function timeAgo(d: string | Date | null | undefined) {
  if (!d) return '—';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (Math.abs(s) < 45) return s < 0 ? 'in a moment' : 'just now';
  const fmt = (v: number, u: string) => (s < 0 ? `in ${v}${u}` : `${v}${u} ago`);
  const a = Math.abs(s);
  if (a < 3600) return fmt(Math.round(a / 60), 'm');
  if (a < 86400) return fmt(Math.round(a / 3600), 'h');
  return fmt(Math.round(a / 86400), 'd');
}
export const dateTime = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export const errText = (e: unknown) => (e instanceof ApiError ? e.full : e instanceof Error ? e.message : String(e));

// ── Buttons ──────────────────────────────────────────────────────────
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-hover active:bg-brand-active border border-transparent',
  secondary: 'bg-white text-ink border border-line hover:bg-canvas hover:border-line-strong',
  ghost: 'bg-transparent text-muted hover:bg-slate-100 hover:text-ink border border-transparent',
  danger: 'bg-white text-rose-600 border border-rose-200 hover:bg-rose-50',
};
export function Button({ variant = 'secondary', loading, size = 'md', className, children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; size?: 'sm' | 'md' }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-[34px] px-3.5 text-[13px]',
        VARIANTS[variant],
        className,
      )}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
}

// ── Pills ────────────────────────────────────────────────────────────
const PILL = {
  transactional: 'bg-rose-100 border-rose-300 text-rose-700',
  marketing: 'bg-violet-100 border-violet-200 text-violet-700',
  automation: 'bg-lime-100 border-lime-200 text-lime-700',
  alert: 'bg-orange-100 border-orange-200 text-orange-700',
  success: 'bg-emerald-100 border-emerald-200 text-emerald-700',
  neutral: 'bg-slate-100 border-slate-200 text-slate-600',
  brand: 'bg-indigo-50 border-indigo-200 text-indigo-700',
  danger: 'bg-rose-50 border-rose-200 text-rose-700',
};
export type Tone = keyof typeof PILL;
export function Pill({ tone = 'neutral', children, dot, className }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={cx('inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[10px] font-bold uppercase tracking-[0.06em] whitespace-nowrap', PILL[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const SEND_STATUS: Record<string, [Tone, string]> = {
  queued: ['neutral', 'Queued'],
  sending: ['brand', 'Sending'],
  accepted: ['success', 'Accepted'],
  failed: ['danger', 'Failed'],
  suppressed: ['alert', 'Suppressed'],
  cancelled: ['neutral', 'Cancelled'],
  unknown: ['alert', 'Unknown'],
};
export function SendStatus({ status, replied, bounced }: { status: string; replied?: boolean; bounced?: boolean }) {
  if (bounced) return <Pill tone="danger" dot>Bounced</Pill>;
  if (replied) return <Pill tone="brand" dot>Replied</Pill>;
  const [tone, label] = SEND_STATUS[status] ?? ['neutral', status];
  return <Pill tone={tone} dot>{label}</Pill>;
}
export function KindPill({ kind }: { kind: string }) {
  const map: Record<string, [Tone, string]> = { transactional: ['transactional', 'Transactional'], marketing: ['marketing', 'Marketing'], test: ['neutral', 'Test'], automation: ['automation', 'Automation'] };
  const [tone, label] = map[kind] ?? ['neutral', kind];
  return <Pill tone={tone}>{label}</Pill>;
}

// ── Layout bits ──────────────────────────────────────────────────────
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('card', className)}>{children}</section>;
}
export function CardHeader({ title, subtitle, right, icon }: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3">
      <div className="flex items-start gap-2.5 min-w-0">
        {icon && <div className="mt-0.5 text-brand">{icon}</div>}
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold leading-5 tracking-tight">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[12px] text-muted">{subtitle}</p>}
        </div>
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}
export function PageHeader({ eyebrow, title, subtitle, actions }: { eyebrow?: ReactNode; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div>
        {eyebrow && <div className="mb-1 flex items-center gap-2 text-label-caps uppercase text-brand">{eyebrow}</div>}
        <h1 className="text-[22px] font-semibold leading-7 tracking-[-0.015em]">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] text-muted max-w-2xl">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
export function Stat({ label, value, sub, icon, accent }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode; accent?: string }) {
  return (
    <div className="card flex flex-col justify-between gap-2 p-4">
      <div className="flex items-center justify-between">
        <span className="caps">{label}</span>
        <span className={cx('text-brand', accent)}>{icon}</span>
      </div>
      <div className="tnum text-[26px] font-semibold leading-8 tracking-tight">{value}</div>
      {sub && <div className="text-[12px] text-muted">{sub}</div>}
    </div>
  );
}
export function Meter({ value, tone = 'bg-brand' }: { value: number; tone?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={cx('h-full rounded-full', tone)} style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </div>
  );
}
export function Field({ label, hint, children, right }: { label: string; hint?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-ink-2">{label}</span>
        {right}
      </div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-muted">{hint}</div>}
    </label>
  );
}
export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-slate-400">{icon}</div>}
      <div className="text-[14px] font-semibold">{title}</div>
      {children && <div className="max-w-md text-[12px] text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-10 text-muted">
      <Loader2 className="size-4 animate-spin" /> {label}
    </div>
  );
}
export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">{errText(error)}</div>;
}
export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[] }) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
      {items.map((i) => (
        <button
          key={i.value}
          type="button"
          onClick={() => onChange(i.value)}
          className={cx('rounded-md px-2.5 py-1 text-[12px] font-medium', value === i.value ? 'bg-white text-ink shadow-sm' : 'text-ink-2 hover:text-ink')}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}

// ── Overlays ─────────────────────────────────────────────────────────
export function Modal({ open, onClose, title, subtitle, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 pt-[8vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div className={cx('card w-full shadow-[0_20px_25px_-5px_rgba(15,23,42,0.12)]', wide ? 'max-w-4xl' : 'max-w-lg')} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h3 className="text-[18px] font-semibold leading-6">{title}</h3>
            {subtitle && <p className="mt-0.5 text-[12px] text-muted">{subtitle}</p>}
          </div>
          <button className="rounded p-1 text-muted hover:bg-slate-100" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 rounded-b-xl border-t border-line bg-canvas px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}
export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40" onMouseDown={onClose}>
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-xl flex-col border-l border-line-strong bg-white shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="text-[15px] font-semibold">{title}</div>
          <button className="rounded p-1 text-muted hover:bg-slate-100" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </aside>
    </div>
  );
}

// ── Toasts ───────────────────────────────────────────────────────────
type Toast = { id: number; text: string; tone: 'ok' | 'error' };
const ToastCtx = createContext<(text: string, tone?: 'ok' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={cx('rounded-lg border px-3.5 py-2.5 text-[13px] shadow-lg', t.tone === 'ok' ? 'border-emerald-200 bg-white text-ink' : 'border-rose-200 bg-rose-50 text-rose-800')}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
