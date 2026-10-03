#!/usr/bin/env bash
# Резервная копия базы FiberFleet (безопасна при работающем сервисе).
# Хранит копии за KEEP_DAYS дней. Запускается cron'ом ежедневно (см. install.sh).
set -euo pipefail
DB=${FF_DB:-/var/lib/fiberfleet/fiberfleet.db}
DIR=${BACKUP_DIR:-/var/backups/fiberfleet}
KEEP_DAYS=${KEEP_DAYS:-14}
mkdir -p "$DIR"
STAMP=$(date +%Y-%m-%d_%H%M)
sqlite3 "$DB" ".backup '$DIR/fiberfleet_$STAMP.db'"
gzip -f "$DIR/fiberfleet_$STAMP.db"
find "$DIR" -name 'fiberfleet_*.db.gz' -mtime +"$KEEP_DAYS" -delete
echo "Резервная копия: $DIR/fiberfleet_$STAMP.db.gz"
