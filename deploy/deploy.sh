#!/bin/bash
# Rolling deploy of the SportsArc beta on the VPS (runs from /opt/sportsarc,
# next to compose.yml, Caddyfile and .env). GitHub Actions calls
# `deploy.sh deploy <tag>` after pushing the image; the owner can run any of:
#
#   deploy.sh deploy <tag>     pull <image>:<tag>, migrate, then replace the
#                              app containers one at a time
#   deploy.sh rollback [tag]   back to the previous release (or <tag>);
#                              no migrations run
#   deploy.sh status           current and previous release, containers
#   deploy.sh history          past releases
#   deploy.sh compose <args>   docker compose in this project
#
# Safety: a failed pull, Caddy config, migration or health check stops the
# deploy with the old version still serving. Migrations are all-or-nothing
# (one transaction), and the app containers are only touched after they
# succeed. If a new container fails its health check it is put back on the
# old tag, and so is any container already switched. Re-running with the same
# tag is a no-op apart from the (no-op) migration and health checks.
#
# Migrations must stay compatible with the release before them (add columns
# and tables; drop in a later release), because one old container keeps
# serving during the roll and a rollback does not undo them.
#
# Env overrides: APP_IMAGE (else from .env), HEALTH_TIMEOUT (120s),
# SETTLE_SECONDS (8: time for Caddy to see a new container healthy before
# the next one goes down).

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DIR/.env"
HISTORY="$DIR/releases.log"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
SETTLE_SECONDS="${SETTLE_SECONDS:-8}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
HEALTH_PATH="$(grep -E '^HEALTH_PATH=' "$(dirname "${BASH_SOURCE[0]}")/.env" 2> /dev/null | tail -1 | cut -d= -f2- || true)"
HEALTH_PATH="${HEALTH_PATH:-/health/ready}"
log() { printf '%s [deploy] %s\n' "$(ts)" "$*"; }
die() { printf '%s [deploy] error: %s\n' "$(ts)" "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing (bootstrap-vps.sh writes it)"
command -v docker > /dev/null || die "docker is not installed"

# compose.yml plus compose.override.yml when present (e.g. an app3).
dc() { docker compose --project-directory "$DIR" "$@"; }

env_get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }

# Set KEY=value in .env in place, keeping its mode and owner.
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "$DIR/.env.XXXXXX")"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"; printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  chmod --reference="$ENV_FILE" "$tmp" 2> /dev/null || chmod 600 "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}

app_services() { dc config --services | grep -E '^app[0-9]+$' | sort -V; }

container_health() {
  local cid
  cid="$(dc ps -q "$1" 2> /dev/null || true)"
  [ -n "$cid" ] || { echo missing; return; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2> /dev/null || echo missing
}

# Readiness from inside the container: 200 only once the database answers.
container_ready() {
  dc exec -T "$1" node -e "fetch('http://127.0.0.1:3000${HEALTH_PATH}').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" > /dev/null 2>&1
}

wait_healthy() {
  local svc="$1" waited=0 status
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    status="$(container_health "$svc")"
    case "$status" in
      healthy) container_ready "$svc" && return 0 ;;
      unhealthy|exited|dead|restarting|missing) [ "$waited" -ge 20 ] && { log "$svc is $status"; return 1; } ;;
    esac
    sleep 2; waited=$((waited + 2))
  done
  log "$svc not healthy after ${HEALTH_TIMEOUT}s (status: $(container_health "$svc"))"
  return 1
}

ensure_image() {
  local ref="$1"
  if docker image inspect "$ref" > /dev/null 2>&1; then
    log "image $ref is present"
  else
    log "pulling $ref"
    docker pull -q "$ref" > /dev/null || die "could not pull $ref"
  fi
}

