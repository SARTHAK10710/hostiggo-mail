import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, CircleDashed, Inbox, MailPlus, Plus, ShieldCheck, Trash2, Unplug } from 'lucide-react';
import { Link } from 'react-router';
import { useState } from 'react';
import { api } from '../api';
import { canEdit, isAdmin, useAuth } from '../auth';
import { useMailboxes, useSystem, type Mailbox } from '../hooks';
import { Button, Card, CardHeader, Empty, ErrorBox, Field, Meter, Modal, PageHeader, Pill, Spinner, Stat, Tabs, cx, dateTime, errText, num, pct, timeAgo, useToast } from '../ui';

export function useConnectGmail() {
  const toast = useToast();
  return useMutation({
    mutationFn: (login_hint?: string) => api('/v1/mailboxes/google/authorize', { body: login_hint ? { login_hint } : {} }),
    onSuccess: (r: any) => { window.location.href = r.url; },
    onError: (e) => toast(errText(e), 'error'),
  });
}

export function DeliverabilityPage() {
  const d = useQuery({ queryKey: ['deliverability'], queryFn: () => api('/v1/deliverability'), refetchInterval: 30_000 });
  const connect = useConnectGmail();
  const { workspace } = useAuth();
  const r = d.data?.last_30_days;
  return (
    <>
      <PageHeader
        eyebrow={<Pill tone="alert">Deliverability</Pill>}
        title="Deliverability & Mailbox Health"
        subtitle="Gmail connection status, bounce and complaint signals, and the suppression list that protects your sender reputation."
        actions={isAdmin(workspace?.role) && <Button variant="primary" className="bg-orange-500 hover:bg-orange-600" loading={connect.isPending} onClick={() => connect.mutate(undefined)}><MailPlus className="size-3.5" /> Connect Gmail account</Button>}
      />
      <SetupBanner />
      <MailboxCards />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Accepted (30 days)" icon={<CheckCircle2 className="size-4" />} accent="text-emerald-600" value={num(r?.accepted)} sub={`${num(r?.failed)} failed sends`} />
        <Stat label="Bounce rate" icon={<CircleAlert className="size-4" />} accent="text-orange-500" value={pct(r?.bounce_rate, 2)} sub={<span className="block space-y-1.5"><span className="block">{num(r?.bounced)} bounced · target &lt; 2%</span><Meter value={(r?.bounce_rate ?? 0) / 0.02} tone={(r?.bounce_rate ?? 0) < 0.02 ? 'bg-emerald-600' : 'bg-rose-500'} /></span>} />
        <Stat label="Spam complaint rate" icon={<ShieldCheck className="size-4" />} accent="text-orange-500" value={pct(r?.complaint_rate, 2)} sub={<span className="block space-y-1.5"><span className="block">{num(r?.complained)} complaints · target &lt; 0.1%</span><Meter value={(r?.complaint_rate ?? 0) / 0.001} tone={(r?.complaint_rate ?? 0) < 0.001 ? 'bg-emerald-600' : 'bg-rose-500'} /></span>} />
        <Stat label="Unsubscribes (30 days)" icon={<Unplug className="size-4" />} accent="text-violet-500" value={num(r?.unsubscribed)} sub="One-click + link unsubscribes" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader title="Sender standards checklist" subtitle="What Gmail and Yahoo expect from senders, checked against this workspace." icon={<ShieldCheck className="size-4" />} />
          <div className="space-y-2 px-5 pb-5">
            {d.isLoading && <Spinner />}
            {d.data?.checklist.map((c: any) => (
              <div key={c.key} className={cx('flex items-center gap-3 rounded-lg px-3 py-2.5', c.ok === false ? 'bg-orange-50' : 'bg-canvas')}>
                {c.ok === true ? <CheckCircle2 className="size-4 shrink-0 text-emerald-600" /> : c.ok === false ? <CircleAlert className="size-4 shrink-0 text-orange-500" /> : <CircleDashed className="size-4 shrink-0 text-slate-400" />}
                <span className="flex-1 text-[13px]">{c.label}</span>
                <span className={cx('font-mono text-[11px] font-semibold', c.ok === true ? 'text-emerald-700' : c.ok === false ? 'text-orange-700' : 'text-muted')}>
                  {c.value != null ? pct(c.value, 2) : c.ok === true ? 'OK' : c.ok === false ? 'Action needed' : 'Later'}
                </span>
              </div>
            ))}
            <p className="pt-1 text-[11px] text-muted">{d.data?.note}</p>
          </div>
        </Card>
        <Card>
          <CardHeader title="Top failure reasons" subtitle="Failed or unknown sends in the last 30 days." />
          <div className="px-5 pb-5">
            {d.data?.top_failures?.length ? (
              <div className="space-y-2">
                {d.data.top_failures.map((f: any) => (
                  <div key={f.error_code ?? 'none'} className="flex items-center justify-between rounded-md bg-canvas px-3 py-2">
                    <span className="font-mono text-[12px]">{f.error_code ?? 'unspecified'}</span>
                    <span className="text-[12px] text-muted"><b className="tnum text-ink">{f.n}</b> · last {timeAgo(f.last_seen)}</span>
                  </div>
                ))}
              </div>
            ) : <Empty icon={<CheckCircle2 className="size-6 text-emerald-500" />} title="No failures" />}
          </div>
        </Card>
      </div>

      <SuppressionTable counts={d.data?.suppressions ?? {}} />
    </>
  );
}

