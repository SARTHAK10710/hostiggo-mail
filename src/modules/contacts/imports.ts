import type { FastifyInstance } from 'fastify';
import { parse as parseCsv } from 'csv-parse/sync';
import { z } from 'zod';
import { audit, authorize } from '../../auth/index.js';
import type { Ctx } from '../../context.js';
import { one, type Queryable } from '../../db/index.js';
import { enqueue } from '../../jobs/queue.js';
import { isValidEmail, normalizeEmail } from '../../lib/email.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { IdParams, parse } from '../../lib/http.js';
import { addToLists, upsertContact } from './service.js';

/**
 * Staged CSV import (guide §6): upload -> preview with suggested mapping -> adjust
 * mapping -> commit (idempotent, background job) -> summary + downloadable error report.
 */
const MAX_ROWS = 50_000;
const SAMPLE = 5;

const Target = z.union([
  z.enum(['email', 'first_name', 'last_name', 'consent_status', 'consent_at', 'ignore']),
  z.string().regex(/^custom:[a-z0-9_]{1,50}$/, 'custom field keys: lower-case letters, digits, underscore'),
]);
type Mapping = Record<string, string>;

const MappingBody = z.object({
  mapping: z.record(z.string(), Target),
  list_id: z.string().uuid().nullish(),
  /** Default consent for rows without a mapped consent column. A CSV does not itself prove consent. */
  consent_status: z.enum(['opted_in', 'unknown']).default('unknown'),
  consent_source: z.string().max(200).nullish(),
  update_existing: z.boolean().default(false),
});

const slug = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 50) || 'field';

export function suggestMapping(headers: string[]): Mapping {
  const m: Mapping = {};
  for (const h of headers) {
    const k = slug(h);
    if (/^(e_?mail|email_address|e_mail_address|mail)$/.test(k) && !Object.values(m).includes('email')) m[h] = 'email';
    else if (/^(first_?name|firstname|given_name|fname|first)$/.test(k)) m[h] = 'first_name';
    else if (/^(last_?name|lastname|surname|family_name|lname|last)$/.test(k)) m[h] = 'last_name';
    else if (/^(consent|consent_status|opted_in|subscribed|marketing_consent)$/.test(k)) m[h] = 'consent_status';
    else if (/^(consent_at|consent_date|opted_in_at|subscribed_at)$/.test(k)) m[h] = 'consent_at';
    else m[h] = `custom:${k}`;
  }
  return m;
}

const TRUTHY = new Set(['yes', 'y', 'true', '1', 'opted_in', 'opt-in', 'subscribed']);

interface RowPlan {
  email: string | null;
  input: Parameters<typeof upsertContact>[2] | null;
  classification: 'new' | 'existing_update' | 'existing_skip' | 'invalid' | 'duplicate_in_file' | 'suppressed';
  error: string | null;
  already_subscribed: boolean;
}

