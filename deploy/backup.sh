#!/usr/bin/env bash
# Nightly Postgres backup with rotation (spec §12.2). Run from cron on the host, e.g.:
#   30 4 * * * /home/kenny/paceo/deploy/backup.sh >> /var/log/paceo-backup.log 2>&1
# The dump includes everything: app data, uploaded/synced FIT files (bytea) and the pg-boss queue.
# Off-box: set RCLONE_REMOTE in deploy/.env (use an rclone "crypt" remote so backups are encrypted).
set -euo pipefail

cd "$(dirname "$0")"
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

BACKUP_DIR=${BACKUP_DIR:-/var/backups/paceo}
KEEP_DAILY=${KEEP_DAILY:-14}
KEEP_WEEKLY=${KEEP_WEEKLY:-8}
stamp=$(date +%Y-%m-%d_%H%M)

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"
chmod 700 "$BACKUP_DIR"

out="$BACKUP_DIR/daily/paceo-$stamp.dump"
echo "[$(date -Is)] dumping to $out"
docker compose exec -T postgres pg_dump -U paceo -d paceo -Fc --no-owner >"$out.partial"
mv "$out.partial" "$out"
chmod 600 "$out"

# Sanity check: the archive's table of contents must be readable.
docker compose exec -T postgres pg_restore --list <"$out" >/dev/null
echo "[$(date -Is)] dump ok ($(du -h "$out" | cut -f1))"

# Sunday's dump is also kept as a weekly.
if [ "$(date +%u)" = "7" ]; then
  cp "$out" "$BACKUP_DIR/weekly/"
fi

rotate() { # dir keep
  find "$1" -maxdepth 1 -name 'paceo-*.dump' -printf '%T@ %p\n' | sort -rn | tail -n +"$(( $2 + 1 ))" | cut -d' ' -f2- | xargs -r rm -f --
}
rotate "$BACKUP_DIR/daily" "$KEEP_DAILY"
rotate "$BACKUP_DIR/weekly" "$KEEP_WEEKLY"

if [ -n "${RCLONE_REMOTE:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone sync "$BACKUP_DIR" "$RCLONE_REMOTE" --log-level NOTICE
    echo "[$(date -Is)] synced to $RCLONE_REMOTE"
  else
    echo "[$(date -Is)] RCLONE_REMOTE is set but rclone is not installed" >&2
    exit 1
  fi
fi
