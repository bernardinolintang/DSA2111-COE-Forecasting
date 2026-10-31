#!/usr/bin/env bash
# Dump the Postgres database to a timestamped, compressed file (docker compose).
#
#   bash scripts/backup_db.sh                  # -> backups/coe-20261001-2130.sql.gz
#   gunzip -c backups/<file>.sql.gz | docker compose exec -T db psql -U coe -d coe   # restore
# this stops on any error so that a failed dump is not saved as a good backup
set -euo pipefail

# this moves to the repo root so that paths work from any folder
cd "$(dirname "$0")/.."
mkdir -p backups
# this names the file by time so that backups do not overwrite each other
file="backups/coe-$(date +%Y%m%d-%H%M).sql.gz"
docker compose exec -T db pg_dump -U "${POSTGRES_USER:-coe}" -d "${POSTGRES_DB:-coe}" | gzip > "$file"
echo "Saved $file ($(du -h "$file" | cut -f1))"

# this keeps the 10 most recent backups so that the disk does not fill up
ls -1t backups/coe-*.sql.gz | tail -n +11 | xargs -r rm --
