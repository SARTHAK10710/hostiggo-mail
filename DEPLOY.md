# Deploying Hostiggo Mail (Phase 6)

Today the app runs on your computer with an embedded database. For real users it needs
**real Postgres**, a **public HTTPS address**, and a **separate background worker**.
The code supports all three; it's verified against PostgreSQL 18 with `npm run test:pg`.

## 1. Choose where it runs

| Option | Database | App + worker | Good for |
|---|---|---|---|
| **A. Managed** | Supabase (the Hostiggo site already uses it) | Render / Railway / Fly.io (two services from this repo) | Least maintenance |
| **B. One server** | Postgres in `docker-compose.yml` | Same compose file (api + worker) behind Caddy for HTTPS | Cheapest, full control |

### Option A: Supabase + Render (example)
1. Supabase → new project → **Project settings → Database → Connection string (URI)**, using the *session pooler* or direct connection (port 5432).
2. Render → **New Web Service** from this GitHub repo:
   build `npm ci && npm run build`, start `node dist/server.js`, health check path `/health/ready`.
3. Render → **New Background Worker** from the same repo: build the same, start `node dist/worker.js`.
4. Give both the environment variables from section 2. The API service gets `RUN_WORKER_IN_PROCESS=false`.

### Option B: docker compose on a VPS
```bash
git clone https://github.com/SARTHAK10710/hostiggo-mail && cd hostiggo-mail
cp .env.example .env   # fill in section 2
export POSTGRES_PASSWORD='a-long-random-password'
docker compose up -d --build
```
Then put HTTPS in front, e.g. a Caddyfile with `mail.hostiggo.com { reverse_proxy localhost:4000 }`.

## 2. Environment variables (production)

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` (the server refuses dev secrets or the embedded DB in production) |
| `DATABASE_URL` | `postgres://…` |
| `API_BASE_URL`, `APP_BASE_URL` | your public URL, e.g. `https://mail.hostiggo.com` |
| `CORS_ORIGINS` | same URL (or the dashboard's URL if hosted separately) |
| `APP_SECRET` | long random string (`node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"`) |
| `TOKEN_ENCRYPTION_KEYS` | `k1:<base64 32 bytes>` from `npm run gen:key`. **Do not** reuse the local `dev:` key |
| `EMAIL_PROVIDER_MODE` | `gmail` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from Google Cloud (rotate the one shared in chat) |
| `GMAIL_REPLY_TRACKING` | `true` if you want reply counts |
| `ALLOW_SIGNUPS` | `false` (invite-only; your first account is still allowed) |
| `SUPPORT_EMAIL`, `COMPANY_NAME` | shown on `/privacy`, `/terms`, `/support` |
| `OPERATOR_EMAILS` | your email (sees the server-wide queue and workers) |
| `UNSUBSCRIBE_FOOTER` | `true` (one-click unsubscribe works once on HTTPS) |

## 3. Google Cloud changes
- Add the redirect URI `https://<your-domain>/oauth/google/callback` to the OAuth client.
- Consent screen: home page `https://<your-domain>`, privacy `…/privacy`, terms `…/terms`, authorised domain = your domain.
- Optional, for instant reply detection: create a Pub/Sub topic, grant `gmail-api-push@system.gserviceaccount.com`
  the *Publisher* role, add a push subscription to `https://<your-domain>/webhooks/google/pubsub` with OIDC auth,
  and set `GMAIL_PUBSUB_TOPIC`, `PUBSUB_AUDIENCE`, `PUBSUB_SERVICE_ACCOUNT_EMAIL`.
- Making the app public (external users) requires verification: see [GOOGLE-VERIFICATION.md](GOOGLE-VERIFICATION.md).

## 4. Data you already have locally
The new server starts with an empty Postgres. For a handful of contacts and templates the simplest path is to
recreate them (re-import the CSV, copy templates) and reconnect the mailbox. A one-shot export from the embedded
database to Postgres needs a newer PGlite version than this project uses, so it's tracked in IMPROVE.md.

## 5. After deploying: checklist
- [ ] `https://<domain>/health/ready` returns `{"ok":true}`; add it to an uptime monitor (UptimeRobot, Better Stack).
- [ ] Sign in, **Settings → Operations** shows the worker as *Running*.
- [ ] Connect the mailbox, send a test, see *Accepted*.
- [ ] Database backups are on (Supabase: daily on paid plans; compose: schedule `pg_dump`, e.g.
      `docker compose exec -T db pg_dump -U hostiggo hostiggo_mail | gzip > backup-$(date +%F).sql.gz`).
- [ ] `ALLOW_SIGNUPS=false`, invite teammates from **Settings → Members**.
