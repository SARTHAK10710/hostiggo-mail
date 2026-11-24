import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Archive, CheckCircle2, CircleAlert, HardDriveDownload, RotateCcw, Server } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import { Button, Card, CardHeader, Empty, KindPill, Pill, SendStatus, Spinner, Stat, dateTime, errText, num, timeAgo, useToast } from '../ui';
import { SendDrawer } from './shared';

const ERROR_HELP: Record<string, string> = {
  provider_rejected: 'Gmail refused the message (bad address or content). Fix the cause, then retry.',
  mailbox_auth: 'Google access expired or was revoked. Reconnect the mailbox on Deliverability, then retry.',
  mailbox_disconnected: 'The mailbox was disconnected. Connect it again and retry.',
  outcome_unknown: 'Network error mid-send. Check the Gmail Sent folder before retrying so you do not send twice.',
  render_failed: 'The template could not be rendered. Open the template, fix it and retry.',
  mailbox_unhealthy: 'Marketing was paused because bounces/complaints are too high. See Deliverability.',
  provider_transient: 'Gmail was temporarily unavailable; it retries automatically.',
  provider_quota: 'Gmail sending limit reached; it retries automatically.',
  rate_limited: 'Daily limit reached; queued until capacity frees up.',
  automation_paused: 'Waiting for the automation to be resumed.',
};

