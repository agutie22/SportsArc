#!/bin/bash
# SportsArc database backups: nightly pg_dump with 7-daily / 4-weekly rotation,
# kept in /backups (./backups on the host). Runs in the stock postgres image
# (same major version as the database). The optional off-site copy is the
# `s3` compose profile (s3-sync.sh), which mirrors this directory.
#
#   backup.sh daemon                 run forever; one dump a day at BACKUP_HOUR_UTC
#   backup.sh now                    one dump right now (and rotate)
#   backup.sh list                   what is on disk
#   backup.sh restore FILE --yes     restore FILE into DATABASE_URL
#                                    (or into --url URL); drops what it replaces
#
# FILE is a path under /backups (e.g. daily/sportsarc-20260927T030000Z.dump)
# or an absolute path. Dumps are pg_dump custom format (-Fc): compressed, and
# restorable with this image's pg_restore.
#
# Env: DATABASE_URL (required), BACKUP_HOUR_UTC (3), BACKUP_KEEP_DAILY (7),
# BACKUP_KEEP_WEEKLY (4).

set -euo pipefail
# Dumps hold personal data: owner-only files.
umask 077

DIR=/backups
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
HOUR="${BACKUP_HOUR_UTC:-3}"

log() { printf '%s [backup] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
err() { printf '%s [backup] level=error %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

need_url() {
  if [ -z "${DATABASE_URL:-}" ]; then err "DATABASE_URL is not set"; exit 1; fi
}

# Keep the newest $2 files matching *.dump in $1.
prune() {
  local dir="$1" keep="$2"
  # Names embed a UTC timestamp, so lexical order is age order.
  mapfile -t files < <(find "$dir" -maxdepth 1 -name '*.dump' -printf '%f\n' | sort -r)
  local i
  for ((i = keep; i < ${#files[@]}; i++)); do
    rm -f -- "$dir/${files[$i]}"
    log "pruned $dir/${files[$i]}"
  done
}

backup_now() {
  need_url
  mkdir -p "$DIR/daily" "$DIR/weekly"
  local stamp file tmp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  file="$DIR/daily/sportsarc-${stamp}.dump"
  tmp="${file}.partial"
  log "dumping database to $file"
  if ! pg_dump --format=custom --compress=6 --no-owner --no-privileges \
      --dbname="$DATABASE_URL" --file="$tmp"; then
    rm -f -- "$tmp"
    err "pg_dump failed"
    return 1
  fi
  # A dump pg_restore cannot list is not a backup.
  if ! pg_restore --list "$tmp" > /dev/null; then
    rm -f -- "$tmp"
    err "dump is unreadable"
    return 1
  fi
  mv -- "$tmp" "$file"
  log "wrote $file ($(du -h "$file" | cut -f1))"

  # Weekly: keep a copy when the newest weekly is 7+ days old (or none yet).
  local newest_weekly
  newest_weekly="$(find "$DIR/weekly" -maxdepth 1 -name '*.dump' -mtime -7 | head -1)"
  if [ -z "$newest_weekly" ]; then
    cp -- "$file" "$DIR/weekly/"
    log "kept weekly copy $DIR/weekly/$(basename "$file")"
  fi

  prune "$DIR/daily" "$KEEP_DAILY"
  prune "$DIR/weekly" "$KEEP_WEEKLY"
}

list() {
  mkdir -p "$DIR/daily" "$DIR/weekly"
  (cd "$DIR" && find daily weekly -name '*.dump' -printf '%TY-%Tm-%Td %TH:%TM  %10s  %p\n' | sort)
}

restore() {
  local file="" url="${DATABASE_URL:-}" yes=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes) yes=1 ;;
      --url) url="$2"; shift ;;
      *) file="$1" ;;
    esac
    shift
  done
  if [ -z "$file" ]; then err "usage: backup.sh restore FILE [--url URL] --yes"; exit 2; fi
  case "$file" in /*) ;; *) file="$DIR/$file" ;; esac
  if [ ! -f "$file" ]; then err "no such dump: $file"; exit 2; fi
  if [ -z "$url" ]; then err "no target: set DATABASE_URL or pass --url"; exit 2; fi
  if [ "$yes" != 1 ]; then
    err "restore replaces the tables in the target database; re-run with --yes"
    exit 2
  fi
  log "restoring $file"
  pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error \
    --single-transaction --dbname="$url" "$file"
  log "restore finished"
}

seconds_until_next_run() {
  local now target
  now="$(date -u +%s)"
  target="$(date -u -d "today ${HOUR}:00" +%s)"
  if [ "$target" -le "$now" ]; then target=$((target + 86400)); fi
  echo $((target - now))
}

daemon() {
  need_url
  log "daemon started: daily at ${HOUR}:00 UTC, keeping ${KEEP_DAILY} daily and ${KEEP_WEEKLY} weekly"
  trap 'log "stopping"; exit 0' TERM INT
  while true; do
    local wait
    wait="$(seconds_until_next_run)"
    log "next backup in $((wait / 3600))h$(((wait % 3600) / 60))m"
    sleep "$wait" &
    wait $! || true
    backup_now || err "backup failed; will try again tomorrow"
  done
}

cmd="${1:-daemon}"
shift || true
case "$cmd" in
  daemon) daemon ;;
  now) backup_now ;;
  list) list ;;
  restore) restore "$@" ;;
  *) echo "usage: backup.sh daemon|now|list|restore FILE [--url URL] --yes" >&2; exit 2 ;;
esac
