import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, CalendarClock, CheckCircle2, CircleAlert, MailOpen, Megaphone, PenLine, Plus, Rocket, ShieldCheck, Users, XCircle } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { canEdit, useAuth } from '../auth';
import { useActiveMailboxes, useLists, useSystem, useTemplates } from '../hooks';
import { Button, Card, CardHeader, Empty, ErrorBox, Field, Modal, PageHeader, Pill, Spinner, Tabs, cx, dateTime, errText, num, pct, timeAgo, useToast } from '../ui';

const STATUS: Record<string, any> = { draft: 'neutral', scheduled: 'brand', sending: 'brand', sent: 'success', cancelled: 'danger' };

export function MarketingPage() {
  const [filter, setFilter] = useState<'all' | 'draft' | 'scheduled' | 'sent' | 'cancelled'>('all');
  const [editing, setEditing] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['campaigns'], queryFn: async () => (await api('/v1/campaigns')).data as any[], refetchInterval: 15_000 });
  const { workspace } = useAuth();
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => api('/v1/campaigns', { body: { name: `Untitled campaign · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` } }),
    onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ['campaigns'] }); setEditing(r.id); },
  });
  const rows = (q.data ?? []).filter((c) => filter === 'all' || c.status === filter || (filter === 'scheduled' && c.status === 'sending'));
  const count = (s: string) => (q.data ?? []).filter((c) => c.status === s).length;
  const draft = editing ?? q.data?.find((c) => c.status === 'draft')?.id ?? null;

  return (
    <>
      <PageHeader eyebrow={<><span>Delivery operations</span><span className="text-muted">›</span><span>Campaign orchestration</span></>} title="Marketing Emails & Campaigns"
        subtitle="One-off broadcasts to opted-in lists, with an explicit send review. Gmail campaigns are kept small; bulk sending needs an ESP adapter."
        actions={canEdit(workspace?.role) && <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}><Plus className="size-3.5" /> Create campaign</Button>} />

      {draft && canEdit(workspace?.role) ? <Composer key={draft} id={draft} onDone={() => setEditing(null)} /> : (
        <Card><Empty icon={<Megaphone className="size-7 text-violet-500" />} title="No draft in progress" action={canEdit(workspace?.role) ? <Button variant="primary" size="sm" onClick={() => create.mutate()}>Start a campaign</Button> : undefined}>Pick an opted-in list, a marketing template and a mailbox, then review who will receive it.</Empty></Card>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          <div className="card flex flex-wrap items-center justify-between gap-2 p-3">
            <Tabs value={filter} onChange={setFilter} items={[
              { value: 'all', label: `All (${q.data?.length ?? 0})` }, { value: 'scheduled', label: `Scheduled (${count('scheduled') + count('sending')})` },
              { value: 'sent', label: `Sent (${count('sent')})` }, { value: 'draft', label: `Drafts (${count('draft')})` }, { value: 'cancelled', label: `Cancelled (${count('cancelled')})` },
            ]} />
          </div>
          {q.isLoading && <Spinner />}
          {rows.map((c) => <CampaignCard key={c.id} c={c} onEdit={() => setEditing(c.id)} active={draft === c.id} />)}
          {q.data && rows.length === 0 && <Card><Empty title="No campaigns here" /></Card>}
        </div>
        <ComplianceCard />
      </div>
    </>
  );
}

function Tile({ n, label, icon, done, active, children }: { n: string; label: string; icon: ReactNode; done: boolean; active?: boolean; children: ReactNode }) {
  return (
    <div className={cx('flex flex-col gap-2 rounded-lg p-4', active ? 'bg-indigo-50 ring-1 ring-indigo-200' : 'bg-canvas')}>
      <div className="flex items-center justify-between">
        <Pill tone={done ? 'success' : active ? 'brand' : 'neutral'}>{done ? '✓ ' : ''}{n} {label}</Pill>
        <span className="text-brand">{icon}</span>
      </div>
      {children}
    </div>
  );
}

