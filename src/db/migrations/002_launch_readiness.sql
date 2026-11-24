-- Phase 6: launch readiness.

-- Invitations: lets admins add people who have no account yet, so open sign-up can be turned off.
create table invites (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  email         text not null,
  role          text not null check (role in ('admin','member','viewer')),
  token_hash    text not null unique,
  invited_by    uuid references users(id) on delete set null,
  expires_at    timestamptz not null,
  accepted_at   timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index invites_ws on invites(workspace_id) where accepted_at is null and revoked_at is null;

-- Worker heartbeats: lets the operations page show whether background sending is alive.
create table worker_heartbeats (
  worker_id   text primary key,
  hostname    text,
  pid         int,
  started_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  jobs_done   bigint not null default 0,
  jobs_failed bigint not null default 0
);
