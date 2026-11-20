#!/bin/bash
# One-time setup of a fresh Ubuntu 22.04/24.04 VPS for the SportsArc beta.
# Run as root from a copy of the repo's deploy/ directory:
#
#   scp -r deploy root@<vps>:/root/sportsarc-deploy
#   ssh root@<vps> 'bash /root/sportsarc-deploy/bootstrap-vps.sh \
#       --ssh-key "ssh-ed25519 AAAA... github-actions" --domain beta.example.com'
#
# Safe to run again: every step checks first and says what it did.
#   1. Docker Engine + compose plugin (Docker's apt repository), log rotation
#      for container logs in /etc/docker/daemon.json
#   2. a `deploy` user (docker group) that logs in with the given SSH key(s)
#   3. ufw: deny incoming except 22 (and sshd's own port), 80, 443 (tcp+udp)
#   4. unattended security updates
#   5. a 2 GB swap file when the machine has none (small VPS headroom)
#   6. /opt/sportsarc owned by deploy, with the stack files and a .env
#      (mode 600) whose secrets are generated here and never leave the VPS
#   7. logrotate for /opt/sportsarc/*.log
#
# Options:
#   --ssh-key "<public key>"     repeatable; appended to deploy's authorized_keys
#   --ssh-key-file <path>        same, from a file
#   --domain <name>              fill in DOMAIN/SITE_ADDRESS in a new .env
#   --email <address>            ACME account email for Let's Encrypt notices
#   --no-swap                    skip the swap file

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR=/opt/sportsarc
DEPLOY_USER=deploy
KEYS=()
DOMAIN=""
EMAIL=""
SWAP=yes

step() { printf '\n\033[1m[%s]\033[0m %s\n' "$1" "$2"; }
did() { printf '  changed: %s\n' "$*"; }
same() { printf '  ok:      %s\n' "$*"; }
warn() { printf '  WARNING: %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ssh-key) KEYS+=("$2"); shift ;;
    --ssh-key-file) [ -f "$2" ] || die "no such file: $2"; while IFS= read -r k; do [ -n "$k" ] && KEYS+=("$k"); done < "$2"; shift ;;
    --domain) DOMAIN="$2"; shift ;;
    --email) EMAIL="$2"; shift ;;
    --no-swap) SWAP=no ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

[ "$(id -u)" = 0 ] || die "run as root (sudo bash $0 ...)"
[ -f "$HERE/.env.beta.example" ] || die "run this from a copy of the repo's deploy/ directory (needs .env.beta.example next to it)"
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in
  ubuntu:22.04|ubuntu:24.04) ;;
  *) warn "tested on Ubuntu 22.04 and 24.04; this is ${PRETTY_NAME:-unknown}" ;;
esac
export DEBIAN_FRONTEND=noninteractive

# ── 1. Docker ──────────────────────────────────────────────────────────
step 1 "Docker Engine and the compose plugin"
if command -v docker > /dev/null && docker compose version > /dev/null 2>&1; then
  same "$(docker --version); $(docker compose version)"
else
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg openssl > /dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/ubuntu/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin > /dev/null
  did "installed $(docker --version)"
fi
systemctl enable --now docker > /dev/null 2>&1 && same "docker service enabled and running"

DAEMON=/etc/docker/daemon.json
if [ ! -f "$DAEMON" ]; then
  mkdir -p /etc/docker
  cat > "$DAEMON" << 'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" }
}
EOF
  systemctl restart docker
  did "container log rotation in $DAEMON (10 MB x 5 per container)"
elif grep -q '"max-size"' "$DAEMON"; then
  same "container log rotation already set in $DAEMON"
else
  warn "$DAEMON exists without log rotation; compose.yml still rotates every service's logs"
fi

# ── 2. deploy user ─────────────────────────────────────────────────────
step 2 "the $DEPLOY_USER user"
if id "$DEPLOY_USER" > /dev/null 2>&1; then
  same "user $DEPLOY_USER exists"
else
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
  did "created user $DEPLOY_USER (no password; SSH keys only)"