function Composer({ id, onDone }: { id: string; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const c = useQuery({ queryKey: ['campaign', id], queryFn: () => api(`/v1/campaigns/${id}`) });
  const lists = useLists();
  const templates = useTemplates('marketing');
  const mailboxes = useActiveMailboxes();
  const [f, setF] = useState({ name: '', list_id: '', template_id: '', mailbox_id: '' });
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => { if (c.data) setF({ name: c.data.name, list_id: c.data.list_id ?? '', template_id: c.data.template_id ?? '', mailbox_id: c.data.mailbox_id ?? '' }); }, [c.data]);

  const save = useMutation({
    mutationFn: (patch: Partial<typeof f>) => api(`/v1/campaigns/${id}`, { method: 'PUT', body: Object.fromEntries(Object.entries({ ...f, ...patch }).map(([k, v]) => [k, v || undefined])) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaigns'] }); qc.invalidateQueries({ queryKey: ['campaign-review', id] }); },
    onError: (e) => toast(errText(e), 'error'),
  });
  const set = (k: keyof typeof f) => (v: string) => { setF((s) => ({ ...s, [k]: v })); save.mutate({ [k]: v }); };
  const review = useQuery({ queryKey: ['campaign-review', id], queryFn: () => api(`/v1/campaigns/${id}/review`) });
  const tpl = templates.data?.find((t) => t.id === f.template_id);
  const list = lists.data?.find((l) => l.id === f.list_id);
  const mb = mailboxes.data?.find((m) => m.id === f.mailbox_id);
  if (c.isLoading) return <Card><Spinner /></Card>;
  if (c.data?.status !== 'draft') return null;

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="size-2.5 rounded-full bg-brand" />
        <Pill tone="brand">Composer</Pill>
        <input className="min-w-60 flex-1 rounded-md border border-transparent px-1.5 py-0.5 text-[15px] font-semibold hover:border-line focus:border-brand focus:outline-none" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} onBlur={() => save.mutate({})} />
        <span className="font-mono text-[11px] text-muted">{save.isPending ? 'Saving…' : `Autosaved ${timeAgo(c.data.updated_at)}`}</span>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Tile n="01" label="Recipients" icon={<Users className="size-4" />} done={!!f.list_id}>
          <select className="input" value={f.list_id} onChange={(e) => set('list_id')(e.target.value)}>
            <option value="">Choose a list…</option>
            {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name} ({num(l.member_count)})</option>)}
          </select>
          {review.data?.audience && list && <div className="text-[12px] text-ink-2"><b className="tnum">{num(review.data.audience.eligible)}</b> eligible · {num(review.data.audience.suppressed + review.data.audience.not_opted_in)} excluded</div>}
        </Tile>
        <Tile n="02" label="Sender" icon={<AtSign className="size-4" />} done={!!f.mailbox_id}>
          <select className="input" value={f.mailbox_id} onChange={(e) => set('mailbox_id')(e.target.value)}>
            <option value="">Choose a mailbox…</option>
            {mailboxes.data?.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
          </select>
          {mb && <div className="text-[12px] text-ink-2">{num(Math.max(0, mb.effective_daily_limit - mb.sent_last_24h))} sends left in 24h window{mb.warming_up ? ' (mailbox is warming up; the limit rises weekly)' : ''}</div>}
        </Tile>
        <Tile n="03" label="Content" icon={<PenLine className="size-4" />} done={!!f.template_id}>
          <select className="input" value={f.template_id} onChange={(e) => set('template_id')(e.target.value)}>
            <option value="">Choose a marketing template…</option>
            {templates.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {tpl ? <div className="truncate text-[12px] text-ink-2" title={tpl.subject}>Subj: {tpl.subject}</div> : <Link to="/templates?new=marketing" className="text-[12px] font-medium text-brand">Create a marketing template</Link>}
        </Tile>
        <Tile n="04" label="Schedule & review" icon={<CalendarClock className="size-4" />} done={false} active>
          <Tabs value={when} onChange={setWhen} items={[{ value: 'now', label: 'Send now' }, { value: 'later', label: 'Schedule' }]} />
          {when === 'later' && <input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}
          <Button variant="primary" disabled={!f.list_id || !f.mailbox_id || !f.template_id || (when === 'later' && !at)} onClick={() => setReviewing(true)}><Rocket className="size-3.5" /> Review & launch</Button>
        </Tile>
      </div>
      {reviewing && <ReviewModal id={id} scheduledAt={when === 'later' && at ? new Date(at).toISOString() : undefined} onClose={() => setReviewing(false)} onLaunched={onDone} />}
    </Card>
  );
}

