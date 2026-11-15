#!/usr/bin/env bash
# Prove a backup can actually be restored: load it into a SCRATCH database and count rows.
#   SCRATCH_DATABASE_URL=postgres://.../restore_test ./scripts/restore-check.sh backups/hostiggo-mail-....sql.gz
# Never point SCRATCH_DATABASE_URL at production: the restore replays CREATE TABLE statements.
set -euo pipefail
: "${SCRATCH_DATABASE_URL:?Set SCRATCH_DATABASE_URL to an empty throwaway database}"
file="${1:?usage: restore-check.sh <backup.sql.gz>}"
gzip -dc "$file" | psql --quiet --set ON_ERROR_STOP=1 "$SCRATCH_DATABASE_URL" >/dev/null
for t in workspaces users contacts suppressions sends; do
  printf '%-14s %s\n' "$t" "$(psql -At "$SCRATCH_DATABASE_URL" -c "select count(*) from $t")"
done
echo "restore OK"