export function OperationsSection() {
  const q = useQuery({ queryKey: ['ops'], queryFn: () => api('/v1/ops'), refetchInterval: 15_000 });
  const [openSend, setOpenSend] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const retrySend = useMutation({
    mutationFn: (id: string) => api(`/v1/sends/${id}/retry`, { method: 'POST' }),
    onSuccess: () => { toast('Send re-queued'); qc.invalidateQueries({ queryKey: ['ops'] }); },
    onError: (e) => toast(errText(e), 'error'),
  });
  if (q.isLoading) return <Spinner />;
  const d = q.data;
  const c = d.last_7_days ?? {};
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Background worker" icon={<Server className="size-4" />} accent={d.worker_alive ? 'text-emerald-600' : 'text-rose-600'}
          value={d.worker_alive ? 'Running' : 'Not running'} sub={d.worker_alive ? 'Sends, delays and reply checks are processing' : 'Nothing will send until the server/worker is started'} />
        <Stat label="Accepted (7 days)" icon={<CheckCircle2 className="size-4" />} accent="text-emerald-600" value={num(c.accepted)} sub={`${num(c.queued)} waiting in queue`} />
        <Stat label="Failed (7 days)" icon={<CircleAlert className="size-4" />} accent="text-rose-600" value={num(c.failed)} sub="Need attention below" />
        <Stat label="Outcome unknown" icon={<Activity className="size-4" />} accent="text-orange-500" value={num(c.unknown)} sub="Check Sent folder before retrying" />
      </div>

      <Card>
        <CardHeader title="Sends that need attention" subtitle="Failed or unknown in the last 7 days. Click a row for the full event timeline." />
        {d.problem_sends.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px]">
              <thead><tr><th className="th">Recipient</th><th className="th">Type</th><th className="th">Status</th><th className="th">Why</th><th className="th">When</th><th className="th text-right"></th></tr></thead>
              <tbody>{d.problem_sends.map((s: any) => (
                <tr key={s.id} className="row-hover cursor-pointer" onClick={() => setOpenSend(s.id)}>
                  <td className="td font-mono text-[12px]">{s.to_email}</td>
                  <td className="td"><KindPill kind={s.kind} /></td>
                  <td className="td"><SendStatus status={s.status} /></td>
                  <td className="td max-w-md text-[12px]">
                    <div className="font-mono font-semibold">{s.error_code}</div>
                    <div className="text-muted">{ERROR_HELP[s.error_code] ?? s.last_error}</div>
                  </td>
                  <td className="td whitespace-nowrap font-mono text-[11px] text-muted">{timeAgo(s.requested_at)}</td>
                  <td className="td text-right" onClick={(e) => e.stopPropagation()}>
                    <Button size="sm" loading={retrySend.isPending && retrySend.variables === s.id} onClick={() => retrySend.mutate(s.id)}><RotateCcw className="size-3.5" /> Retry</Button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <Empty icon={<CheckCircle2 className="size-6 text-emerald-500" />} title="No failed sends this week" />}
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Stuck in queue" subtitle="Queued more than 15 minutes for a reason other than limits or a paused automation." />
          {d.stuck_sends.length ? (
            <div className="space-y-1 px-5 pb-5">{d.stuck_sends.map((s: any) => (
              <button key={s.id} onClick={() => setOpenSend(s.id)} className="flex w-full items-center justify-between rounded-md bg-canvas px-3 py-2 text-left text-[12px]">
                <span className="font-mono">{s.to_email}</span><span className="text-muted">{s.status} · since {timeAgo(s.requested_at)}</span>
              </button>
            ))}</div>
          ) : <Empty title="Nothing stuck" />}
          {d.deferred.length > 0 && (
            <div className="space-y-1 border-t border-line px-5 py-4">
              <div className="caps mb-1">Waiting on purpose</div>
              {d.deferred.map((x: any) => (
                <div key={x.error_code} className="flex items-center justify-between text-[12px]"><span>{ERROR_HELP[x.error_code] ?? x.error_code}</span><b className="tnum">{x.n}</b></div>
              ))}
            </div>
          )}
        </Card>
        <Card>
          <CardHeader title="Mailbox issues" subtitle="Mailboxes that are not active and healthy." />
          {d.mailbox_issues.length ? (
            <div className="space-y-2 px-5 pb-5">{d.mailbox_issues.map((m: any) => (
              <div key={m.id} className="rounded-md bg-canvas p-3 text-[12px]">
                <div className="flex items-center justify-between"><span className="font-mono font-semibold">{m.email}</span><Pill tone={m.status === 'active' ? 'alert' : 'danger'}>{m.status} · {m.health}</Pill></div>
                {m.last_error && <div className="mt-1 text-rose-700">{m.last_error}</div>}
              </div>
            ))}</div>
          ) : <Empty icon={<CheckCircle2 className="size-6 text-emerald-500" />} title="All mailboxes healthy" />}
        </Card>
      </div>

      {d.operator ? <OperatorPanel data={d.operator} /> : (
        <p className="text-[12px] text-muted">Server-wide queue, worker and backup details are visible to the server operator only.</p>
      )}
      <SendDrawer id={openSend} onClose={() => { setOpenSend(null); qc.invalidateQueries({ queryKey: ['ops'] }); }} />
    </>
  );
}

function OperatorPanel({ data }: { data: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const backups = useQuery({ queryKey: ['backups'], queryFn: () => api('/v1/ops/backups') });
  const retryJob = useMutation({
    mutationFn: (id: number) => api(`/v1/ops/jobs/${id}/retry`, { method: 'POST' }),
    onSuccess: () => { toast('Job re-queued'); qc.invalidateQueries({ queryKey: ['ops'] }); },
    onError: (e) => toast(errText(e), 'error'),
  });
  const backupNow = useMutation({
    mutationFn: () => api('/v1/ops/backups', { method: 'POST' }),
    onSuccess: (r: any) => { toast(`Backup saved: ${r.file}`); qc.invalidateQueries({ queryKey: ['backups'] }); },
    onError: (e) => toast(errText(e), 'error'),
  });
  const b = backups.data;
  return (
    <>
      <h2 className="pt-2 text-[15px] font-semibold">Server operator</h2>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Worker processes" icon={<Server className="size-4" />} subtitle="Heartbeat every 30 seconds; stale after 2 minutes." />
          <div className="space-y-2 px-5 pb-5">
            {data.workers.length === 0 && <div className="text-[12px] text-rose-700">No worker has reported in. Start the server (or `npm run start:worker` with Postgres).</div>}
            {data.workers.map((w: any) => (
              <div key={w.worker_id} className="flex items-center justify-between rounded-md bg-canvas px-3 py-2 text-[12px]">
                <span className="font-mono">{w.hostname} · pid {w.pid}</span>
                <span className="flex items-center gap-2"><span className="text-muted">{num(w.jobs_done)} done · {num(w.jobs_failed)} failed · seen {timeAgo(w.last_seen)}</span><Pill tone={w.alive ? 'success' : 'danger'} dot>{w.alive ? 'alive' : 'stale'}</Pill></span>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title="Job queue" subtitle="Background jobs by type and state." />
          {data.queue.length ? (
            <table className="w-full">
              <thead><tr><th className="th">Type</th><th className="th">State</th><th className="th text-right">Count</th><th className="th text-right">Oldest due</th></tr></thead>
              <tbody>{data.queue.map((r: any) => (
                <tr key={r.type + r.status}><td className="td font-mono text-[12px]">{r.type}</td><td className="td"><Pill tone={r.status === 'failed' ? 'danger' : r.status === 'running' ? 'brand' : 'neutral'}>{r.status}</Pill></td><td className="td tnum text-right">{num(r.n)}</td><td className="td text-right font-mono text-[11px] text-muted">{timeAgo(r.oldest_run_at)}</td></tr>
              ))}</tbody>
            </table>
          ) : <Empty title="Queue is empty" />}
        </Card>
      </div>
      <Card>
        <CardHeader title="Failed background jobs" subtitle="Jobs that ran out of retries. Fix the cause shown, then retry." />
        {data.failed_jobs.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead><tr><th className="th">Job</th><th className="th">Error</th><th className="th">Attempts</th><th className="th">When</th><th className="th"></th></tr></thead>
              <tbody>{data.failed_jobs.map((j: any) => (
                <tr key={j.id}><td className="td font-mono text-[12px]">#{j.id} {j.type}</td><td className="td max-w-md truncate text-[12px] text-rose-700" title={j.last_error}>{j.last_error}</td><td className="td tnum">{j.attempts}/{j.max_attempts}</td><td className="td font-mono text-[11px] text-muted">{timeAgo(j.updated_at)}</td>
                  <td className="td text-right"><Button size="sm" loading={retryJob.isPending && retryJob.variables === j.id} onClick={() => retryJob.mutate(j.id)}><RotateCcw className="size-3.5" /> Retry</Button></td></tr>
              ))}</tbody>
            </table>
          </div>
        ) : <Empty icon={<CheckCircle2 className="size-6 text-emerald-500" />} title="No failed jobs" />}
      </Card>
      <Card>
        <CardHeader title="Database backups" icon={<Archive className="size-4" />}
          subtitle={b?.supported ? `Automatic every ${b.every_hours}h, keeping the newest ${b.keep}. Saved in ${b.directory}` : b?.note}
          right={b?.supported && <Button size="sm" variant="primary" loading={backupNow.isPending} onClick={() => backupNow.mutate()}><HardDriveDownload className="size-3.5" /> Back up now</Button>} />
        {b?.supported && (b.data.length ? (
          <div className="space-y-1 px-5 pb-5">
            {b.data.map((f: any) => (
              <div key={f.file} className="flex items-center justify-between rounded-md bg-canvas px-3 py-2 text-[12px]"><span className="font-mono">{f.file}</span><span className="text-muted">{(f.bytes / 1024 / 1024).toFixed(1)} MB · {dateTime(f.created_at)}</span></div>
            ))}
            <p className="pt-2 text-[11px] text-muted">To restore: stop the server (Ctrl+C), then run <code className="font-mono">npm run restore -- backups/&lt;file&gt;</code>. The current database is moved aside, not deleted.</p>
          </div>
        ) : <Empty title="No backups yet">The first one is taken within an hour of the server starting, or click "Back up now".</Empty>)}
      </Card>
    </>
  );
}
