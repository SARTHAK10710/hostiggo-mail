# Direction: where Hostiggo Mail is going

Hostiggo Mail has two jobs:

1. **Hostiggo's internal email system.** Booking emails for hostiggo.com, guest and host lifecycle emails, and
   permission-based marketing, sent from Hostiggo's own Google Workspace mailboxes.
2. **A showcase project.** A public repo and live demo that show real engineering decisions on a real business
   problem.

It is **not** a product sold to other companies. That rules out a lot of work, listed in
[What we are not building](#what-we-are-not-building), and keeps the effort on things Hostiggo will use.

The other docs go deeper on single topics: [DEPLOY.md](DEPLOY.md) (hosting),
[SPAM-FIX.md](SPAM-FIX.md) (inbox placement), [BOOKING-EMAILS.md](BOOKING-EMAILS.md) (website integration),
[IMPROVE.md](IMPROVE.md) (full backlog with status) and [GOOGLE-VERIFICATION.md](GOOGLE-VERIFICATION.md). This
file says **what order to do things in and why**.

---

## Where it stands (November 2026)

**Built and tested** (71 automated tests, run on both the embedded database and PostgreSQL 18; CI on every push):

- **Sending:** Gmail mailboxes connected by OAuth, with encrypted tokens, a crash-safe job queue,
  duplicate-proof sends, daily limits and warm-up.
- **Contacts and consent:** contacts, lists, CSV import, consent records and suppressions, plus bulk actions,
  data export and erase.
- **Messages:** templates with versions, automations (wait and email steps), campaigns with a review step,
  and the transactional send API.
- **Booking emails:** 8 templates, scheduled reminders you can cancel by booking tag, a check that refuses
  emails with missing details, priority over marketing, and signed webhooks to the website.
- **Tracking:** reply and bounce detection, unsubscribe by reply, and deliverability and analytics pages.
- **Running it:** invite-only sign-up, cookie sessions, security headers, rate limits, an Operations page,
  `/health/ready`, backups, a Dockerfile and docker-compose.

**Not done yet:** it has never run on a public server; hostiggo.com doesn't call it yet; email comes from a
personal Gmail and partly lands in Spam; there is no password reset.

---

## Things to always take care of

These apply to every change, now and later.

### Never lose or leak data
- **No real data in the repo.** The repo is public. Contacts, CSVs, `.env`, database files and backups stay out
  (they're in `.gitignore`; keep it that way). Use made-up addresses (`@example.com`) in tests, docs and demos.
- **Secrets live in the server's environment or a secret manager, never in code or chat.** The Google client
  secret shared in an earlier chat must be rotated before going live.
- **Back up before anything risky**, and test that a backup restores. The embedded database has been
  corrupted once already by a force-killed process. Stop the server with Ctrl+C, not by killing it.
- **Database changes only go forward.** Never edit a migration that has already run anywhere. Add a new file
  (`004_….sql`, `005_….sql`) that only adds things, and keep it ASCII-only (Windows Postgres can break on other
  characters).

### Never send the wrong email
- **Marketing only to people who opted in, always with a way out.** Keep the consent source, honour
  unsubscribes and bounces immediately, and turn the visible unsubscribe line back on once deployed
  (`UNSUBSCRIBE_FOOTER=true`). Add Hostiggo's postal address to marketing emails (US CAN-SPAM requires one).
- **Never send twice.** Every send needs an idempotency key. If the outcome is unknown, don't retry
  automatically; check the Sent folder first. This is already how the code behaves; don't weaken it.
- **"Accepted" is not "delivered".** Gmail only says it accepted a message. Don't show it as delivered or
  opened anywhere.
- **Booking emails come first.** They must never be blocked by marketing. Keep the priority and the reserved
  share of the daily limit (`TRANSACTIONAL_RESERVE_PERCENT`).
- **A link in an email must never change data on a plain click.** Security scanners open links. Accept/Reject
  open a confirmation page; the change happens on its button.

### Keep it trustworthy
- **Every change goes through a branch and a pull request**, with CI green before merging. Run
  `npm run typecheck`, `npm test` and `npm run build` locally first; run `npm run test:pg` for anything that
  touches SQL.
- **Every bug fixed gets a test** that would have caught it.
- **Keep the docs honest.** When something is built, update its row in IMPROVE.md and the README. When
  something is not verified, say so.
- **Check with Hostiggo** that it's fine for this code to be public, especially if other people contribute.
  Anything sensitive about Hostiggo goes in the private deployment settings, not the repo.

---

## How to progress

Work in this order. Each stage ends with something usable, and later stages build on it.

### Stage 0: tidy up (this week, about a day)
- [ ] Merge PR #2 (fixes `npm install` looping on Windows) once CI passes.
- [ ] Rotate the Google OAuth client secret (Google Cloud → Clients → new secret, delete the old one).
- [ ] Reconnect the Gmail mailbox (access expires every 7 days while the Google app is in Testing).
- [ ] Set `SUPPORT_EMAIL` and `COMPANY_NAME` so the privacy, terms and support pages are complete.

### Stage 1: internal launch (about 2 weeks)
Goal: Hostiggo staff use it every day, on a real server, with mail landing in the inbox.

- [ ] **Google Workspace on hostiggo.com.** Create `bookings@hostiggo.com` (booking emails) and
      `hello@hostiggo.com` (marketing). Set up SPF, DKIM and DMARC: [SPAM-FIX.md](SPAM-FIX.md) step 5.
- [ ] **Google OAuth app set to "Internal"** inside that Workspace. No verification, no test-user list, no
      weekly reconnecting.
- [ ] **Deploy** with Postgres (Supabase) plus an API service and a separate worker service (Render), or
      `docker-compose` on a small server: [DEPLOY.md](DEPLOY.md). Use `NODE_ENV=production`,
      `ALLOW_SIGNUPS=false`, `UNSUBSCRIBE_FOOTER=true`, `OPERATOR_EMAILS=<your email>`.
- [ ] **Monitoring:** an uptime check on `/health/ready` (UptimeRobot or Better Stack) and a Slack alert URL in
      `ALERT_WEBHOOK_URL`.
- [ ] **Backups:** confirm the database provider's daily backups, and run one restore test.
- [ ] **Recreate the data** on the new server: connect mailboxes, re-import contacts, install the booking
      templates, invite teammates (Settings → Members).
- [ ] **To build: password reset** (email a single-use link from the system mailbox), plus **sending the
      invitation link by email** instead of copying it by hand.
- [ ] **To build: postal address in the marketing footer** (new setting, shown next to the unsubscribe line).

Done when: a teammate signs in on the public URL, a test email lands in the inbox at Gmail and Outlook, and the
uptime check is green for a week.

### Stage 2: booking emails live on hostiggo.com (about 1-2 weeks)
Goal: every booking on the website sends the right emails at the right time.
Full guide with code: [BOOKING-EMAILS.md](BOOKING-EMAILS.md).

- [ ] Website calls the batch send when a guest books (host request, guest receipt, reminder at +90 minutes).
- [ ] Host Accept/Reject pages on hostiggo.com: a signed link opens a confirmation page, and the booking
      changes only when the host confirms.
- [ ] On accept, reject and expiry, the website cancels the reminder by tag and sends the matching emails.
- [ ] An expiry job on the website for bookings still pending after 2 hours (cancel, refund, then email).
- [ ] A webhook receiver on the website for `send.failed`, `send.bounced`, `send.suppressed` and `send.unknown`.
- [ ] **To build (worth it): SMS or WhatsApp backup** for the host request when that webhook fires. A missed
      email costs a booking.
- [ ] **To build (nice): a default mailbox for transactional mail**, so the website doesn't pass `mailbox_id`.
- [ ] **To build (nice): date and money formatting inside templates**, so the website can send raw values.

Done when: 20 real bookings in a row produced the right emails, with no duplicates and no reminder sent after
the host had already answered.

### Stage 3: reliability and day-to-day use (ongoing, after launch)
- [ ] **Instant reply and bounce detection** with Gmail push notifications (a Google Cloud Pub/Sub topic; the
      endpoint is already built). Removes the 5-minute delay.
- [ ] **Automated browser tests** (Playwright) for sign-in, connecting a mailbox, importing contacts,
      publishing an automation and sending a booking email.
- [ ] **Error tracking** (Sentry or Better Stack) so crashes arrive with details.
- [ ] **A weekly look at Google Postmaster Tools** (spam rate and domain reputation) once the domain has volume.
- [ ] **Sync contacts from the website** (new users and guests, with their consent) through `/v1/contacts` and
      `/v1/events`, instead of CSV imports.

### Stage 4: showcase polish (in parallel with Stage 3)
Goal: someone looking at the repo understands in two minutes what it is, sees it working, and sees the
engineering behind it.

- [ ] **Public live demo** on a separate deployment in fake-mail mode (`EMAIL_PROVIDER_MODE=fake`), with
      sample data: a demo sign-in, booking templates installed, a sample campaign and automation, and a
      nightly reset. It must never touch Hostiggo's real mailboxes or data.
- [ ] **README rewrite:** the problem in one paragraph ("hosts have 2 hours to accept a booking"),
      screenshots or a short GIF, demo link, features, how to run it locally, CI badge.
- [ ] **ARCHITECTURE.md** explaining the main decisions and why:
  - a Postgres job queue that survives crashes;
  - duplicate-proof sends;
  - "unknown" sends are never retried automatically;
  - booking priority and reserved capacity;
  - signed webhooks;
  - Gmail tokens encrypted at rest;
  - least-privilege Gmail permissions.
- [ ] **A short write-up or blog post**, for example "Why our Gmail emails landed in Spam and how we fixed it"
      or "Designing a 2-hour booking acceptance flow".
- [ ] **Tidy the public docs:** IMPROVE.md written as a roadmap rather than a work log, a `LICENSE`, and no
      leftover personal details.

### Stage 5: later, only if Hostiggo needs it
- **Double opt-in:** new marketing sign-ups confirm by email.
- **Preference centre:** topics and frequency instead of all-or-nothing unsubscribe.
- **Segments:** saved filters (city, last booking, consent date).
- **Smarter automations:** "if they replied, stop", conditions, business hours and recipient time zones.
- **A visual email editor** and template version comparison.
- **An outside sending service** (Amazon SES or Postmark) **for marketing only**, if marketing volume outgrows
  Workspace's roughly 2,000 emails a day or you want delivered and opened data. The code has a place to plug
  one in (`EmailProvider` in `src/providers/index.ts`). Booking emails can stay on Workspace.

---

## What we are not building

These only matter for a product sold to other companies. Don't spend time on them unless that decision changes:

- Google's public app verification and the yearly security assessment for `gmail.metadata` (the Internal app
  avoids both)
- Billing, plans and usage metering
- Abuse controls for unknown customers (account vetting, automatic pausing of other people's sending)
- Public API documentation sites and client libraries for outside developers
- Customer domain verification, single sign-on, contracts and data processing agreements

---

## Decisions still open

| Question | Why it matters | Default if nobody decides |
|---|---|---|
| Where to host: Supabase + Render, or one server with docker-compose? | Cost vs maintenance | Supabase + Render (least upkeep) |
| SMS/WhatsApp provider for the host backup (Twilio, MSG91, Gupshup, WhatsApp Cloud API)? | Cost per message and reach in India | Decide in Stage 2 |
| Is the repo staying public? | Hostiggo's comfort with its internal tool being public | Public, with no Hostiggo data or secrets |
| Who besides you can merge changes? | The PR process only protects main if everyone uses it | Only you merge; others open PRs |

---

## How to tell it's working

Once live, check these monthly:

- **Booking emails:** 100% sent, and failures reported to the website within a minute.
- **Inbox placement:** test emails land in the inbox at Gmail, Outlook and Yahoo.
- **Bounce rate** below 2% and **spam complaints** below 0.1% (Deliverability page and Postmaster Tools).
- **No duplicate emails** and **no "unknown" sends** left unreviewed (Settings → Operations).
- **Uptime:** above 99.5%, and the worker is never down for more than 5 minutes.
- **Backups:** one restore test per quarter.