/** Re-classifies every staged row for the given mapping. Pure read of contacts/suppressions; writes only the staging table. */
async function classify(q: Queryable, importId: string, workspaceId: string, cfg: z.infer<typeof MappingBody>) {
  const emailHeader = Object.entries(cfg.mapping).find(([, t]) => t === 'email')?.[0];
  if (!emailHeader) throw badRequest('email_column_required', 'Map one column to email');
  if (cfg.consent_status === 'opted_in' && !cfg.consent_source) {
    throw badRequest('consent_source_required', 'Say where consent came from (consent_source) to import contacts as opted in');
  }
  const rows = (await q.query<{ row_number: number; raw: Record<string, string> }>(
    `select row_number, raw from contact_import_rows where import_id = $1 order by row_number`,
    [importId],
  )).rows;

  const emails = [...new Set(rows.map((r) => normalizeEmail(r.raw[emailHeader])).filter(Boolean))];
  const existing = new Map(
    (await q.query<{ email: string; consent_status: string; deleted_at: Date | null }>(
      `select email, consent_status, deleted_at from contacts where workspace_id = $1 and email = any($2)`,
      [workspaceId, emails],
    )).rows.map((c) => [c.email, c]),
  );
  const suppressed = new Set(
    (await q.query<{ email: string }>(`select distinct email from suppressions where workspace_id = $1 and email = any($2)`, [workspaceId, emails])).rows.map((s) => s.email),
  );

  const seen = new Set<string>();
  const counts: Record<string, number> = { new: 0, existing_update: 0, existing_skip: 0, invalid: 0, duplicate_in_file: 0, suppressed: 0, already_subscribed: 0 };
  const cols: { rn: number[]; email: (string | null)[]; cls: string[]; err: (string | null)[] } = { rn: [], email: [], cls: [], err: [] };
  for (const r of rows) {
    const plan = planRow(r.raw, cfg, emailHeader, seen, existing, suppressed);
    counts[plan.classification] += 1;
    if (plan.already_subscribed) counts.already_subscribed += 1;
    cols.rn.push(r.row_number);
    cols.email.push(plan.email);
    cols.cls.push(plan.classification);
    cols.err.push(plan.error);
  }
  for (let i = 0; i < cols.rn.length; i += 2000) {
    await q.query(
      `update contact_import_rows r set email = v.email, classification = v.cls, error = v.err
       from unnest($2::int[], $3::text[], $4::text[], $5::text[]) as v(rn, email, cls, err)
       where r.import_id = $1 and r.row_number = v.rn`,
      [importId, cols.rn.slice(i, i + 2000), cols.email.slice(i, i + 2000), cols.cls.slice(i, i + 2000), cols.err.slice(i, i + 2000)],
    );
  }
  return counts;
}

function planRow(
  raw: Record<string, string>,
  cfg: z.infer<typeof MappingBody>,
  emailHeader: string,
  seen: Set<string>,
  existing: Map<string, { consent_status: string; deleted_at: Date | null }>,
  suppressed: Set<string>,
): RowPlan {
  const email = normalizeEmail(raw[emailHeader]);
  if (!email) return { email: null, input: null, classification: 'invalid', error: 'Missing email', already_subscribed: false };
  if (!isValidEmail(email)) return { email, input: null, classification: 'invalid', error: 'Invalid email address', already_subscribed: false };
  if (seen.has(email)) return { email, input: null, classification: 'duplicate_in_file', error: 'Email appears earlier in this file', already_subscribed: false };
  seen.add(email);
  if (suppressed.has(email)) return { email, input: null, classification: 'suppressed', error: 'Address is suppressed (unsubscribed, bounced or complained)', already_subscribed: false };

  const input = buildInput(raw, cfg, email);
  if ('error' in input) return { email, input: null, classification: 'invalid', error: input.error, already_subscribed: false };
  const ex = existing.get(email);
  if (!ex || ex.deleted_at) return { email, input: input.value, classification: 'new', error: null, already_subscribed: false };
  return {
    email,
    input: input.value,
    classification: cfg.update_existing ? 'existing_update' : 'existing_skip',
    error: null,
    already_subscribed: ex.consent_status === 'opted_in',
  };
}

function buildInput(raw: Record<string, string>, cfg: z.infer<typeof MappingBody>, email: string): { error: string } | { value: any } {
  const value: any = { email, custom_fields: {} };
  let consent: 'opted_in' | 'unknown' = cfg.consent_status;
  for (const [header, target] of Object.entries(cfg.mapping)) {
    const v = (raw[header] ?? '').trim();
    if (target === 'ignore' || target === 'email' || v === '') continue;
    if (target === 'first_name' || target === 'last_name') value[target] = v.slice(0, 200);
    else if (target === 'consent_status') consent = TRUTHY.has(v.toLowerCase()) ? 'opted_in' : 'unknown';
    else if (target === 'consent_at') {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return { error: `Unreadable consent date "${v}"` };
      value.consent_at = d.toISOString();
    } else if (target.startsWith('custom:')) value.custom_fields[target.slice(7)] = v.slice(0, 2000);
  }
  if (consent === 'opted_in' && !cfg.consent_source) return { error: 'Row marked opted in but no consent_source was given for the import' };
  value.consent_status = consent;
  value.consent_source = consent === 'opted_in' ? cfg.consent_source : null;
  return { value };
}

