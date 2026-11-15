import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen, ChevronDown, Code2, Contact, FileCode2, LayoutDashboard, LogOut, Megaphone, Menu, Receipt, Search, Send, Settings, ShieldCheck, Workflow, X,
} from 'lucide-react';
import { Suspense, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { api } from './api';
import { useAuth } from './auth';
import { useActiveMailboxes, useMailboxes, useSystem } from './hooks';
import { Button, Field, Modal, Spinner, cx, errText, num, useToast } from './ui';

const NAV: { to: string; label: string; icon: ReactNode; dot?: string }[] = [
  { to: '/', label: 'Overview', icon: <LayoutDashboard className="size-4" /> },
  { to: '/automations', label: 'Automations', icon: <Workflow className="size-4" />, dot: 'bg-lime-400' },
  { to: '/transactional', label: 'Transactional Emails', icon: <Receipt className="size-4" />, dot: 'bg-rose-500' },
  { to: '/marketing', label: 'Marketing Emails', icon: <Megaphone className="size-4" />, dot: 'bg-violet-400' },
  { to: '/deliverability', label: 'Deliverability', icon: <ShieldCheck className="size-4" />, dot: 'bg-orange-400' },
  { to: '/contacts', label: 'Contacts', icon: <Contact className="size-4" /> },
  { to: '/templates', label: 'Templates', icon: <FileCode2 className="size-4" /> },
  { to: '/settings/api', label: 'API & Webhooks', icon: <Code2 className="size-4" /> },
];

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid size-8 place-items-center rounded-lg bg-brand text-[15px] font-bold text-white">H</div>
      <div className="leading-tight">
        <div className="text-[15px] font-semibold text-white">Hostiggo Mail</div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-400">Operations</div>
      </div>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const sys = useSystem();
  const live = sys.data?.delivers_real_email;
  return (
    <nav className="flex h-full w-60 flex-col bg-shell text-slate-300">
      <div className="px-4 py-4">
        <Logo />
      </div>
      <div className="px-4 pb-2 pt-3 text-label-caps uppercase text-slate-500">Operations core</div>
      <div className="flex flex-col gap-0.5 px-2">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            onClick={onNavigate}
            className={({ isActive }) =>
              cx('flex h-[34px] items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors', isActive ? 'bg-brand text-white' : 'hover:bg-shell-active hover:text-white')
            }
          >
            <span className={cx('size-1.5 rounded-full', n.dot ?? 'bg-transparent')} />
            {n.icon}
            <span className="truncate">{n.label}</span>
          </NavLink>
        ))}
      </div>
      <div className="mt-auto flex flex-col gap-1 border-t border-shell-line p-2">
        <Link to="/settings" onClick={onNavigate} className={cx('flex items-center gap-2 rounded-md px-2.5 py-2 text-[12px] font-semibold', live ? 'bg-emerald-950/40 text-emerald-300' : 'bg-orange-950/40 text-orange-300')}>
          <span className={cx('size-2 rounded-full', live ? 'bg-emerald-400' : 'bg-orange-400')} />
          {sys.data ? (live ? 'Gmail delivery live' : 'Dev mode: not delivering') : 'Checking…'}
        </Link>
        <a href="https://developers.google.com/workspace/gmail/api/guides/sending" target="_blank" rel="noreferrer" className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[12px] hover:bg-shell-active hover:text-white">
          <BookOpen className="size-4" /> Gmail API docs
        </a>
        <NavLink to="/settings" end onClick={onNavigate} className={({ isActive }) => cx('flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[12px]', isActive ? 'bg-shell-active text-white' : 'hover:bg-shell-active hover:text-white')}>
          <Settings className="size-4" /> Settings
        </NavLink>
      </div>
    </nav>
  );
}

function Quota() {
  const mb = useActiveMailboxes();
  const boxes = mb.data ?? [];
  const used = boxes.reduce((s, m) => s + m.sent_last_24h, 0);
  const limit = boxes.reduce((s, m) => s + m.effective_daily_limit, 0);
  if (!boxes.length) return null;
  return (
    <div className="hidden min-w-36 lg:block" title="Messages accepted by Gmail in the last 24 hours across connected mailboxes">
      <div className="text-label-caps uppercase text-slate-500">Sent quota (24h)</div>
      <div className="mt-0.5 flex items-center gap-2">
        <span className="tnum font-mono text-[11px] text-ink-2">{num(used)} / {num(limit)}</span>
        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200">
          <div className="h-full bg-brand" style={{ width: `${limit ? Math.min(100, (used / limit) * 100) : 0}%` }} />
        </div>
      </div>
    </div>
  );
}

