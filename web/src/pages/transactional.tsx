import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BedDouble, CheckCircle2, Copy, KeyRound, Plus, Receipt, RefreshCw, Search, Send, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { isAdmin, useAuth } from '../auth';
import { useActiveMailboxes, useSystem, useTemplates } from '../hooks';
import { Button, Card, CardHeader, Empty, ErrorBox, Field, Modal, PageHeader, Pill, Stat, Tabs, cx, errText, num, pct, timeAgo, useToast } from '../ui';
import { SendTable } from './overview';
import { SendDrawer } from './shared';

export function TransactionalPage() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('send');
  const [tab, setTab] = useState<'log' | 'templates' | 'problems' | 'booking'>(() => (params.get('tab') === 'booking' ? 'booking' : 'log'));
  const [tag, setTag] = useState('');
  const [sendOpen, setSendOpen] = useState(false);
  const statsQ = useQuery({ queryKey: ['overview', '1'], queryFn: () => api('/v1/analytics/overview?days=1'), refetchInterval: 20_000 });
  const rows: { kind: string; status: string; n: number }[] = statsQ.data?.by_kind ?? [];
  const tx = rows.filter((r) => r.kind === 'transactional');
  const total = tx.reduce((s, r) => s + r.n, 0);
  const by = (st: string) => tx.filter((r) => r.status === st).reduce((s, r) => s + r.n, 0);

  const logParams = (tab === 'problems' ? 'kind=transactional,test&status=failed' : 'kind=transactional,test') + (tag.trim() ? `&tag=${encodeURIComponent(tag.trim())}` : '');
  const log = useQuery({ queryKey: ['sends', 'tx', tab, tag.trim()], enabled: tab === 'log' || tab === 'problems', queryFn: async () => (await api(`/v1/sends?limit=50&${logParams}`)).data as any[], refetchInterval: 10_000 });
  const unknown = useQuery({ queryKey: ['sends', 'unknown'], queryFn: async () => (await api('/v1/sends?limit=50&status=unknown')).data as any[] });
  const templates = useTemplates('transactional');

  return (
    <>
      <PageHeader
        eyebrow={<Pill tone="transactional" dot>Transactional</Pill>}
        title="Transactional Emails · API Dispatch"
        subtitle="Receipts, booking confirmations, password resets and account notices sent one at a time through a connected Gmail mailbox."
        actions={<Button variant="primary" className="bg-rose-600 hover:bg-rose-700" onClick={() => setSendOpen(true)}><Send className="size-3.5" /> Send a message</Button>}
      />

      <ApiPanel template={templates.data?.find((t) => t.slug === 'booking_request_host') ?? templates.data?.[0]} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="24h transactional volume" icon={<Zap className="size-4" />} accent="text-rose-500" value={num(total)} sub="Requests via API, automations and this console" />
        <Stat label="Accepted by Gmail" icon={<CheckCircle2 className="size-4" />} accent="text-emerald-600" value={pct(total ? by('accepted') / total : null)} sub={`${num(by('accepted'))} accepted · ${num(by('queued') + by('sending'))} in queue`} />
        <Stat label="Failed / suppressed" icon={<AlertTriangle className="size-4" />} accent="text-orange-500" value={num(by('failed') + by('suppressed'))} sub={`${num(by('failed'))} failed · ${num(by('suppressed'))} suppressed`} />
        <Stat label="Outcome unknown" icon={<RefreshCw className="size-4" />} accent="text-orange-500" value={num(unknown.data?.length ?? 0)} sub="Network errors held for manual review (never auto-retried)" />
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
          <Tabs value={tab} onChange={setTab} items={[
            { value: 'log', label: <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-rose-500" />Dispatch log</span> },
            { value: 'templates', label: `Templates (${templates.data?.length ?? 0})` },
            { value: 'problems', label: 'Failed' },
            { value: 'booking', label: <span className="flex items-center gap-1.5"><BedDouble className="size-3.5" />Booking emails</span> },
          ]} />
          {(tab === 'log' || tab === 'problems') && (
            <div className="flex items-center gap-2">
              <label className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
                <input className="input h-8 w-56 pl-8 font-mono text-[12px]" placeholder="Filter by tag, e.g. booking:HG-1042" value={tag} onChange={(e) => setTag(e.target.value)} />
              </label>
              <Button size="sm" variant="ghost" onClick={() => log.refetch()}><RefreshCw className={cx('size-3.5', log.isFetching && 'animate-spin')} /> Refresh</Button>
            </div>
          )}
        </div>
        {tab === 'booking' ? (
          <BookingPack />
        ) : tab === 'templates' ? (
          templates.data?.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead><tr><th className="th">Template</th><th className="th">API name</th><th className="th">Subject</th><th className="th">Variables</th><th className="th text-right">Updated</th></tr></thead>
                <tbody>
                  {templates.data.map((t) => (
                    <tr key={t.id} className="row-hover">
                      <td className="td font-medium"><Link to={`/templates?id=${t.id}`} className="hover:text-brand">{t.name}</Link> <span className="font-mono text-[11px] text-muted">v{t.current_version}</span></td>
                      <td className="td font-mono text-[11px]">{t.slug ?? <span className="text-muted" title="No API name: send with template_id">{t.id}</span>}</td>
                      <td className="td max-w-72 truncate">{t.subject}</td>
                      <td className="td font-mono text-[11px] text-muted">{t.variables.join(', ') || '—'}</td>
                      <td className="td text-right font-mono text-[11px] text-muted">{timeAgo(t.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon={<Receipt className="size-6" />} title="No transactional templates" action={<Link to="/templates?new=transactional"><Button variant="primary" size="sm">Create template</Button></Link>}>Templates keep subject and body in one place; the API sends them with per-message variables.</Empty>
          )
        ) : (
          <SendTable rows={log.data} loading={log.isLoading} onInspect={(id) => setParams({ send: id })} />
        )}
      </Card>

      <SendDrawer id={openId} onClose={() => setParams({})} />
      <SendMessageModal open={sendOpen} onClose={() => setSendOpen(false)} onSent={(id) => setParams({ send: id })} />
    </>
  );
}

function ApiPanel({ template }: { template?: { id: string; slug?: string | null } }) {
  const { workspace } = useAuth();
  const sys = useSystem();
  const qc = useQueryClient();
  const toast = useToast();
  const [lang, setLang] = useState<'curl' | 'node' | 'python'>('curl');
  const [newKey, setNewKey] = useState<string | null>(null);
  const keys = useQuery({ queryKey: ['api-keys'], enabled: isAdmin(workspace?.role), queryFn: async () => (await api('/v1/api-keys')).data as any[] });
  const sendKeys = (keys.data ?? []).filter((k) => !k.revoked_at && k.scopes.includes('messages:send'));
  const create = useMutation({
    mutationFn: () => api('/v1/api-keys', { body: { name: 'Transactional sender', scopes: ['messages:send'] } }),
    onSuccess: (r: any) => { setNewKey(r.key); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e) => toast(errText(e), 'error'),
  });
  const base = sys.data?.api_base_url ?? window.location.origin;
  const key = newKey ?? 'hm_live_YOUR_KEY';
  const body = template
    ? `{"to":"host@example.com",${template.slug ? `"template":"${template.slug}"` : `"template_id":"${template.id}"`},"variables":{"guest":{"name":"Priya Sharma"}},"tags":["booking:HG-1042"]}`
    : `{"to":"guest@example.com","subject":"Booking confirmed","text_body":"Thanks for booking with Hostiggo!"}`;
  const code = useMemo(() => {
    if (lang === 'curl') return `curl -X POST ${base}/v1/messages/send \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Idempotency-Key: order-1042" \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`;
    if (lang === 'node') return `const res = await fetch("${base}/v1/messages/send", {\n  method: "POST",\n  headers: {\n    Authorization: \`Bearer \${process.env.HOSTIGGO_MAIL_KEY}\`,\n    "Idempotency-Key": "order-1042", // retries never double-send\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify(${body}),\n});\nconst { id, status } = await res.json(); // status: "queued"`;
    return `import os, requests\n\nr = requests.post(\n    "${base}/v1/messages/send",\n    headers={\n        "Authorization": f"Bearer {os.environ['HOSTIGGO_MAIL_KEY']}",\n        "Idempotency-Key": "order-1042",\n    },\n    json=${body.replace(/"/g, "'").replace(/'(\w+)':/g, '"$1":')},\n)\nprint(r.json())  # {'id': ..., 'status': 'queued'}`;
  }, [lang, base, key, body]);

  return (
    <Card className="grid grid-cols-1 overflow-hidden lg:grid-cols-[1fr_1.3fr]">
      <div className="flex flex-col gap-4 p-5">
        <div>
          <div className="flex items-center gap-2 text-[15px] font-semibold"><KeyRound className="size-4 text-rose-500" /> API credentials</div>
          <p className="mt-1 text-[12px] text-muted">Your backend calls <span className="font-mono">POST /v1/messages/send</span> with a scoped key. Keys are shown once and stored hashed.</p>
        </div>
        {newKey ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
            <div className="caps mb-1 text-emerald-700">New key: copy it now</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-[12px]">{newKey}</code>
              <Button size="sm" onClick={() => { navigator.clipboard.writeText(newKey); toast('Key copied'); }}><Copy className="size-3.5" /> Copy</Button>
            </div>
          </div>
        ) : null}
        {isAdmin(workspace?.role) ? (
          <div className="space-y-2">
            <div className="caps">Keys with messages:send scope</div>
            {sendKeys.length === 0 && <div className="text-[12px] text-muted">None yet.</div>}
            {sendKeys.map((k) => (
              <div key={k.id} className="flex items-center justify-between rounded-md bg-canvas px-3 py-2">
                <span className="font-mono text-[12px]">{k.prefix}••••••••</span>
                <span className="text-[11px] text-muted">{k.last_used_at ? `used ${timeAgo(k.last_used_at)}` : 'never used'}</span>
              </div>
            ))}
            <div className="flex gap-2">
              <Button size="sm" variant="primary" loading={create.isPending} onClick={() => create.mutate()}><Plus className="size-3.5" /> Create key</Button>
              <Link to="/settings/api"><Button size="sm">Manage keys</Button></Link>
            </div>
          </div>
        ) : <div className="text-[12px] text-muted">Ask a workspace admin for an API key.</div>}
        <div className="mt-auto flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
          <Zap className="mt-0.5 size-3.5 shrink-0" /> Always send an <b>Idempotency-Key</b>: repeating a request with the same key returns the original message instead of sending twice.
        </div>
      </div>
      <div className="bg-shell p-4 text-slate-200">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex gap-1">
            {(['curl', 'node', 'python'] as const).map((l) => (
              <button key={l} onClick={() => setLang(l)} className={cx('rounded px-2.5 py-1 text-[12px] font-semibold', lang === l ? 'bg-shell-active text-white' : 'text-slate-400 hover:text-white')}>{l === 'node' ? 'Node.js' : l === 'curl' ? 'cURL' : 'Python'}</button>
            ))}
          </div>
          <button className="text-slate-400 hover:text-white" onClick={() => { navigator.clipboard.writeText(code); toast('Snippet copied'); }} aria-label="Copy snippet"><Copy className="size-4" /></button>
        </div>
        <pre className="overflow-x-auto rounded-lg bg-black/30 p-4 font-mono text-[12px] leading-5 text-emerald-200"><code>{code}</code></pre>
      </div>
    </Card>
  );
}

function SendMessageModal({ open, onClose, onSent }: { open: boolean; onClose: () => void; onSent: (id: string) => void }) {
  const mb = useActiveMailboxes();
  const templates = useTemplates('transactional');
  const sys = useSystem();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ to: '', mailbox_id: '', template_id: '', subject: '', text_body: '', variables: '{}' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const pickTemplate = (id: string) => {
    const t = templates.data?.find((x) => x.id === id);
    const sample = t?.sample_variables && Object.keys(t.sample_variables).length ? JSON.stringify(t.sample_variables, null, 2) : '{}';
    setF({ ...f, template_id: id, variables: sample });
  };
  const send = useMutation({
    mutationFn: () => {
      let variables: Record<string, unknown> = {};
      try { variables = JSON.parse(f.variables || '{}'); } catch { throw new Error('Variables must be valid JSON'); }
      const body: any = { to: f.to, mailbox_id: f.mailbox_id || undefined, variables };
      if (f.template_id) body.template_id = f.template_id; else { body.subject = f.subject; body.text_body = f.text_body; }
      return api('/v1/messages/send', { body, headers: { 'idempotency-key': `console-${crypto.randomUUID()}` } });
    },
    onSuccess: (r: any) => { toast(sys.data?.delivers_real_email ? 'Message queued for delivery' : 'Queued (dev mode: not delivered)'); qc.invalidateQueries({ queryKey: ['sends'] }); onClose(); onSent(r.id); },
  });
  return (
    <Modal open={open} onClose={onClose} title="Send a transactional message" subtitle="Same path as the API. Bounced or complained addresses are blocked automatically."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={send.isPending} disabled={!f.to || (!f.template_id && (!f.subject || !f.text_body)) || !mb.data?.length} onClick={() => send.mutate()}><Send className="size-3.5" /> Send</Button></>}>
      <div className="space-y-3">
        {!mb.data?.length && <ErrorBox error="Connect a Gmail mailbox first (Deliverability page)." />}
        <div className="grid grid-cols-2 gap-3">
          <Field label="To"><input className="input" type="email" value={f.to} onChange={set('to')} placeholder="guest@example.com" /></Field>
          <Field label="From mailbox">
            <select className="input" value={f.mailbox_id} onChange={set('mailbox_id')}>
              <option value="">First connected</option>
              {mb.data?.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Template">
          <select className="input" value={f.template_id} onChange={(e) => pickTemplate(e.target.value)}>
            <option value="">No template (write it below)</option>
            {templates.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        {f.template_id ? (
          <Field label="Variables (JSON)" hint={`Template uses: ${templates.data?.find((t) => t.id === f.template_id)?.variables.join(', ') || 'none'}`}>
            <textarea className="input font-mono text-[12px]" rows={f.variables.length > 40 ? 10 : 3} value={f.variables} onChange={set('variables')} />
          </Field>
        ) : (
          <>
            <Field label="Subject"><input className="input" value={f.subject} onChange={set('subject')} /></Field>
            <Field label="Message"><textarea className="input" rows={5} value={f.text_body} onChange={set('text_body')} /></Field>
          </>
        )}
        <ErrorBox error={send.error} />
      </div>
    </Modal>
  );
}

const FLOW: { step: string; who: string; sends: string }[] = [
  { step: 'Guest books', who: 'Website', sends: 'booking_request_host + booking_received_guest now; booking_reminder_host with send_at = booked + 90 min' },
  { step: 'Host accepts', who: 'Website', sends: 'Cancel tag booking:<id>, then booking_confirmed_guest + booking_confirmed_host' },
  { step: 'Host rejects', who: 'Website', sends: 'Cancel tag booking:<id>, start the refund, then booking_declined_guest' },
  { step: '2 hours, no answer', who: 'Website expiry job', sends: 'Cancel tag booking:<id>, start the refund, then booking_expired_guest + booking_expired_host' },
];

/** The booking email starter pack: install it, see which templates exist, and the order the website sends them in. */
function BookingPack() {
  const qc = useQueryClient();
  const toast = useToast();
  const pack = useQuery({ queryKey: ['starter', 'booking'], queryFn: async () => (await api('/v1/templates/starter/booking')).data as any[] });
  const install = useMutation({
    mutationFn: () => api('/v1/templates/starter/booking', { method: 'POST' }),
    onSuccess: (r: any) => {
      toast(r.created.length ? `Added ${r.created.length} booking templates` : 'All booking templates are already installed');
      qc.invalidateQueries({ queryKey: ['starter', 'booking'] });
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const missing = (pack.data ?? []).filter((t) => !t.template_id).length;
  return (
    <div className="space-y-5 px-5 pb-5">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg bg-canvas p-4">
        <div className="max-w-2xl text-[13px] text-ink-2">
          <div className="text-[14px] font-semibold text-ink">Host has 2 hours to accept</div>
          The website owns the booking status and calls the send API at each change. Tag every email <span className="font-mono">booking:&lt;id&gt;</span> so the
          reminder can be cancelled and the whole history found in the log. The guide <span className="font-mono">BOOKING-EMAILS.md</span> has the website code.
        </div>
        <Button variant="primary" loading={install.isPending} disabled={pack.isLoading || missing === 0} onClick={() => install.mutate()}>
          <Plus className="size-3.5" /> {missing === 0 && pack.data ? 'All installed' : `Add booking templates${missing && missing < (pack.data?.length ?? 0) ? ` (${missing} missing)` : ''}`}
        </Button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead><tr><th className="th">When</th><th className="th">Who calls</th><th className="th">What it sends</th></tr></thead>
          <tbody>
            {FLOW.map((f) => (
              <tr key={f.step}><td className="td font-medium whitespace-nowrap">{f.step}</td><td className="td text-muted whitespace-nowrap">{f.who}</td><td className="td font-mono text-[11px]">{f.sends}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead><tr><th className="th">Template</th><th className="th">API name</th><th className="th">Sent</th><th className="th text-right">Status</th></tr></thead>
          <tbody>
            {(pack.data ?? []).map((t) => (
              <tr key={t.slug} className="row-hover">
                <td className="td font-medium">{t.template_id ? <Link to={`/templates?id=${t.template_id}`} className="hover:text-brand">{t.name}</Link> : t.name}</td>
                <td className="td font-mono text-[11px]">{t.slug}</td>
                <td className="td max-w-96 text-[12px] text-muted">{t.when}</td>
                <td className="td text-right">{t.template_id ? <Pill tone="success" dot>Installed</Pill> : <Pill tone="neutral">Not installed</Pill>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
