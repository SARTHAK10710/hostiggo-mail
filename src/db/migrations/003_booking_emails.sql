-- Booking (transactional) email support: tags, priority, template slugs and outbound webhooks.

-- Tags let a website find or cancel every email for one booking (e.g. 'booking:HG-1042').
-- Metadata is echoed back in webhooks so the caller can match events to its own records.
alter table sends add column tags text[] not null default '{}';
alter table sends add column metadata jsonb not null default '{}';
create index sends_tags on sends using gin (tags);

-- Higher priority jobs are claimed first, so booking emails never wait behind a marketing campaign.
alter table jobs add column priority int not null default 0;
drop index if exists jobs_due;
create index jobs_due on jobs(priority desc, run_at) where status = 'pending';

-- A stable, human-readable name for API callers ('booking_request_host') instead of a UUID.
alter table templates add column slug text;
-- Example values used by the dashboard preview and test sends (booking templates ship with them).
alter table templates add column sample_variables jsonb not null default '{}';
create unique index templates_slug on templates(workspace_id, slug) where slug is not null and archived_at is null;

-- Outbound webhooks: tell the caller's backend when a send fails, bounces, etc.
create table webhook_endpoints (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  url               text not null,
  description       text,
  events            text[] not null,
  encrypted_secret  text not null,
  created_by        uuid references users(id) on delete set null,
  created_at        timestamptz not null default now(),
  disabled_at       timestamptz
);
create index webhook_endpoints_ws on webhook_endpoints(workspace_id) where disabled_at is null;

create table webhook_deliveries (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  endpoint_id      uuid not null references webhook_endpoints(id) on delete cascade,
  event            text not null,
  payload          jsonb not null,
  status           text not null default 'pending' check (status in ('pending','delivered','failed')),
  attempts         int not null default 0,
  response_status  int,
  last_error       text,
  created_at       timestamptz not null default now(),
  delivered_at     timestamptz
);
create index webhook_deliveries_endpoint on webhook_deliveries(endpoint_id, created_at desc);