export function SendTestModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mb = useActiveMailboxes();
  const sys = useSystem();
  const { me } = useAuth();
  const [mailboxId, setMailboxId] = useState('');
  const [to, setTo] = useState('');
  const toast = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  const boxes = mb.data ?? [];
  const chosen = mailboxId || boxes[0]?.id || '';
  const send = useMutation({
    mutationFn: () => api(`/v1/mailboxes/${chosen}/test`, { body: { to: to || me?.user.email } }),
    onSuccess: (r: any) => {
      toast(sys.data?.delivers_real_email ? 'Test email queued. Check the inbox in a few seconds.' : 'Queued in dev mode (not delivered). See it in Settings → Dev outbox.');
      qc.invalidateQueries({ queryKey: ['sends'] });
      onClose();
      nav(`/transactional?send=${r.id}`);
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send a test email"
      subtitle="Sends a short plain-text message through a connected mailbox."
      footer={
        boxes.length ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={send.isPending} onClick={() => send.mutate()}>
              <Send className="size-3.5" /> Send test
            </Button>
          </>
        ) : undefined
      }
    >
      {boxes.length === 0 ? (
        <div className="space-y-3 text-[13px]">
          <p>No mailbox is connected yet. Connect a Gmail account first.</p>
          <Button variant="primary" onClick={() => { onClose(); nav('/deliverability'); }}>Connect Gmail</Button>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); send.mutate(); }}>
          {!sys.data?.delivers_real_email && (
            <div className="rounded-md border border-orange-200 bg-orange-50 px-3 py-2 text-[12px] text-orange-800">
              The server is in <b>dev mode</b>: messages are recorded but not delivered. Set up Gmail in Settings to send real email.
            </div>
          )}
          <Field label="From mailbox">
            <select className="input" value={chosen} onChange={(e) => setMailboxId(e.target.value)}>
              {boxes.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
            </select>
          </Field>
          <Field label="Send to" hint="Defaults to your own sign-in email.">
            <input className="input" type="email" placeholder={me?.user.email} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </form>
      )}
    </Modal>
  );
}

export function AppLayout() {
  const { me, workspace, switchWorkspace, signOut } = useAuth();
  const [menu, setMenu] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [q, setQ] = useState('');
  const nav = useNavigate();
  useMailboxes();
  return (
    <div className="flex h-full">
      <div className="sticky top-0 hidden h-screen shrink-0 lg:block">
        <Sidebar />
      </div>
      {mobileNav && (
        <div className="fixed inset-0 z-40 bg-slate-900/50 lg:hidden" onClick={() => setMobileNav(false)}>
          <div className="h-full w-60" onClick={(e) => e.stopPropagation()}>
            <Sidebar onNavigate={() => setMobileNav(false)} />
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-white/95 px-4 backdrop-blur">
          <button className="rounded p-1.5 text-muted hover:bg-slate-100 lg:hidden" onClick={() => setMobileNav(true)} aria-label="Open navigation">
            {mobileNav ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
          <div className="relative">
            <select
              className="h-[34px] max-w-48 appearance-none truncate rounded-md border border-line bg-slate-50 pl-2.5 pr-7 text-[13px] font-medium"
              value={workspace?.id ?? ''}
              onChange={(e) => switchWorkspace(e.target.value)}
              aria-label="Workspace"
            >
              {me?.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-2.5 size-3.5 text-muted" />
          </div>
          <form className="relative hidden max-w-xs flex-1 md:block" onSubmit={(e) => { e.preventDefault(); nav(`/contacts?search=${encodeURIComponent(q)}`); }}>
            <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted" />
            <input className="input pl-8" placeholder="Search contacts…" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          <div className="ml-auto flex items-center gap-3">
            <Quota />
            <Button variant="primary" onClick={() => setTestOpen(true)}>
              <Send className="size-3.5" /> <span className="hidden sm:inline">Send Test Email</span>
            </Button>
            <div className="relative">
              <button className="flex items-center gap-2 rounded-md p-1 hover:bg-slate-100" onClick={() => setMenu((m) => !m)}>
                <div className="grid size-8 place-items-center rounded-full bg-slate-800 text-[12px] font-semibold uppercase text-white">{me?.user.email[0]}</div>
                <div className="hidden text-left leading-tight xl:block">
                  <div className="max-w-40 truncate text-[12px] font-semibold">{me?.user.email}</div>
                  <div className="text-[11px] capitalize text-muted">{workspace?.role}</div>
                </div>
              </button>
              {menu && (
                <div className="absolute right-0 mt-1 w-56 rounded-lg border border-line bg-white py-1 shadow-lg" onMouseLeave={() => setMenu(false)}>
                  <div className="truncate px-3 py-2 text-[12px] text-muted">{me?.user.email}</div>
                  <Link to="/settings" className="block px-3 py-1.5 text-[13px] hover:bg-canvas" onClick={() => setMenu(false)}>Settings</Link>
                  <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-rose-600 hover:bg-rose-50" onClick={() => signOut()}>
                    <LogOut className="size-3.5" /> Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1440px] flex-1 space-y-5 p-4 md:p-6">
          <Suspense fallback={<Spinner />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <SendTestModal open={testOpen} onClose={() => setTestOpen(false)} />
    </div>
  );
}
