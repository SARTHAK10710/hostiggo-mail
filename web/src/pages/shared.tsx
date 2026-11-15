import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, RotateCcw, XCircle } from 'lucide-react';
import { api } from '../api';
import { Button, Drawer, KindPill, SendStatus, Spinner, dateTime, errText, useToast } from '../ui';

export function ReplyRateNote({ definition }: { definition?: string }) {
  if (!definition) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg bg-indigo-50/60 px-3 py-2 text-[12px] text-ink-2">
      <Info className="mt-0.5 size-3.5 shrink-0 text-brand" />
      <span><b>Reply rate:</b> {definition} Gmail reports acceptance, not inbox delivery or opens.</span>
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  requested: 'Requested', accepted: 'Accepted by Gmail', delivered: 'Delivered', bounced: 'Bounced', complained: 'Spam complaint',
  opened: 'Opened (estimate)', clicked: 'Clicked', replied: 'Replied', unsubscribed: 'Unsubscribed', failed: 'Failed', suppressed: 'Suppressed',
};

/** Side drawer with the full ledger entry + event timeline for one send. */
export function SendDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['send', id], enabled: !!id, queryFn: () => api(`/v1/sends/${id}`), refetchInterval: (query) => (['queued', 'sending'].includes((query.state.data as any)?.status) ? 2000 : false) });
  const act = useMutation({
    mutationFn: (what: 'retry' | 'cancel') => api(`/v1/sends/${id}/${what}`, { method: 'POST' }),
    onSuccess: (_r, what) => { toast(what === 'retry' ? 'Send re-queued' : 'Send cancelled'); qc.invalidateQueries({ queryKey: ['send', id] }); qc.invalidateQueries({ queryKey: ['sends'] }); },
    onError: (e) => toast(errText(e), 'error'),
  });
  const s = q.data;
  return (
    <Drawer open={!!id} onClose={onClose} title={<span className="font-mono text-[13px]">Send {id?.slice(0, 8)}</span>}>
      {!s ? <Spinner /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <SendStatus status={s.status} />
            <KindPill kind={s.kind} />
            <span className="font-mono text-[11px] text-muted">source: {s.source_type}{s.step_key ? ` · step ${s.step_key}` : ''}</span>
          </div>
          <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 text-[12px]">
            <dt className="text-muted">To</dt><dd className="font-mono">{s.to_email}</dd>
            <dt className="text-muted">Subject</dt><dd>{s.subject ?? '—'}</dd>
            <dt className="text-muted">Attempts</dt><dd className="font-mono">{s.attempts} / {s.max_attempts}</dd>
            <dt className="text-muted">Gmail message</dt><dd className="break-all font-mono">{s.provider_message_id ?? '—'}</dd>
            <dt className="text-muted">Thread</dt><dd className="break-all font-mono">{s.provider_thread_id ?? '—'}</dd>
            <dt className="text-muted">Next attempt</dt><dd>{s.next_attempt_at ? dateTime(s.next_attempt_at) : '—'}</dd>
          </dl>
          {(s.error_code || s.last_error) && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-[12px] text-rose-800">
              <div className="font-mono font-semibold">{s.error_code}</div>
              <div className="mt-1">{s.last_error}</div>
            </div>
          )}
          <div>
            <div className="caps mb-2">Event timeline</div>
            <ol className="space-y-2 border-l border-line pl-4">
              {s.events.map((e: any, i: number) => (
                <li key={i} className="relative text-[12px]">
                  <span className="absolute -left-[21px] top-1 size-2.5 rounded-full border-2 border-white bg-brand" />
                  <div className="font-medium">{EVENT_LABEL[e.type] ?? e.type}</div>
                  <div className="font-mono text-[11px] text-muted">{dateTime(e.occurred_at)} · {e.source}{e.metadata?.code ? ` · ${e.metadata.code}` : ''}</div>
                </li>
              ))}
            </ol>
          </div>
          <div className="flex gap-2">
            {['failed', 'unknown'].includes(s.status) && <Button variant="primary" loading={act.isPending} onClick={() => act.mutate('retry')}><RotateCcw className="size-3.5" /> Retry send</Button>}
            {s.status === 'queued' && <Button variant="danger" loading={act.isPending} onClick={() => act.mutate('cancel')}><XCircle className="size-3.5" /> Cancel</Button>}
          </div>
          {s.status === 'unknown' && <p className="text-[12px] text-orange-700">The outcome is unknown (network error mid-send). Check the mailbox's Sent folder before retrying to avoid a duplicate.</p>}
        </div>
      )}
    </Drawer>
  );
}
