import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, Copy, KeyRound, Plus, Send, Trash2, Webhook } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, useNavigate, useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import { isAdmin, useAuth } from '../auth';
import { useSystem } from '../hooks';
import { Button, Card, CardHeader, Empty, ErrorBox, Field, Modal, PageHeader, Pill, Spinner, cx, dateTime, errText, timeAgo, useToast } from '../ui';
import { MailboxCards, SetupBanner } from './deliverability';
import { OperationsSection } from './operations';

const OAUTH_ERRORS: Record<string, string> = {
  access_denied: 'Google access was not granted.',
  scope_missing: 'Permission to send email was not granted. Reconnect and leave "Send email on your behalf" ticked.',
  state_expired: 'The connection request expired. Please try again.',
  no_refresh_token: 'Google did not return offline access. Remove Hostiggo Mail from your Google account permissions and reconnect.',
  google_not_configured: 'Google OAuth credentials are not configured on the server.',
};

export function SettingsPage() {
  const { section = 'mailboxes' } = useParams();
  const sys = useSystem();
  const tabs = [
    ['mailboxes', 'Mailboxes'], ['gmail', 'Gmail setup'], ['api', 'API keys & webhooks'], ['members', 'Members'], ['ops', 'Operations'], ['audit', 'Audit log'],
    ...(sys.data && !sys.data.delivers_real_email ? [['outbox', 'Dev outbox']] : []),
  ];
  return (
    <>
      <PageHeader eyebrow="Workspace" title="Settings" subtitle="Mailbox connections, sending setup, API access and team." />
      <div className="flex flex-wrap gap-1 border-b border-line">
        {tabs.map(([k, l]) => (
          <NavLink key={k} to={`/settings/${k}`} className={cx('-mb-px border-b-2 px-3 py-2 text-[13px] font-medium', section === k ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-ink')}>{l}</NavLink>
        ))}
      </div>
      {section === 'mailboxes' && <MailboxesSection />}
      {section === 'gmail' && <GmailSetup />}
      {section === 'api' && <ApiSection />}
      {section === 'members' && <Members />}
      {section === 'audit' && <Audit />}
      {section === 'outbox' && <Outbox />}
      {section === 'ops' && <OperationsSection />}
    </>
  );
}

function MailboxesSection() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const qc = useQueryClient();
  useEffect(() => {
    const connected = params.get('connected');
    const error = params.get('error');
    if (connected) { toast('Gmail connected. Send a test email to check it.'); qc.invalidateQueries(); }
    if (error) toast(OAUTH_ERRORS[error] ?? `Could not connect Gmail (${error}).`, 'error');
    if (connected || error) setParams({}, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <><SetupBanner /><MailboxCards /></>;
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <div className="flex items-start gap-2 text-[13px]">{ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-orange-500" />}<span>{children}</span></div>;
}

function GmailSetup() {
  const sys = useSystem();
  const toast = useToast();
  if (!sys.data) return <Spinner />;
  const s = sys.data;
  const copy = (t: string) => { navigator.clipboard.writeText(t); toast('Copied'); };
  const env = `EMAIL_PROVIDER_MODE=gmail\nGOOGLE_CLIENT_ID=<your client id>.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=<your client secret>\n# Generate once with: npm run gen:key\nTOKEN_ENCRYPTION_KEYS=k1:<base64 key>\nAPP_SECRET=<long random string>`;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_380px]">
      <Card>
        <CardHeader title="Turn on real Gmail sending" subtitle="About 10 minutes in Google Cloud Console. Only you (and test users you add) can connect until Google verifies the app." />
        <ol className="space-y-4 px-5 pb-5 text-[13px]">
          <li><b>1. Create a Google Cloud project</b> at console.cloud.google.com and enable the <b>Gmail API</b> (APIs & Services → Library).</li>
          <li><b>2. Configure the OAuth consent screen</b>: User type <i>External</i>, app name "Hostiggo Mail", your support email. Leave it in <b>Testing</b> mode and add the Gmail address you will connect under <b>Test users</b>.</li>
          <li><b>3. Create credentials</b> → OAuth client ID → <i>Web application</i>. Add this <b>Authorized redirect URI</b>:
            <div className="mt-2 flex items-center gap-2"><code className="flex-1 truncate rounded bg-canvas px-2 py-1.5 font-mono text-[12px]">{s.oauth_redirect_uri}</code><Button size="sm" onClick={() => copy(s.oauth_redirect_uri)}><Copy className="size-3.5" /></Button></div>
          </li>
          <li><b>4. Put the credentials in the server's <span className="font-mono">.env</span></b> and restart it:
            <div className="relative mt-2"><pre className="overflow-x-auto rounded-lg bg-shell p-3 font-mono text-[12px] leading-5 text-emerald-200">{env}</pre><button className="absolute right-2 top-2 text-slate-400 hover:text-white" onClick={() => copy(env)} aria-label="Copy"><Copy className="size-4" /></button></div>
          </li>
          <li><b>5. Connect your mailbox</b> on the Deliverability page, then use <b>Send Test Email</b> in the top bar. The send log shows <i>Accepted</i> with the Gmail message id, and the message appears in your Gmail <i>Sent</i> folder.</li>
          <li className="text-muted"><b>Optional, reply tracking:</b> set <span className="font-mono">GMAIL_REPLY_TRACKING=true</span>. This adds the restricted <span className="font-mono">gmail.metadata</span> scope (fine in Testing mode; needs Google verification for public use). Without a Pub/Sub topic, replies are picked up every 15 minutes.</li>
        </ol>
      </Card>
      <Card className="h-fit">
        <CardHeader title="Server status" />
        <div className="space-y-2.5 px-5 pb-5">
          <Check ok={s.delivers_real_email}>{s.delivers_real_email ? 'Gmail delivery mode is on' : <>Dev mode (<span className="font-mono">EMAIL_PROVIDER_MODE=fake</span>): emails are not delivered</>}</Check>
          <Check ok={s.google_configured}>{s.google_configured ? 'Google OAuth client configured' : 'Google OAuth client id/secret missing'}</Check>
          <Check ok={s.reply_tracking_enabled}>{s.reply_tracking_enabled ? 'Reply tracking scope requested' : 'Send-only (reply tracking off)'}</Check>
          <Check ok={s.pubsub_configured}>{s.pubsub_configured ? 'Gmail push notifications configured' : 'No Pub/Sub topic: periodic sync only'}</Check>
          <div className="pt-2 text-[12px] text-muted">Default daily limit per mailbox: <b>{s.gmail_default_daily_limit}</b> · campaign cap: <b>{s.gmail_max_campaign_recipients}</b></div>
        </div>
      </Card>
    </div>
  );
}

function ApiSection() {
  const { workspace } = useAuth();
  const sys = useSystem();
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const keys = useQuery({ queryKey: ['api-keys'], enabled: isAdmin(workspace?.role), queryFn: async () => (await api('/v1/api-keys')).data as any[] });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/v1/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast('Key revoked'); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e) => toast(errText(e), 'error'),
  });
  const base = sys.data?.api_base_url ?? window.location.origin;
  if (!isAdmin(workspace?.role)) return <Card><Empty title="Admins only">Ask a workspace owner or admin to manage API keys.</Empty></Card>;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_380px]">
      <Card>
        <CardHeader title="API keys" subtitle="Scoped keys for your backend. Shown once, stored as a hash." icon={<KeyRound className="size-4" />} right={<Button variant="primary" size="sm" onClick={() => setCreating(true)}><Plus className="size-3.5" /> New key</Button>} />
        {shown && (
          <div className="mx-5 mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
            <div className="caps mb-1 text-emerald-700">Copy this key now. It won't be shown again.</div>
            <div className="flex gap-2"><code className="flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-[12px]">{shown}</code><Button size="sm" onClick={() => { navigator.clipboard.writeText(shown); toast('Copied'); }}><Copy className="size-3.5" /> Copy</Button></div>
          </div>
        )}
        {keys.isLoading ? <Spinner /> : keys.data?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px]">
              <thead><tr><th className="th">Name</th><th className="th">Key</th><th className="th">Scopes</th><th className="th">Last used</th><th className="th text-right"></th></tr></thead>
              <tbody>{keys.data.map((k) => (
                <tr key={k.id} className={cx('row-hover', k.revoked_at && 'opacity-50')}>
                  <td className="td font-medium">{k.name}</td>
                  <td className="td font-mono text-[12px]">{k.prefix}••••</td>
                  <td className="td">{k.scopes.map((s: string) => <Pill key={s} tone="brand" className="mr-1 normal-case">{s}</Pill>)}</td>
                  <td className="td font-mono text-[11px] text-muted">{k.revoked_at ? `revoked ${timeAgo(k.revoked_at)}` : k.last_used_at ? timeAgo(k.last_used_at) : 'never'}</td>
                  <td className="td text-right">{!k.revoked_at && <button className="rounded p-1 text-rose-500 hover:bg-rose-50" title="Revoke" onClick={() => confirm(`Revoke "${k.name}"? Apps using it stop working immediately.`) && revoke.mutate(k.id)}><Trash2 className="size-4" /></button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <Empty title="No API keys" />}
      </Card>
      <Card className="h-fit">
        <CardHeader title="Endpoints" subtitle="Base URL for your integrations." />
        <div className="space-y-3 px-5 pb-5 text-[12px]">
          {[
            ['POST', '/v1/messages/send', 'Transactional send (messages:send)'],
            ['POST', '/v1/messages/batch', 'Up to 50 sends in one all-or-nothing call (messages:send)'],
            ['POST', '/v1/sends/cancel', 'Cancel queued or scheduled sends by tag (messages:send)'],
            ['POST', '/v1/events', 'Product events → automation triggers (events:write)'],
            ['POST', '/v1/contacts', 'Create/update contacts (contacts:write)'],
            ['POST', '/webhooks/google/pubsub', 'Gmail push notifications (Google signs these)'],
            ['POST', '/webhooks/provider/:name', 'ESP events, HMAC-signed'],
          ].map(([m, p, d]) => (
            <div key={p} className="rounded-md bg-canvas p-2.5"><div className="font-mono"><b className="text-brand">{m}</b> {base}{p}</div><div className="mt-0.5 text-muted">{d}</div></div>
          ))}
        </div>
      </Card>
      <WebhooksCard />
      {creating && <NewKeyModal onClose={() => setCreating(false)} onCreated={setShown} />}
    </div>
  );
}

const EVENT_HELP: Record<string, string> = {
  'send.failed': 'Gmail rejected it or the mailbox needs reconnecting',
  'send.suppressed': 'Blocked: the address bounced or complained before',
  'send.bounced': 'Accepted, then bounced back',
  'send.unknown': 'Network error mid-send; outcome unclear',
  'send.accepted': 'Handed to Gmail',
  'send.complained': 'Marked as spam',
  'send.replied': 'The recipient replied',
};

/** Outbound webhooks: tell the website when a booking email can't reach someone. */
function WebhooksCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['webhooks'], queryFn: () => api('/v1/webhooks') as Promise<any> });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/v1/webhooks/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast('Webhook removed'); qc.invalidateQueries({ queryKey: ['webhooks'] }); },
    onError: (e) => toast(errText(e), 'error'),
  });
  const ping = useMutation({
    mutationFn: (id: string) => api(`/v1/webhooks/${id}/test`, { method: 'POST' }),
    onSuccess: (_r, id) => { toast('Test event queued'); setOpenId(id); setTimeout(() => qc.invalidateQueries({ queryKey: ['webhook-deliveries', id] }), 2500); },
    onError: (e) => toast(errText(e), 'error'),
  });
  const rows: any[] = list.data?.data ?? [];
  return (
    <Card className="xl:col-span-2">
      <CardHeader title="Webhooks" subtitle="We POST a signed event to your server when a transactional email fails, so the website can fall back (SMS, call the host)." icon={<Webhook className="size-4" />}
        right={<Button variant="primary" size="sm" onClick={() => setAdding(true)}><Plus className="size-3.5" /> Add endpoint</Button>} />
      {secret && (
        <div className="mx-5 mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <div className="caps mb-1 text-emerald-700">Signing secret: copy it now. It won't be shown again.</div>
          <div className="flex gap-2"><code className="flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-[12px]">{secret}</code><Button size="sm" onClick={() => { navigator.clipboard.writeText(secret); toast('Copied'); }}><Copy className="size-3.5" /> Copy</Button></div>
          <p className="mt-2 text-[12px] text-emerald-800">Verify each request: HMAC-SHA256 of <span className="font-mono">"&lt;t&gt;.&lt;raw body&gt;"</span> with this secret must equal <span className="font-mono">v1</span> in the <span className="font-mono">Hostiggo-Signature</span> header.</p>
        </div>
      )}
      {list.isLoading ? <Spinner /> : rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px]">
            <thead><tr><th className="th">URL</th><th className="th">Events</th><th className="th">Last 7 days</th><th className="th text-right"></th></tr></thead>
            <tbody>{rows.map((w) => (
              <tr key={w.id} className="row-hover align-top">
                <td className="td"><div className="font-mono text-[12px] break-all">{w.url}</div>{w.description && <div className="text-[11px] text-muted">{w.description}</div>}
                  {openId === w.id && <Deliveries id={w.id} />}</td>
                <td className="td">{w.events.map((e: string) => <Pill key={e} tone="neutral" className="mr-1 mb-1 normal-case">{e}</Pill>)}</td>
                <td className="td text-[12px] whitespace-nowrap">
                  <span className="text-emerald-700">{w.delivered_7d} delivered</span>
                  {w.failed_7d > 0 && <span className="text-rose-600"> · {w.failed_7d} failed</span>}
                  {w.pending > 0 && <span className="text-orange-600"> · {w.pending} retrying</span>}
                  <div><button className="text-[11px] text-brand hover:underline" onClick={() => setOpenId(openId === w.id ? null : w.id)}>{openId === w.id ? 'Hide' : 'Show'} recent deliveries</button></div>
                </td>
                <td className="td text-right whitespace-nowrap">
                  <Button size="sm" loading={ping.isPending && ping.variables === w.id} onClick={() => ping.mutate(w.id)}><Send className="size-3.5" /> Send test</Button>
                  <button className="ml-1 rounded p-1 text-rose-500 hover:bg-rose-50" title="Remove" onClick={() => confirm(`Stop sending events to ${w.url}?`) && remove.mutate(w.id)}><Trash2 className="size-4" /></button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Empty icon={<Webhook className="size-6" />} title="No webhooks">Add your website's endpoint to hear about failed or bounced booking emails within seconds.</Empty>}
      {adding && <NewWebhookModal events={list.data?.events ?? []} defaults={list.data?.default_events ?? []} onClose={() => setAdding(false)} onCreated={setSecret} />}
    </Card>
  );
}

function Deliveries({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['webhook-deliveries', id], queryFn: async () => (await api(`/v1/webhooks/${id}/deliveries`)).data as any[], refetchInterval: 5000 });
  if (q.isLoading) return <Spinner />;
  if (!q.data?.length) return <div className="mt-2 text-[11px] text-muted">No deliveries yet.</div>;
  return (
    <div className="mt-2 space-y-1">
      {q.data.slice(0, 10).map((d) => (
        <div key={d.id} className="flex items-center gap-2 text-[11px]">
          <Pill tone={d.status === 'delivered' ? 'success' : d.status === 'failed' ? 'danger' : 'alert'} className="normal-case">{d.status}</Pill>
          <span className="font-mono">{d.event}</span>
          <span className="text-muted">{timeAgo(d.created_at)} · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}{d.response_status ? ` · HTTP ${d.response_status}` : ''}</span>
          {d.last_error && d.status !== 'delivered' && <span className="truncate text-rose-600" title={d.last_error}>{d.last_error}</span>}
        </div>
      ))}
    </div>
  );
}