export function SetupBanner() {
  const sys = useSystem();
  if (!sys.data || sys.data.delivers_real_email) return null;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-orange-200 bg-orange-50 p-4 text-[13px] text-orange-900 md:flex-row md:items-center md:justify-between">
      <div>
        <div className="font-semibold">Dev mode: emails are recorded but not delivered.</div>
        <div className="text-[12px]">The server runs with <span className="font-mono">EMAIL_PROVIDER_MODE=fake</span>, so "Connect Gmail" opens a stand-in consent screen. To send real email, add Google OAuth credentials (Settings → Gmail setup).</div>
      </div>
      <Link to="/settings/gmail"><Button size="sm">How to enable real sending</Button></Link>
    </div>
  );
}

export function MailboxCards() {
  const mb = useMailboxes();
  const qc = useQueryClient();
  const toast = useToast();
  const { workspace } = useAuth();
  const connect = useConnectGmail();
  const [disconnecting, setDisconnecting] = useState<Mailbox | null>(null);
  const [limitFor, setLimitFor] = useState<Mailbox | null>(null);
  const live = (mb.data ?? []).filter((m) => m.status !== 'disconnected');
  const sys = useSystem();
  const sync = useMutation({
    mutationFn: (id: string) => api(`/v1/mailboxes/${id}/sync`, { method: 'POST' }),
    onSuccess: () => {
      toast('Checking the inbox for replies… counts update within a minute');
      setTimeout(() => qc.invalidateQueries(), 8000);
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => api(`/v1/mailboxes/${id}/disconnect`, { method: 'POST' }),
    onSuccess: () => { toast('Mailbox disconnected and Google access revoked'); qc.invalidateQueries(); setDisconnecting(null); },
    onError: (e) => toast(errText(e), 'error'),
  });
  if (mb.isLoading) return <Spinner />;
  if (!live.length) {
    return (
      <Card>
        <Empty icon={<Inbox className="size-7" />} title="No Gmail mailbox connected"
          action={isAdmin(workspace?.role) ? <Button variant="primary" loading={connect.isPending} onClick={() => connect.mutate(undefined)}><MailPlus className="size-3.5" /> Connect Gmail</Button> : undefined}>
          Each sender authorizes Hostiggo Mail with Google and can disconnect at any time. Gmail allows about 500 messages/day on personal accounts and 2,000 on Workspace accounts.
        </Empty>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {live.map((m) => (
        <Card key={m.id} className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-indigo-50 text-brand"><Inbox className="size-5" /></div>
              <div className="min-w-0">
                <div className="truncate font-mono text-[14px] font-semibold">{m.email}</div>
                <div className="text-[12px] text-muted">Connected {timeAgo(m.created_at)}{m.display_name ? ` · sends as "${m.display_name}"` : ''}</div>
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-1">
              <Pill tone={m.status === 'active' ? 'success' : 'danger'} dot>{m.status.replace('_', ' ')}</Pill>
              {m.health === 'unhealthy' && <Pill tone="danger">Unhealthy</Pill>}
            </div>
          </div>
          {m.last_error && <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-800">{m.last_error}</div>}
          <div className="mt-4 grid grid-cols-2 gap-3 text-[12px]">
            <div className="rounded-lg bg-canvas p-3">
              <div className="caps">Sent last 24h</div>
              <div className="tnum mt-1 font-mono text-[13px] font-semibold">{num(m.sent_last_24h)} / {num(m.daily_send_limit)}</div>
              <div className="mt-1.5"><Meter value={m.sent_last_24h / m.daily_send_limit} /></div>
            </div>
            <div className="rounded-lg bg-canvas p-3">
              <div className="caps">Reply tracking</div>
              <div className="mt-1 font-medium">{m.reply_tracking ? 'Enabled' : 'Send-only permission'}</div>
              <div className="mt-0.5 text-[11px] text-muted">{m.reply_tracking ? (m.watch_expires_at ? `Push watch until ${dateTime(m.watch_expires_at)}` : `Polling · last sync ${timeAgo(m.last_synced_at)}`) : 'Replies are not read'}</div>
            </div>
          </div>
          {canEdit(workspace?.role) && (
            <div className="mt-4 flex flex-wrap gap-2">
              {m.status === 'reauth_required' && <Button size="sm" variant="primary" onClick={() => connect.mutate(m.email)}>Reconnect</Button>}
              {m.status === 'active' && m.reply_tracking && <Button size="sm" loading={sync.isPending && sync.variables === m.id} onClick={() => sync.mutate(m.id)}>Check for replies now</Button>}
              {m.status === 'active' && !m.reply_tracking && sys.data?.reply_tracking_enabled && isAdmin(workspace?.role) && (
                <Button size="sm" variant="primary" onClick={() => connect.mutate(m.email)}>Reconnect to track replies</Button>
              )}
              {isAdmin(workspace?.role) && <Button size="sm" onClick={() => setLimitFor(m)}>Daily limit</Button>}
              {isAdmin(workspace?.role) && <Button size="sm" variant="danger" onClick={() => setDisconnecting(m)}><Unplug className="size-3.5" /> Disconnect</Button>}
            </div>
          )}
        </Card>
      ))}
      <Modal open={!!disconnecting} onClose={() => setDisconnecting(null)} title="Disconnect mailbox?" subtitle={disconnecting?.email}
        footer={<><Button onClick={() => setDisconnecting(null)}>Keep connected</Button><Button variant="danger" loading={disconnect.isPending} onClick={() => disconnect.mutate(disconnecting!.id)}>Disconnect & revoke</Button></>}>
        <ul className="list-disc space-y-1 pl-5 text-[13px]">
          <li>Google access is revoked and the stored token is deleted.</li>
          <li>Queued messages from this mailbox are cancelled.</li>
          <li>Live automations sending from it are paused.</li>
        </ul>
      </Modal>
      {limitFor && <LimitModal mailbox={limitFor} onClose={() => setLimitFor(null)} />}
    </div>
  );
}

function LimitModal({ mailbox, onClose }: { mailbox: Mailbox; onClose: () => void }) {
  const [v, setV] = useState(String(mailbox.daily_send_limit));
  const qc = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: () => api(`/v1/mailboxes/${mailbox.id}`, { method: 'PATCH', body: { daily_send_limit: Number(v) } }),
    onSuccess: () => { toast('Daily limit updated'); qc.invalidateQueries({ queryKey: ['mailboxes'] }); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title="Daily send limit" subtitle={mailbox.email} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <Field label="Messages per rolling 24 hours" hint="Gmail's own caps (≈500 personal, ≈2,000 Workspace) are shared with every other app using this mailbox, so stay comfortably below them. Extra messages wait in the queue.">
        <input className="input" type="number" min={1} max={2000} value={v} onChange={(e) => setV(e.target.value)} />
      </Field>
      <ErrorBox error={save.error} />
    </Modal>
  );
}

function SuppressionTable({ counts }: { counts: Record<string, number> }) {
  const [reason, setReason] = useState<'all' | 'bounced' | 'complained' | 'unsubscribed' | 'manual'>('all');
  const [email, setEmail] = useState('');
  const [adding, setAdding] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const { workspace } = useAuth();
  const p = new URLSearchParams({ limit: '100' });
  if (reason !== 'all') p.set('reason', reason);
  if (email.includes('@')) p.set('email', email);
  const q = useQuery({ queryKey: ['suppressions', p.toString()], queryFn: async () => (await api(`/v1/suppressions?${p}`)).data as any[] });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/v1/suppressions/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast('Suppression removed'); qc.invalidateQueries({ queryKey: ['suppressions'] }); qc.invalidateQueries({ queryKey: ['deliverability'] }); },
    onError: (e) => toast(errText(e), 'error'),
  });
  const tone: Record<string, any> = { bounced: 'danger', complained: 'alert', unsubscribed: 'marketing', manual: 'neutral' };
  return (
    <Card>
      <CardHeader title="Suppression list" subtitle="Global to this workspace and checked before every send. Bounces and complaints block all mail; unsubscribes block marketing."
        right={canEdit(workspace?.role) && <Button size="sm" onClick={() => setAdding(true)}><Plus className="size-3.5" /> Add suppression</Button>} />
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pb-3">
        <Tabs value={reason} onChange={setReason} items={[
          { value: 'all', label: 'All' },
          { value: 'bounced', label: `Hard bounces (${counts.bounced ?? 0})` },
          { value: 'complained', label: `Complaints (${counts.complained ?? 0})` },
          { value: 'unsubscribed', label: `Unsubscribed (${counts.unsubscribed ?? 0})` },
          { value: 'manual', label: `Manual (${counts.manual ?? 0})` },
        ]} />
        <input className="input w-64" placeholder="Exact email…" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      {q.isLoading ? <Spinner /> : q.data?.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead><tr><th className="th">Address</th><th className="th">Reason</th><th className="th">Source</th><th className="th">Logged</th><th className="th text-right">Actions</th></tr></thead>
            <tbody>
              {q.data.map((s) => (
                <tr key={s.id} className="row-hover">
                  <td className="td font-mono text-[12px]">{s.email}</td>
                  <td className="td"><Pill tone={tone[s.reason]} dot>{s.reason}</Pill></td>
                  <td className="td max-w-72 truncate font-mono text-[11px] text-muted">{s.source}</td>
                  <td className="td font-mono text-[11px] text-muted">{dateTime(s.created_at)}</td>
                  <td className="td text-right">
                    {isAdmin(workspace?.role) && <button className="rounded p-1 text-rose-500 hover:bg-rose-50" title="Remove suppression" onClick={() => confirm(`Allow mail to ${s.email} again?`) && remove.mutate(s.id)}><Trash2 className="size-4" /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty icon={<ShieldCheck className="size-6" />} title="No suppressed addresses" />}
      {adding && <AddSuppression onClose={() => setAdding(false)} />}
    </Card>
  );
}

function AddSuppression({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('manual');
  const qc = useQueryClient();
  const toast = useToast();
  const add = useMutation({
    mutationFn: () => api('/v1/suppressions', { body: { email, reason } }),
    onSuccess: () => { toast('Address suppressed'); qc.invalidateQueries({ queryKey: ['suppressions'] }); qc.invalidateQueries({ queryKey: ['deliverability'] }); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title="Add suppression" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={add.isPending} onClick={() => add.mutate()}>Suppress</Button></>}>
      <div className="space-y-3">
        <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Reason">
          <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="manual">Manual block (all marketing)</option>
            <option value="unsubscribed">Unsubscribed (they asked to stop)</option>
          </select>
        </Field>
        <ErrorBox error={add.error} />
      </div>
    </Modal>
  );
}

