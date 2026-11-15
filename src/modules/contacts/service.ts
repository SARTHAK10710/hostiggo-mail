import { one, type Queryable } from '../../db/index.js';
import { isValidEmail, normalizeEmail } from '../../lib/email.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { fireTrigger } from '../automations/triggers.js';
import { suppressionReasons } from '../suppressions.js';

export interface Contact {
  id: string;
  workspace_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  custom_fields: Record<string, unknown>;
  consent_status: 'opted_in' | 'unknown' | 'opted_out';
  consent_source: string | null;
  consent_at: Date | null;
  import_source: string | null;
  created_at: Date;
  deleted_at: Date | null;
}

export interface ContactInput {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  custom_fields?: Record<string, unknown>;
  consent_status?: 'opted_in' | 'unknown';
  consent_source?: string | null;
  consent_at?: string | Date | null;
}

export type UpsertOutcome = 'created' | 'restored' | 'updated' | 'unchanged';

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/**
 * Create or (optionally) update a contact. Rules from the guide:
 *  - email is normalised for duplicate checks;
 *  - consent/custom fields are never silently overwritten (requires onDuplicate=update);
 *  - an opted-out / unsubscribed contact cannot be flipped back to opted-in here.
 */
export async function upsertContact(
  q: Queryable,
  workspaceId: string,
  input: ContactInput,
  opts: { onDuplicate: 'skip' | 'update'; importSource?: string; now: Date },
): Promise<{ contact: Contact; outcome: UpsertOutcome }> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) throw badRequest('invalid_email', `Invalid email address: ${input.email}`);
  if (input.consent_status === 'opted_in' && blank(input.consent_source)) {
    throw badRequest('consent_source_required', 'consent_source is required when marking a contact as opted in');
  }
  const consentAt = input.consent_status === 'opted_in' ? (input.consent_at ? new Date(input.consent_at) : opts.now) : null;

  const existing = await one<Contact>(q, `select * from contacts where workspace_id = $1 and email = $2 for update`, [workspaceId, email]);

  if (!existing) {
    const contact = await one<Contact>(
      q,
      `insert into contacts(workspace_id, email, first_name, last_name, custom_fields, consent_status, consent_source, consent_at, import_source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [
        workspaceId,
        email,
        input.first_name?.trim() || null,
        input.last_name?.trim() || null,
        JSON.stringify(input.custom_fields ?? {}),
        input.consent_status ?? 'unknown',
        input.consent_source ?? null,
        consentAt,
        opts.importSource ?? null,
      ],
    );
    await fireTrigger(q, workspaceId, { type: 'contact_created' }, contact!.id, `contact:${contact!.id}`, opts.now);
    return { contact: contact!, outcome: 'created' };
  }

  const wasDeleted = !!existing.deleted_at;
  if (!wasDeleted && opts.onDuplicate === 'skip') return { contact: existing, outcome: 'unchanged' };

  // Consent upgrade guard.
  let consentStatus = existing.consent_status;
  let consentSource = existing.consent_source;
  let consentAtFinal = existing.consent_at;
  if (input.consent_status === 'opted_in' && existing.consent_status !== 'opted_in') {
    const reasons = await suppressionReasons(q, workspaceId, email);
    if (existing.consent_status === 'opted_out' || reasons.includes('unsubscribed')) {
      throw conflict('consent_conflict', `${email} has opted out; remove the unsubscribe suppression explicitly before re-subscribing`);
    }
    consentStatus = 'opted_in';
    consentSource = input.consent_source ?? null;
    consentAtFinal = consentAt;
  }

  const merged = {
    first_name: blank(input.first_name) ? existing.first_name : input.first_name!.trim(),
    last_name: blank(input.last_name) ? existing.last_name : input.last_name!.trim(),
    custom_fields: { ...existing.custom_fields, ...(input.custom_fields ?? {}) },
  };
  const changed =
    wasDeleted ||
    merged.first_name !== existing.first_name ||
    merged.last_name !== existing.last_name ||
    JSON.stringify(merged.custom_fields) !== JSON.stringify(existing.custom_fields) ||
    consentStatus !== existing.consent_status;

  if (!changed) return { contact: existing, outcome: 'unchanged' };
  const contact = await one<Contact>(
    q,
    `update contacts set first_name = $2, last_name = $3, custom_fields = $4, consent_status = $5, consent_source = $6,
       consent_at = $7, deleted_at = null, updated_at = now() where id = $1 returning *`,
    [existing.id, merged.first_name, merged.last_name, JSON.stringify(merged.custom_fields), consentStatus, consentSource, consentAtFinal],
  );
  if (wasDeleted) {
    await fireTrigger(q, workspaceId, { type: 'contact_created' }, contact!.id, `contact:${contact!.id}:restored:${opts.now.getTime()}`, opts.now);
  }
  return { contact: contact!, outcome: wasDeleted ? 'restored' : 'updated' };
}

/** Add a contact to lists; each *new* membership fires the list_joined trigger. */
export async function addToLists(q: Queryable, workspaceId: string, contactId: string, listIds: string[], source: string, now: Date) {
  let added = 0;
  for (const listId of listIds) {
    const list = await one(q, `select 1 from contact_lists where id = $1 and workspace_id = $2`, [listId, workspaceId]);
    if (!list) throw notFound(`List ${listId}`);
    const ins = await one<{ added_at: Date }>(
      q,
      `insert into list_memberships(list_id, contact_id, workspace_id, source) values ($1, $2, $3, $4)
       on conflict do nothing returning added_at`,
      [listId, contactId, workspaceId, source],
    );
    if (ins) {
      added += 1;
      await fireTrigger(
        q,
        workspaceId,
        { type: 'list_joined', list_id: listId },
        contactId,
        `list:${listId}:${contactId}:${new Date(ins.added_at).getTime()}`,
        now,
      );
    }
  }
  return added;
}

export async function softDeleteContact(q: Queryable, workspaceId: string, contactId: string) {
  const r = await q.query(
    `update contacts set deleted_at = now(), updated_at = now() where id = $1 and workspace_id = $2 and deleted_at is null`,
    [contactId, workspaceId],
  );
  if (r.rowCount === 0) throw notFound('Contact');
  await q.query(`delete from list_memberships where contact_id = $1 and workspace_id = $2`, [contactId, workspaceId]);
  await q.query(
    `update enrollments set state = 'exited', exit_reason = 'contact_deleted', next_run_at = null, finished_at = now(), updated_at = now()
     where contact_id = $1 and workspace_id = $2 and state = 'active'`,
    [contactId, workspaceId],
  );
  await q.query(
    `update sends set status = 'cancelled', error_code = 'contact_deleted', last_error = 'Contact was deleted', finished_at = now()
     where contact_id = $1 and workspace_id = $2 and status = 'queued'`,
    [contactId, workspaceId],
  );
}
