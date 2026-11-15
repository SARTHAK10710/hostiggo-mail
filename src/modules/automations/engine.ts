import type { Ctx } from '../../context.js';
import { one, type Tx } from '../../db/index.js';
import { enqueue } from '../../jobs/queue.js';
import { contactContext } from '../../lib/template.js';
import { queueSend } from '../sends/service.js';
import { HARD_REASONS, suppressionReasons } from '../suppressions.js';
import { UNIT_MS, type Definition } from './definition.js';

interface EnrollmentRow {
  id: string;
  workspace_id: string;
  automation_id: string;
  version_id: string;
  contact_id: string;
  state: string;
  current_position: number;
  next_run_at: Date | null;
}

interface StepRow {
  step_key: string;
  position: number;
  type: 'wait' | 'email';
  config: any;
  template_version_id: string | null;
}

const MAX_STEPS_PER_RUN = 20;

/**
 * Job handler: advance one enrollment as far as it can go right now.
 * Each step transition (position + next_run_at + follow-up job) commits in one
 * transaction, so a crash never skips or repeats a step. Email steps use the
 * idempotency key enr:<enrollment>:<step>, so even a replayed step can't double-send.
 */
export async function runEnrollment(ctx: Ctx, enrollmentId: string) {
  for (let i = 0; i < MAX_STEPS_PER_RUN; i++) {
    const more = await ctx.db.tx((tx) => advanceOnce(ctx, tx, enrollmentId));
    if (!more) return;
  }
  // Long chain of zero-delay steps: continue in a fresh job.
  await enqueue(ctx.db, 'enrollment.run', { enrollmentId }, { uniqueKey: `enr:${enrollmentId}` });
}

async function exit(tx: Tx, e: EnrollmentRow, reason: string) {
  await tx.query(
    `update enrollments set state = 'exited', exit_reason = $2, next_run_at = null, finished_at = now(), updated_at = now() where id = $1`,
    [e.id, reason],
  );
}

/** Returns true if another step is due immediately. */
async function advanceOnce(ctx: Ctx, tx: Tx, enrollmentId: string): Promise<boolean> {
  const now = ctx.clock.now();
  const e = await one<EnrollmentRow>(tx, `select * from enrollments where id = $1 and state = 'active' for update`, [enrollmentId]);
  if (!e) return false;
  if (e.next_run_at && new Date(e.next_run_at) > now) {
    // Woken early (e.g. resume): make sure a job exists for the real due time.
    await enqueue(tx, 'enrollment.run', { enrollmentId }, { runAt: new Date(e.next_run_at), uniqueKey: `enr:${e.id}` });
    return false;
  }

  const automation = await one<{ status: string }>(tx, `select status from automations where id = $1`, [e.automation_id]);
  // Pause is immediate: nothing advances; resume re-enqueues due enrollments without replaying sends.
  if (!automation || automation.status === 'paused') return false;
  if (automation.status === 'archived') {
    await exit(tx, e, 'automation_archived');
    return false;
  }

  const version = await one<{ definition: Definition }>(tx, `select definition from automation_versions where id = $1`, [e.version_id]);
  const step = await one<StepRow>(
    tx,
    `select step_key, position, type, config, template_version_id from automation_steps where version_id = $1 and position = $2`,
    [e.version_id, e.current_position],
  );
  if (!step) {
    await tx.query(
      `update enrollments set state = 'completed', next_run_at = null, finished_at = now(), updated_at = now() where id = $1`,
      [e.id],
    );
    return false;
  }

  // Exit rules: deleted contact, hard suppression, or (marketing) unsubscribe / no consent.
  const contact = await one<any>(tx, `select * from contacts where id = $1`, [e.contact_id]);
  if (!contact || contact.deleted_at) {
    await exit(tx, e, 'contact_deleted');
    return false;
  }
  const reasons = await suppressionReasons(tx, e.workspace_id, contact.email);
  const hard = reasons.find((r) => HARD_REASONS.includes(r));
  if (hard) {
    await exit(tx, e, hard);
    return false;
  }
  if (version!.definition.message_kind === 'marketing') {
    if (reasons.length) {
      await exit(tx, e, reasons[0]);
      return false;
    }
    if (contact.consent_status !== 'opted_in') {
      await exit(tx, e, 'no_consent');
      return false;
    }
  }

  if (step.type === 'wait') {
    const due = new Date(now.getTime() + step.config.amount * UNIT_MS[step.config.unit as keyof typeof UNIT_MS]);
    await tx.query(`update enrollments set current_position = $2, next_run_at = $3, updated_at = now() where id = $1`, [e.id, step.position + 1, due]);
    await enqueue(tx, 'enrollment.run', { enrollmentId: e.id }, { runAt: due, uniqueKey: `enr:${e.id}` });
    return false;
  }

  // Email step.
  await queueSend(ctx, tx, {
    workspaceId: e.workspace_id,
    kind: version!.definition.message_kind,
    sourceType: 'automation',
    sourceId: e.automation_id,
    enrollmentId: e.id,
    stepKey: step.step_key,
    mailboxId: version!.definition.mailbox_id!,
    contactId: contact.id,
    toEmail: contact.email,
    templateVersionId: step.template_version_id,
    variables: contactContext(contact),
    idempotencyKey: `enr:${e.id}:step:${step.step_key}`,
  });
  await tx.query(`update enrollments set current_position = $2, next_run_at = $3, updated_at = now() where id = $1`, [e.id, step.position + 1, now]);
  return true;
}
