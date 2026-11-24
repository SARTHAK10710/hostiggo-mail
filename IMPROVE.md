# Hostiggo Mail: what to improve next

A prioritised list of gaps and next steps, with the **status of each item** (after the `improvements`
branch, Phase 6 and the booking emails). Each item says **why** it matters.

Legend: ✅ done in code (tested) · 🔧 needs you (an account, DNS, a decision or a deploy; code can't do it) · ⏭️ not built yet

Priority: 🔴 before real users · 🟠 important soon · 🟢 nice to have

---

## 1. Before real users (🔴)

| # | Improvement | Status | Why / what's left |
|---|---|---|---|
| 1.1 | **Move from PGlite to real Postgres** (Supabase). `DATABASE_URL=postgres://…`, API and `node dist/worker.js` as separate processes. | ✅ verified + guard · 🔧 provision | The whole suite passes on PostgreSQL 18 (`npm run test:pg`) and production **refuses to start** on PGlite. You still need to create the database and set `DATABASE_URL` ([DEPLOY.md](DEPLOY.md)). |
| 1.2 | **Deploy on public HTTPS** and set `API_BASE_URL` / `APP_BASE_URL`; add the redirect URI in Google Cloud. | ✅ Docker + guard · 🔧 deploy | `Dockerfile` and `docker-compose.yml` (Postgres + API + worker); not built here because Docker wasn't running. Production refuses non-`https://` URLs. Pick a host and deploy ([DEPLOY.md](DEPLOY.md)). |
| 1.3 | **Rotate the Google OAuth client secret.** | 🔧 you | Google Cloud → Clients → new secret, delete the old one, paste into `.env`. Only you can do this. |
| 1.4 | **Google Workspace on your own domain** with SPF, DKIM, DMARC. See [SPAM-FIX.md](SPAM-FIX.md). | 🔧 you | Needs your domain registrar and a Workspace subscription. Steps are in SPAM-FIX step 5. Matters most for booking emails. |
| 1.5 | **Visible unsubscribe line on** (`UNSUBSCRIBE_FOOTER=true`). | ✅ · 🔧 you | Default is on and the server warns at startup in production if it's off. Your local `.env` has it off; turn it back on once deployed on HTTPS. |
| 1.6 | **Secrets from a secret manager / KMS.** | ✅ support · 🔧 setup | `APP_SECRET_FILE`, `TOKEN_ENCRYPTION_KEYS_FILE`, `GOOGLE_CLIENT_SECRET_FILE`, `DATABASE_URL_FILE`, … are read from mounted files. After re-connecting every mailbox, drop the `dev:` key. |
| 1.7 | **Backups** and a tested restore. | ✅ · 🔧 schedule | Embedded DB: automatic daily snapshot, keep 7, `npm run restore`. Postgres: `scripts/backup.sh` (dump + prune) and `scripts/restore-check.sh` (restore into a scratch DB); not run here (no `pg_dump` on this machine). |

## 2. Deliverability & compliance (🟠)

| # | Improvement | Status | Why / what's left |
|---|---|---|---|
| 2.1 | **Process "unsubscribe" replies automatically.** | ✅ | A reply whose subject or first line is just "unsubscribe"/"stop"/"remove me"… from a known contact suppresses them and opts them out. "Stop by tomorrow?" is deliberately not matched. Needs reply tracking on (the Gmail snippet is used, never the body). |
| 2.2 | **Gmail push notifications** (Pub/Sub). | ✅ code · 🔧 GCP | The endpoint, OIDC check and watch renewal already exist. Create the topic and subscription (README → *Going live*). |
| 2.3 | **Google OAuth verification** for users outside your organisation. | 🔧 you | A Google review process (`gmail.metadata` is restricted). Alternative: an *Internal* Workspace app. |
| 2.4 | **Double opt-in.** | ⏭️ | Needs a confirmation email + public confirm page. |
| 2.5 | **Preference centre.** | ⏭️ | Topics/frequency instead of all-or-nothing. |
| 2.6 | **ESP adapter** (SES, Postmark, Resend, SendGrid). | ⏭️ | Plug into `EmailProvider` in `src/providers/index.ts`. Needs your ESP account to build and test against, so I did not write it blind. |
| 2.7 | **Google Postmaster Tools** + weekly report. | 🔧 you | Register the domain at postmaster.google.com once it's on Workspace. |
| 2.8 | **Warm-up schedule** per mailbox. | ✅ | 20/day, doubling every 7 days up to the mailbox limit. On by default for new mailboxes (`WARMUP_DEFAULT`), toggle per mailbox under *Deliverability → Daily limit*. Sends over the cap wait in the queue; campaign review and the header quota show today's cap. |

## 3. Product features (🟠/🟢)

| # | Improvement | Status | Why / what's left |
|---|---|---|---|
| 3.1 🟠 | **Enroll existing list members on publish.** | ✅ | Checkbox next to Publish (list triggers). Only enrolls into *that* automation; non-opted-in and suppressed contacts are still skipped. |
| 3.2 🟠 | **Bulk actions on Contacts.** | ✅ | Select rows → mark opted in (consent source required), add/remove list, delete. People who unsubscribed are skipped, never re-subscribed. |
| 3.3 🟠 | **Edit contact form.** | ✅ | Edit names and custom fields in the contact panel. (Blank leaves a field unchanged by design; email can't be changed.) |
| 3.4 🟠 | **Member invites + password reset.** | ✅ invites · ⏭️ reset | Admins create a 7-day single-use invitation link (Settings → Members); sign-up can be invite-only (`ALLOW_SIGNUPS=false`). Emailing the link and "forgot password" still need a system sender. |
| 3.5 🟢 | Automation branches, business hours, time zones. | ⏭️ | |
| 3.6 🟢 | Migrate enrollments to a new version. | ⏭️ | |
| 3.7 🟢 | Segments (saved filters). | ⏭️ | |
| 3.8 🟢 | Template editor upgrades (MJML, images, diff/rollback). | ⏭️ | |
| 3.9 🟢 | A/B subject tests, open/click tracking. | ⏭️ | Only worth it once deliverability is solid. |
| 3.10 🟢 | Sync contacts from the Hostiggo website. | ⏭️ | Needs the website's data model; `/v1/events` and `/v1/contacts` are ready to receive it. Booking emails already use the send API ([BOOKING-EMAILS.md](BOOKING-EMAILS.md)). |

## 4. Engineering & operations (🟠/🟢)

| # | Improvement | Status | Why / what's left |
|---|---|---|---|
| 4.1 🟠 | **CI on GitHub Actions.** | ✅ | `.github/workflows/ci.yml`: `npm ci`, typecheck, tests, build on every push/PR. |
| 4.2 🟠 | **Browser end-to-end tests** (Playwright). | ⏭️ | The UI was verified by hand in a browser; automated browser tests are still missing. |
| 4.3 🟠 | **Security hardening.** | ✅ | `@fastify/helmet` (CSP etc.), 429 rate limit on sign-in/sign-up (`AUTH_RATE_LIMIT_MAX`) plus an optional general per-IP limit (`RATE_LIMIT`), session in an `httpOnly` `SameSite=Lax` cookie with an Origin check (old stored tokens are removed on load). |
| 4.4 🟠 | **Quieter logs.** | ✅ · 🔧 service | Per-request logs are off by default (`LOG_REQUESTS=true` to bring them back). Shipping logs to Better Stack/Sentry needs your account. |
| 4.5 🟢 | **Alerts.** | ✅ | `ALERT_WEBHOOK_URL` (Slack-compatible) fires when a mailbox loses Google access or is paused; Settings → Operations and `/health/ready` show worker and send problems. |
| 4.6 🟢 | OpenAPI spec. | ⏭️ | |
| 4.7 🟢 | **Data-subject tools.** | ✅ | Admin-only: export everything about one address (JSON), and erase permanently. The opt-out record is kept by default so they are never emailed again (`?suppressions=erase` removes it too). The audit entry holds no address. |
| 4.8 🟢 | **Split the dashboard bundle.** | ✅ | Pages load on demand: main bundle 465 KB → 331 KB. |

---

## Added in Phase 6 work
| # | Improvement | Why |
|---|---|---|
| 6.1 🟠 | **Export the embedded database to Postgres** (needs upgrading PGlite to the version `@electric-sql/pglite-tools` supports). | Moves existing local data to the hosted database without re-entering it. |

## Booking emails (follow-ups)
| # | Improvement | Why |
|---|---|---|
| 7.1 🟠 | **Wire the website** (hostiggo.com) to the API as described in [BOOKING-EMAILS.md](BOOKING-EMAILS.md): batch send on booking, cancel + confirm on accept/reject, expiry job, confirmation page for Accept/Reject links, webhook receiver. | The email side is built; the website still has to call it. |
| 7.2 🟠 | **SMS / WhatsApp fallback** for the host request when the `send.failed`/`send.bounced` webhook fires. | With a 2-hour window, an email that doesn't arrive costs the booking. |
| 7.3 🟢 | **Per-workspace default mailbox for transactional mail** (instead of passing `mailbox_id`). | Keeps booking mail on `bookings@` without each caller knowing the id. |
| 7.4 🟢 | **Date/currency filters in templates** (`{{ stay.check_in \| date: "EEE d MMM" }}`). | Today the website must pre-format every value in the recipient's time zone. |

## Known limitations today

- Gmail reports **accepted**, not delivered or opened. "Accepted" ≠ inbox.
- In Google OAuth **Testing** mode, refresh tokens expire after **7 days**: reconnect weekly.
- **Dev mode** (`EMAIL_PROVIDER_MODE=fake`) keeps its outbox in memory; it's cleared on restart.
- Replies are matched by Gmail thread / Message-ID. Replies that start a **new thread** are not counted (an "unsubscribe" reply is still caught, by sender).
- Reply tracking without Pub/Sub polls every **5 minutes**; "Check for replies now" forces a check.
- Reply-to-unsubscribe needs the reply-tracking permission; without it, add suppressions by hand.
