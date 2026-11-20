#!/bin/bash
# Off-site copy of the database backups (compose profile `s3`, off by default).
# Mirrors /backups (daily/ and weekly/) to an S3-compatible bucket every
# S3_SYNC_INTERVAL_MIN minutes with `aws s3 sync --delete`, so the bucket
# keeps the same 7-daily / 4-weekly set as the machine. Runs in the official
# amazon/aws-cli image; works with AWS S3, Backblaze B2, Cloudflare R2,
# Wasabi and MinIO (set S3_ENDPOINT for anything but AWS).
#
# Env: S3_BUCKET, S3_PREFIX (sportsarc), S3_ENDPOINT (empty for AWS),
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION,
# S3_SYNC_INTERVAL_MIN (60). `s3-sync.sh once` syncs one time and exits.

set -euo pipefail

log() { printf '%s [s3-sync] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
err() { printf '%s [s3-sync] level=error %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

if [ -z "${S3_BUCKET:-}" ]; then
  err "S3_BUCKET is not set; nothing to do (remove the s3 profile or fill in S3_* in .env)"
  exit 1
fi

dest="s3://${S3_BUCKET}/${S3_PREFIX:-sportsarc}"
endpoint=()
if [ -n "${S3_ENDPOINT:-}" ]; then endpoint=(--endpoint-url "$S3_ENDPOINT"); fi

sync_once() {
  # Only finished dumps; *.partial is a dump in progress.
  if aws "${endpoint[@]}" s3 sync /backups "$dest" --delete --only-show-errors \
      --exclude '*' --include 'daily/*.dump' --include 'weekly/*.dump'; then
    log "synced /backups to $dest"
  else
    err "sync to $dest failed"
    return 1
  fi
}

if [ "${1:-}" = "once" ]; then sync_once; exit $?; fi

interval=$(( ${S3_SYNC_INTERVAL_MIN:-60} * 60 ))
log "mirroring /backups to $dest every $((interval / 60)) min"
trap 'log "stopping"; exit 0' TERM INT
while true; do
  sync_once || true
  sleep "$interval" &
  wait $! || true
done