function NewWebhookModal({ events, defaults, onClose, onCreated }: { events: string[]; defaults: string[]; onClose: () => void; onCreated: (secret: string) => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [picked, setPicked] = useState<string[]>(defaults);
  const create = useMutation({
    mutationFn: () => api('/v1/webhooks', { body: { url, description: description || undefined, events: picked } }),
    onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ['webhooks'] }); onCreated(r.secret); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title="Add a webhook endpoint" subtitle="Transactional sends only. Failed deliveries are retried for about an hour."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={!url || picked.length === 0} onClick={() => create.mutate()}>Add endpoint</Button></>}>
      <div className="space-y-3">
        <Field label="Endpoint URL" hint="Must be https in production."><input className="input font-mono text-[12px]" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hostiggo.com/api/mail-events" /></Field>
        <Field label="Description (optional)"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Website booking fallback" /></Field>
        <div>
          <div className="caps mb-1.5">Events</div>
          <div className="space-y-1.5">
            {events.map((e) => (
              <label key={e} className="flex items-start gap-2 text-[13px]">
                <input type="checkbox" className="mt-1" checked={picked.includes(e)} onChange={(ev) => setPicked(ev.target.checked ? [...picked, e] : picked.filter((x) => x !== e))} />
                <span><span className="font-mono text-[12px]">{e}</span> <span className="text-muted">{EVENT_HELP[e] ?? ''}</span></span>
              </label>
            ))}
          </div>
        </div>
        <ErrorBox error={create.error} />
      </div>
    </Modal>
  );
}

function NewKeyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (k: string) => void }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['messages:send']);
  const qc = useQueryClient();
  const all = [['messages:send', 'Send transactional email'], ['events:write', 'Post product events'], ['contacts:write', 'Create/update contacts'], ['contacts:read', 'Read contacts']];
  const create = useMutation({
    mutationFn: () => api('/v1/api-keys', { body: { name, scopes } }),
    onSuccess: (r: any) => { onCreated(r.key); qc.invalidateQueries({ queryKey: ['api-keys'] }); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title="New API key" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name || !scopes.length} loading={create.isPending} onClick={() => create.mutate()}>Create key</Button></>}>
      <div className="space-y-3">
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Booking service (production)" /></Field>
        <div className="space-y-1.5">
          <div className="text-[12px] font-semibold text-ink-2">Scopes</div>
          {all.map(([s, d]) => (
            <label key={s} className="flex items-center gap-2 text-[13px]"><input type="checkbox" className="size-4 accent-brand" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} /><span className="font-mono text-[12px]">{s}</span><span className="text-muted">· {d}</span></label>
          ))}
        </div>
        <ErrorBox error={create.error} />
      </div>
    </Modal>
  );
}

function Members() {
  const { workspace, me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['members'], queryFn: async () => (await api('/v1/members')).data as any[] });
  const add = useMutation({
    mutationFn: () => api('/v1/members', { body: { email, role } }),
    onSuccess: (r: any) => {
      setEmail('');
      if (r.invited) { setInviteUrl(r.invite_url); toast(`${r.email} has no account yet: share the invitation link`); }
      else toast('Member added');
      qc.invalidateQueries({ queryKey: ['members'] });
      qc.invalidateQueries({ queryKey: ['invites'] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const change = useMutation({
    mutationFn: ({ id, role, remove }: { id: string; role?: string; remove?: boolean }) => remove ? api(`/v1/members/${id}`, { method: 'DELETE' }) : api(`/v1/members/${id}`, { method: 'PATCH', body: { role } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['members'] }),
    onError: (e) => toast(errText(e), 'error'),
  });
  const admin = isAdmin(workspace?.role);
  return (
    <Card>
      <CardHeader title={`Members of ${workspace?.name}`} subtitle="Viewers read; members build and send; admins manage mailboxes, keys and people." />
      {admin && (
        <form className="flex flex-wrap gap-2 px-5 pb-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <input className="input max-w-xs" type="email" required placeholder="teammate@hostiggo.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select className="input w-36" value={role} onChange={(e) => setRole(e.target.value)}><option value="viewer">Viewer</option><option value="member">Member</option><option value="admin">Admin</option></select>
          <Button type="submit" variant="primary" loading={add.isPending}>Add member</Button>
        </form>
      )}
      {q.isLoading ? <Spinner /> : (
        <table className="w-full">
          <thead><tr><th className="th">Email</th><th className="th">Role</th><th className="th">Joined</th><th className="th"></th></tr></thead>
          <tbody>{q.data?.map((m) => (
            <tr key={m.user_id} className="row-hover">
              <td className="td">{m.email}{m.user_id === me?.user.id && <span className="ml-1 text-muted">(you)</span>}</td>
              <td className="td">{admin && m.role !== 'owner' && m.user_id !== me?.user.id ? (
                <select className="input h-7 w-28" value={m.role} onChange={(e) => change.mutate({ id: m.user_id, role: e.target.value })}><option value="viewer">viewer</option><option value="member">member</option><option value="admin">admin</option></select>
              ) : <Pill tone={m.role === 'owner' ? 'brand' : 'neutral'}>{m.role}</Pill>}</td>
              <td className="td font-mono text-[11px] text-muted">{dateTime(m.created_at)}</td>
              <td className="td text-right">{admin && m.role !== 'owner' && m.user_id !== me?.user.id && <button className="rounded p-1 text-rose-500 hover:bg-rose-50" onClick={() => confirm(`Remove ${m.email}?`) && change.mutate({ id: m.user_id, remove: true })}><Trash2 className="size-4" /></button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {admin && <Invites inviteUrl={inviteUrl} />}
      <NewWorkspace />
    </Card>
  );
}

function Invites({ inviteUrl }: { inviteUrl: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['invites'], queryFn: async () => (await api('/v1/invites')).data as any[] });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/v1/invites/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast('Invitation revoked'); qc.invalidateQueries({ queryKey: ['invites'] }); },
    onError: (e) => toast(errText(e), 'error'),
  });
  return (
    <div className="space-y-2 border-t border-line px-5 py-4">
      {inviteUrl && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <div className="caps mb-1 text-emerald-700">Invitation link: send it to them (valid 7 days, works once)</div>
          <div className="flex gap-2"><code className="flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-[12px]">{inviteUrl}</code>
            <Button size="sm" onClick={() => { navigator.clipboard.writeText(inviteUrl); toast('Link copied'); }}><Copy className="size-3.5" /> Copy</Button></div>
          <p className="mt-1 text-[11px] text-emerald-800">The link only works for that email address. Links can't be shown again; invite again to get a new one.</p>
        </div>
      )}
      <div className="caps">Pending invitations</div>
      {q.data?.length ? q.data.map((i) => (
        <div key={i.id} className="flex items-center justify-between rounded-md bg-canvas px-3 py-2 text-[12px]">
          <span>{i.email} <Pill className="ml-1">{i.role}</Pill></span>
          <span className="flex items-center gap-2 text-muted">expires {dateTime(i.expires_at)}
            <button className="rounded p-1 text-rose-500 hover:bg-rose-50" title="Revoke" onClick={() => revoke.mutate(i.id)}><Trash2 className="size-4" /></button></span>
        </div>
      )) : <div className="text-[12px] text-muted">None. Adding someone who has no account creates an invitation link.</div>}
    </div>
  );
}

function NewWorkspace() {
  const [name, setName] = useState('');
  const { switchWorkspace } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const create = useMutation({
    mutationFn: () => api('/v1/workspaces', { body: { name } }),
    onSuccess: async (r: any) => { await qc.invalidateQueries({ queryKey: ['me'] }); switchWorkspace(r.id); nav('/'); },
  });
  return (
    <form className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-4" onSubmit={(e) => { e.preventDefault(); if (name) create.mutate(); }}>
      <span className="text-[12px] text-muted">Create another workspace:</span>
      <input className="input max-w-xs" value={name} onChange={(e) => setName(e.target.value)} placeholder="Workspace name" />
      <Button type="submit" loading={create.isPending}>Create</Button>
    </form>
  );
}

function Audit() {
  const { workspace } = useAuth();
  const q = useQuery({ queryKey: ['audit'], enabled: isAdmin(workspace?.role), queryFn: async () => (await api('/v1/audit-logs?limit=200')).data as any[] });
  if (!isAdmin(workspace?.role)) return <Card><Empty title="Admins only" /></Card>;
  return (
    <Card>
      <CardHeader title="Audit log" subtitle="Connection changes, key management, publishes, imports and other sensitive actions." />
      {q.isLoading ? <Spinner /> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead><tr><th className="th">When</th><th className="th">Action</th><th className="th">Actor</th><th className="th">Target</th><th className="th">Details</th></tr></thead>
            <tbody>{q.data?.map((e) => (
              <tr key={e.id} className="row-hover">
                <td className="td whitespace-nowrap font-mono text-[11px] text-muted">{dateTime(e.created_at)}</td>
                <td className="td font-mono text-[12px] font-semibold">{e.action}</td>
                <td className="td text-[12px]">{e.actor_type}</td>
                <td className="td font-mono text-[11px] text-muted">{e.target_type ? `${e.target_type}:${String(e.target_id).slice(0, 12)}` : '—'}</td>
                <td className="td max-w-80 truncate font-mono text-[11px] text-muted">{Object.keys(e.metadata ?? {}).length ? JSON.stringify(e.metadata) : ''}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Outbox() {
  const q = useQuery({ queryKey: ['outbox'], queryFn: async () => (await api('/v1/dev/outbox')).data as any[], refetchInterval: 5000 });
  const [open, setOpen] = useState<any>(null);
  return (
    <Card>
      <CardHeader title="Dev outbox" subtitle="Dev mode only: what would have been delivered by Gmail. Nothing here left the server." />
      {q.isLoading ? <Spinner /> : q.data?.length ? (
        <table className="w-full">
          <thead><tr><th className="th">From</th><th className="th">To</th><th className="th">Subject</th><th className="th">Date</th></tr></thead>
          <tbody>{q.data.map((m) => (
            <tr key={m.id} className="row-hover cursor-pointer" onClick={() => setOpen(m)}>
              <td className="td font-mono text-[12px]">{m.from}</td><td className="td font-mono text-[12px]">{m.to}</td><td className="td">{m.subject}</td><td className="td font-mono text-[11px] text-muted">{m.date}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : <Empty title="Outbox is empty">Send a test email to see it here.</Empty>}
      <Modal open={!!open} onClose={() => setOpen(null)} wide title={open?.subject} subtitle={open ? `${open.from} → ${open.to}` : ''}>
        {open?.list_unsubscribe && <div className="mb-2 font-mono text-[11px] text-muted">List-Unsubscribe: {open.list_unsubscribe}</div>}
        {open?.html ? <iframe title="Message" sandbox="" className="h-[60vh] w-full rounded border border-line" srcDoc={open.html} /> : <pre className="whitespace-pre-wrap rounded bg-canvas p-3 font-mono text-[12px]">{open?.text}</pre>}
      </Modal>
    </Card>
  );
}
