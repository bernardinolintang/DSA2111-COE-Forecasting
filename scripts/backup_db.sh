#!/usr/bin/env bash
# Dump the Postgres database to a timestamped, compressed file (docker compose).
#
#   bash scripts/backup_db.sh                  # -> backups/coe-20261001-2130.sql.gz
#   gunzip -c backups/<file>.sql.gz | docker compose exec -T db psql -U coe -d coe   # restore
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p backups
file="backups/coe-$(date +%Y%m%d-%H%M).sql.gz"
docker compose exec -T db pg_dump -U "${POSTGRES_USER:-coe}" -d "${POSTGRES_DB:-coe}" | gzip > "$file"
echo "Saved $file ($(du -h "$file" | cut -f1))"

# Keep the 10 most recent backups.
ls -1t backups/coe-*.sql.gz | tail -n +11 | xargs -r rm --
