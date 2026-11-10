#!/usr/bin/env bash
# Quick update of an already-installed server with new code. Run as root:
#   bash deploy/update.sh            (from inside the new source folder)
# Used by the GitHub deploy (through /usr/local/sbin/mtg-deploy) and safe to run by hand.
# Never touches data/ (invites, decks, config, host password), models/ or bin/.
# The app (and the video calls inside it) is only restarted when server code, packages or the
# service file changed. Page-only changes are copied in place, so games in progress aren't
# interrupted; players get the new page when they reload.
# If the app doesn't answer after a restart, the previous code is put back.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR=/opt/mtg-table
APP_USER=mtg
PREV=/var/lib/mtg-deploy/previous
DOMAIN="$(cat /etc/mtg-table/domain)"
SYNC=(rsync -a --delete --exclude node_modules --exclude bin --exclude data --exclude models --exclude .git)

log() { echo "[deploy] $*"; }

healthy() {
  for _ in $(seq 1 30); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/)" = 200 ] && systemctl is-active --quiet mtg-table; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Caddy's access log: new files land in group $APP_USER (setgid folder), so the app can read them.
caddy_logs() {
  install -d -o caddy -g "$APP_USER" -m 2750 /var/log/caddy
  chgrp "$APP_USER" /var/log/caddy/* 2>/dev/null || true
}

# Web server and fail2ban settings: both reload without dropping anyone.
install_extras() {
  caddy_logs
  install -m 644 deploy/fail2ban/filter.conf /etc/fail2ban/filter.d/mtg-host.conf
  install -m 644 deploy/fail2ban/jail.conf /etc/fail2ban/jail.d/mtg-host.conf
  sed "s/{{DOMAIN}}/$DOMAIN/" deploy/Caddyfile > /etc/caddy/Caddyfile
  systemctl reload caddy
  systemctl reload-or-restart fail2ban
}

install_code() { # $1 = source folder
  "${SYNC[@]}" "$1"/ "$APP_DIR"/
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  cd "$APP_DIR"
  local lock
  lock=$(sha256sum package-lock.json | cut -d' ' -f1)
  if [ "$(cat node_modules/.mtg-lock 2>/dev/null)" != "$lock" ]; then
    log "packages changed, installing"
    sudo -u "$APP_USER" npm ci --omit=dev --no-audit --no-fund --loglevel=error
    echo "$lock" | sudo -u "$APP_USER" tee node_modules/.mtg-lock >/dev/null
  fi
  sudo -u "$APP_USER" node scripts/setup.js >/dev/null
  install -m 644 deploy/mtg-table.service /etc/systemd/system/mtg-table.service
  systemctl daemon-reload
  install_extras
  systemctl restart mtg-table
}

# Which files differ (by content), and does any of them need the app restarted?
changed=$(rsync -rlci --delete --dry-run --exclude node_modules --exclude bin --exclude data --exclude models --exclude .git   "$SRC_DIR"/ "$APP_DIR"/ | awk '{print $2}')
if [ -z "$changed" ]; then
  log "nothing changed"
  exit 0
fi
if ! grep -qE '^(server/|scripts/|package(-lock)?\.json$|deploy/mtg-table\.service$)' <<<"$changed"; then
  log "only page or deploy files changed: copying them in, no restart (calls keep going)"
  "${SYNC[@]}" "$SRC_DIR"/ "$APP_DIR"/
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  cd "$APP_DIR"
  install_extras
  if healthy; then log "ok: the app is answering"; exit 0; fi
  log "the app is not answering; check: journalctl -u mtg-table"
  exit 1
fi
log "server code changed: restarting the app (calls in progress will reconnect)"

log "saving the current version"
mkdir -p "$PREV"
"${SYNC[@]}" "$APP_DIR"/ "$PREV"/

log "installing $(cat "$SRC_DIR/.deploy-version" 2>/dev/null || echo 'new code')"
install_code "$SRC_DIR"
if healthy; then
  log "ok: the app is answering"
  exit 0
fi

log "the app did not come up; recent log:"
journalctl -u mtg-table -n 30 --no-pager | grep -v '\[livekit\]' || true
log "rolling back to the previous version"
install_code "$PREV"
if healthy; then log "rolled back; the previous version is running"; else log "rollback also failed, check: journalctl -u mtg-table"; fi
exit 1
