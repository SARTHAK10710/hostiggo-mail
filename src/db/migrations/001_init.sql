-- Hostiggo Mail: initial schema.
-- Every tenant-owned table carries workspace_id; every query must filter by it.

-- ------------------------- Phase 1: foundation -------------------------
create table workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  settings    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create table users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique,
  name           text,
  password_hash  text not null,
  created_at     timestamptz not null default now()
);

create table memberships (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  role          text not null check (role in ('owner','admin','member','viewer')),
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create table api_keys (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  prefix        text not null,
  key_hash      text not null unique,
  scopes        text[] not null,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index api_keys_ws on api_keys(workspace_id);

create table audit_logs (
  id           bigserial primary key,
  workspace_id uuid references workspaces(id) on delete cascade,
  actor_type   text not null check (actor_type in ('user','api_key','system')),
  actor_id     text,
  action       text not null,
  target_type  text,
  target_id    text,
  metadata     jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index audit_logs_ws_time on audit_logs(workspace_id, created_at desc);

-- ------------------------- Phase 2: mailboxes -------------------------
create table oauth_states (
  nonce         text primary key,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);

create table mailbox_connections (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references workspaces(id) on delete cascade,
  provider                 text not null default 'gmail',
  provider_account_id      text not null,            -- Google "sub"
  email                    text not null,
  display_name             text,
  encrypted_refresh_token  text,                     -- null once disconnected
  scopes                   text[] not null default '{}',
  status                   text not null default 'active'
                           check (status in ('active','reauth_required','error','disconnected')),
  health                   text not null default 'healthy' check (health in ('healthy','unhealthy')),
  last_error               text,
  daily_send_limit         int not null,
  history_id               text,
  watch_expires_at         timestamptz,
  watch_renewed_at         timestamptz,
  last_synced_at           timestamptz,
  connected_by             uuid references users(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  disconnected_at          timestamptz
);
create unique index mailbox_one_live_per_email
  on mailbox_connections(workspace_id, lower(email)) where status <> 'disconnected';
create index mailbox_email on mailbox_connections(lower(email)) where status <> 'disconnected';

-- ------------------------- Phase 3: contacts -------------------------
create table contacts (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  email           text not null,                     -- normalised: trimmed + lower-cased
  first_name      text,
  last_name       text,
  custom_fields   jsonb not null default '{}',
  consent_status  text not null default 'unknown' check (consent_status in ('opted_in','unknown','opted_out')),
  consent_source  text,
  consent_at      timestamptz,
  import_source   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  unique (workspace_id, email)
);

create table contact_lists (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  description   text,
  created_at    timestamptz not null default now(),
  unique (workspace_id, name)
);

create table list_memberships (
  list_id       uuid not null references contact_lists(id) on delete cascade,
  contact_id    uuid not null references contacts(id) on delete cascade,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  source        text,
  added_at      timestamptz not null default now(),
  primary key (list_id, contact_id)
);
create index list_memberships_contact on list_memberships(contact_id);

-- Unsubscribe / bounce / complaint suppressions are global to the workspace and override list membership.
create table suppressions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  email         text not null,
  reason        text not null check (reason in ('unsubscribed','bounced','complained','manual')),
  source        text not null,
  created_at    timestamptz not null default now(),
  unique (workspace_id, email, reason)
);
create index suppressions_ws_email on suppressions(workspace_id, email);

create table contact_imports (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  filename        text,
  status          text not null default 'staged' check (status in ('staged','committing','completed','failed')),
  headers         jsonb not null,
  mapping         jsonb,
  list_id         uuid references contact_lists(id) on delete set null,
  consent_status  text check (consent_status in ('opted_in','unknown')),
  consent_source  text,
  update_existing boolean not null default false,
  total_rows      int not null default 0,
  summary         jsonb,
  error           text,
  created_by      uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  committed_at    timestamptz
);

create table contact_import_rows (
  import_id       uuid not null references contact_imports(id) on delete cascade,
  row_number      int not null,
  raw             jsonb not null,
  email           text,
  classification  text,   -- new | update | existing_unchanged | invalid | duplicate_in_file | suppressed
  error           text,
  contact_id      uuid,
  committed       boolean not null default false,
  primary key (import_id, row_number)
);

-- ------------------------- Phase 4: templates + automations -------------------------
create table templates (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  name             text not null,
  kind             text not null check (kind in ('transactional','marketing')),
  current_version  int not null default 0,
  archived_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Every save creates an immutable version; automations/campaigns pin a version id.
create table template_versions (
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid not null references templates(id) on delete cascade,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  version       int not null,
  subject       text not null,
  html_body     text,
  text_body     text,
  from_name     text,
  reply_to      text,
  variables     text[] not null default '{}',
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (template_id, version)
);

create table automations (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  name                text not null,
  status              text not null default 'draft' check (status in ('draft','active','paused','archived')),
  draft_definition    jsonb not null,
  current_version_id  uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table automation_versions (
  id            uuid primary key default gen_random_uuid(),
  automation_id uuid not null references automations(id) on delete cascade,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  version       int not null,
  definition    jsonb not null,  -- trigger, mailbox, message kind, re-entry policy (immutable)
  published_by  uuid references users(id) on delete set null,
  published_at  timestamptz not null default now(),
  unique (automation_id, version)
);

create table automation_steps (
  id                   uuid primary key default gen_random_uuid(),
  version_id           uuid not null references automation_versions(id) on delete cascade,
  workspace_id         uuid not null references workspaces(id) on delete cascade,
  step_key             text not null,   -- stable id from the draft so analytics line up across versions
  position             int not null,
  type                 text not null check (type in ('wait','email')),
  config               jsonb not null,
  template_version_id  uuid references template_versions(id),
  unique (version_id, position)
);

create table enrollments (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  automation_id     uuid not null references automations(id) on delete cascade,
  version_id        uuid not null references automation_versions(id),
  contact_id        uuid not null references contacts(id) on delete cascade,
  state             text not null default 'active' check (state in ('active','completed','exited')),
  current_position  int not null default 0,
  next_run_at       timestamptz,
  exit_reason       text,
  trigger_key       text not null,     -- idempotency key of the triggering occurrence
  entered_at        timestamptz not null default now(),
  finished_at       timestamptz,
  updated_at        timestamptz not null default now(),
  unique (automation_id, trigger_key)
);
-- Default re-entry policy: one active enrollment per contact per automation.
create unique index enrollments_one_active on enrollments(automation_id, contact_id) where state = 'active';
create index enrollments_due on enrollments(next_run_at) where state = 'active';

create table campaigns (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references workspaces(id) on delete cascade,
  name                  text not null,
  template_id           uuid references templates(id),
  template_version_id   uuid references template_versions(id),
  list_id               uuid references contact_lists(id),
  mailbox_id            uuid references mailbox_connections(id),
  status                text not null default 'draft' check (status in ('draft','scheduled','sending','sent','cancelled')),
  scheduled_at          timestamptz,
  review                jsonb,
  reviewed_by           uuid references users(id) on delete set null,
  reviewed_at           timestamptz,
  sent_at               timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ------------------------- Sends + events (ledger) -------------------------
create table sends (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references workspaces(id) on delete cascade,
  idempotency_key      text not null,
  kind                 text not null check (kind in ('transactional','marketing','test')),
  source_type          text not null check (source_type in ('automation','campaign','api','test')),
  source_id            uuid,
  enrollment_id        uuid references enrollments(id) on delete set null,
  step_key             text,
  mailbox_id           uuid references mailbox_connections(id),
  contact_id           uuid references contacts(id) on delete set null,
  to_email             text not null,
  template_version_id  uuid references template_versions(id),
  variables            jsonb not null default '{}',
  -- Ad-hoc content for API sends without a template (purged by retention policy).
  content              jsonb,
  subject              text,
  status               text not null default 'queued'
                       check (status in ('queued','sending','accepted','failed','suppressed','cancelled','unknown')),
  provider             text,
  provider_message_id  text,
  provider_thread_id   text,
  rfc822_message_id    text,
  attempts             int not null default 0,
  max_attempts         int not null default 5,
  sending_at           timestamptz,
  error_code           text,
  last_error           text,
  next_attempt_at      timestamptz,
  requested_at         timestamptz not null default now(),
  accepted_at          timestamptz,
  finished_at          timestamptz,
  unique (workspace_id, idempotency_key)
);
create index sends_ws_time on sends(workspace_id, requested_at desc);
create index sends_mailbox_accepted on sends(mailbox_id, accepted_at) where accepted_at is not null;
create index sends_thread on sends(mailbox_id, provider_thread_id) where provider_thread_id is not null;
create index sends_provider_msg on sends(provider, provider_message_id) where provider_message_id is not null;
create index sends_source on sends(source_type, source_id);

create table email_events (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  send_id            uuid references sends(id) on delete cascade,
  contact_id         uuid references contacts(id) on delete set null,
  type               text not null check (type in ('requested','accepted','delivered','bounced','complained',
                                                    'opened','clicked','replied','unsubscribed','failed','suppressed')),
  source             text not null,  -- system | gmail_api | gmail_sync | provider:<name> | unsubscribe_link
  provider_event_id  text,
  occurred_at        timestamptz not null default now(),
  metadata           jsonb not null default '{}'
);
create unique index email_events_dedupe on email_events(workspace_id, source, type, provider_event_id)
  where provider_event_id is not null;
create index email_events_send on email_events(send_id, type);

-- Every inbound Gmail message we inspected, so repeated notifications are idempotent and auditable.
create table inbound_messages (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  mailbox_id          uuid not null references mailbox_connections(id) on delete cascade,
  provider_message_id text not null,
  thread_id           text,
  from_email          text,
  classification      text not null,  -- reply | auto_reply | bounce | internal | unmatched
  send_id             uuid references sends(id) on delete set null,
  received_at         timestamptz,
  processed_at        timestamptz not null default now(),
  unique (mailbox_id, provider_message_id)
);

-- Product events posted to /v1/events (trigger source).
create table product_events (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  name             text not null,
  contact_id       uuid references contacts(id) on delete set null,
  properties       jsonb not null default '{}',
  idempotency_key  text not null,
  received_at      timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

-- ------------------------- Job queue (Postgres-backed, SKIP LOCKED) -------------------------
create table jobs (
  id           bigserial primary key,
  type         text not null,
  payload      jsonb not null default '{}',
  unique_key   text,
  run_at       timestamptz not null default now(),
  status       text not null default 'pending' check (status in ('pending','running','done','failed')),
  attempts     int not null default 0,
  max_attempts int not null default 5,
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index jobs_due on jobs(run_at) where status = 'pending';
create unique index jobs_unique_pending on jobs(unique_key) where status = 'pending' and unique_key is not null;