fi
if id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -qx docker; then
  same "$DEPLOY_USER is in the docker group"
else
  usermod -aG docker "$DEPLOY_USER"
  did "added $DEPLOY_USER to the docker group (docker access is root-equivalent: guard this key)"
fi
HOME_DIR="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$HOME_DIR/.ssh"
AUTH="$HOME_DIR/.ssh/authorized_keys"
touch "$AUTH"; chmod 600 "$AUTH"; chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH"
if [ ${#KEYS[@]} -eq 0 ]; then
  if [ -s "$AUTH" ]; then same "authorized_keys has $(grep -c . "$AUTH") key(s)"
  else warn "no --ssh-key given and $AUTH is empty: GitHub Actions cannot log in yet"; fi
fi
for key in "${KEYS[@]}"; do
  case "$key" in ssh-*|ecdsa-*|sk-*) ;; *) die "that does not look like an SSH public key: ${key:0:20}..." ;; esac
  if grep -qxF "$key" "$AUTH"; then
    same "key already authorized: ${key:0:30}..."
  else
    echo "$key" >> "$AUTH"
    did "authorized key ${key:0:30}..."
  fi
done

# ── 3. firewall ────────────────────────────────────────────────────────
step 3 "firewall (ufw): 22, 80, 443 only"
command -v ufw > /dev/null || { apt-get update -qq; apt-get install -y -qq ufw > /dev/null; did "installed ufw"; }
SSH_PORTS="22"
if command -v sshd > /dev/null; then
  extra="$(sshd -T 2> /dev/null | awk '$1=="port"{print $2}' | grep -vx 22 || true)"
  [ -n "$extra" ] && SSH_PORTS="22 $extra" && warn "sshd also listens on $extra; allowing it too"
fi
before="$(ufw status verbose 2> /dev/null || true)"
ufw default deny incoming > /dev/null
ufw default allow outgoing > /dev/null
for p in $SSH_PORTS; do ufw allow "$p/tcp" comment "ssh" > /dev/null; done
ufw allow 80/tcp comment "http (Caddy)" > /dev/null
ufw allow 443/tcp comment "https (Caddy)" > /dev/null
ufw allow 443/udp comment "http/3 (Caddy)" > /dev/null
ufw --force enable > /dev/null
after="$(ufw status verbose)"
if [ "$before" = "$after" ]; then same "ufw active: allow ${SSH_PORTS// /,}/tcp, 80/tcp, 443/tcp, 443/udp"
else did "ufw active: allow ${SSH_PORTS// /,}/tcp, 80/tcp, 443/tcp, 443/udp; deny the rest"; fi
echo "  note:    Docker publishes ports past ufw; the stack publishes only 80/443 (Grafana is on 127.0.0.1)."
echo "  note:    a provider firewall (Hostinger's hPanel) must also allow 22, 80 and 443."

# ── 4. unattended upgrades ─────────────────────────────────────────────
step 4 "unattended security updates"
if ! dpkg -s unattended-upgrades > /dev/null 2>&1; then
  apt-get update -qq; apt-get install -y -qq unattended-upgrades > /dev/null
  did "installed unattended-upgrades"
fi
AUTO=/etc/apt/apt.conf.d/20auto-upgrades
WANT='APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";'
if [ -f "$AUTO" ] && [ "$(cat "$AUTO")" = "$WANT" ]; then
  same "daily security updates enabled ($AUTO)"
else
  printf '%s\n' "$WANT" > "$AUTO"
  did "daily security updates enabled ($AUTO); reboots stay manual"
fi
systemctl enable --now unattended-upgrades > /dev/null 2>&1 || true

# ── 5. swap ────────────────────────────────────────────────────────────
step 5 "swap"
if [ "$SWAP" = no ]; then
  same "skipped (--no-swap)"
elif [ -n "$(swapon --show --noheadings 2> /dev/null)" ]; then
  same "swap present: $(swapon --show --noheadings | awk '{print $1" "$3}' | tr '\n' ' ')"
