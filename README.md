# Hostiggo Mail — backend

API + background worker for the Hostiggo Mail email automation platform, built from
*Hostiggo Mail Product and Build Guide*. The dashboard frontend is not here yet; this
service exposes everything it needs over a JSON API.

**Stack:** TypeScript · Fastify · PostgreSQL (plain SQL) · a Postgres-backed job queue
(`FOR UPDATE SKIP LOCKED`) · Gmail API. Local dev and tests use **PGlite** (embedded
Postgres), so nothing needs to be installed beyond Node 22.

## Run it

```bash
npm install                 # also installs the dashboard (web/)
cp .env.example .env        # defaults work for local dev
npm run build               # builds dashboard + API
npm start                   # everything on http://localhost:4000
npm test                    # end-to-end tests (embedded Postgres + fake Google)
npm run test:pg             # same suite on a real, throwaway PostgreSQL 18
```

Open http://localhost:4000, create an account, then **Deliverability → Connect Gmail account**.

With `EMAIL_PROVIDER_MODE=fake` (the default) the whole flow works without Google:
"Connect Gmail" opens a local stand-in consent screen, and sent mail is shown under
**Settings → Dev outbox** instead of being delivered. The sidebar shows which mode you are in.

Working on the UI? Run `npm run dev` (API on :4000) and `npm run dev:web` (Vite on :5173,
proxying the API), and set `APP_BASE_URL=http://localhost:5173` so OAuth returns to Vite.

## Sending real email (Gmail)

1. In Google Cloud Console: create a project, enable the **Gmail API**, configure the OAuth
   consent screen (External, **Testing** mode) and add the Gmail address you'll connect as a **Test user**.
2. Create an **OAuth client ID → Web application** with redirect URI
   `http://localhost:4000/oauth/google/callback` (or `${API_BASE_URL}/oauth/google/callback`).
3. In `.env`: `EMAIL_PROVIDER_MODE=gmail`, `GOOGLE_CLIENT_ID=…`, `GOOGLE_CLIENT_SECRET=…`,
   plus `TOKEN_ENCRYPTION_KEYS` (`npm run gen:key`) and a long random `APP_SECRET`. Restart.
4. Connect the mailbox in the dashboard and click **Send Test Email**. The send log shows
   *Accepted* with the Gmail message id, and the message appears in that Gmail account's Sent folder.

Settings → Gmail setup shows the same steps with the exact redirect URI and a live status check.
Note: Google expires refresh tokens for apps left in *Testing* mode after 7 days, so you may need
to reconnect weekly until the app is verified/published.

## Emails landing in spam? What's next?

- [SPAM-FIX.md](SPAM-FIX.md): why test emails land in Spam and how to fix it, from quick steps to Google Workspace with SPF/DKIM/DMARC.
- [IMPROVE.md](IMPROVE.md): prioritised list of improvements (production database, public HTTPS, ESP adapter, bulk actions, CI…).
- [DEPLOY.md](DEPLOY.md): putting it on a public HTTPS address with real Postgres (Supabase/Render or docker compose).
- [GOOGLE-VERIFICATION.md](GOOGLE-VERIFICATION.md): what Google needs before anyone outside your test users can connect.

## Booking emails (built)

The "host has 2 hours to accept" flow for hostiggo.com: 8 ready-made templates (Transactional → Booking emails),
send by template name, scheduled and cancellable sends (`send_at`, cancel by tag), batch sends, a `422` when a
template value is missing, a reserved share of the daily limit plus first-in-line priority for transactional mail,
and signed webhooks to the website when a send fails. Website integration: [BOOKING-EMAILS.md](BOOKING-EMAILS.md).

## Phase 6: launch readiness (built)