# Everything that is not an app container or the migration job: Postgres,
# Caddy, backups and whichever profiles .env enables.
start_infra() {
  local infra
  infra="$(dc config --services | grep -vE '^(app[0-9]+|migrate)$' | tr '\n' ' ')"
  log "starting infrastructure: $infra"
  # shellcheck disable=SC2086
  dc up -d --no-deps --remove-orphans $infra
  # The Caddyfile is bind-mounted; pick up changes to it without a restart.
  dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile > /dev/null 2>&1 \
    || { sleep 3; dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile > /dev/null; } \
    || die "Caddy rejected the Caddyfile; nothing was changed"
  if dc config --services | grep -qx postgres; then
    local _
    for _ in $(seq 1 60); do
      [ "$(container_health postgres)" = healthy ] && return 0
      sleep 2
    done
    die "postgres is not healthy"
  fi
}

# roll <image> <new tag> <old tag>: replace each app container in turn.
roll() {
  local image="$1" new="$2" old="$3" svc done_list=()
  env_set APP_IMAGE "$image"
  env_set APP_TAG "$new"
  for svc in $(app_services); do
    log "replacing $svc with $image:$new"
    dc up -d --no-deps "$svc"
    done_list+=("$svc")
    if ! wait_healthy "$svc"; then
      dc logs --tail=40 "$svc" >&2 || true
      if [ -n "$old" ] && [ "$old" != "$new" ]; then
        log "health check failed; putting ${done_list[*]} back on $image:$old"
        env_set APP_TAG "$old"
        local back
        for back in "${done_list[@]}"; do
          dc up -d --no-deps "$back"
          wait_healthy "$back" || log "warning: $back is not healthy on $old either"
        done
      fi
      die "deploy of $new failed; $old is serving"
    fi
    log "$svc is healthy; waiting ${SETTLE_SECONDS}s for Caddy to route to it"
    sleep "$SETTLE_SECONDS"
  done
}

prune_images() {
  local image="$1" keep1="$2" keep2="$3" ref
  docker image ls --format '{{.Repository}}:{{.Tag}}' "$image" | while read -r ref; do
    case "$ref" in "$image:$keep1"|"$image:$keep2"|"$image:<none>") ;; *)
      docker image rm "$ref" > /dev/null 2>&1 && log "removed old image $ref" || true ;;
    esac
  done
}

deploy() {
  local tag="${1:-}" migrate="${2:-yes}"
  [ -n "$tag" ] || die "usage: deploy.sh deploy <tag>"
  local image current previous
  image="${APP_IMAGE:-$(env_get APP_IMAGE)}"
  [ -n "$image" ] || die "APP_IMAGE is not set (in .env or the environment)"
  current="$(env_get APP_TAG)"
  previous="$(env_get PREVIOUS_TAG)"
  log "deploying $image:$tag (current: ${current:-none})"

  ensure_image "$image:$tag"
  start_infra

  if [ "$migrate" = yes ]; then
    log "running migrations with $image:$tag"
    APP_IMAGE="$image" APP_TAG="$tag" dc run --rm --no-deps migrate \
      || die "migration failed; nothing was changed and ${current:-the old version} is serving"
  fi

  roll "$image" "$tag" "$current"

  if [ -n "$current" ] && [ "$current" != "$tag" ]; then
    env_set PREVIOUS_TAG "$current"
    previous="$current"
  fi
  printf '%s %s %s\n' "$(ts)" "$tag" "$([ "$migrate" = yes ] && echo deploy || echo rollback)" >> "$HISTORY"
  prune_images "$image" "$tag" "$previous"
  log "done: $image:$tag is live${previous:+ (rollback target: $previous)}"
}

cmd="${1:-}"
shift || true
exec 9> "$DIR/.deploy.lock"
case "$cmd" in
  deploy|rollback)
    flock -n 9 || die "another deploy is running"
    if [ "$cmd" = deploy ]; then
      deploy "${1:-}" yes
    else
      target="${1:-$(env_get PREVIOUS_TAG)}"
      [ -n "$target" ] || die "no previous release recorded; pass a tag"
      log "rolling back to $target"
      deploy "$target" no
    fi
    ;;
  status)
    echo "image:    $(env_get APP_IMAGE)"
    echo "current:  $(env_get APP_TAG)"
    echo "previous: $(env_get PREVIOUS_TAG)"
    dc ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
    ;;
  history) tail -n 20 "$HISTORY" 2> /dev/null || echo "no releases yet" ;;
  compose) dc "$@" ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