else
  fallocate -l 2G /swapfile 2> /dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile; mkswap /swapfile > /dev/null; swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  did "2 GB swap file at /swapfile"
fi

# ── 6. /opt/sportsarc ──────────────────────────────────────────────────
step 6 "$APP_DIR"
install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"
install -d -m 700 -o root -g root "$APP_DIR/backups"
# The stack files; GitHub Actions refreshes them on every deploy. .env is
# never overwritten.
for f in compose.yml Caddyfile deploy.sh .env.beta.example; do
  install -m 644 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$HERE/$f" "$APP_DIR/$f"
done
chmod 755 "$APP_DIR/deploy.sh"
cp -R "$HERE/backup" "$HERE/observability" "$APP_DIR/"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/backup" "$APP_DIR/observability"
same "stack files copied (compose.yml, Caddyfile, deploy.sh, backup/, observability/)"

ENV="$APP_DIR/.env"
rand() {
  if command -v openssl > /dev/null; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}
set_var() { # set_var KEY VALUE: replace the KEY= line in .env
  awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$ENV" > "$ENV.tmp" && mv "$ENV.tmp" "$ENV"
}
if [ -f "$ENV" ]; then
  same ".env exists; left as is (secrets untouched)"
else
  cp "$HERE/.env.beta.example" "$ENV"
  set_var COMPOSE_PROJECT_NAME sportsarc
  set_var SESSION_SECRET "$(rand 32)"
  set_var POSTGRES_PASSWORD "$(rand 24)"
  set_var GRAFANA_ADMIN_PASSWORD "$(rand 12)"
  set_var HTTP_PORT 80
  set_var HTTPS_PORT 443
  set_var COOKIE_SECURE 1
  set_var NODE_ENV production
  set_var APP_TAG ""
  if [ -n "$DOMAIN" ]; then
    set_var SITE_ADDRESS "$DOMAIN"
    printf 'DOMAIN=%s\n' "$DOMAIN" >> "$ENV"
  else
    warn "no --domain: SITE_ADDRESS stays :80 (plain http) until you set it in $ENV"
  fi
  [ -n "$EMAIL" ] && set_var CADDY_GLOBAL_OPTIONS "email $EMAIL"
  did "wrote $ENV with generated SESSION_SECRET, POSTGRES_PASSWORD and GRAFANA_ADMIN_PASSWORD"
  echo "  next:    fill in BREVO_API_KEY, EMAIL_FROM, ADMIN_EMAILS, TELEGRAM_* (and chain settings) in $ENV"
fi
chown "$DEPLOY_USER:$DEPLOY_USER" "$ENV"; chmod 600 "$ENV"
same ".env is mode 600, owned by $DEPLOY_USER"

# ── 7. logrotate ───────────────────────────────────────────────────────
step 7 "log rotation"
LR=/etc/logrotate.d/sportsarc
WANT_LR="$APP_DIR/*.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  copytruncate
  su $DEPLOY_USER $DEPLOY_USER
}"
if [ -f "$LR" ] && [ "$(cat "$LR")" = "$WANT_LR" ]; then
  same "$LR"
else
  printf '%s\n' "$WANT_LR" > "$LR"
  did "$LR (release log; container logs rotate through Docker)"
fi

printf '\n\033[1mDone.\033[0m Next (deploy/README.md, "Move to the VPS"):\n'
echo "  1. edit $ENV (Brevo, ADMIN_EMAILS, Telegram, chain settings)"
echo "  2. add the GitHub secrets VPS_HOST, VPS_USER=$DEPLOY_USER, VPS_SSH_KEY, VPS_SSH_KNOWN_HOSTS"
echo "     known hosts line: ssh-keyscan -t ed25519 <this server's address>, checked against:"
HOSTKEY=/etc/ssh/ssh_host_ed25519_key.pub
if [ -f "$HOSTKEY" ]; then echo "     $(ssh-keygen -lf "$HOSTKEY")"; fi
echo "  3. push to main (or run the Deploy workflow) for the first deploy"
