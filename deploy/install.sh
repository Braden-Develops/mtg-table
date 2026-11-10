#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server (ARM or x86) for MTG Table.
# Run as the default sudo user from inside the copied app folder:
#   sudo bash deploy/install.sh mtg.example.com
# Re-running is safe. Installs: Node 22, Caddy (HTTPS from Let's Encrypt), LiveKit, a firewall,
# automatic security updates, fail2ban, and a systemd service that keeps the app running.
set -euo pipefail

DOMAIN="${1:?usage: sudo bash deploy/install.sh <domain>}"
APP_USER=mtg
APP_DIR=/opt/mtg-table
LIVEKIT_VERSION=1.13.11
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

case "$(uname -m)" in
  aarch64) LK_ARCH=arm64 ;;
  x86_64) LK_ARCH=amd64 ;;
  *) echo "Unsupported CPU $(uname -m)"; exit 1 ;;
esac

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https \
  unattended-upgrades fail2ban iptables-persistent rsync

if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

echo "== automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== SSH: keys only, no root login"
cat > /etc/ssh/sshd_config.d/90-mtg.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
systemctl reload ssh || systemctl reload sshd || true

echo "== firewall (Oracle's Ubuntu image blocks everything but SSH with iptables)"
# Insert our rules before Oracle's final REJECT rule, once.
for rule in "-p tcp --dport 80" "-p tcp --dport 443" "-p tcp --dport 7881" "-p udp --dport 7882"; do
  # shellcheck disable=SC2086
  iptables -C INPUT $rule -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null && continue
  reject=$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')
  if [ -n "$reject" ]; then
    # shellcheck disable=SC2086
    iptables -I INPUT "$reject" $rule -m conntrack --ctstate NEW -j ACCEPT
  else
    # shellcheck disable=SC2086
    iptables -A INPUT $rule -m conntrack --ctstate NEW -j ACCEPT
  fi
done
netfilter-persistent save

echo "== app user and files"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/mtg --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
rsync -a --delete --exclude node_modules --exclude bin --exclude data --exclude models --exclude .git "$SRC_DIR"/ "$APP_DIR"/
mkdir -p "$APP_DIR/data" "$APP_DIR/bin" "$APP_DIR/models" /etc/mtg-table
echo "$DOMAIN" > /etc/mtg-table/domain
[ -d "$SRC_DIR/data" ] && rsync -a --ignore-existing "$SRC_DIR/data"/ "$APP_DIR/data"/
[ -d "$SRC_DIR/models" ] && rsync -a "$SRC_DIR/models"/ "$APP_DIR/models"/
if [ ! -x "$APP_DIR/bin/livekit-server" ] || ! "$APP_DIR/bin/livekit-server" --version | grep -q "$LIVEKIT_VERSION"; then
  curl -fsSL "https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_${LK_ARCH}.tar.gz" \
    | tar xz -C "$APP_DIR/bin" livekit-server
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --omit=dev --no-audit --no-fund
sha256sum package-lock.json | cut -d' ' -f1 | sudo -u "$APP_USER" tee node_modules/.mtg-lock >/dev/null
sudo -u "$APP_USER" node scripts/setup.js --domain "$DOMAIN"

echo "== fail2ban rule for host-page logins"
install -m 644 "$APP_DIR/deploy/fail2ban/filter.conf" /etc/fail2ban/filter.d/mtg-host.conf
install -m 644 "$APP_DIR/deploy/fail2ban/jail.conf" /etc/fail2ban/jail.d/mtg-host.conf
systemctl enable fail2ban
systemctl reload-or-restart fail2ban

echo "== deploy command for GitHub (root-owned so the app user can't change it)"
install -o root -g root -m 755 "$APP_DIR/deploy/mtg-deploy" /usr/local/sbin/mtg-deploy

echo "== Caddy (HTTPS)"
sed "s/{{DOMAIN}}/$DOMAIN/" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

echo "== service"
cp "$APP_DIR/deploy/mtg-table.service" /etc/systemd/system/mtg-table.service
systemctl daemon-reload
systemctl enable mtg-table
systemctl restart mtg-table

cat <<EOF

Done. The site will be at https://$DOMAIN once DNS points here.
Set the host password:  sudo -u $APP_USER node $APP_DIR/scripts/host-password.js && sudo systemctl restart mtg-table
Logs:                   journalctl -u mtg-table -f
EOF
