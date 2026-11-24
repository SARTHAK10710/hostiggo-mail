#!/usr/bin/env bash
# Dump the Hostiggo Mail Postgres database to a timestamped, compressed file and prune old ones.
#   DATABASE_URL=postgres://... ./scripts/backup.sh [backup-dir] [keep-count]
# Run it from cron / a scheduled job. Supabase paid plans also take daily backups; this is your own copy.
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to the postgres:// connection string}"
case "$DATABASE_URL" in postgres://*|postgresql://*) ;; *) echo "DATABASE_URL must be a real Postgres URL (not pglite)" >&2; exit 1;; esac
dir="${1:-./backups}"
keep="${2:-14}"
mkdir -p "$dir"
file="$dir/hostiggo-mail-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip > "$file"
# A dump that is empty or truncated is worse than none: fail loudly.
[ "$(gzip -dc "$file" | grep -c 'CREATE TABLE')" -ge 10 ] || { echo "backup looks incomplete: $file" >&2; rm -f "$file"; exit 1; }
echo "wrote $file"
ls -1t "$dir"/hostiggo-mail-*.sql.gz | tail -n +"$((keep + 1))" | xargs -r rm -f