async function loadImport(q: Queryable, workspaceId: string, id: string) {
  const imp = await one<any>(q, `select * from contact_imports where id = $1 and workspace_id = $2`, [id, workspaceId]);
  if (!imp) throw notFound('Import');
  return imp;
}

async function preview(q: Queryable, importId: string) {
  const samples = await q.query(
    `select row_number, email, classification, error, raw from (
       select *, row_number() over (partition by classification order by row_number) as rn from contact_import_rows where import_id = $1
     ) t where rn <= $2 order by classification, row_number`,
    [importId, SAMPLE],
  );
  return samples.rows;
}

/** Background job: commit classified rows. Safe to re-run; committed rows are skipped. */
export async function commitImportJob(ctx: Ctx, importId: string) {
  const imp = await one<any>(ctx.db, `select * from contact_imports where id = $1`, [importId]);
  if (!imp || imp.status !== 'committing') return;
  const cfg = MappingBody.parse({ ...imp.mapping, list_id: imp.list_id, consent_status: imp.consent_status, consent_source: imp.consent_source, update_existing: imp.update_existing });
  const emailHeader = Object.entries(cfg.mapping).find(([, t]) => t === 'email')![0];
  try {
    for (;;) {
      const batch = await ctx.db.query<{ row_number: number; raw: Record<string, string>; classification: string }>(
        `select row_number, raw, classification from contact_import_rows
         where import_id = $1 and not committed order by row_number limit 200`,
        [importId],
      );
      if (batch.rows.length === 0) break;
      await ctx.db.tx(async (tx) => {
        const now = ctx.clock.now();
        for (const r of batch.rows) {
          let contactId: string | null = null;
          let error: string | null = null;
          let classification = r.classification;
          if (['new', 'existing_update', 'existing_skip'].includes(r.classification)) {
            const built = buildInput(r.raw, cfg, normalizeEmail(r.raw[emailHeader]));
            try {
              if ('error' in built) throw badRequest('invalid_row', built.error);
              const { contact } = await upsertContact(tx, imp.workspace_id, built.value, {
                onDuplicate: r.classification === 'existing_skip' ? 'skip' : 'update',
                importSource: `import:${importId}`,
                now,
              });
              contactId = contact.id;
              if (cfg.list_id) await addToLists(tx, imp.workspace_id, contact.id, [cfg.list_id], `import:${importId}`, now);
            } catch (err) {
              if (!(err instanceof AppError)) throw err;
              classification = 'invalid';
              error = err.message;
            }
          }
          await tx.query(
            `update contact_import_rows set committed = true, contact_id = $3, classification = $4, error = coalesce($5, error)
             where import_id = $1 and row_number = $2`,
            [importId, r.row_number, contactId, classification, error],
          );
        }
      });
    }
    const summary = await one<{ s: Record<string, number> }>(
      ctx.db,
      `select coalesce(jsonb_object_agg(classification, n), '{}') as s from (
         select classification, count(*)::int as n from contact_import_rows where import_id = $1 group by classification) t`,
      [importId],
    );
    await ctx.db.tx(async (tx) => {
      await tx.query(`update contact_imports set status = 'completed', summary = $2, committed_at = now() where id = $1`, [importId, JSON.stringify(summary!.s)]);
      await audit(tx, { workspaceId: imp.workspace_id, type: 'system', id: null }, 'import.completed', { type: 'import', id: importId }, summary!.s);
    });
  } catch (err) {
    await ctx.db.query(`update contact_imports set status = 'failed', error = $2 where id = $1`, [importId, (err as Error).message.slice(0, 500)]);
    throw err;
  }
}

