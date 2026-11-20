#!/bin/sh
# Grafana entrypoint wrapper: writes the alert contact point from .env, then
# starts Grafana. Grafana rejects a provisioned Telegram/Discord/email
# receiver with empty settings, so the file is generated for whichever
# channel is configured:
#   ALERT_CHANNEL=telegram|email|discord, or unset to pick the first one
#   whose variables are filled in (Telegram, then Discord, then email).
# With none configured, alerts still show in Grafana (Alerting > Alert rules)
# and delivery goes to a placeholder webhook that fails quietly.
# One receiver uid for every channel, so switching replaces it in place.
set -eu

SRC=/etc/sportsarc/provisioning
DST=/tmp/provisioning
rm -rf "$DST"
cp -R "$SRC" "$DST"
mkdir -p "$DST/alerting" "$DST/plugins" "$DST/notifiers"
out="$DST/alerting/contact-points.yml"

# Values are written into the file as YAML single-quoted strings. Grafana's
# own $VAR expansion would turn a numeric chat ID into a number, which it
# then rejects. The file lives only inside this container.
yq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

channel="${ALERT_CHANNEL:-}"
if [ -z "$channel" ]; then
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then channel=telegram
  elif [ -n "${DISCORD_WEBHOOK_URL:-}" ]; then channel=discord
  elif [ -n "${ALERT_EMAIL_TO:-}" ]; then channel=email
  else channel=none
  fi
fi

{
  echo "apiVersion: 1"
  echo "contactPoints:"
  echo "  - orgId: 1"
  echo "    name: sportsarc-alerts"
  echo "    receivers:"
  case "$channel" in
    telegram)
      echo "      - uid: sportsarc-receiver"
      echo "        type: telegram"
      echo "        settings:"
      echo "          bottoken: $(yq "$TELEGRAM_BOT_TOKEN")"
      echo "          chatid: $(yq "$TELEGRAM_CHAT_ID")"
      echo "          disable_web_page_preview: true"
      ;;
    discord)
      echo "      - uid: sportsarc-receiver"
      echo "        type: discord"
      echo "        settings:"
      echo "          url: $(yq "$DISCORD_WEBHOOK_URL")"
      ;;
    email)
      echo "      - uid: sportsarc-receiver"
      echo "        type: email"
      echo "        settings:"
      echo "          addresses: $(yq "$ALERT_EMAIL_TO")"
      echo "          singleEmail: true"
      ;;
    *)
      echo "      - uid: sportsarc-receiver"
      echo "        type: webhook"
      echo "        settings:"
      echo "          url: http://127.0.0.1:9/alerts-not-configured"
      ;;
  esac
} > "$out"
echo "[grafana] alert contact point: $channel"

export GF_PATHS_PROVISIONING="$DST"
exec /run.sh "$@"
