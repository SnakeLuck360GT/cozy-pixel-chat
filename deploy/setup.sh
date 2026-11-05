#!/usr/bin/env bash
# Sets up chat on an Ubuntu server (it can share one with other sites). Run
# it from the project folder on the server:
#
#   sudo DOMAIN=chat.example.com CONTENT_DOMAIN=chat-files.example.com ADMIN=yourname bash deploy/setup.sh
#
# DOMAIN is the app; CONTENT_DOMAIN serves attachments. Both need DNS
# records pointing at this server. ADMIN creates the owner account and
# prints its password; leave it out on later runs. Running it again updates
# the code and restarts, keeping accounts, messages, files and /etc/chat.env.
#
# It also sets up coturn, a TURN relay for calls between people who can't
# connect directly (common on mobile data). That needs UDP 3478 and
# 49160-49200 (and TCP 3478) open in the cloud provider's firewall too.
set -euo pipefail

: "${DOMAIN:?Set DOMAIN, e.g. sudo DOMAIN=chat.example.com CONTENT_DOMAIN=chat-files.example.com bash deploy/setup.sh}"
: "${CONTENT_DOMAIN:?Set CONTENT_DOMAIN, the subdomain that serves attachments, e.g. chat-files.example.com}"
[ "$(id -u)" -eq 0 ] || { echo "Run this with sudo." >&2; exit 1; }

SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/chat
DATA=/var/lib/chat
ENV_FILE=/etc/chat.env
export DEBIAN_FRONTEND=noninteractive

echo "==> Checking Node.js"
# node:sqlite works without a flag from Node 22.13.
if ! command -v node >/dev/null || ! node -e 'require("node:sqlite")' 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Installing Caddy"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
    gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

echo "==> Installing coturn (the call relay)"
command -v turnserver >/dev/null || apt-get install -y coturn

# Some cloud Ubuntu images (Oracle's, for one) reject everything but SSH; the provider's
# security list also needs these ports open.
echo "==> Opening ports"
open_port() {
  iptables -C INPUT -p "$1" --dport "$2" -m state --state NEW -j ACCEPT 2>/dev/null ||
    iptables -I INPUT 1 -p "$1" --dport "$2" -m state --state NEW -j ACCEPT
}
open_port tcp 80
open_port tcp 443
open_port udp 3478
open_port tcp 3478
open_port udp 49160:49200
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save; fi

echo "==> Installing the app in $APP"
id chat >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin chat
mkdir -p "$APP" "$DATA/files"
rm -rf "$APP/public" "$APP/lib"
cp -r "$SRC/server.js" "$SRC/manage.js" "$SRC/package.json" "$SRC/package-lock.json" "$SRC/lib" "$SRC/public" "$APP/"
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund)
chown -R chat:chat "$DATA"
chmod 700 "$DATA"

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
PUBLIC_URL=https://$DOMAIN
CONTENT_URL=https://$CONTENT_DOMAIN
DATA_DIR=$DATA
PORT=3002
# Signs attachment links. Changing it only breaks links that are already open.
SIGNING_SECRET=$(openssl rand -hex 32)
# Calls. TURN_SECRET is shared with coturn (/etc/turnserver.conf).
STUN_URLS="stun:$DOMAIN:3478 stun:stun.l.google.com:19302"
TURN_URLS="turn:$DOMAIN:3478?transport=udp turn:$DOMAIN:3478?transport=tcp"
TURN_SECRET=$(openssl rand -hex 32)
# Starting limit. Change it later on the admin page.
MAX_SIZE_MB=100
ENV
  chmod 600 "$ENV_FILE"
fi
sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|; s|^CONTENT_URL=.*|CONTENT_URL=https://$CONTENT_DOMAIN|" "$ENV_FILE"

echo "==> Configuring coturn"
TURN_SECRET=$(grep '^TURN_SECRET=' "$ENV_FILE" | cut -d= -f2)
PRIVATE_IP=$(hostname -I | awk '{print $1}')
PUBLIC_IP=$(curl -fsS https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)
[ -n "$PUBLIC_IP" ] || PUBLIC_IP=$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}')
cat > /etc/turnserver.conf <<TURN
# Written by chat's deploy/setup.sh. A relay for calls only: logins are
# short-lived and made by the chat server with the shared secret.
listening-port=3478
external-ip=$PUBLIC_IP/$PRIVATE_IP
realm=$DOMAIN
use-auth-secret
static-auth-secret=$TURN_SECRET
min-port=49160
max-port=49200
fingerprint
no-cli
no-tls
no-dtls
no-multicast-peers
user-quota=12
total-quota=60
stale-nonce=600
syslog
# Never relay into this server or the private network behind it.
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
TURN
chmod 640 /etc/turnserver.conf
chown root:turnserver /etc/turnserver.conf 2>/dev/null || true
[ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
systemctl enable coturn
systemctl restart coturn

# Lets you manage accounts from SSH: sudo chat-admin add-user <name> [--admin]
cat > /usr/local/bin/chat-admin <<'WRAPPER'
#!/usr/bin/env bash
set -a; . /etc/chat.env; set +a
cd /opt/chat && exec sudo -E -u chat /usr/bin/node --disable-warning=ExperimentalWarning manage.js "$@"
WRAPPER
chmod 755 /usr/local/bin/chat-admin

if [ -n "${ADMIN:-}" ]; then
  echo "==> Creating owner account $ADMIN"
  /usr/local/bin/chat-admin add-user "$ADMIN" --owner
fi

echo "==> Starting the server"
cp "$SRC/deploy/chat.service" /etc/systemd/system/chat.service
systemctl daemon-reload
systemctl enable chat
systemctl restart chat

# Each site keeps its own file in /etc/caddy/sites, so sites on the same
# server don't overwrite each other.
echo "==> Configuring Caddy for $DOMAIN and $CONTENT_DOMAIN"
mkdir -p /etc/caddy/sites
sed -e "s/{{CONTENT_DOMAIN}}/$CONTENT_DOMAIN/g" -e "s/{{DOMAIN}}/$DOMAIN/g" "$SRC/deploy/Caddyfile" > /etc/caddy/sites/chat.caddy
grep -q '^import /etc/caddy/sites/\*.caddy' /etc/caddy/Caddyfile 2>/dev/null ||
  echo "import /etc/caddy/sites/*.caddy" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy || systemctl restart caddy

echo
echo "Done. Open https://$DOMAIN"
echo "If it doesn't load, check that $DOMAIN and $CONTENT_DOMAIN point at this server."
echo "For calls over mobile data, open UDP 3478, TCP 3478 and UDP 49160-49200 in your cloud provider's firewall too."