export function importRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/v1/contacts/imports', { bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => {
    const a = authorize(req, { role: 'member', scope: 'contacts:write' });
    const body = parse(z.object({ filename: z.string().max(255).optional(), csv: z.string().min(1) }), req.body);
    let records: string[][];
    try {
      records = parseCsv(body.csv, { bom: true, skip_empty_lines: true, relax_column_count: true, trim: true });
    } catch (err) {
      throw badRequest('csv_unreadable', `Could not read CSV: ${(err as Error).message}`);
    }
    if (records.length < 2) throw badRequest('csv_empty', 'CSV needs a header row and at least one data row');
    const headers = records[0].map((h, i) => h || `column_${i + 1}`);
    if (new Set(headers).size !== headers.length) throw badRequest('duplicate_headers', 'Column headers must be unique');
    const dataRows = records.slice(1);
    if (dataRows.length > MAX_ROWS) throw badRequest('csv_too_large', `Imports are limited to ${MAX_ROWS} rows`);
    const mapping = suggestMapping(headers);
    if (!Object.values(mapping).includes('email')) {
      // Fall back to the first column whose sample looks like an email.
      const guess = headers.find((_, i) => dataRows.slice(0, 20).some((r) => isValidEmail(normalizeEmail(r[i]))));
      if (guess) mapping[guess] = 'email';
    }

    const result = await ctx.db.tx(async (tx) => {
      const imp = await one<{ id: string }>(
        tx,
        `insert into contact_imports(workspace_id, filename, headers, mapping, total_rows, created_by, consent_status)
         values ($1, $2, $3, $4, $5, $6, 'unknown') returning id`,
        [a.workspaceId, body.filename ?? null, JSON.stringify(headers), JSON.stringify({ mapping }), dataRows.length, a.userId],
      );
      // Batched insert of staged rows.
      for (let i = 0; i < dataRows.length; i += 500) {
        const chunk = dataRows.slice(i, i + 500);
        const values: string[] = [];
        const params: unknown[] = [imp!.id];
        chunk.forEach((cells, j) => {
          const raw = Object.fromEntries(headers.map((h, k) => [h, cells[k] ?? '']));
          params.push(i + j + 2, JSON.stringify(raw)); // row_number = line in file (header is line 1)
          values.push(`($1, $${params.length - 1}, $${params.length})`);
        });
        await tx.query(`insert into contact_import_rows(import_id, row_number, raw) values ${values.join(',')}`, params);
      }
      let counts: Record<string, number> | null = null;
      if (Object.values(mapping).includes('email')) {
        counts = await classify(tx, imp!.id, a.workspaceId, MappingBody.parse({ mapping }));
      }
      return { id: imp!.id, counts };
    });
    reply.code(201);
    return {
      id: result.id,
      status: 'staged',
      filename: body.filename ?? null,
      headers,
      suggested_mapping: mapping,
      total_rows: dataRows.length,
      preview: result.counts ? { counts: result.counts, samples: await preview(ctx.db, result.id) } : null,
    };
  });

  app.put('/v1/contacts/imports/:id/mapping', async (req) => {
    const a = authorize(req, { role: 'member', scope: 'contacts:write' });
    const { id } = parse(IdParams, req.params);
    const cfg = parse(MappingBody, req.body);
    return ctx.db.tx(async (tx) => {
      const imp = await loadImport(tx, a.workspaceId, id);
      if (imp.status !== 'staged') throw conflict('import_locked', `Import is ${imp.status}`);
      const headers: string[] = imp.headers;
      const unknown = Object.keys(cfg.mapping).filter((h) => !headers.includes(h));
      if (unknown.length) throw badRequest('unknown_columns', `Unknown columns: ${unknown.join(', ')}`);
      if (cfg.list_id && !(await one(tx, `select 1 from contact_lists where id = $1 and workspace_id = $2`, [cfg.list_id, a.workspaceId]))) {
        throw notFound('List');
      }
      const counts = await classify(tx, id, a.workspaceId, cfg);
      await tx.query(
        `update contact_imports set mapping = $2, list_id = $3, consent_status = $4, consent_source = $5, update_existing = $6, summary = $7 where id = $1`,
        [id, JSON.stringify({ mapping: cfg.mapping }), cfg.list_id ?? null, cfg.consent_status, cfg.consent_source ?? null, cfg.update_existing, JSON.stringify(counts)],
      );
      return { id, status: 'staged', counts, samples: await preview(tx, id) };
    });
  });

  app.get('/v1/contacts/imports/:id', async (req) => {
    const a = authorize(req, { scope: 'contacts:read' });
    const { id } = parse(IdParams, req.params);
    const imp = await loadImport(ctx.db, a.workspaceId, id);
    const counts = await ctx.db.query(
      `select classification, count(*)::int as n, count(*) filter (where committed)::int as committed
       from contact_import_rows where import_id = $1 group by classification`,
      [id],
    );
    return { ...imp, counts: counts.rows };
  });

  app.get('/v1/contacts/imports/:id/rows', async (req) => {
    const a = authorize(req, { scope: 'contacts:read' });
    const { id } = parse(IdParams, req.params);
    const q = parse(z.object({ classification: z.string().optional(), limit: z.coerce.number().max(500).default(100), offset: z.coerce.number().default(0) }), req.query);
    await loadImport(ctx.db, a.workspaceId, id);
    const r = await ctx.db.query(
      `select row_number, email, classification, error, committed, contact_id, raw from contact_import_rows
       where import_id = $1 and ($2::text is null or classification = $2) order by row_number limit $3 offset $4`,
      [id, q.classification ?? null, q.limit, q.offset],
    );
    return { data: r.rows };
  });

  // Downloadable error report for skipped rows.
  app.get('/v1/contacts/imports/:id/errors.csv', async (req, reply) => {
    const a = authorize(req, { scope: 'contacts:read' });
    const { id } = parse(IdParams, req.params);
    const imp = await loadImport(ctx.db, a.workspaceId, id);
    const r = await ctx.db.query<{ row_number: number; email: string | null; classification: string; error: string | null; raw: Record<string, string> }>(
      `select row_number, email, classification, error, raw from contact_import_rows
       where import_id = $1 and classification in ('invalid','duplicate_in_file','suppressed') order by row_number`,
      [id],
    );
    const headers: string[] = imp.headers;
    const esc = (v: unknown) => {
      const s = String(v ?? '');
      return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
    };
    const lines = [['line', 'outcome', 'reason', ...headers].map(esc).join(',')];
    for (const row of r.rows) lines.push([row.row_number, row.classification, row.error, ...headers.map((h) => row.raw[h])].map(esc).join(','));
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="import-${id}-errors.csv"`);
    return lines.join('\r\n') + '\r\n';
  });

  app.post('/v1/contacts/imports/:id/commit', async (req, reply) => {
    const a = authorize(req, { role: 'member', scope: 'contacts:write' });
    const { id } = parse(IdParams, req.params);
    const result = await ctx.db.tx(async (tx) => {
      const imp = await loadImport(tx, a.workspaceId, id);
      if (imp.status === 'completed' || imp.status === 'committing') return { id, status: imp.status, summary: imp.summary };
      if (imp.status === 'failed') throw conflict('import_failed', `Import failed: ${imp.error}`);
      if (!Object.values(imp.mapping?.mapping ?? {}).includes('email')) throw badRequest('email_column_required', 'Map one column to email first');
      await tx.query(`update contact_imports set status = 'committing' where id = $1`, [id]);
      await enqueue(tx, 'import.commit', { importId: id }, { uniqueKey: `import:${id}` });
      await audit(tx, a, 'import.committed', { type: 'import', id }, { rows: imp.total_rows });
      return { id, status: 'committing', summary: imp.summary };
    });
    reply.code(202);
    return result;
  });
}
