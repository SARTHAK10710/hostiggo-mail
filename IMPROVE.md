# Hostiggo Mail: what to improve next

A prioritised list of gaps and next steps, based on the build guide, what's built today, and what
came up while testing real Gmail sending. Each item says **why** it matters.

Legend: 🔴 do before real users · 🟠 important soon · 🟢 nice to have

---

## 1. Before real users (🔴)

| # | Improvement | Why |
|---|---|---|
| 1.1 | ✅ *Code verified on Postgres 18 (`npm run test:pg`); deploy steps in DEPLOY.md.* **Move from PGlite to real Postgres** (Supabase, which the Hostiggo site already uses). Set `DATABASE_URL=postgres://…`, run the API and `npm run start:worker` as separate processes. | PGlite is an embedded, single-process database meant for local dev. A hard kill (closing the terminal, a crash) can corrupt it. This already happened once during testing. |
| 1.2 | **Deploy on a public HTTPS address** (Render, Railway, Fly.io, or a VPS behind Caddy/Nginx) and set `API_BASE_URL` / `APP_BASE_URL` to it. Add the new redirect URI in Google Cloud. | Needed for one-click unsubscribe (Gmail requires https), Gmail push notifications (Pub/Sub can't reach localhost), and access from other machines. |
| 1.3 | **Rotate the Google OAuth client secret.** Create a new secret in Google Cloud → Clients, delete the old one, and paste the new one straight into `.env`. | The current secret was shared in a chat transcript. |
| 1.4 | **Switch to Google Workspace on your own domain** with SPF, DKIM and DMARC. See [SPAM-FIX.md](SPAM-FIX.md). | Biggest single improvement to inbox placement; also raises the daily limit to ~2,000 and removes the weekly re-consent in Testing mode (use an *Internal* OAuth app). |
| 1.5 | **Turn the visible unsubscribe line back on** (`UNSUBSCRIBE_FOOTER=true`) once the app is on public HTTPS. | Marketing email without an easy opt-out produces spam reports (which hurt deliverability more than unsubscribes) and breaks CAN-SPAM/GDPR/CASL expectations. |
| 1.6 | **Load secrets from a secret manager / KMS** in production (`APP_SECRET`, `TOKEN_ENCRYPTION_KEYS`, Google client secret). After re-connecting all mailboxes, remove the `dev:` entry from `TOKEN_ENCRYPTION_KEYS`. | Encryption keys in a plain `.env` on a server are the weakest link for stored Gmail tokens. |
| 1.7 | ✅ *Embedded DB: automatic snapshots + restore. Postgres: provider backups (DEPLOY.md).* **Backups** of the database (Supabase does daily backups on paid plans) and a tested restore. | Contacts, consent records and suppressions are business-critical. |

## 2. Deliverability & compliance (🟠)

| # | Improvement | Why |
|---|---|---|
| 2.1 | **Process "unsubscribe" replies automatically.** When reply tracking sees a reply whose subject/body is "unsubscribe" (or the mailto List-Unsubscribe), add an `unsubscribed` suppression. | On a non-public server people are asked to reply "unsubscribe", which today must be handled by hand. |
| 2.2 | **Gmail push notifications** (Pub/Sub topic + push subscription → `/webhooks/google/pubsub`). | Replies and bounces show up in seconds instead of on the 5-minute poll. |
| 2.3 | **Google OAuth verification** if the app will be used by people outside your organisation. `gmail.metadata` is a *restricted* scope and needs a security assessment (CASA). | Without it, only test users (max 100) can connect, and tokens expire every 7 days in Testing mode. Alternative: keep the app *Internal* to your Workspace. |
| 2.4 | **Double opt-in**: send a confirmation email for new marketing sign-ups and only mark `opted_in` after the click. | Strongest consent record; removes typo'd and fake addresses before they bounce. |
| 2.5 | **Preference centre** page (topics / frequency) instead of all-or-nothing unsubscribe. | Fewer full unsubscribes and spam reports. |
| 2.6 | **ESP adapter** (Amazon SES, Postmark, Resend or SendGrid) behind the existing `EmailProvider` interface in `src/providers/index.ts`, plus mapping their webhooks into `/webhooks/provider/:name`. | Gmail/Workspace is not allowed for bulk marketing and is capped at 500–2,000/day. Keep Gmail for 1:1 and transactional mail. |
| 2.7 | **Google Postmaster Tools** + a weekly deliverability report in the dashboard (spam rate, domain reputation). | You can't fix what you can't see; Postmaster Tools is Google's own view of your domain. |
| 2.8 | **Send-time throttling / warm-up schedule** per mailbox (e.g. start at 20/day and ramp). | New domains and mailboxes that jump straight to high volume get filtered. |

## 3. Product features (🟠/🟢)

| # | Improvement | Why |
|---|---|---|
| 3.1 🟠 | **Enroll existing list members** when an automation is published (optional checkbox), not only people who join afterwards. | Today, contacts already in the trigger list are skipped. This surprised us during testing. |
| 3.2 🟠 | **Bulk actions on Contacts**: select many → opt in (with source), add to list, remove, delete. | Opting in 5 people meant 5 separate clicks. |
| 3.3 🟠 | **Edit contact form** (names, custom fields) in the contact panel. | Only consent can be changed in the UI right now. |
| 3.4 🟠 | ✅ *Invite links done (sharing by email still manual).* **Member invites by email** + **password reset**; or reuse the Hostiggo website's Supabase auth (single sign-on). | Teammates currently must sign up first; there is no "forgot password". |
| 3.5 🟢 | **Automation branches**: "if replied → stop", condition splits, business-hour windows, recipient time zones. | Deferred by the guide until the linear engine proved reliable, which it now has (tests cover it). |
| 3.6 🟢 | **Migrate enrollments to a new version** on publish (optional). | Today contacts finish the version they started, which is safe but sometimes not what you want. |
| 3.7 🟢 | **Segments** (saved filters: city, consent date, custom fields, engagement). | Lists are manual. |
| 3.8 🟢 | **Template editor upgrades**: visual/MJML editor, image upload/hosting, version diff and rollback. | HTML by hand is error-prone and a common spam trigger when broken. |
| 3.9 🟢 | **A/B subject tests** and **open/click tracking** (labelled as estimates, with a privacy notice). | Deferred by the guide; only worth it once deliverability is solid. |
| 3.10 🟢 | **Sync contacts from the Hostiggo website** (Supabase users / bookings) via `/v1/events` and `/v1/contacts`. | Avoids CSV round-trips; enables booking-triggered sequences. |

## 4. Engineering & operations (🟠/🟢)

| # | Improvement | Why |
|---|---|---|
| 4.1 🟠 | **CI on GitHub Actions**: `npm ci`, `npm run typecheck`, `npm test`, `npm run build` on every push/PR. | Keeps the 41-test suite green as the code changes. |
| 4.2 🟠 | **Browser end-to-end tests** (Playwright) for login, connect mailbox, import CSV, build automation, launch campaign. | The UI was verified by hand; regressions would go unnoticed. |
| 4.3 🟠 | ✅ *Headers/CSP + rate limits done; cookie sessions still open.* **Security hardening**: rate-limit `/v1/auth/*`, security headers / CSP (`@fastify/helmet`), session token in an httpOnly cookie instead of `localStorage`. | Protects against brute force and XSS token theft. |
| 4.4 🟠 | ✅ *Request logs off by default (`LOG_REQUESTS`).* **Quieter, shippable logs**: `LOG_LEVEL=warn` locally or disable per-request logging; send structured logs + errors to a service (Better Stack, Sentry). | The terminal is flooded with request logs; real errors are hard to spot. |
| 4.5 🟢 | *Partly: Operations page + `/health/ready` for uptime monitors.* **Alerts**: email/Slack when a mailbox needs reconnecting, becomes unhealthy, or sends fail repeatedly. | Today you only find out by opening the dashboard. |
| 4.6 🟢 | **OpenAPI spec** generated from the zod schemas + published API docs. | Easier integration for the Hostiggo backend team. |
| 4.7 🟢 | **Data-subject tools**: export and hard-delete everything about one email address (GDPR). | Soft-delete keeps the address for suppression; a full erase flow is still needed. |
| 4.8 🟢 | **Split the dashboard bundle** (route-level code splitting). | Single 465 KB JS bundle today; fine locally, slower on mobile. |

---

## Added in Phase 6 work
| # | Improvement | Why |
|---|---|---|
| 6.1 🟠 | **Export the embedded database to Postgres** (needs upgrading PGlite to the version `@electric-sql/pglite-tools` supports). | Moves existing local data to the hosted database without re-entering it. |

## Known limitations today

- Gmail reports **accepted**, not delivered or opened. "Accepted" ≠ inbox.
- In Google OAuth **Testing** mode, refresh tokens expire after **7 days** → reconnect weekly.
- **Dev mode** (`EMAIL_PROVIDER_MODE=fake`) keeps its outbox in memory; it's cleared on restart.
- Replies are matched by Gmail thread / Message-ID. Replies that start a **new thread** are not counted.
- Reply tracking without Pub/Sub polls every **5 minutes**; "Check for replies now" forces a check.
