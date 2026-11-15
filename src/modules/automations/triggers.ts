import { one, type Queryable } from '../../db/index.js';
import { enqueue } from '../../jobs/queue.js';
import { suppressionReasons, HARD_REASONS } from '../suppressions.js';
import type { Definition } from './definition.js';

export type TriggerOccurrence =
  | { type: 'list_joined'; list_id: string }
  | { type: 'contact_created' }
  | { type: 'event'; event_name: string };

/**
 * Called inside the transaction that caused the trigger (contact created, list joined,
 * product event stored). Creates at most one enrollment per automation per occurrence
 * (unique trigger_key) and per contact while active (partial unique index).
 */
export async function fireTrigger(
  q: Queryable,
  workspaceId: string,
  occurrence: TriggerOccurrence,
  contactId: string,
  occurrenceKey: string,
  now: Date,
  opts: { onlyAutomationId?: string } = {},
): Promise<string[]> {
  const candidates = await q.query<{ automation_id: string; version_id: string; definition: Definition }>(
    `select a.id as automation_id, v.id as version_id, v.definition
     from automations a join automation_versions v on v.id = a.current_version_id
     where a.workspace_id = $1 and a.status = 'active' and v.definition->'trigger'->>'type' = $2
       and ($3::uuid is null or a.id = $3::uuid)`,
    [workspaceId, occurrence.type, opts.onlyAutomationId ?? null],
  );
  const matching = candidates.rows.filter(({ definition: d }) => {
    const t = d.trigger!;
    if (t.type === 'list_joined' && occurrence.type === 'list_joined') return t.list_id === occurrence.list_id;
    if (t.type === 'event' && occurrence.type === 'event') return t.event_name === occurrence.event_name;
    return t.type === occurrence.type;
  });
  if (matching.length === 0) return [];

  const contact = await one<{ email: string; consent_status: string; deleted_at: Date | null }>(
    q,
    `select email, consent_status, deleted_at from contacts where id = $1 and workspace_id = $2`,
    [contactId, workspaceId],
  );
  if (!contact || contact.deleted_at) return [];
  const reasons = await suppressionReasons(q, workspaceId, contact.email);

  const created: string[] = [];
  for (const m of matching) {
    const d = m.definition;
    // Eligibility at entry (re-checked before every send).
    if (reasons.some((r) => HARD_REASONS.includes(r))) continue;
    if (d.message_kind === 'marketing' && (contact.consent_status !== 'opted_in' || reasons.length > 0)) continue;
    if (d.reentry === 'once') {
      const before = await one(q, `select 1 from enrollments where automation_id = $1 and contact_id = $2`, [m.automation_id, contactId]);
      if (before) continue;
    }
    const ins = await one<{ id: string }>(
      q,
      `insert into enrollments(workspace_id, automation_id, version_id, contact_id, trigger_key, next_run_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict do nothing returning id`,
      [workspaceId, m.automation_id, m.version_id, contactId, occurrenceKey, now],
    );
    if (!ins) continue; // duplicate occurrence or already active
    await enqueue(q, 'enrollment.run', { enrollmentId: ins.id }, { runAt: now, uniqueKey: `enr:${ins.id}` });
    created.push(ins.id);
  }
  return created;
}
