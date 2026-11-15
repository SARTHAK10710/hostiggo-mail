import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drain, harness, signup, type Harness, type Session } from './helpers.js';

let h: Harness;
let s: Session;

beforeAll(async () => {
  h = await harness();
  s = await signup(h);
});
afterAll(() => h.close());

describe('Phase 3: contacts', () => {
  it('adds a contact, normalises email and handles duplicates without overwriting', async () => {
    const first = await s.req('POST', '/v1/contacts', { email: '  Ana@Example.COM ', first_name: 'Ana' });
    expect(first.status).toBe(201);
    expect(first.body.email).toBe('ana@example.com');
    const dup = await s.req('POST', '/v1/contacts', { email: 'ana@example.com', first_name: 'Changed', custom_fields: { plan: 'pro' } });
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
    expect(dup.body.first_name).toBe('Ana'); // not silently overwritten
    const upd = await s.req('POST', '/v1/contacts', { email: 'ana@example.com', custom_fields: { plan: 'pro' }, on_duplicate: 'update' });
    expect(upd.body.outcome).toBe('updated');
    expect(upd.body.custom_fields).toEqual({ plan: 'pro' });
    expect(upd.body.first_name).toBe('Ana'); // blank input never clears a field
  });

  it('requires a consent source to mark someone opted in', async () => {
    const r = await s.req('POST', '/v1/contacts', { email: 'consent@example.com', consent_status: 'opted_in' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('consent_source_required');
    const ok = await s.req('POST', '/v1/contacts', { email: 'consent@example.com', consent_status: 'opted_in', consent_source: 'signup form' });
    expect(ok.body.consent_status).toBe('opted_in');
    expect(ok.body.consent_at).toBeTruthy();
  });

  it('will not re-subscribe someone who unsubscribed', async () => {
    await s.req('POST', '/v1/contacts', { email: 'gone@example.com' });
    await s.req('POST', '/v1/suppressions', { email: 'gone@example.com', reason: 'unsubscribed' });
    const r = await s.req('POST', '/v1/contacts', { email: 'gone@example.com', consent_status: 'opted_in', consent_source: 'import', on_duplicate: 'update' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('consent_conflict');
  });

  it('opts an existing contact in from the contact panel (with a consent source)', async () => {
    const c = await s.req('POST', '/v1/contacts', { email: 'later@example.com', first_name: 'Later' });
    expect(c.body.consent_status).toBe('unknown');
    const noSource = await s.req('PATCH', `/v1/contacts/${c.body.id}`, { consent_status: 'opted_in' });
    expect(noSource.body.error.code).toBe('consent_source_required');
    const ok = await s.req('PATCH', `/v1/contacts/${c.body.id}`, { consent_status: 'opted_in', consent_source: 'Agreed in person' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ consent_status: 'opted_in', consent_source: 'Agreed in person', first_name: 'Later' });
    expect(ok.body.consent_at).toBeTruthy();
  });

  it('rejects invalid emails', async () => {
    const r = await s.req('POST', '/v1/contacts', { email: 'not-an-email' });
    expect(r.status).toBe(400);
  });
});

describe('Phase 3: staged CSV import', () => {
  const csv = [
    'E-mail,First Name,Surname,Company',
    'new1@example.com,Nia,One,Acme',
    'NEW2@example.com ,Bo,Two,Beta',
    'not-an-email,X,Y,Z',
    'new1@example.com,Dupe,Row,Acme',
    'ana@example.com,Ana,Existing,Gamma',
    'gone@example.com,Gone,Person,Delta',
    ',missing,email,row',
  ].join('\n');
  let importId: string;
  let listId: string;

  it('stages the upload and previews outcomes with a suggested mapping', async () => {
    const r = await s.req('POST', '/v1/contacts/imports', { filename: 'leads.csv', csv });
    expect(r.status).toBe(201);
    importId = r.body.id;
    expect(r.body.suggested_mapping).toEqual({ 'E-mail': 'email', 'First Name': 'first_name', Surname: 'last_name', Company: 'custom:company' });
    expect(r.body.preview.counts).toMatchObject({ new: 2, invalid: 2, duplicate_in_file: 1, existing_skip: 1, suppressed: 1 });
    // Nothing is committed yet.
    const contacts = await s.req('GET', '/v1/contacts?search=new1');
    expect(contacts.body.total).toBe(0);
  });

  it('re-classifies when the mapping changes, and requires a consent source for opted-in imports', async () => {
    listId = (await s.req('POST', '/v1/lists', { name: 'Leads' })).body.id;
    const bad = await s.req('PUT', `/v1/contacts/imports/${importId}/mapping`, {
      mapping: { 'E-mail': 'email', 'First Name': 'first_name', Surname: 'last_name', Company: 'custom:company' },
      consent_status: 'opted_in',
    });
    expect(bad.body.error.code).toBe('consent_source_required');
    const r = await s.req('PUT', `/v1/contacts/imports/${importId}/mapping`, {
      mapping: { 'E-mail': 'email', 'First Name': 'first_name', Surname: 'last_name', Company: 'custom:company' },
      list_id: listId,
      consent_status: 'opted_in',
      consent_source: 'Trade show sign-up sheet 2030-01',
      update_existing: true,
    });
    expect(r.status).toBe(200);
    expect(r.body.counts).toMatchObject({ new: 2, existing_update: 1, already_subscribed: 0 });
  });

  it('commits idempotently and produces a summary + error report', async () => {
    const c1 = await s.req('POST', `/v1/contacts/imports/${importId}/commit`);
    expect(c1.status).toBe(202);
    const c2 = await s.req('POST', `/v1/contacts/imports/${importId}/commit`);
    expect(c2.status).toBe(202);
    await drain(h);
    const imp = await s.req('GET', `/v1/contacts/imports/${importId}`);
    expect(imp.body.status).toBe('completed');
    const members = await s.req('GET', `/v1/contacts?list_id=${listId}`);
    expect(members.body.data.map((c: any) => c.email).sort()).toEqual(['ana@example.com', 'new1@example.com', 'new2@example.com']);
    const nia = members.body.data.find((c: any) => c.email === 'new1@example.com');
    expect(nia).toMatchObject({ first_name: 'Nia', consent_status: 'opted_in', consent_source: 'Trade show sign-up sheet 2030-01', custom_fields: { company: 'Acme' } });
    // ana was opted-in by the explicit update_existing import; the unsubscribed address was not imported.
    const total = await s.req('GET', '/v1/contacts?search=gone');
    expect(total.body.data[0].consent_status).toBe('opted_out');

    const report = await h.app.inject({ method: 'GET', url: `/v1/contacts/imports/${importId}/errors.csv`, headers: { authorization: `Bearer ${s.token}`, 'x-workspace-id': s.workspaceId } });
    expect(report.headers['content-type']).toContain('text/csv');
    const lines = report.body.trim().split('\r\n');
    expect(lines[0]).toBe('line,outcome,reason,E-mail,First Name,Surname,Company');
    expect(lines).toHaveLength(5); // header + 2 invalid + 1 duplicate + 1 suppressed
  });
});
