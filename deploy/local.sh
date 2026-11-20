#!/bin/bash
# Run the SportsArc beta stack on your own machine (Linux + Docker Engine; a
# Mac with Docker Desktop works too, minus host metrics). One command:
#
#   deploy/local.sh up         build from this checkout and start everything
#                              -> http://localhost:8080, Grafana on :3001
#   deploy/local.sh tunnel     also start a public https URL (phone testing)
#   deploy/local.sh url        print the current tunnel URL
#   deploy/local.sh ps | stats | logs [service...] | otp
#   deploy/local.sh backup     take a database backup now
#   deploy/local.sh restore <file>   restore one (stops the apps meanwhile)
#   deploy/local.sh down       stop everything (data is kept)
#   deploy/local.sh destroy    stop and delete all data volumes
#   deploy/local.sh compose <args>   any docker compose command
#
# The first `up` writes deploy/.env from .env.beta.example with generated
# secrets. Edit it for Telegram alerts, Brevo, Circle and chain settings.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HERE/.env"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v docker > /dev/null || die "docker is not installed (https://docs.docker.com/engine/install/)"
docker compose version > /dev/null 2>&1 || die "the docker compose plugin is missing"

dc() { docker compose --project-directory "$HERE" -f "$HERE/compose.yml" "$@"; }

rand_hex() {
  if command -v openssl > /dev/null; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

# Set KEY=value in .env when the current value is empty.
fill() {
  local key="$1" value="$2"
  if grep -qE "^${key}=$" "$ENV_FILE"; then
    sed -i.bak "s|^${key}=$|${key}=${value}|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    say "generated $key"
  fi
}

ensure_env() {
  if [ ! -f "$ENV_FILE" ]; then
    cp "$HERE/.env.beta.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    # No Brevo key yet: print login codes to the app log instead. The app
    # only allows that outside production.
    sed -i.bak -e 's|^NODE_ENV=.*|NODE_ENV=development|' -e 's|^EMAIL_PROVIDER=.*|EMAIL_PROVIDER=console|' "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    say "wrote $ENV_FILE from .env.beta.example"
    say "login codes print to the app log (deploy/local.sh otp); to email them, set"
    say "BREVO_API_KEY and EMAIL_FROM, then EMAIL_PROVIDER=brevo and NODE_ENV=production"
  fi
  fill SESSION_SECRET "$(rand_hex 32)"
  fill POSTGRES_PASSWORD "$(rand_hex 24)"
  fill GRAFANA_ADMIN_PASSWORD "$(rand_hex 12)"
  if [ -z "$(env_get ADMIN_EMAILS)" ]; then
    say "note: ADMIN_EMAILS is empty in deploy/.env. The beta is invite-only, so put"
    say "your own email there (then deploy/local.sh up again) to sign up and invite testers."
  fi
}

env_get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }

wait_healthy() {
  local svc cid status i
  for svc in "$@"; do
    printf '    waiting for %s ' "$svc"
    for i in $(seq 1 90); do
      cid="$(dc ps -q "$svc" 2> /dev/null || true)"
      status="$( [ -n "$cid" ] && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2> /dev/null || echo starting)"
      if [ "$status" = "healthy" ]; then echo "ok"; break; fi
      if [ "$i" = 90 ]; then echo "timed out ($status)"; return 1; fi
      printf '.'; sleep 2
    done
  done
}

tunnel_url() {
  local cid url _
  for _ in $(seq 1 30); do
    cid="$(dc ps -q tunnel 2> /dev/null || true)"
    if [ -n "$cid" ]; then
      # The tunnel's own URL, not api.trycloudflare.com from an error line.
      url="$(docker logs "$cid" 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | grep -v '^https://api\.' | tail -1 || true)"
      if [ -n "$url" ]; then echo "$url"; return 0; fi
    fi
    sleep 2
  done
  return 1
}

cmd="${1:-up}"
shift || true
case "$cmd" in
  up)
    ensure_env
    say "building the app image and starting the stack"
    dc up -d --build
    wait_healthy app1 app2
    port="$(env_get HTTP_PORT)"; gport="$(env_get GRAFANA_PORT)"
    say "SportsArc:  http://localhost:${port:-8080}"
    if dc ps --services 2> /dev/null | grep -qx grafana; then
      say "Grafana:    http://localhost:${gport:-3001}  (user $(env_get GRAFANA_ADMIN_USER), password GRAFANA_ADMIN_PASSWORD in deploy/.env)"
    fi
    say "Sign-in codes: deploy/local.sh otp"
    ;;
  tunnel)
    ensure_env
    say "starting the Cloudflare quick tunnel"
    COMPOSE_PROFILES="$(env_get COMPOSE_PROFILES),tunnel" dc up -d tunnel
    if url="$(tunnel_url)"; then
      say "Public URL: $url"
      say "It changes every time the tunnel restarts. Anyone with it can reach your stack."
    else
      die "no URL yet; check: deploy/local.sh logs tunnel"
    fi
    ;;
  url)
    tunnel_url || die "no tunnel URL yet: start it with deploy/local.sh tunnel, or see deploy/local.sh logs tunnel"
    ;;
  ps) dc ps ;;
  stats) mapfile -t ids < <(dc ps -q); docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' "${ids[@]}" ;;
  logs) dc logs -f --tail=200 "$@" ;;
  otp) dc logs --no-log-prefix app1 app2 2>&1 | grep -E '^\[otp\] ' | tail -20 ;;
  backup) dc run --rm backup now ;;
  restore)
    [ $# -ge 1 ] || die "usage: deploy/local.sh restore daily/<file>.dump"
    dc stop app1 app2
    dc run --rm backup restore "$1" --yes
    dc start app1 app2
    ;;
  # --profile '*' covers every profile; a named --profile would replace
  # COMPOSE_PROFILES from .env and leave those services running.
  down) dc --profile '*' down ;;
  destroy)
    read -r -p "Delete the database, uploads, logs and dashboards data (deploy/backups is kept)? Type yes: " ok
    [ "$ok" = yes ] || die "aborted"
    dc --profile '*' down -v
    ;;
  compose) dc "$@" ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
