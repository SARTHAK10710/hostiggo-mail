-- Per-mailbox send warm-up: when set, the effective daily limit ramps up from a low start
-- (see effectiveDailyLimit in src/modules/mailboxes/service.ts). Null = no warm-up.
alter table mailbox_connections add column warmup_started_at timestamptz;