- **Real Postgres verified**: `npm run test:pg` runs the whole suite on a throwaway PostgreSQL 18.
- **Security**: security headers/CSP, per-IP rate limits (sign-in 10/min), invite-only sign-up (`ALLOW_SIGNUPS=false`) with 7-day single-use invitation links.
- **Public pages**: `/privacy` (with Google's Limited Use disclosure), `/terms`, `/support`, linked from the sign-in page.
- **Operations** (Settings → Operations): worker heartbeat, failed/unknown/stuck sends with plain-language reasons and retry, mailbox issues; for the server operator also the job queue, failed jobs and backups. `/health/ready` for uptime monitors.
- **Backups** of the embedded database: automatic daily snapshot, keep 7, "Back up now", `npm run restore -- <file>`.
- **Onboarding**: Getting started checklist on the Overview.
- **Deploy**: `Dockerfile`, `docker-compose.yml` (Postgres + API + worker).

## Dashboard (web/)

React + Vite + Tailwind, built from the Stitch designs (Overview, Automations builder,
Transactional, Marketing, Deliverability, Contacts + CSV import) plus Templates and Settings.
Every number comes from the API; mock-only panels in the designs (IP warmup, DKIM/SPF records,
A/B tests, client distribution, condition branches) were left out because Gmail sending doesn't
provide that data. The API serves the built dashboard, so one URL runs everything.

## What's built (guide §9 phases 1–5)

| Phase | Built | Completion signal (tested) |
|---|---|---|
| 1 Foundation | Sign-up/login (scrypt, hashed session tokens), workspaces, roles (owner/admin/member/viewer), API keys (shown once, hashed, scoped, revocable), audit log | Users only see their workspace; spoofed `X-Workspace-Id` → 403 |
| 2 Gmail | OAuth code flow with single-use signed state, least-privilege scopes, AES-256-GCM token encryption with key rotation, test send, disconnect (stop watch + revoke + delete token + cancel queued sends + pause automations), per-mailbox daily cap | Test email sends and shows `requested → accepted`; failures carry an error code + message |
| 3 Contacts | Single add with consent metadata + duplicate rules, lists, global suppressions, staged CSV import (preview → mapping → idempotent commit → error report CSV) | Preview reports new/existing/invalid/duplicate/suppressed; commit twice = once |
| 4 Automations | Draft → validated publish into immutable versions (template versions pinned), list/contact/event triggers, waits, email steps, pause/resume/archive, re-entry policy, test sends; marketing campaigns with explicit send review | A contact enters once and gets each step once; pause/resume never replays |
| 5 Replies | Gmail watch + Pub/Sub push (OIDC verified), history-cursor sync, expired-cursor recovery, periodic reconciliation, thread/Message-ID matching, auto-reply/bounce/internal filtering, reply rate with numerator/denominator/window | A reply is attributed once even with duplicate notifications |

Safety rules from guide §4/§8 that are enforced in code:
- Idempotency keys on every send (`enr:<enrollment>:step:<step>`, `camp:<id>:<contact>`, client `Idempotency-Key`), unique enrollment trigger keys, one active enrollment per contact per automation.
- Consent, suppression, contact state, automation state, mailbox health and daily cap are **re-checked right before every send**.
- Only transient Gmail errors (429/5xx) retry. A network error where Gmail *might* have accepted the message becomes `unknown` and is never auto-retried (no duplicates). Sends stuck mid-flight become `unknown` too.
- `accepted` (provider took it) is tracked separately from `delivered`, `bounced`, `replied`, etc.
- Bounces/complaints suppress the address for all mail; unsubscribes stop marketing only.
- Marketing mail always gets a visible unsubscribe link plus `List-Unsubscribe` one-click headers. GET on the link only shows a confirmation (link scanners can't unsubscribe people).
- Logs redact auth headers, tokens and message bodies. Ad-hoc API message bodies are purged 30 days after sending.

## API map (for the frontend)

Auth: `Authorization: Bearer <session token>` + `X-Workspace-Id: <id>` (dashboard) or
`Authorization: Bearer hm_live_…` (API keys, scoped). Errors are `{ error: { code, message, details } }`.

| Area | Routes |
|---|---|
| Auth & workspace | `POST /v1/auth/signup` · `POST /v1/auth/login` · `POST /v1/auth/logout` · `GET /v1/me` · `POST /v1/workspaces` · `GET/POST/PATCH/DELETE /v1/members[/:userId]` · `GET/POST/DELETE /v1/api-keys[/:id]` · `GET /v1/audit-logs` |
| Mailboxes / Deliverability | `GET /v1/mailboxes[/:id]` · `POST /v1/mailboxes/google/authorize` → `{url}` · `GET /oauth/google/callback` (redirects to `APP_BASE_URL/settings/mailboxes?connected=<id>` or `?error=<code>`) · `PATCH /v1/mailboxes/:id` · `POST /v1/mailboxes/:id/test` · `POST /v1/mailboxes/:id/disconnect` · `GET /v1/deliverability` |
| Contacts | `GET/POST /v1/contacts` · `GET/PATCH/DELETE /v1/contacts/:id` · `GET/POST/PATCH/DELETE /v1/lists[/:id]` · `POST /v1/lists/:id/contacts` · `DELETE /v1/lists/:id/contacts/:contactId` · `GET/POST/DELETE /v1/suppressions[/:id]` |
| CSV import | `POST /v1/contacts/imports` (`{filename, csv}`) · `PUT /v1/contacts/imports/:id/mapping` · `GET /v1/contacts/imports/:id[/rows]` · `GET /v1/contacts/imports/:id/errors.csv` · `POST /v1/contacts/imports/:id/commit` |
| Templates | `GET/POST /v1/templates` · `GET/PUT /v1/templates/:id` (PUT = new version; optional `slug` = API name) · `POST /v1/templates/:id/preview` · `POST /v1/templates/:id/test` · `POST /v1/templates/:id/archive` · `GET/POST /v1/templates/starter/booking` |
| Automations | `GET/POST /v1/automations` · `GET/PUT /v1/automations/:id` · `POST /v1/automations/:id/{publish,pause,resume,archive,test}` · `GET /v1/automations/:id/enrollments` · `GET /v1/automations/:id/analytics` |
| Campaigns | `GET/POST /v1/campaigns` · `GET/PUT /v1/campaigns/:id` · `GET /v1/campaigns/:id/review` · `POST /v1/campaigns/:id/send` (`confirm_recipients` must equal reviewed eligible count) · `POST /v1/campaigns/:id/cancel` · `GET /v1/campaigns/:id/analytics` |
| Transactional / send log | `POST /v1/messages/send` (needs `Idempotency-Key`; `template` slug or `template_id`, `variables`, `send_at`, `tags`, `metadata`) · `POST /v1/messages/batch` · `POST /v1/sends/cancel` (`tag` or `idempotency_key`) · `GET /v1/sends` (`?tag=`) · `GET /v1/sends/:id` (with event timeline) · `POST /v1/sends/:id/retry` · `POST /v1/sends/:id/cancel` · `GET /v1/analytics/overview` |
| Outbound webhooks | `GET/POST /v1/webhooks` · `DELETE /v1/webhooks/:id` · `POST /v1/webhooks/:id/test` · `GET /v1/webhooks/:id/deliveries` (signed `Hostiggo-Signature: t=…,v1=…`) |
| Product events | `POST /v1/events` (`{name, email|contact_id, idempotency_key, properties}`) |
| Public / webhooks | `GET/POST /u/:token` (unsubscribe) · `POST /webhooks/google/pubsub` · `POST /webhooks/provider/:name` (HMAC `X-Hostiggo-Signature: sha256=…`) · `GET /health` |

Automation definition shape (what the visual builder should produce):

```json
{
  "trigger": { "type": "list_joined", "list_id": "…" },
  "mailbox_id": "…",
  "message_kind": "marketing",
  "reentry": "once",
  "steps": [
    { "id": "welcome", "type": "email", "template_id": "…" },
    { "id": "wait1",   "type": "wait",  "amount": 1, "unit": "days" },
    { "id": "followup","type": "email", "template_id": "…" }
  ]
}
```
Triggers: `list_joined` · `contact_created` · `event` (`event_name`). Template merge fields:
`{{ contact.first_name | default: "there" }}`, `{{ contact.<custom_field> }}`, any `variables` passed in.

## Going live with Gmail (guide §2)

1. Create separate Google Cloud projects for dev and prod; enable the Gmail API; set the OAuth consent screen (branding, support email, privacy policy, terms, authorized domains).
2. Add redirect URI `${API_BASE_URL}/oauth/google/callback`; put the client id/secret in `.env`; set `EMAIL_PROVIDER_MODE=gmail`.
3. Send-only uses `gmail.send` (sensitive). Reply tracking adds `gmail.metadata` (**restricted** — public apps need OAuth verification and possibly a security assessment). Keep the app in testing mode with an allowlist until that's done.
4. For push: create a Pub/Sub topic, grant `gmail-api-push@system.gserviceaccount.com` publish rights, create a push subscription to `${API_BASE_URL}/webhooks/google/pubsub` with OIDC auth, and set `GMAIL_PUBSUB_TOPIC`, `PUBSUB_AUDIENCE`, `PUBSUB_SERVICE_ACCOUNT_EMAIL`. Without a topic, the worker reconciles every 15 minutes.
5. Load `TOKEN_ENCRYPTION_KEYS` from a secret manager/KMS in production.

## Deliberately deferred (guide §10)

Branching/reply conditions, drag-and-drop canvas, A/B tests, open/click tracking, an ESP
adapter for bulk sends (the `EmailProvider` interface in `src/providers/index.ts` is where
it plugs in), segments with saved rules, business-hour send windows, and public self-serve
Gmail access before OAuth verification. Phase 6 (launch readiness: monitoring, backups,
abuse review, privacy/support pages) is operational work still to do.

## Layout

```
src/
  app.ts, server.ts, worker.ts, config.ts, context.ts
  auth/                  sessions, API keys, role/scope checks, audit
  db/                    pg + PGlite adapter, migrations/001_init.sql
  jobs/                  queue (SKIP LOCKED) + worker with periodic tasks
  lib/                   crypto, MIME builder, template renderer, email utils
  providers/             Google client (real + fake), provider-neutral send interface
  modules/               mailboxes, contacts (+imports), suppressions, templates, sends,
                         automations (definition, triggers, engine), campaigns, events,
                         replies (Gmail sync), analytics, unsubscribe, provider webhooks
test/                    end-to-end tests against embedded Postgres + fake Google
web/                     dashboard (React/Vite/Tailwind): src/pages/* one file per screen
```
