import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, CloudUpload, Download, FileText, ListPlus, Pencil, Plus, Trash2, TriangleAlert, Users } from 'lucide-react';
import { Fragment, useEffect, useState, type ChangeEvent } from 'react';
import { useSearchParams } from 'react-router';
import { api, download } from '../api';
import { canEdit, isAdmin, useAuth } from '../auth';
import { useLists } from '../hooks';
import { Button, Card, CardHeader, Drawer, Empty, ErrorBox, Field, Modal, PageHeader, Pill, SendStatus, Spinner, Stat, cx, dateTime, errText, num, timeAgo, useToast } from '../ui';

const PAGE = 50;

export function ContactsPage() {
  const [params, setParams] = useSearchParams();
  const search = params.get('search') ?? '';
  const listId = params.get('list') ?? '';
  const consent = params.get('consent') ?? '';
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<BulkAction | null>(null);
  const { workspace } = useAuth();
  const lists = useLists();
  const qs = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
  if (search) qs.set('search', search);
  if (listId) qs.set('list_id', listId);
  if (consent === 'suppressed') qs.set('suppressed', 'true');
  else if (consent) qs.set('consent_status', consent);
  const q = useQuery({ queryKey: ['contacts', qs.toString()], queryFn: () => api(`/v1/contacts?${qs}`) });
  // A selection only makes sense for the page it was made on.
  const queryKey = qs.toString();
  useEffect(() => setSelected(new Set()), [queryKey]);
  const rows: any[] = q.data?.data ?? [];
  const allOnPage = rows.length > 0 && rows.every((c) => selected.has(c.id));
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const editable = canEdit(workspace?.role);
  const counts = useQuery({
    queryKey: ['contact-counts'],
    queryFn: async () => {
      const [all, opted] = await Promise.all([api('/v1/contacts?limit=1'), api('/v1/contacts?limit=1&consent_status=opted_in')]);
      return { total: all.total as number, optedIn: opted.total as number };
    },
  });
  const sup = useQuery({ queryKey: ['contacts', 'suppressed-count'], queryFn: () => api('/v1/contacts?limit=1&suppressed=true') });
  const setFilter = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    setParams(p);
    setPage(0);
  };
  const total = q.data?.total ?? 0;

  return (
    <>
      <PageHeader
        eyebrow="Audience"
        title="Contacts & Audience"
        subtitle="Permission-based contacts, lists, and consent records. Suppressions override list membership."
        actions={canEdit(workspace?.role) && <>
          <Button onClick={() => setAdding(true)}><Plus className="size-3.5" /> Add contact</Button>
          <Button variant="primary" onClick={() => setImporting(true)}><CloudUpload className="size-3.5" /> Import CSV</Button>
        </>}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Contacts" icon={<Users className="size-4" />} value={num(counts.data?.total)} sub="Active (not deleted)" />
        <Stat label="Opted in to marketing" icon={<Check className="size-4" />} accent="text-emerald-600" value={num(counts.data?.optedIn)} sub="With recorded consent source" />
        <Stat label="Suppressed" icon={<TriangleAlert className="size-4" />} accent="text-orange-500" value={num(sup.data?.total)} sub="Unsubscribed, bounced or complained" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_280px]">
        <Card>
          <div className="flex flex-wrap items-center gap-2 px-5 pt-4 pb-3">
            <input className="input max-w-xs" placeholder="Search email or name…" defaultValue={search} onKeyDown={(e) => e.key === 'Enter' && setFilter('search', (e.target as HTMLInputElement).value)} onBlur={(e) => e.target.value !== search && setFilter('search', e.target.value)} />
            <select className="input w-44" value={listId} onChange={(e) => setFilter('list', e.target.value)}>
              <option value="">All lists</option>
              {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <select className="input w-44" value={consent} onChange={(e) => setFilter('consent', e.target.value)}>
              <option value="">Any consent</option>
              <option value="opted_in">Opted in</option>
              <option value="unknown">Unknown</option>
              <option value="opted_out">Opted out</option>
              <option value="suppressed">Suppressed</option>
            </select>
            <span className="ml-auto font-mono text-[11px] text-muted">{num(total)} matching</span>
          </div>
          {selected.size > 0 && (
            <div className="mx-5 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-[12px]">
              <b className="text-brand">{num(selected.size)} selected</b>
              <span className="mx-1 text-muted">|</span>
              <Button size="sm" onClick={() => setBulk('opt_in')}><Check className="size-3.5" /> Mark opted in</Button>
              <Button size="sm" onClick={() => setBulk('add_to_list')}><ListPlus className="size-3.5" /> Add to list</Button>
              <Button size="sm" onClick={() => setBulk('remove_from_list')}>Remove from list</Button>
              <Button size="sm" variant="danger" onClick={() => setBulk('delete')}><Trash2 className="size-3.5" /> Delete</Button>
              <button className="ml-auto text-muted hover:text-ink" onClick={() => setSelected(new Set())}>Clear</button>
            </div>
          )}
          {q.isLoading ? <Spinner /> : q.data?.data.length ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px]">
                  <thead><tr>{editable && <th className="th w-9"><input type="checkbox" aria-label="Select all on this page" className="size-4 accent-brand" checked={allOnPage} onChange={() => setSelected(allOnPage ? new Set() : new Set(rows.map((c) => c.id)))} /></th>}<th className="th">Email</th><th className="th">Name</th><th className="th">Consent</th><th className="th">Source</th><th className="th">Status</th><th className="th text-right">Added</th></tr></thead>
                  <tbody>
                    {q.data.data.map((c: any) => (
                      <tr key={c.id} className={cx('row-hover cursor-pointer', selected.has(c.id) && 'bg-indigo-50/50')} onClick={() => setOpenId(c.id)}>
                        {editable && <td className="td w-9" onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${c.email}`} className="size-4 accent-brand" checked={selected.has(c.id)} onChange={() => toggle(c.id)} /></td>}
                        <td className="td font-mono text-[12px]">{c.email}</td>
                        <td className="td">{[c.first_name, c.last_name].filter(Boolean).join(' ') || <span className="text-muted">—</span>}</td>
                        <td className="td"><ConsentPill status={c.consent_status} /></td>
                        <td className="td max-w-48 truncate text-[12px] text-muted" title={c.consent_source ?? ''}>{c.consent_source ?? c.import_source ?? '—'}</td>
                        <td className="td">{c.suppressions.length ? c.suppressions.map((s: string) => <Pill key={s} tone="alert" className="mr-1">{s}</Pill>) : <Pill tone="success">Sendable</Pill>}</td>
                        <td className="td text-right font-mono text-[11px] text-muted">{timeAgo(c.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between px-5 py-3 text-[12px] text-muted">
                <span>Showing {page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {num(total)}</span>
                <div className="flex gap-2">
                  <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
                  <Button size="sm" disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>Next</Button>
                </div>
              </div>
            </>
          ) : (
            <Empty icon={<Users className="size-6" />} title={search || listId || consent ? 'No contacts match' : 'No contacts yet'} action={canEdit(workspace?.role) && !search ? <Button variant="primary" size="sm" onClick={() => setImporting(true)}>Import a CSV</Button> : undefined}>
              Add people who gave permission to hear from you. A CSV upload does not by itself prove consent.
            </Empty>
          )}
        </Card>
        <ListsPanel activeId={listId} onSelect={(id) => setFilter('list', id === listId ? '' : id)} />
      </div>

      <ContactDrawer id={openId} onClose={() => setOpenId(null)} />
      {bulk && <BulkModal action={bulk} ids={[...selected]} onClose={() => setBulk(null)} onDone={() => { setBulk(null); setSelected(new Set()); }} />}
      {adding && <AddContactModal onClose={() => setAdding(false)} />}
      {importing && <ImportWizard onClose={() => setImporting(false)} />}
    </>
  );
}

export function ConsentPill({ status }: { status: string }) {
  if (status === 'opted_in') return <Pill tone="success" dot>Opted in</Pill>;
  if (status === 'opted_out') return <Pill tone="danger" dot>Opted out</Pill>;
  return <Pill tone="neutral" dot>Unknown</Pill>;
}

type BulkAction = 'opt_in' | 'add_to_list' | 'remove_from_list' | 'delete';

const BULK_TITLE: Record<BulkAction, string> = {
  opt_in: 'Mark as opted in',
  add_to_list: 'Add to list',
  remove_from_list: 'Remove from list',
  delete: 'Delete contacts',
};

/** Apply one action to every selected contact. Unsubscribed people are always skipped, never re-subscribed. */
function BulkModal({ action, ids, onClose, onDone }: { action: BulkAction; ids: string[]; onClose: () => void; onDone: () => void }) {
  const lists = useLists();
  const qc = useQueryClient();
  const toast = useToast();
  const [source, setSource] = useState('');
  const [listId, setListId] = useState('');
  const needsList = action === 'add_to_list' || action === 'remove_from_list';
  const run = useMutation({
    mutationFn: () => api('/v1/contacts/bulk', { body: { contact_ids: ids, action, list_id: needsList ? listId : undefined, consent_source: action === 'opt_in' ? source.trim() : undefined } }),
    onSuccess: (r: any) => {
      toast(`${num(r.processed)} updated${r.skipped ? `, ${num(r.skipped)} skipped` : ''}`);
      for (const key of ['contacts', 'contact-counts', 'lists', 'contact', 'campaign-review']) qc.invalidateQueries({ queryKey: [key] });
      onDone();
    },
  });
  const ready = action === 'opt_in' ? !!source.trim() : needsList ? !!listId : true;
  return (
    <Modal open onClose={onClose} title={`${BULK_TITLE[action]} (${num(ids.length)} contacts)`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant={action === 'delete' ? 'danger' : 'primary'} disabled={!ready} loading={run.isPending} onClick={() => run.mutate()}>{BULK_TITLE[action]}</Button></>}>
      <div className="space-y-3">
        {action === 'opt_in' && (
          <>
            <p className="text-[13px] text-ink-2">Only do this if every selected person agreed to receive marketing email. People who already unsubscribed are skipped.</p>
            <Field label="Where did consent come from?" hint="Required. Saved on each contact as the consent record, e.g. 'Event sign-up sheet, Goa, March'."><input className="input" autoFocus value={source} onChange={(e) => setSource(e.target.value)} /></Field>
          </>
        )}
        {needsList && (
          <Field label="List">
            <select className="input" value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">Choose a list…</option>
              {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
        )}
        {action === 'add_to_list' && <p className="text-[12px] text-muted">Anyone added to a list that triggers a live automation enters it right away.</p>}
        {action === 'delete' && <p className="text-[13px] text-ink-2">Active sequences stop and queued messages are cancelled. Their opt-out and bounce records are kept.</p>}
        <ErrorBox error={run.error} />
      </div>
    </Modal>
  );
}

function ListsPanel({ activeId, onSelect }: { activeId: string; onSelect: (id: string) => void }) {
  const lists = useLists();
  const { workspace } = useAuth();
  const [name, setName] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  const create = useMutation({
    mutationFn: () => api('/v1/lists', { body: { name } }),
    onSuccess: () => { setName(''); qc.invalidateQueries({ queryKey: ['lists'] }); toast('List created'); },
    onError: (e) => toast(errText(e), 'error'),
  });
  return (
    <Card className="h-fit">
      <CardHeader title="Lists" subtitle="Click a list to filter." icon={<ListPlus className="size-4" />} />
      <div className="space-y-1 px-3 pb-3">
        {lists.data?.map((l) => (
          <button key={l.id} onClick={() => onSelect(l.id)} className={cx('flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-[13px]', activeId === l.id ? 'bg-indigo-50 text-brand' : 'hover:bg-canvas')}>
            <span className="truncate font-medium">{l.name}</span>
            <span className="tnum font-mono text-[11px] text-muted">{num(l.member_count)}</span>
          </button>
        ))}
        {lists.data?.length === 0 && <div className="px-2.5 py-2 text-[12px] text-muted">No lists yet.</div>}
        {canEdit(workspace?.role) && (
          <form className="flex gap-2 px-1 pt-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
            <input className="input" placeholder="New list name" value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" loading={create.isPending}>Add</Button>
          </form>
        )}
      </div>
    </Card>
  );
}

function AddContactModal({ onClose }: { onClose: () => void }) {
  const lists = useLists();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ email: '', first_name: '', last_name: '', opted_in: false, consent_source: '', list_id: '' });
  const save = useMutation({
    mutationFn: () => api('/v1/contacts', {
      body: {
        email: f.email, first_name: f.first_name || undefined, last_name: f.last_name || undefined,
        ...(f.opted_in ? { consent_status: 'opted_in', consent_source: f.consent_source } : {}),
        list_ids: f.list_id ? [f.list_id] : undefined,
      },
    }),
    onSuccess: (r: any) => {
      toast(r.duplicate ? `${r.email} already exists (not overwritten)` : 'Contact added');
      qc.invalidateQueries({ queryKey: ['contacts'] }); qc.invalidateQueries({ queryKey: ['contact-counts'] }); qc.invalidateQueries({ queryKey: ['lists'] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title="Add contact" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!f.email || (f.opted_in && !f.consent_source)} onClick={() => save.mutate()}>Add contact</Button></>}>
      <div className="space-y-3">
        <Field label="Email"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name"><input className="input" value={f.first_name} onChange={(e) => setF({ ...f, first_name: e.target.value })} /></Field>
          <Field label="Last name"><input className="input" value={f.last_name} onChange={(e) => setF({ ...f, last_name: e.target.value })} /></Field>
        </div>
        <Field label="Add to list">
          <select className="input" value={f.list_id} onChange={(e) => setF({ ...f, list_id: e.target.value })}>
            <option value="">No list</option>
            {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </Field>
        <label className="flex items-start gap-2 rounded-lg bg-canvas p-3 text-[13px]">
          <input type="checkbox" className="mt-0.5 size-4 accent-brand" checked={f.opted_in} onChange={(e) => setF({ ...f, opted_in: e.target.checked })} />
          <span>This person opted in to marketing email.</span>
        </label>
        {f.opted_in && <Field label="Where did consent come from?" hint="Required. E.g. 'Checkout checkbox', 'Newsletter form on hostiggo.com'."><input className="input" value={f.consent_source} onChange={(e) => setF({ ...f, consent_source: e.target.value })} /></Field>}
        <ErrorBox error={save.error} />
      </div>
    </Modal>
  );
}

/** Record marketing consent for an existing contact (never for someone who unsubscribed). */
function OptInBox({ contact }: { contact: any }) {
  const [source, setSource] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  const optIn = useMutation({
    mutationFn: () => api(`/v1/contacts/${contact.id}`, { method: 'PATCH', body: { consent_status: 'opted_in', consent_source: source.trim() } }),
    onSuccess: () => {
      toast(`${contact.email} is now opted in`);
      setSource('');
      for (const key of ['contact', 'contacts', 'contact-counts', 'campaign-review']) qc.invalidateQueries({ queryKey: [key] });
    },
  });
  const unsubscribed = contact.consent_status === 'opted_out' || contact.suppressions.includes('unsubscribed');
  if (unsubscribed) {
    return (
      <div className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-[12px] text-orange-800">
        This person unsubscribed, so they can't be opted back in here. Only they can re-subscribe. An admin can remove the
        suppression on the Deliverability page if they ask to.
      </div>
    );
  }
  return (
    <section className="rounded-lg border border-line bg-canvas p-3">
      <div className="caps mb-1">Marketing consent</div>
      <p className="mb-2 text-[12px] text-muted">Only mark someone opted in if they agreed to receive marketing email from you. The source is saved as your consent record.</p>
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); if (source.trim()) optIn.mutate(); }}>
        <input className="input" placeholder="Consent source, e.g. Signed up on hostiggo.com" value={source} onChange={(e) => setSource(e.target.value)} />
        <Button type="submit" variant="primary" disabled={!source.trim()} loading={optIn.isPending}><Check className="size-3.5" /> Mark as opted in</Button>
      </form>
      <div className="mt-2"><ErrorBox error={optIn.error} /></div>
    </section>
  );
}

/** Edit name and custom fields. Blank values leave a field unchanged (the API never clears data by accident). */
function EditContact({ contact, onDone }: { contact: any; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [first, setFirst] = useState(contact.first_name ?? '');
  const [last, setLast] = useState(contact.last_name ?? '');
  const [fields, setFields] = useState<Record<string, string>>(Object.fromEntries(Object.entries(contact.custom_fields ?? {}).map(([k, v]) => [k, String(v ?? '')])));
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const save = useMutation({
    mutationFn: () => {
      const custom: Record<string, string> = { ...fields };
      const key = newKey.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
      if (key && newVal.trim()) custom[key] = newVal.trim();
      return api(`/v1/contacts/${contact.id}`, { method: 'PATCH', body: { first_name: first.trim() || undefined, last_name: last.trim() || undefined, custom_fields: custom } });
    },
    onSuccess: () => {
      toast('Contact updated');
      for (const key of ['contact', 'contacts']) qc.invalidateQueries({ queryKey: [key] });
      onDone();
    },
  });
  return (
    <form className="space-y-3 rounded-lg border border-line bg-canvas p-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name"><input className="input" value={first} onChange={(e) => setFirst(e.target.value)} /></Field>
        <Field label="Last name"><input className="input" value={last} onChange={(e) => setLast(e.target.value)} /></Field>
      </div>
      {Object.keys(fields).length > 0 && (
        <div className="space-y-2">
          <div className="caps">Custom fields</div>
          {Object.entries(fields).map(([k, v]) => (
            <div key={k} className="grid grid-cols-[110px_1fr] items-center gap-2"><span className="truncate font-mono text-[11px] text-muted">{k}</span><input className="input" value={v} onChange={(e) => setFields({ ...fields, [k]: e.target.value })} /></div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-[110px_1fr] gap-2">
        <input className="input" placeholder="new field" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
        <input className="input" placeholder="value" value={newVal} onChange={(e) => setNewVal(e.target.value)} />
      </div>
      <p className="text-[11px] text-muted">Leaving a field blank keeps its current value. Email can't be changed; add the new address as a new contact.</p>
      <ErrorBox error={save.error} />
      <div className="flex justify-end gap-2"><Button type="button" onClick={onDone}>Cancel</Button><Button type="submit" variant="primary" loading={save.isPending}>Save changes</Button></div>
    </form>
  );
}

function ContactDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [id]);
  const q = useQuery({ queryKey: ['contact', id], enabled: !!id, queryFn: () => api(`/v1/contacts/${id}`) });
  const qc = useQueryClient();
  const toast = useToast();
  const { workspace } = useAuth();
  const del = useMutation({
    mutationFn: () => api(`/v1/contacts/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast('Contact deleted; sequences stopped'); qc.invalidateQueries({ queryKey: ['contacts'] }); qc.invalidateQueries({ queryKey: ['contact-counts'] }); onClose(); },
    onError: (e) => toast(errText(e), 'error'),
  });
  const erase = useMutation({
    mutationFn: () => api(`/v1/contacts/${id}/erase`, { method: 'DELETE' }),
    onSuccess: () => { toast('Contact erased. Their opt-out record, if any, was kept.'); for (const key of ['contacts', 'contact-counts', 'lists']) qc.invalidateQueries({ queryKey: [key] }); onClose(); },
    onError: (e) => toast(errText(e), 'error'),
  });
  const c = q.data;
  return (
    <Drawer open={!!id} onClose={onClose} title={c?.email ?? 'Contact'}>
      {!c ? <Spinner /> : (
        <div className="space-y-5 text-[13px]">
          <div className="flex flex-wrap gap-2"><ConsentPill status={c.consent_status} />{c.suppressions.map((s: string) => <Pill key={s} tone="alert">{s}</Pill>)}</div>
          {editing ? <EditContact contact={c} onDone={() => setEditing(false)} /> : (
          <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 text-[12px]">
            <dt className="text-muted">Name</dt><dd>{[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}</dd>
            <dt className="text-muted">Consent source</dt><dd>{c.consent_source ?? '—'}</dd>
            <dt className="text-muted">Consent at</dt><dd>{dateTime(c.consent_at)}</dd>
            <dt className="text-muted">Added via</dt><dd className="font-mono">{c.import_source ?? '—'}</dd>
            {Object.entries(c.custom_fields ?? {}).map(([k, v]) => <Fragment key={k}><dt className="font-mono text-muted">{k}</dt><dd>{String(v)}</dd></Fragment>)}
          </dl>
          )}
          {canEdit(workspace?.role) && !editing && <Button size="sm" onClick={() => setEditing(true)}><Pencil className="size-3.5" /> Edit details</Button>}
          {canEdit(workspace?.role) && c.consent_status !== 'opted_in' && <OptInBox contact={c} />}
          <section>
            <div className="caps mb-2">Lists</div>
            <div className="flex flex-wrap gap-1">{c.lists.length ? c.lists.map((l: any) => <Pill key={l.id} tone="brand">{l.name}</Pill>) : <span className="text-muted">None</span>}</div>
          </section>
          <section>
            <div className="caps mb-2">Automations</div>
            {c.enrollments.length ? c.enrollments.map((e: any) => (
              <div key={e.id} className="mb-1 flex items-center justify-between rounded-md bg-canvas px-3 py-2"><span>{e.automation_name}</span><Pill tone={e.state === 'active' ? 'automation' : e.state === 'completed' ? 'success' : 'neutral'}>{e.state}{e.exit_reason ? `: ${e.exit_reason}` : ''}</Pill></div>
            )) : <span className="text-muted">Not enrolled</span>}
          </section>
          <section>
            <div className="caps mb-2">Recent messages</div>
            {c.recent_sends.length ? c.recent_sends.map((s: any) => (
              <div key={s.id} className="mb-1 flex items-center justify-between gap-2 rounded-md bg-canvas px-3 py-2"><span className="truncate">{s.subject ?? '(pending render)'}</span><SendStatus status={s.status} /></div>
            )) : <span className="text-muted">None</span>}
          </section>
          {canEdit(workspace?.role) && <Button variant="danger" loading={del.isPending} onClick={() => confirm('Delete this contact? Active sequences stop and queued messages are cancelled.') && del.mutate()}><Trash2 className="size-3.5" /> Delete contact</Button>}
          {isAdmin(workspace?.role) && (
            <section className="space-y-2 rounded-lg border border-line p-3">
              <div className="caps">Privacy (data-subject requests)</div>
              <p className="text-[12px] text-muted">Export everything held about this person, or erase it permanently. An opt-out record is kept so they are never emailed again.</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => download(`/v1/contacts/${id}/export`, `contact-${String(id).slice(0, 8)}.json`).catch((e) => toast(errText(e), 'error'))}><Download className="size-3.5" /> Export data</Button>
                <Button size="sm" variant="danger" loading={erase.isPending} onClick={() => confirm(`Permanently erase ${c.email} and all their messages and history? This cannot be undone.`) && erase.mutate()}><Trash2 className="size-3.5" /> Erase permanently</Button>
              </div>
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}

// ── CSV import wizard ────────────────────────────────────────────────
const TARGETS = [
  { value: 'email', label: 'Email address (required)' },
  { value: 'first_name', label: 'First name' },
  { value: 'last_name', label: 'Last name' },
  { value: 'consent_status', label: 'Consent flag (yes/true = opted in)' },
  { value: 'consent_at', label: 'Consent date' },
  { value: 'ignore', label: "Don't import" },
];
const CLASS_LABEL: Record<string, [string, string]> = {
  new: ['New contacts', 'text-emerald-700'],
  existing_update: ['Existing, will update', 'text-brand'],
  existing_skip: ['Existing, left unchanged', 'text-muted'],
  invalid: ['Invalid', 'text-rose-700'],
  duplicate_in_file: ['Duplicate in file', 'text-orange-700'],
  suppressed: ['Suppressed (skipped)', 'text-orange-700'],
};

function ImportWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(1);
  const [imp, setImp] = useState<any>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [listId, setListId] = useState('');
  const [optedIn, setOptedIn] = useState(false);
  const [source, setSource] = useState('');
  const [updateExisting, setUpdateExisting] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const lists = useLists();
  const qc = useQueryClient();

  const upload = useMutation({
    mutationFn: async (file: File) => api('/v1/contacts/imports', { body: { filename: file.name, csv: await file.text() } }),
    onSuccess: (r: any) => { setImp(r); setMapping(r.suggested_mapping); setPreview(r.preview); setStep(2); },
  });
  const remap = useMutation({
    mutationFn: () => api(`/v1/contacts/imports/${imp.id}/mapping`, { method: 'PUT', body: { mapping, list_id: listId || null, consent_status: optedIn ? 'opted_in' : 'unknown', consent_source: optedIn ? source : null, update_existing: updateExisting } }),
    onSuccess: (r: any) => { setPreview(r); setStep(3); },
  });
  const commit = useMutation({ mutationFn: () => api(`/v1/contacts/imports/${imp.id}/commit`, { method: 'POST' }), onSuccess: () => setStep(4) });
  const status = useQuery({
    queryKey: ['import', imp?.id],
    enabled: step === 4,
    queryFn: () => api(`/v1/contacts/imports/${imp.id}`),
    refetchInterval: (q) => ((q.state.data as any)?.status === 'committing' || !q.state.data ? 1000 : false),
  });
  const done = status.data?.status === 'completed';
  useEffect(() => {
    if (!done) return;
    qc.invalidateQueries({ queryKey: ['contacts'] });
    qc.invalidateQueries({ queryKey: ['lists'] });
    qc.invalidateQueries({ queryKey: ['contact-counts'] });
  }, [done, qc]);

  const counts = preview?.counts ?? {};
  const importable = (counts.new ?? 0) + (counts.existing_update ?? 0);
  const skipped = (counts.invalid ?? 0) + (counts.duplicate_in_file ?? 0) + (counts.suppressed ?? 0);
  const hasEmail = Object.values(mapping).includes('email');
  const steps = ['Upload', 'Map columns', 'Preview & check', 'Import'];

  return (
    <Modal open onClose={onClose} wide title="Import contacts from CSV" subtitle="Staged import: nothing is written until you confirm."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} className="mr-auto">{done ? 'Close' : 'Cancel'}</Button>
          {step === 3 && <Button onClick={() => setStep(2)}><ArrowLeft className="size-3.5" /> Back to mapping</Button>}
          {step === 2 && <Button variant="primary" disabled={!hasEmail || (optedIn && !source)} loading={remap.isPending} onClick={() => remap.mutate()}>Preview import <ArrowRight className="size-3.5" /></Button>}
          {step === 3 && <Button variant="primary" disabled={importable === 0 && !listId} loading={commit.isPending} onClick={() => commit.mutate()}>Import {num(importable)} contacts <ArrowRight className="size-3.5" /></Button>}
        </>
      }>
      <ol className="mb-5 grid grid-cols-4 gap-2 rounded-lg bg-canvas p-2">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span className={cx('grid size-6 place-items-center rounded-full text-[11px] font-bold', step > i + 1 ? 'bg-emerald-600 text-white' : step === i + 1 ? 'bg-brand text-white' : 'border border-line-strong text-muted')}>{step > i + 1 ? <Check className="size-3.5" /> : i + 1}</span>
            <span className={cx('hidden text-[12px] font-medium sm:inline', step === i + 1 ? 'text-ink' : 'text-muted')}>{s}</span>
          </li>
        ))}
      </ol>

      {step === 1 && (
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line-strong p-10 text-center hover:border-brand">
          <CloudUpload className="size-8 text-brand" />
          <div className="text-[14px] font-semibold">Choose a .csv file</div>
          <div className="text-[12px] text-muted">Needs an email column. Up to 50,000 rows. Names and other columns can be mapped next.</div>
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e: ChangeEvent<HTMLInputElement>) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
          {upload.isPending && <Spinner label="Reading file…" />}
          <ErrorBox error={upload.error} />
        </label>
      )}

      {step === 2 && imp && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-lg bg-canvas p-3">
            <FileText className="size-5 text-muted" />
            <div><div className="font-mono text-[13px] font-semibold">{imp.filename}</div><div className="text-[12px] text-muted">{num(imp.total_rows)} rows · {imp.headers.length} columns</div></div>
          </div>
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full">
              <thead><tr><th className="th">Source column</th><th className="th">Sample</th><th className="th">Hostiggo field</th></tr></thead>
              <tbody>
                {imp.headers.map((h: string) => {
                  const sample = preview?.samples?.find((s: any) => s.raw?.[h])?.raw?.[h] ?? '';
                  const v = mapping[h] ?? 'ignore';
                  const isCustom = v.startsWith('custom:');
                  return (
                    <tr key={h}>
                      <td className="td font-mono text-[12px] font-semibold">{h}</td>
                      <td className="td max-w-40 truncate font-mono text-[11px] text-muted">{sample}</td>
                      <td className="td">
                        <select className="input" value={isCustom ? 'custom' : v} onChange={(e) => setMapping({ ...mapping, [h]: e.target.value === 'custom' ? `custom:${h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50) || 'field'}` : e.target.value })}>
                          {TARGETS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                          <option value="custom">Custom field{isCustom ? ` (${v.slice(7)})` : ''}</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!hasEmail && <ErrorBox error="Map one column to Email address." />}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Add imported contacts to list">
              <select className="input" value={listId} onChange={(e) => setListId(e.target.value)}>
                <option value="">No list</option>
                {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
            <label className="flex items-start gap-2 self-end rounded-lg bg-canvas p-3 text-[12px]">
              <input type="checkbox" className="mt-0.5 size-4 accent-brand" checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} />
              <span>Update names/custom fields of contacts that already exist (consent is never downgraded; opted-out contacts are never re-subscribed).</span>
            </label>
          </div>
          <div className="rounded-lg border border-line bg-canvas p-3">
            <label className="flex items-start gap-2 text-[13px]">
              <input type="checkbox" className="mt-0.5 size-4 accent-brand" checked={optedIn} onChange={(e) => setOptedIn(e.target.checked)} />
              <span><b>Consent:</b> everyone in this file explicitly opted in to marketing email from Hostiggo. (Leave unchecked for transactional-only contacts. A CSV by itself does not prove consent.)</span>
            </label>
            {optedIn && <div className="mt-3"><Field label="Consent source (required)" hint="Recorded on every contact, e.g. 'Booking form opt-in, Jan 2030'."><input className="input" value={source} onChange={(e) => setSource(e.target.value)} /></Field></div>}
          </div>
          <ErrorBox error={remap.error} />
        </div>
      )}

      {step === 3 && preview && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {Object.entries(CLASS_LABEL).map(([k, [label, color]]) => (
              <div key={k} className="rounded-lg bg-canvas p-3"><div className="caps">{label}</div><div className={cx('tnum mt-1 text-[20px] font-semibold', color)}>{num(counts[k] ?? 0)}</div></div>
            ))}
          </div>
          {skipped > 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-[12px] text-rose-800">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <div className="flex-1"><b>{num(skipped)} rows</b> will be skipped (invalid email, duplicate in file, or suppressed). You can download them after the import.</div>
            </div>
          )}
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full">
              <thead><tr><th className="th">Line</th><th className="th">Email</th><th className="th">Outcome</th><th className="th">Reason</th></tr></thead>
              <tbody>
                {preview.samples.map((s: any) => (
                  <tr key={s.row_number}><td className="td font-mono text-[11px]">{s.row_number}</td><td className="td font-mono text-[12px]">{s.email ?? '—'}</td><td className={cx('td text-[12px] font-medium', CLASS_LABEL[s.classification]?.[1])}>{CLASS_LABEL[s.classification]?.[0] ?? s.classification}</td><td className="td text-[12px] text-muted">{s.error ?? ''}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <ErrorBox error={commit.error} />
        </div>
      )}

      {step === 4 && (
        <div className="space-y-4">
          {!done && status.data?.status !== 'failed' && <Spinner label="Importing… (safe to close; it continues in the background)" />}
          {status.data?.status === 'failed' && <ErrorBox error={`Import failed: ${status.data.error}`} />}
          {done && (
            <>
              <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-900"><Check className="size-5" /><div><div className="font-semibold">Import complete</div><div className="text-[12px]">Contacts added to the list will enter any live "joins list" automation.</div></div></div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                {status.data.counts.map((c: any) => <div key={c.classification} className="rounded-lg bg-canvas p-3"><div className="caps">{CLASS_LABEL[c.classification]?.[0] ?? c.classification}</div><div className="tnum mt-1 text-[18px] font-semibold">{num(c.n)}</div></div>)}
              </div>
              {skipped > 0 && <Button onClick={() => download(`/v1/contacts/imports/${imp.id}/errors.csv`, `import-errors-${imp.id.slice(0, 8)}.csv`)}><Download className="size-3.5" /> Download skipped rows (CSV)</Button>}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
