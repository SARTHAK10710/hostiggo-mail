import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive, ArrowLeft, CheckCircle2, Clock, FlaskConical, Mail, MessagesSquare, Pause, Play, Plus, Save, Trash2, UserPlus, Workflow, Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api';
import { canEdit, useAuth } from '../auth';
import { useActiveMailboxes, useLists, useTemplates } from '../hooks';
import { Button, Card, CardHeader, Empty, ErrorBox, Field, Modal, PageHeader, Pill, Spinner, Tabs, cx, dateTime, errText, num, pct, timeAgo, useToast } from '../ui';
import { triggerLabel } from './overview';
import { ReplyRateNote } from './shared';

type Step = { id: string; type: 'email'; template_id: string } | { id: string; type: 'wait'; amount: number; unit: 'minutes' | 'hours' | 'days' };
interface Definition {
  trigger: null | { type: 'list_joined'; list_id: string } | { type: 'contact_created' } | { type: 'event'; event_name: string };
  mailbox_id: string | null;
  message_kind: 'marketing' | 'transactional';
  reentry: 'once' | 'after_exit';
  steps: Step[];
}

const STATUS_TONE: Record<string, any> = { active: 'success', paused: 'alert', draft: 'neutral', archived: 'neutral' };

export function AutomationsPage() {
  const q = useQuery({ queryKey: ['automations'], queryFn: async () => (await api('/v1/automations')).data as any[] });
  const [creating, setCreating] = useState(false);
  const { workspace } = useAuth();
  return (
    <>
      <PageHeader eyebrow={<Pill tone="automation">Automations</Pill>} title="Lifecycle automations"
        subtitle="Linear sequences: a trigger, waits, and email steps. Publishing freezes a version; contacts finish the version they entered."
        actions={canEdit(workspace?.role) && <Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-3.5" /> New automation</Button>} />
      <Card>
        {q.isLoading ? <Spinner /> : q.data?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead><tr><th className="th">Automation</th><th className="th">Trigger</th><th className="th">Status</th><th className="th">Version</th><th className="th text-right">Active</th><th className="th text-right">Total enrolled</th><th className="th text-right">Updated</th></tr></thead>
              <tbody>
                {q.data.map((a) => (
                  <tr key={a.id} className="row-hover">
                    <td className="td font-medium"><Link className="hover:text-brand" to={`/automations/${a.id}`}>{a.name}</Link></td>
                    <td className="td text-[12px] text-ink-2">{triggerLabel(a.trigger)}</td>
                    <td className="td"><Pill tone={STATUS_TONE[a.status]} dot>{a.status}</Pill></td>
                    <td className="td font-mono text-[12px]">{a.published_version ? `v${a.published_version}` : '—'}</td>
                    <td className="td tnum text-right">{num(a.active_enrollments)}</td>
                    <td className="td tnum text-right">{num(a.total_enrollments)}</td>
                    <td className="td text-right font-mono text-[11px] text-muted">{timeAgo(a.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={<Workflow className="size-7" />} title="No automations yet" action={canEdit(workspace?.role) ? <Button variant="primary" size="sm" onClick={() => setCreating(true)}>Create your first sequence</Button> : undefined}>
            Example: when someone joins "New guests", send a welcome email, wait 2 days, then send a tips email.
          </Empty>
        )}
      </Card>
      {creating && <CreateModal onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const nav = useNavigate();
  const create = useMutation({
    mutationFn: () => api('/v1/automations', { body: { name, definition: { steps: [] } } }),
    onSuccess: (r: any) => nav(`/automations/${r.id}`),
  });
  return (
    <Modal open onClose={onClose} title="New automation" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name} loading={create.isPending} onClick={() => create.mutate()}>Create draft</Button></>}>
      <Field label="Name"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Guest onboarding" onKeyDown={(e) => e.key === 'Enter' && name && create.mutate()} /></Field>
      <ErrorBox error={create.error} />
    </Modal>
  );
}

// ── Builder ──────────────────────────────────────────────────────────
type Sel = 'trigger' | string;

export function AutomationBuilder() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { workspace } = useAuth();
  const editable = canEdit(workspace?.role);
  const auto = useQuery({ queryKey: ['automation', id], queryFn: () => api(`/v1/automations/${id}`) });
  const stats = useQuery({ queryKey: ['automation-stats', id], queryFn: () => api(`/v1/automations/${id}/analytics`), refetchInterval: 20_000 });
  const templates = useTemplates();
  const lists = useLists();
  const mailboxes = useActiveMailboxes();
  const [def, setDef] = useState<Definition | null>(null);
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<Sel>('trigger');
  const [testOpen, setTestOpen] = useState(false);
  const [tab, setTab] = useState<'builder' | 'enrollments'>('builder');

  useEffect(() => {
    if (auto.data && !dirty) {
      setDef({ trigger: null, mailbox_id: null, message_kind: 'marketing', reentry: 'once', steps: [], ...auto.data.draft_definition });
      setName(auto.data.name);
    }
  }, [auto.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (fn: (d: Definition) => Definition) => { setDef((d) => (d ? fn(d) : d)); setDirty(true); };
  const refresh = () => { qc.invalidateQueries({ queryKey: ['automation', id] }); qc.invalidateQueries({ queryKey: ['automations'] }); };

  const save = useMutation({
    mutationFn: () => api(`/v1/automations/${id}`, { method: 'PUT', body: { name, definition: def } }),
    onSuccess: () => { setDirty(false); toast('Draft saved'); refresh(); },
    onError: (e) => toast(errText(e), 'error'),
  });
  const publish = useMutation({
    mutationFn: async () => {
      if (dirty) await api(`/v1/automations/${id}`, { method: 'PUT', body: { name, definition: def } });
      return api(`/v1/automations/${id}/publish`, { method: 'POST' });
    },
    onSuccess: (r: any) => { setDirty(false); toast(`Published version ${r.version} (${r.status})`); refresh(); },
  });
  const action = useMutation({
    mutationFn: (a: 'pause' | 'resume' | 'archive') => api(`/v1/automations/${id}/${a}`, { method: 'POST' }),
    onSuccess: (_r, a) => { toast(a === 'pause' ? 'Paused: no further steps will run' : a === 'resume' ? 'Resumed: contacts continue where they stopped' : 'Archived: everyone exited'); refresh(); },
    onError: (e) => toast(errText(e), 'error'),
  });

  const stepStats = useMemo(() => Object.fromEntries((stats.data?.steps ?? []).map((s: any) => [s.step_id, s])), [stats.data]);
  if (auto.isLoading || !def) return <Spinner />;
  const a = auto.data;
  const kindTemplates = (templates.data ?? []).filter((t) => t.kind === def.message_kind);
  const newId = (type: string) => { let n = def.steps.length + 1; while (def.steps.some((s) => s.id === `${type}_${n}`)) n++; return `${type}_${n}`; };
  const addStep = (index: number, type: 'email' | 'wait') => {
    const step: Step = type === 'email' ? { id: newId('email'), type, template_id: kindTemplates[0]?.id ?? '' } : { id: newId('wait'), type, amount: 1, unit: 'days' };
    update((d) => ({ ...d, steps: [...d.steps.slice(0, index), step, ...d.steps.slice(index)] }));
    setSel(step.id);
  };
  const enr = (stats.data?.enrollments ?? []) as { state: string; exit_reason: string; n: number }[];
  const enrCount = (st: string) => enr.filter((e) => e.state === st).reduce((s, e) => s + e.n, 0);
  const selected = def.steps.find((s) => s.id === sel);

  return (
    <>
      <div className="card flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <Link to="/automations" className="flex items-center gap-1 text-muted hover:text-ink"><ArrowLeft className="size-3.5" /> Automations</Link>
          <span className="text-line-strong">/</span>
          <input className="min-w-0 rounded-md border border-transparent px-1.5 py-0.5 text-[18px] font-semibold hover:border-line focus:border-brand focus:outline-none" value={name} disabled={!editable} onChange={(e) => { setName(e.target.value); setDirty(true); }} />
          {a.published && <Pill tone="brand">v{a.published.version}</Pill>}
          <Pill tone={STATUS_TONE[a.status]} dot>{a.status}{a.status === 'active' ? ` · ${num(enrCount('active'))} active` : ''}</Pill>
          {(dirty || a.has_unpublished_changes) && a.status !== 'draft' && <Pill tone="alert">Unpublished changes</Pill>}
        </div>
        {editable && a.status !== 'archived' && (
          <div className="flex flex-wrap gap-2">
            <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}><Save className="size-3.5" /> Save draft</Button>
            <Button onClick={async () => { if (dirty) await save.mutateAsync(); setTestOpen(true); }}><FlaskConical className="size-3.5" /> Send test sequence</Button>
            <Button variant="primary" loading={publish.isPending} onClick={() => publish.mutate()}><CheckCircle2 className="size-3.5" /> {a.published ? 'Publish changes' : 'Publish'}</Button>
            {a.status === 'active' && <Button onClick={() => action.mutate('pause')} loading={action.isPending}><Pause className="size-3.5" /> Pause</Button>}
            {a.status === 'paused' && <Button onClick={() => action.mutate('resume')} loading={action.isPending}><Play className="size-3.5" /> Resume</Button>}
            {a.published && <Button variant="danger" className="sm:ml-auto" onClick={() => confirm('Archive this automation? Every contact exits and queued emails are cancelled. This cannot be undone.') && action.mutate('archive')}><Archive className="size-3.5" /> Archive</Button>}
          </div>
        )}
        <ErrorBox error={publish.error} />
      </div>

      <Tabs value={tab} onChange={setTab} items={[{ value: 'builder', label: 'Sequence' }, { value: 'enrollments', label: `Enrollments (${num(enr.reduce((s, e) => s + e.n, 0))})` }]} />

      {tab === 'enrollments' ? <Enrollments id={id!} /> : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_380px]">
          <div className="card min-h-[560px] bg-[radial-gradient(#cbd5e1_1px,transparent_1px)] [background-size:16px_16px] p-6">
            <div className="mx-auto flex max-w-xl flex-col items-stretch">
              <Node selected={sel === 'trigger'} onClick={() => setSel('trigger')} tag={<Pill tone="success">Trigger</Pill>} stepNo="Step #01"
                icon={<UserPlus className="size-5" />} iconBg="bg-emerald-600 text-white"
                title={def.trigger ? triggerLabel(def.trigger) : 'Choose a trigger'}
                subtitle={def.trigger?.type === 'list_joined' ? `List: ${lists.data?.find((l) => l.id === (def.trigger as any).list_id)?.name ?? '—'}` : def.trigger?.type === 'event' ? 'POST /v1/events with this name' : def.trigger ? 'Any new contact' : 'Click to configure'}
                footer={<><span>Total enrolled</span><b className="tnum font-mono">{num(enr.reduce((s, e) => s + e.n, 0))} contacts</b></>} />
              <Connector onAdd={editable ? (t) => addStep(0, t) : undefined} />
              {def.steps.map((s, i) => {
                const st = stepStats[s.id];
                const tpl = s.type === 'email' ? templates.data?.find((t) => t.id === s.template_id) : null;
                return (
                  <div key={s.id} className="flex flex-col items-stretch">
                    {s.type === 'email' ? (
                      <Node selected={sel === s.id} onClick={() => setSel(s.id)} tag={<Pill tone="brand">{sel === s.id ? 'Editing now' : 'Email action'}</Pill>} stepNo={s.id}
                        icon={<Mail className="size-5" />} iconBg="bg-indigo-50 text-brand"
                        title={tpl ? `Send: ${tpl.name}` : 'Send: choose a template'}
                        subtitle={tpl ? `“${tpl.subject}”` : 'No template selected'}
                        footer={<div className="grid w-full grid-cols-4 text-center">
                          {[['Requested', st?.counts?.requested], ['Accepted', st?.counts?.accepted], ['Bounced', st?.counts?.bounced], ['Replied', st?.counts?.replied]].map(([l, v]) => (
                            <div key={l as string}><div className="caps">{l}</div><div className="tnum mt-0.5 font-mono text-[12px] font-semibold">{num((v as number) ?? 0)}</div></div>
                          ))}
                        </div>} />
                    ) : (
                      <Node selected={sel === s.id} onClick={() => setSel(s.id)} tag={<Pill tone="neutral">Delay</Pill>} stepNo={s.id}
                        icon={<Clock className="size-5" />} iconBg="bg-slate-100 text-ink-2"
                        title={`Wait ${s.amount} ${s.amount === 1 ? s.unit.replace(/s$/, '') : s.unit}`} subtitle="Then continue to the next step" />
                    )}
                    <Connector onAdd={editable ? (t) => addStep(i + 1, t) : undefined} />
                  </div>
                );
              })}
              <div className="mx-auto rounded-full border border-line bg-white px-3 py-1 text-[11px] font-semibold text-muted">Exit · sequence complete</div>
            </div>
          </div>

          <Card className="h-fit xl:sticky xl:top-20">
            <CardHeader title={sel === 'trigger' ? 'Trigger & settings' : selected?.type === 'email' ? 'Email step' : 'Wait step'} subtitle="Configuration inspector" icon={<Zap className="size-4" />} />
            <div className="space-y-3 px-5 pb-5">
              {sel === 'trigger' && (
                <>
                  <Field label="When">
                    <select className="input" disabled={!editable} value={def.trigger?.type ?? ''} onChange={(e) => {
                      const t = e.target.value;
                      update((d) => ({ ...d, trigger: t === 'list_joined' ? { type: 'list_joined', list_id: lists.data?.[0]?.id ?? '' } : t === 'event' ? { type: 'event', event_name: 'booking.confirmed' } : t === 'contact_created' ? { type: 'contact_created' } : null }));
                    }}>
                      <option value="">Choose…</option>
                      <option value="list_joined">A contact joins a list</option>
                      <option value="contact_created">A contact is created</option>
                      <option value="event">A product event is received (API)</option>
                    </select>
                  </Field>
                  {def.trigger?.type === 'list_joined' && (
                    <Field label="List" hint={lists.data?.length ? undefined : 'Create a list on the Contacts page first.'}>
                      <select className="input" disabled={!editable} value={def.trigger.list_id} onChange={(e) => update((d) => ({ ...d, trigger: { type: 'list_joined', list_id: e.target.value } }))}>
                        {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                      </select>
                    </Field>
                  )}
                  {def.trigger?.type === 'event' && (
                    <Field label="Event name" hint="Your app sends POST /v1/events with this name and the contact's email.">
                      <input className="input font-mono text-[12px]" disabled={!editable} value={def.trigger.event_name} onChange={(e) => update((d) => ({ ...d, trigger: { type: 'event', event_name: e.target.value } }))} />
                    </Field>
                  )}
                  <Field label="Send from mailbox">
                    <select className="input" disabled={!editable} value={def.mailbox_id ?? ''} onChange={(e) => update((d) => ({ ...d, mailbox_id: e.target.value || null }))}>
                      <option value="">Choose…</option>
                      {mailboxes.data?.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
                    </select>
                  </Field>
                  <Field label="Message type" hint={def.message_kind === 'marketing' ? 'Only opted-in, unsuppressed contacts enter; unsubscribes exit the sequence.' : 'Account/booking notices; ignores marketing consent but still respects bounces.'}>
                    <select className="input" disabled={!editable} value={def.message_kind} onChange={(e) => update((d) => ({ ...d, message_kind: e.target.value as any }))}>
                      <option value="marketing">Marketing</option>
                      <option value="transactional">Transactional</option>
                    </select>
                  </Field>
                  <Field label="Re-entry">
                    <select className="input" disabled={!editable} value={def.reentry} onChange={(e) => update((d) => ({ ...d, reentry: e.target.value as any }))}>
                      <option value="once">A contact can enter only once</option>
                      <option value="after_exit">Can re-enter after finishing</option>
                    </select>
                  </Field>
                </>
              )}
              {selected?.type === 'email' && (
                <>
                  <Field label="Step identifier"><input className="input font-mono text-[12px]" disabled value={selected.id} /></Field>
                  <Field label="Template" right={selected.template_id ? <Link className="text-[11px] font-semibold text-brand" to={`/templates?id=${selected.template_id}`}>Open template</Link> : <Link className="text-[11px] font-semibold text-brand" to={`/templates?new=${def.message_kind}`}>New template</Link>}
                    hint={kindTemplates.length ? 'The latest version is pinned when you publish.' : `No ${def.message_kind} templates yet.`}>
                    <select className="input" disabled={!editable} value={selected.template_id} onChange={(e) => update((d) => ({ ...d, steps: d.steps.map((s) => (s.id === selected.id ? { ...s, template_id: e.target.value } as Step : s)) }))}>
                      <option value="">Choose…</option>
                      {kindTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </Field>
                  {stepStats[selected.id]?.reply_rate && (
                    <div className="rounded-lg bg-canvas p-3 text-[12px]">
                      <div className="caps mb-1">Reply rate (this step)</div>
                      <div className="tnum text-[18px] font-semibold">{pct(stepStats[selected.id].reply_rate.rate)}</div>
                      <div className="font-mono text-[11px] text-muted">{stepStats[selected.id].reply_rate.numerator} / {stepStats[selected.id].reply_rate.denominator} recipients · {stepStats[selected.id].reply_rate.window_days}d window</div>
                    </div>
                  )}
                </>
              )}
              {selected?.type === 'wait' && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Wait for"><input className="input" type="number" min={1} disabled={!editable} value={selected.amount} onChange={(e) => update((d) => ({ ...d, steps: d.steps.map((s) => (s.id === selected.id ? { ...s, amount: Math.max(1, Number(e.target.value)) } as Step : s)) }))} /></Field>
                  <Field label="Unit">
                    <select className="input" disabled={!editable} value={selected.unit} onChange={(e) => update((d) => ({ ...d, steps: d.steps.map((s) => (s.id === selected.id ? { ...s, unit: e.target.value } as Step : s)) }))}>
                      <option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option>
                    </select>
                  </Field>
                </div>
              )}
              {selected && editable && (
                <button className="flex items-center gap-1.5 text-[12px] font-semibold text-rose-600 hover:underline" onClick={() => { update((d) => ({ ...d, steps: d.steps.filter((s) => s.id !== selected.id) })); setSel('trigger'); }}>
                  <Trash2 className="size-3.5" /> Delete this step
                </button>
              )}
              {dirty && <div className="rounded-md bg-orange-50 px-3 py-2 text-[12px] text-orange-800">Unsaved changes. Save the draft, then publish to make them live.</div>}
            </div>
          </Card>
        </div>
      )}

      <Card className="flex flex-wrap items-center gap-6 p-4">
        <div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-full bg-emerald-600 text-white"><MessagesSquare className="size-5" /></div>
          <div><div className="caps">Reply rate</div><div className="tnum font-mono text-[13px] font-semibold">{pct(stats.data?.reply_rate?.rate)} <span className="font-normal text-muted">({stats.data?.reply_rate?.numerator ?? 0}/{stats.data?.reply_rate?.denominator ?? 0}, {stats.data?.reply_rate?.window_days}d)</span></div></div></div>
        <div><div className="caps">Active</div><div className="tnum font-mono text-[13px] font-semibold">{num(enrCount('active'))}</div></div>
        <div><div className="caps">Completed</div><div className="tnum font-mono text-[13px] font-semibold">{num(enrCount('completed'))}</div></div>
        <div><div className="caps">Exited</div><div className="tnum font-mono text-[13px] font-semibold" title={enr.filter((e) => e.state === 'exited').map((e) => `${e.exit_reason}: ${e.n}`).join(', ')}>{num(enrCount('exited'))}</div></div>
        <div className="min-w-64 flex-1"><ReplyRateNote definition={stats.data?.reply_rate_definition} /></div>
      </Card>
      {testOpen && <TestSequenceModal id={id!} onClose={() => setTestOpen(false)} />}
    </>
  );
}

function Node({ selected, onClick, tag, stepNo, icon, iconBg, title, subtitle, footer }: { selected: boolean; onClick: () => void; tag: ReactNode; stepNo: string; icon: ReactNode; iconBg: string; title: string; subtitle?: string; footer?: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cx('card w-full p-4 text-left transition-shadow', selected ? 'ring-2 ring-brand' : 'hover:shadow-md')}>
      <div className="flex items-center justify-between">{tag}<span className="font-mono text-[11px] text-muted">{stepNo}</span></div>
      <div className="mt-2 flex items-center gap-3">
        <div className={cx('grid size-10 shrink-0 place-items-center rounded-lg', iconBg)}>{icon}</div>
        <div className="min-w-0"><div className="truncate text-[15px] font-semibold">{title}</div>{subtitle && <div className="truncate text-[12px] text-muted">{subtitle}</div>}</div>
      </div>
      {footer && <div className="mt-3 flex items-center justify-between rounded-md bg-canvas px-3 py-2 text-[12px]">{footer}</div>}
    </button>
  );
}

function Connector({ onAdd }: { onAdd?: (type: 'email' | 'wait') => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex h-14 flex-col items-center justify-center">
      <div className="absolute inset-y-0 w-px bg-line-strong" />
      {onAdd && (
        <div className="relative">
          <button type="button" onClick={() => setOpen((o) => !o)} className="grid size-6 place-items-center rounded-full border border-line-strong bg-white text-muted hover:border-brand hover:text-brand" aria-label="Add step"><Plus className="size-3.5" /></button>
          {open && (
            <div className="absolute left-8 top-1/2 z-10 flex -translate-y-1/2 gap-1 rounded-lg border border-line bg-white p-1 shadow-lg" onMouseLeave={() => setOpen(false)}>
              <Button size="sm" variant="ghost" onClick={() => { onAdd('email'); setOpen(false); }}><Mail className="size-3.5" /> Email</Button>
              <Button size="sm" variant="ghost" onClick={() => { onAdd('wait'); setOpen(false); }}><Clock className="size-3.5" /> Wait</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Enrollments({ id }: { id: string }) {
  const [state, setState] = useState<'' | 'active' | 'completed' | 'exited'>('');
  const q = useQuery({ queryKey: ['enrollments', id, state], queryFn: async () => (await api(`/v1/automations/${id}/enrollments?limit=100${state ? `&state=${state}` : ''}`)).data as any[] });
  return (
    <Card>
      <div className="px-5 pt-4 pb-3"><Tabs value={state} onChange={setState} items={[{ value: '', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'completed', label: 'Completed' }, { value: 'exited', label: 'Exited' }]} /></div>
      {q.isLoading ? <Spinner /> : q.data?.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead><tr><th className="th">Contact</th><th className="th">State</th><th className="th">Version</th><th className="th">Next step at</th><th className="th">Entered</th></tr></thead>
            <tbody>{q.data.map((e) => (
              <tr key={e.id} className="row-hover">
                <td className="td font-mono text-[12px]">{e.email}</td>
                <td className="td"><Pill tone={e.state === 'active' ? 'automation' : e.state === 'completed' ? 'success' : 'neutral'}>{e.state}{e.exit_reason ? `: ${e.exit_reason}` : ''}</Pill></td>
                <td className="td font-mono text-[12px]">v{e.version}</td>
                <td className="td font-mono text-[11px] text-muted">{e.state === 'active' ? dateTime(e.next_run_at) : '—'}</td>
                <td className="td font-mono text-[11px] text-muted">{timeAgo(e.entered_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Empty title="No enrollments yet">Contacts appear here once the published trigger fires.</Empty>}
    </Card>
  );
}

function TestSequenceModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { me } = useAuth();
  const [to, setTo] = useState(me?.user.email ?? '');
  const toast = useToast();
  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: () => api(`/v1/automations/${id}/test`, { body: { to } }),
    onSuccess: (r: any) => { toast(`${r.sends.length} test email(s) queued`); qc.invalidateQueries({ queryKey: ['sends'] }); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title="Send test sequence" subtitle="Sends every email step of the draft right away (no waits), using sample contact data. Not counted in metrics."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={send.isPending} onClick={() => send.mutate()}>Dispatch</Button></>}>
      <Field label="Send to"><input className="input" type="email" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      <div className="mt-3"><ErrorBox error={send.error} /></div>
    </Modal>
  );
}
