import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Eye, FileCode2, Plus, Save, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../api';
import { canEdit, useAuth } from '../auth';
import { useActiveMailboxes, useTemplates } from '../hooks';
import { Button, Card, CardHeader, Empty, ErrorBox, Field, KindPill, Modal, PageHeader, Spinner, Tabs, cx, errText, timeAgo, useToast } from '../ui';

const VARS = ['contact.first_name', 'contact.last_name', 'contact.full_name', 'contact.email'];
const BLANK = { name: '', kind: 'marketing', subject: '', html_body: '', text_body: '', from_name: '', reply_to: '' };

export function TemplatesPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('id');
  const isNew = params.get('new');
  const [kind, setKind] = useState<'all' | 'transactional' | 'marketing'>('all');
  const list = useTemplates(kind === 'all' ? undefined : kind);
  const { workspace } = useAuth();
  return (
    <>
      <PageHeader eyebrow="Content" title="Templates" subtitle="Every save creates an immutable version. Published automations and sent campaigns keep the version they were built with."
        actions={canEdit(workspace?.role) && <Button variant="primary" onClick={() => setParams({ new: 'marketing' })}><Plus className="size-3.5" /> New template</Button>} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[320px_1fr]">
        <Card className="h-fit">
          <div className="px-4 pt-4 pb-2"><Tabs value={kind} onChange={setKind} items={[{ value: 'all', label: 'All' }, { value: 'transactional', label: 'Transactional' }, { value: 'marketing', label: 'Marketing' }]} /></div>
          <div className="space-y-1 p-2">
            {list.isLoading && <Spinner />}
            {list.data?.map((t) => (
              <button key={t.id} onClick={() => setParams({ id: t.id })} className={cx('w-full rounded-lg px-3 py-2.5 text-left', selected === t.id ? 'bg-indigo-50 ring-1 ring-indigo-200' : 'hover:bg-canvas')}>
                <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{t.name}</span><KindPill kind={t.kind} /></div>
                <div className="mt-0.5 truncate text-[12px] text-muted">{t.subject}</div>
                <div className="mt-0.5 font-mono text-[10px] text-muted">v{t.current_version} · {timeAgo(t.updated_at)}</div>
              </button>
            ))}
            {list.data?.length === 0 && <Empty icon={<FileCode2 className="size-6" />} title="No templates yet" />}
          </div>
        </Card>
        {selected || isNew ? <Editor key={selected ?? `new-${isNew}`} id={selected} initialKind={isNew ?? 'marketing'} onSaved={(id) => setParams({ id })} /> : (
          <Card><Empty icon={<FileCode2 className="size-7" />} title="Select a template" action={canEdit(workspace?.role) ? <Button variant="primary" size="sm" onClick={() => setParams({ new: 'transactional' })}>New transactional template</Button> : undefined}>Pick a template on the left, or create one.</Empty></Card>
        )}
      </div>
    </>
  );
}