function ReviewModal({ id, scheduledAt, onClose, onLaunched }: { id: string; scheduledAt?: string; onClose: () => void; onLaunched: () => void }) {
  const r = useQuery({ queryKey: ['campaign-review', id, 'modal'], queryFn: () => api(`/v1/campaigns/${id}/review`) });
  const sys = useSystem();
  const qc = useQueryClient();
  const toast = useToast();
  const launch = useMutation({
    mutationFn: () => api(`/v1/campaigns/${id}/send`, { body: { confirm_recipients: r.data.audience.eligible, scheduled_at: scheduledAt } }),
    onSuccess: () => { toast(scheduledAt ? 'Campaign scheduled' : sys.data?.delivers_real_email ? 'Campaign is sending' : 'Campaign queued (dev mode: not delivered)'); qc.invalidateQueries({ queryKey: ['campaigns'] }); qc.invalidateQueries({ queryKey: ['sends'] }); onLaunched(); onClose(); },
    onError: () => r.refetch(),
  });
  const a = r.data?.audience;
  return (
    <Modal open onClose={onClose} title="Send review" subtitle="Confirm exactly who will receive this campaign."
      footer={<><Button onClick={onClose}>Back</Button><Button variant="primary" disabled={!r.data?.ready} loading={launch.isPending} onClick={() => launch.mutate()}><Rocket className="size-3.5" /> {scheduledAt ? `Schedule for ${dateTime(scheduledAt)}` : `Send to ${num(a?.eligible)} recipients`}</Button></>}>
      {!r.data ? <Spinner /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {[['In list', a.in_list, ''], ['Eligible (opted in)', a.eligible, 'text-emerald-700'], ['Not opted in', a.not_opted_in, 'text-orange-700'], ['Suppressed', a.suppressed, 'text-orange-700']].map(([l, v, c]) => (
              <div key={l as string} className="rounded-lg bg-canvas p-3"><div className="caps">{l}</div><div className={cx('tnum mt-1 text-[20px] font-semibold', c as string)}>{num(v as number)}</div></div>
            ))}
          </div>
          <div className="space-y-1 text-[12px]">
            <div>Template: <b>{r.data.template?.subject}</b> <span className="font-mono text-muted">(v{r.data.template?.version} will be pinned)</span></div>
            <div>From: <span className="font-mono">{r.data.mailbox?.email}</span>{r.data.capacity && <span className="text-muted"> · {num(r.data.capacity.remaining)} of {num(r.data.capacity.daily_limit)} daily sends left</span>}</div>
          </div>
          {r.data.problems.map((p: string) => <div key={p} className="flex items-start gap-2 rounded-md bg-rose-50 px-3 py-2 text-[12px] text-rose-800"><XCircle className="mt-0.5 size-3.5 shrink-0" />{p}</div>)}
          {r.data.warnings.map((p: string) => <div key={p} className="flex items-start gap-2 rounded-md bg-orange-50 px-3 py-2 text-[12px] text-orange-800"><CircleAlert className="mt-0.5 size-3.5 shrink-0" />{p}</div>)}
          {!sys.data?.delivers_real_email && <div className="rounded-md bg-orange-50 px-3 py-2 text-[12px] text-orange-800">Dev mode: the campaign runs end-to-end but nothing is delivered.</div>}
          <ErrorBox error={launch.error} />
        </div>
      )}
    </Modal>
  );
}

