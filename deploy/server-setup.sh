#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu 22.04 / 24.04 server (Hetzner, DigitalOcean, etc.).
# Run as root:  bash server-setup.sh yourdomain.com
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then echo "Usage: bash server-setup.sh yourdomain.com"; exit 1; fi

echo "== Installing Docker =="
apt-get update -y
apt-get install -y ca-certificates curl ufw
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

echo "== Firewall: SSH, HTTP, HTTPS only =="
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "== Site folder =="
mkdir -p /srv/revx
cd /srv/revx
if [ ! -f .env ]; then
  cat > .env <<EOF
DOMAIN=${DOMAIN}
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
EOF
fi

echo "== Nightly backup of the data folder (kept 14 days) =="
cat > /etc/cron.daily/revx-backup <<'EOF'
#!/bin/sh
/srv/revx/deploy/backup.sh >/dev/null 2>&1
EOF
chmod +x /etc/cron.daily/revx-backup

echo
echo "Server is ready. Now upload the site into /srv/revx (see DEPLOY.md), then run:"
echo "  cd /srv/revx && docker compose up -d --build"