function Editor({ id, initialKind, onSaved }: { id: string | null; initialKind: string; onSaved: (id: string) => void }) {
  const q = useQuery({ queryKey: ['template', id], enabled: !!id, queryFn: () => api(`/v1/templates/${id}`) });
  const [f, setF] = useState({ ...BLANK, kind: initialKind });
  const [focus, setFocus] = useState<'subject' | 'html_body' | 'text_body'>('html_body');
  const [testOpen, setTestOpen] = useState(false);
  const [previewTab, setPreviewTab] = useState<'html' | 'text'>('html');
  const qc = useQueryClient();
  const toast = useToast();
  const { workspace } = useAuth();
  useEffect(() => {
    const c = q.data?.current;
    if (c) setF({ name: q.data.name, kind: q.data.kind, subject: c.subject, html_body: c.html_body ?? '', text_body: c.text_body ?? '', from_name: c.from_name ?? '', reply_to: c.reply_to ?? '' });
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name, subject: f.subject, html_body: f.html_body || null, text_body: f.text_body || null, from_name: f.from_name || null, reply_to: f.reply_to || null };
      return id ? api(`/v1/templates/${id}`, { method: 'PUT', body }) : api('/v1/templates', { body: { ...body, kind: f.kind } });
    },
    onSuccess: (r: any) => {
      toast(id ? `Saved as version ${r.version}` : 'Template created');
      qc.invalidateQueries({ queryKey: ['templates'] });
      qc.invalidateQueries({ queryKey: ['template', id] });
      if (!id) onSaved(r.id);
    },
  });
  const preview = useMutation({ mutationFn: () => api(`/v1/templates/${id}/preview`, { body: {} }) });
  const archive = useMutation({
    mutationFn: () => api(`/v1/templates/${id}/archive`, { method: 'POST' }),
    onSuccess: () => { toast('Template archived'); qc.invalidateQueries({ queryKey: ['templates'] }); },
    onError: (e) => toast(errText(e), 'error'),
  });
  useEffect(() => { if (id && q.data) preview.mutate(); }, [id, q.data?.current_version]); // eslint-disable-line react-hooks/exhaustive-deps

  const insert = (v: string) => setF((s) => ({ ...s, [focus]: `${s[focus]}{{ ${v} }}` }));
  const editable = canEdit(workspace?.role);
  if (id && q.isLoading) return <Card><Spinner /></Card>;

  return (
    <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
      <Card>
        <CardHeader title={id ? f.name || 'Template' : 'New template'} subtitle={id ? `Version ${q.data?.current_version} · ${q.data?.versions.length} versions` : 'Saved as version 1'}
          right={<KindPill kind={f.kind} />} />
        <div className="space-y-3 px-5 pb-5">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Type" hint="Marketing mail gets an unsubscribe link and needs opted-in contacts.">
              <select className="input" value={f.kind} disabled={!!id} onChange={(e) => setF({ ...f, kind: e.target.value })}>
                <option value="transactional">Transactional</option>
                <option value="marketing">Marketing</option>
              </select>
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold text-muted">Insert into {focus.replace('_body', '').replace('html', 'HTML')}:</span>
            {VARS.map((v) => <button key={v} type="button" onClick={() => insert(v)} className="rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[11px] text-brand hover:bg-indigo-100">{v}</button>)}
            <span className="text-[11px] text-muted">· fallback: <code className="font-mono">{'{{ contact.first_name | default: "there" }}'}</code></span>
          </div>
          <Field label="Subject"><input className="input font-mono text-[12px]" value={f.subject} onFocus={() => setFocus('subject')} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
          <Field label="HTML body"><textarea className="input font-mono text-[12px]" rows={10} value={f.html_body} onFocus={() => setFocus('html_body')} onChange={(e) => setF({ ...f, html_body: e.target.value })} /></Field>
          <Field label="Plain-text body" hint="Recommended alongside HTML; some clients only show text."><textarea className="input font-mono text-[12px]" rows={5} value={f.text_body} onFocus={() => setFocus('text_body')} onChange={(e) => setF({ ...f, text_body: e.target.value })} /></Field>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="From name (optional)"><input className="input" value={f.from_name} placeholder="Hostiggo" onChange={(e) => setF({ ...f, from_name: e.target.value })} /></Field>
            <Field label="Reply-to (optional)"><input className="input" type="email" value={f.reply_to} onChange={(e) => setF({ ...f, reply_to: e.target.value })} /></Field>
          </div>
          <ErrorBox error={save.error} />
          {editable && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="primary" loading={save.isPending} disabled={!f.name || !f.subject || (!f.html_body && !f.text_body)} onClick={() => save.mutate()}><Save className="size-3.5" /> {id ? 'Save new version' : 'Create template'}</Button>
              {id && <Button onClick={() => preview.mutate()} loading={preview.isPending}><Eye className="size-3.5" /> Refresh preview</Button>}
              {id && <Button onClick={() => setTestOpen(true)}><Send className="size-3.5" /> Send test</Button>}
              {id && <Button variant="danger" className="ml-auto" onClick={() => confirm('Archive this template? Live automations keep their pinned version.') && archive.mutate()}><Archive className="size-3.5" /> Archive</Button>}
            </div>
          )}
        </div>
      </Card>
      <Card>
        <CardHeader title="Preview" subtitle={id ? 'Rendered with a sample contact (Jane Doe). Save to update.' : 'Save the template to preview it.'}
          right={<Tabs value={previewTab} onChange={setPreviewTab} items={[{ value: 'html', label: 'HTML' }, { value: 'text', label: 'Text' }]} />} />
        <div className="px-5 pb-5">
          {preview.data ? (
            <div className="overflow-hidden rounded-lg border border-line">
              <div className="border-b border-line bg-canvas px-3 py-2 text-[12px]"><span className="text-muted">Subject: </span><b>{preview.data.subject}</b></div>
              {previewTab === 'html' && preview.data.html
                ? <iframe title="Email preview" sandbox="" className="h-[520px] w-full bg-white" srcDoc={preview.data.html} />
                : <pre className="h-[520px] overflow-auto whitespace-pre-wrap p-4 font-mono text-[12px]">{preview.data.text ?? '(no text body)'}</pre>}
              {preview.data.missing?.length > 0 && <div className="border-t border-line bg-orange-50 px-3 py-2 text-[11px] text-orange-800">Empty for the sample contact: {preview.data.missing.join(', ')}</div>}
            </div>
          ) : <Empty icon={<Eye className="size-6" />} title="No preview yet" />}
        </div>
      </Card>
      {testOpen && id && <TestSendModal templateId={id} onClose={() => setTestOpen(false)} />}
    </div>
  );
}

function TestSendModal({ templateId, onClose }: { templateId: string; onClose: () => void }) {
  const mb = useActiveMailboxes();
  const { me } = useAuth();
  const [to, setTo] = useState(me?.user.email ?? '');
  const [mailbox, setMailbox] = useState('');
  const toast = useToast();
  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: () => api(`/v1/templates/${templateId}/test`, { body: { to, mailbox_id: mailbox || mb.data?.[0]?.id } }),
    onSuccess: () => { toast('Test queued'); qc.invalidateQueries({ queryKey: ['sends'] }); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title="Send test of this template" subtitle="Uses sample contact data. Test sends are excluded from metrics."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!mb.data?.length} loading={send.isPending} onClick={() => send.mutate()}>Send test</Button></>}>
      <div className="space-y-3">
        {!mb.data?.length && <ErrorBox error="Connect a Gmail mailbox first." />}
        <Field label="From mailbox"><select className="input" value={mailbox} onChange={(e) => setMailbox(e.target.value)}>{mb.data?.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}</select></Field>
        <Field label="To"><input className="input" type="email" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <ErrorBox error={send.error} />
      </div>
    </Modal>
  );
}