function CampaignCard({ c, onEdit, active }: { c: any; onEdit: () => void; active: boolean }) {
  const stats = useQuery({ queryKey: ['campaign-stats', c.id], enabled: c.status !== 'draft', queryFn: () => api(`/v1/campaigns/${c.id}/analytics`) });
  const qc = useQueryClient();
  const toast = useToast();
  const { workspace } = useAuth();
  const cancel = useMutation({
    mutationFn: () => api(`/v1/campaigns/${c.id}/cancel`, { method: 'POST' }),
    onSuccess: (r: any) => { toast(`Cancelled (${r.cancelled_sends} queued emails stopped)`); qc.invalidateQueries({ queryKey: ['campaigns'] }); },
    onError: (e) => toast(errText(e), 'error'),
  });
  const s = stats.data?.counts;
  const rr = stats.data?.reply_rate;
  const accepted = s?.accepted ?? 0;
  const metric = (label: string, value: ReactNode, sub?: ReactNode) => (
    <div><div className="caps">{label}</div><div className="tnum mt-0.5 text-[18px] font-semibold">{value} <span className="font-mono text-[11px] font-normal text-muted">{sub}</span></div></div>
  );
  return (
    <Card className={cx('p-4', active && 'ring-1 ring-indigo-200')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className={cx('grid size-10 place-items-center rounded-lg', c.status === 'sent' ? 'bg-emerald-50 text-emerald-600' : c.status === 'draft' ? 'bg-indigo-50 text-brand' : 'bg-violet-50 text-violet-600')}>
            {c.status === 'draft' ? <PenLine className="size-5" /> : c.status === 'scheduled' ? <CalendarClock className="size-5" /> : <MailOpen className="size-5" />}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2"><span className="text-[15px] font-semibold">{c.name}</span><Pill tone={STATUS[c.status]}>{c.status}</Pill></div>
            <div className="mt-0.5 text-[12px] text-muted">
              {c.list_name ? `Audience: ${c.list_name}` : 'No audience yet'}{c.template_name ? ` · ${c.template_name}` : ''}
              {c.status === 'scheduled' && c.scheduled_at ? ` · sends ${dateTime(c.scheduled_at)}` : ''}{c.sent_at ? ` · sent ${dateTime(c.sent_at)}` : ''} · {num(c.recipients)} recipients
            </div>
          </div>
        </div>
        {canEdit(workspace?.role) && (
          <div className="flex gap-2">
            {c.status === 'draft' && <Button size="sm" variant="primary" onClick={onEdit}>{active ? 'Editing' : 'Resume editing'}</Button>}
            {['draft', 'scheduled', 'sending'].includes(c.status) && <Button size="sm" variant="danger" loading={cancel.isPending} onClick={() => confirm('Cancel this campaign? Queued emails will not be sent.') && cancel.mutate()}>Cancel</Button>}
          </div>
        )}
      </div>
      {s && (
        <div className="mt-3 grid grid-cols-2 gap-3 rounded-lg bg-canvas p-3 md:grid-cols-5">
          {metric('Accepted', num(accepted), s.requested ? pct(accepted / s.requested) : '')}
          {metric('Bounced', num(s.bounced ?? 0))}
          {metric('Replied', num(s.replied ?? 0), rr?.denominator ? `${pct(rr.rate)} of ${rr.denominator}` : '')}
          {metric('Unsubscribed', num(s.unsubscribed ?? 0))}
          {metric('Failed / suppressed', num((s.failed ?? 0) + (s.suppressed ?? 0)))}
        </div>
      )}
    </Card>
  );
}

function ComplianceCard() {
  const sys = useSystem();
  const items = [
    sys.data && !sys.data.unsubscribe_footer
      ? { icon: <CircleAlert className="size-4 text-orange-500" />, title: 'Unsubscribe line', badge: 'Off', body: 'Marketing emails have no visible unsubscribe line (UNSUBSCRIBE_FOOTER=false). Gmail may still show its own Unsubscribe link from the hidden header.' }
      : sys.data?.one_click_unsubscribe
      ?{ icon: <CheckCircle2 className="size-4 text-emerald-600" />, title: 'One-click unsubscribe', badge: 'Active', body: 'Every marketing email carries a visible unsubscribe link plus RFC 8058 List-Unsubscribe headers.' }
      : { icon: <CircleAlert className="size-4 text-orange-500" />, title: 'Unsubscribe by reply', badge: 'Local server', body: 'This server is not on a public https address, so emails ask people to reply "unsubscribe". Suppress those addresses by hand, or host the app publicly for one-click unsubscribe.' },
    { icon: <ShieldCheck className="size-4 text-emerald-600" />, title: 'Consent enforced', badge: 'Always', body: 'Only contacts marked opted-in with a recorded source are eligible. Suppressions override lists.' },
    { icon: <CircleAlert className="size-4 text-orange-500" />, title: 'Gmail volume cap', badge: `${num(sys.data?.gmail_max_campaign_recipients)} max`, body: 'Gmail limits are per mailbox and shared with its other apps. Larger audiences need a dedicated ESP adapter.' },
  ];
  return (
    <Card className="h-fit">
      <CardHeader title="Compliance & limits" subtitle="What every campaign is checked against." icon={<ShieldCheck className="size-4" />} />
      <div className="space-y-2 px-5 pb-5">
        {items.map((i) => (
          <div key={i.title} className="rounded-lg bg-canvas p-3">
            <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-[13px] font-semibold">{i.icon}{i.title}</span><span className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] font-semibold text-emerald-700">{i.badge}</span></div>
            <p className="mt-1 text-[12px] text-muted">{i.body}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}
