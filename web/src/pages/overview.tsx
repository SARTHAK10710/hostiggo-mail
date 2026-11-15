import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, CircleAlert, Inbox, MailCheck, MessagesSquare, RefreshCw, Send, ShieldCheck, Users, Workflow } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { useSystem } from '../hooks';
import { Button, Card, CardHeader, Empty, KindPill, Meter, PageHeader, Pill, SendStatus, Spinner, Stat, Tabs, cx, num, pct, timeAgo } from '../ui';
import { ReplyRateNote } from './shared';

type Range = '7' | '30' | '90';

export function OverviewPage() {
  const [days, setDays] = useState<Range>('30');
  const sys = useSystem();
  const overview = useQuery({ queryKey: ['overview', days], queryFn: () => api(`/v1/analytics/overview?days=${days}`), refetchInterval: 30_000 });
  const deliver = useQuery({ queryKey: ['deliverability'], queryFn: () => api('/v1/deliverability') });
  const contacts = useQuery({
    queryKey: ['contact-counts'],
    queryFn: async () => {
      const [all, opted] = await Promise.all([api('/v1/contacts?limit=1'), api('/v1/contacts?limit=1&consent_status=opted_in')]);
      return { total: all.total as number, optedIn: opted.total as number };
    },
  });
  const autos = useQuery({ queryKey: ['automations'], queryFn: async () => (await api('/v1/automations')).data as any[] });

  const t = overview.data?.totals ?? {};
  const requested = t.requested ?? 0;
  const accepted = t.accepted ?? 0;
  const acceptance = requested ? accepted / requested : null;
  const rr = overview.data?.reply_rate;
  const lastUpdated = overview.dataUpdatedAt ? timeAgo(new Date(overview.dataUpdatedAt)) : '—';

  return (
    <>
      <div className="card flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
        <PageHeader
          eyebrow={<><span className={cx('size-2 rounded-full', sys.data?.delivers_real_email ? 'bg-emerald-500' : 'bg-orange-400')} />{sys.data?.delivers_real_email ? 'Live · Gmail API delivery' : 'Dev mode · messages are not delivered'}</>}
          title="Overview"
          subtitle="Sending volume, provider acceptance, replies and audience health for this workspace."
        />
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={days} onChange={setDays} items={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
          <Button size="sm" variant="ghost" onClick={() => overview.refetch()}>
            <RefreshCw className={cx('size-3.5', overview.isFetching && 'animate-spin')} /> <span className="font-mono text-[11px]">Synced {lastUpdated}</span>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="Emails requested" icon={<Send className="size-4" />} value={num(requested)} sub={`Last ${days} days · excludes test sends`} />
        <Stat
          label="Accepted by provider"
          icon={<MailCheck className="size-4" />}
          accent="text-emerald-600"
          value={pct(acceptance)}
          sub={<span className="space-y-1.5 block"><span className="block">{num(accepted)} accepted · {num(t.failed ?? 0)} failed</span><Meter value={acceptance ?? 0} tone="bg-emerald-600" /></span>}
        />
        <Stat
          label="Reply rate"
          icon={<MessagesSquare className="size-4" />}
          value={pct(rr?.rate)}
          sub={rr ? <span className="font-mono">{rr.numerator} / {rr.denominator} · {rr.window_days}d window</span> : '—'}
        />
        <Stat label="Bounced" icon={<CircleAlert className="size-4" />} accent="text-orange-500" value={num(t.bounced ?? 0)} sub={`${num(t.unsubscribed ?? 0)} unsubscribed · ${num(t.suppressed ?? 0)} suppressed`} />
        <Stat
          label="Active contacts"
          icon={<Users className="size-4" />}
          value={num(contacts.data?.total)}
          sub={<span className="font-mono">{num(contacts.data?.optedIn)} opted in · {num(deliver.data?.suppressions?.unsubscribed ?? 0)} unsub</span>}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title={<span className="flex items-center gap-2">Sending volume <Pill tone="brand">{days} days</Pill></span>}
            subtitle="Messages requested per day, split into accepted by Gmail and failed."
            right={<div className="flex items-center gap-3 text-[11px] text-muted"><Legend c="bg-brand" t="Accepted" /><Legend c="bg-rose-400" t="Failed" /><Legend c="bg-slate-300" t="Other" /></div>}
          />
          <div className="px-5 pb-5">{overview.isLoading ? <Spinner /> : <VolumeChart rows={overview.data?.daily ?? []} days={Number(days)} />}</div>
          <div className="mx-5 mb-5"><ReplyRateNote definition={overview.data?.reply_rate_definition} /></div>
        </Card>

        <Card>
          <CardHeader title="Mailbox & deliverability" icon={<ShieldCheck className="size-4" />} subtitle="Connection health and 30-day signals." right={<Link to="/deliverability" className="text-[12px] font-medium text-brand">Details</Link>} />
          <div className="space-y-3 px-5 pb-5">
            {(deliver.data?.mailboxes ?? []).length === 0 && (
              <Empty icon={<Inbox className="size-6" />} title="No mailbox connected" action={<Link to="/deliverability"><Button variant="primary" size="sm">Connect Gmail</Button></Link>}>
                Connect a Gmail account to start sending.
              </Empty>
            )}
            {(deliver.data?.mailboxes ?? []).map((m: any) => (
              <div key={m.id} className="rounded-lg bg-canvas p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[12px]">{m.email}</span>
                  <Pill tone={m.status === 'active' ? 'success' : 'danger'} dot>{m.status.replace('_', ' ')}</Pill>
                </div>
                <div className="mt-2 flex items-center justify-between text-[11px] text-muted"><span>Sent 24h</span><span className="tnum font-mono">{m.sent_last_24h} / {m.daily_send_limit}</span></div>
                <Meter value={m.sent_last_24h / m.daily_send_limit} />
              </div>
            ))}
            {deliver.data && (
              <>
                <Rate label="Bounce rate" value={deliver.data.last_30_days.bounce_rate} limit={0.02} />
                <Rate label="Complaint rate" value={deliver.data.last_30_days.complaint_rate} limit={0.001} />
                <div className="space-y-1.5 pt-1">
                  {deliver.data.checklist.filter((c: any) => c.ok !== null).slice(0, 5).map((c: any) => (
                    <div key={c.key} className="flex items-start gap-2 text-[12px]">
                      {c.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-orange-500" />}
                      <span className={c.ok ? 'text-ink-2' : 'text-orange-700'}>{c.label}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          icon={<Workflow className="size-4 text-lime-600" />}
          title={<span className="flex items-center gap-2">Lifecycle automations <Pill tone="automation">{(autos.data ?? []).filter((a) => a.status === 'active').length} live</Pill></span>}
          subtitle="Published sequences and how many contacts are moving through them."
          right={<Link to="/automations" className="flex items-center gap-1 text-[12px] font-medium text-brand">All automations <ArrowRight className="size-3.5" /></Link>}
        />
        <div className="grid grid-cols-1 gap-3 px-5 pb-5 md:grid-cols-3">
          {(autos.data ?? []).slice(0, 3).map((a) => (
            <Link key={a.id} to={`/automations/${a.id}`} className="rounded-lg border border-line bg-canvas p-3 hover:border-line-strong">
              <div className="flex items-center justify-between">
                <span className="text-label-caps uppercase text-lime-700">{triggerLabel(a.trigger)}</span>
                <Pill tone={a.status === 'active' ? 'success' : a.status === 'paused' ? 'alert' : 'neutral'}>{a.status}</Pill>
              </div>
              <div className="mt-1 text-[15px] font-semibold">{a.name}</div>
              <div className="mt-1 font-mono text-[11px] text-muted">v{a.published_version ?? '—'} · {num(a.active_enrollments)} active · {num(a.total_enrollments)} total</div>
            </Link>
          ))}
          {autos.data?.length === 0 && (
            <div className="md:col-span-3"><Empty title="No automations yet" action={<Link to="/automations"><Button variant="primary" size="sm">Create automation</Button></Link>}>Build a welcome sequence: a trigger, a wait, and a couple of emails.</Empty></div>
          )}
        </div>
      </Card>

      <RecentActivity />
    </>
  );
}

const Legend = ({ c, t }: { c: string; t: string }) => <span className="flex items-center gap-1"><span className={cx('size-2 rounded-sm', c)} />{t}</span>;

function Rate({ label, value, limit }: { label: string; value: number; limit: number }) {
  const ok = value < limit;
  return (
    <div>
      <div className="flex items-center justify-between text-[12px]"><span className="font-medium">{label}</span><span className="tnum font-mono">{pct(value, 2)} <span className="text-muted">(limit {pct(limit, limit < 0.01 ? 1 : 0)})</span></span></div>
      <Meter value={Math.min(1, value / limit)} tone={ok ? 'bg-emerald-600' : 'bg-rose-500'} />
    </div>
  );
}

export function triggerLabel(t: any) {
  if (!t) return 'No trigger';
  if (t.type === 'list_joined') return 'Joins a list';
  if (t.type === 'contact_created') return 'Contact created';
  if (t.type === 'event') return `Event · ${t.event_name}`;
  return t.type;
}

function VolumeChart({ rows, days }: { rows: { day: string; requested: number; accepted: number; failed: number }[]; days: number }) {
  const byDay = new Map(rows.map((r) => [new Date(r.day).toISOString().slice(0, 10), r]));
  const series = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.now() - (days - 1 - i) * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    const r = byDay.get(key);
    return { key, label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), accepted: r?.accepted ?? 0, failed: r?.failed ?? 0, other: Math.max(0, (r?.requested ?? 0) - (r?.accepted ?? 0) - (r?.failed ?? 0)) };
  });
  const max = Math.max(1, ...series.map((s) => s.accepted + s.failed + s.other));
  const total = series.reduce((s, x) => s + x.accepted + x.failed + x.other, 0);
  if (total === 0) return <Empty icon={<Send className="size-6" />} title="Nothing sent in this period">Send a test email from the top bar to see it here.</Empty>;
  const tickEvery = Math.ceil(days / 6);
  return (
    <div>
      <div className="flex h-56 items-end gap-[3px] border-b border-line">
        {series.map((s) => {
          const h = (v: number) => `${(v / max) * 100}%`;
          return (
            <div key={s.key} className="group relative flex h-full flex-1 flex-col justify-end" title={`${s.label}: ${s.accepted} accepted, ${s.failed} failed, ${s.other} other`}>
              <div className="bg-slate-300" style={{ height: h(s.other) }} />
              <div className="bg-rose-400" style={{ height: h(s.failed) }} />
              <div className="rounded-t-[2px] bg-brand group-hover:bg-brand-hover" style={{ height: h(s.accepted) }} />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-[3px]">
        {series.map((s, i) => <div key={s.key} className="flex-1 truncate font-mono text-[10px] text-muted">{i % tickEvery === 0 ? s.label : ''}</div>)}
      </div>
    </div>
  );
}

function RecentActivity() {
  const [filter, setFilter] = useState<'all' | 'transactional' | 'marketing' | 'automation' | 'failed'>('all');
  const [to, setTo] = useState('');
  const params = new URLSearchParams({ limit: '10' });
  if (filter === 'transactional' || filter === 'marketing') params.set('kind', filter);
  if (filter === 'automation') params.set('source_type', 'automation');
  if (filter === 'failed') params.set('status', 'failed');
  if (to.includes('@')) params.set('to', to);
  const sends = useQuery({ queryKey: ['sends', 'recent', params.toString()], queryFn: async () => (await api(`/v1/sends?${params}`)).data as any[], refetchInterval: 15_000 });
  return (
    <Card>
      <CardHeader
        title="Recent email activity"
        subtitle="Latest messages from every source, with their current state."
        right={
          <>
            <Tabs value={filter} onChange={setFilter} items={[{ value: 'all', label: 'All' }, { value: 'transactional', label: 'Transactional' }, { value: 'marketing', label: 'Marketing' }, { value: 'automation', label: 'Automations' }, { value: 'failed', label: 'Failed' }]} />
            <input className="input w-56" placeholder="Filter by exact recipient…" value={to} onChange={(e) => setTo(e.target.value)} />
          </>
        }
      />
      <SendTable rows={sends.data} loading={sends.isLoading} />
    </Card>
  );
}

export function SendTable({ rows, loading, onInspect }: { rows?: any[]; loading?: boolean; onInspect?: (id: string) => void }) {
  if (loading) return <Spinner />;
  if (!rows?.length) return <Empty icon={<Inbox className="size-6" />} title="No messages yet" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px]">
        <thead>
          <tr><th className="th">Recipient</th><th className="th">Subject</th><th className="th">Type</th><th className="th">Status</th><th className="th">Detail</th><th className="th text-right">Requested</th></tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} className={cx('row-hover', onInspect && 'cursor-pointer')} onClick={() => onInspect?.(s.id)}>
              <td className="td font-mono text-[12px]">{s.to_email}</td>
              <td className="td max-w-80 truncate">{s.subject ?? <span className="text-muted">(rendered at send time)</span>}</td>
              <td className="td"><KindPill kind={s.source_type === 'automation' && s.kind !== 'test' ? 'automation' : s.kind} /></td>
              <td className="td"><SendStatus status={s.status} replied={s.replied} bounced={s.bounced} /></td>
              <td className="td max-w-64 truncate font-mono text-[11px] text-muted" title={s.last_error ?? ''}>{s.error_code ?? (s.status === 'accepted' ? `gmail:${s.provider_message_id?.slice(0, 10) ?? ''}` : '')}</td>
              <td className="td text-right font-mono text-[11px] text-muted whitespace-nowrap">{timeAgo(s.requested_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
