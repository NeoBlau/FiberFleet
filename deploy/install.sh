#!/usr/bin/env bash
# Установка FiberFleet на Ubuntu 22.04/24.04 или Debian 12 (сервер с root-доступом).
#
#   sudo bash install.sh fleet.example.ru admin@example.ru
#   sudo bash install.sh auto        # без своего домена: адрес <IP>.sslip.io + HTTPS
#
# Аргументы: домен (A-запись должна уже указывать на IP сервера) и e-mail для Let's Encrypt.
# Без домена (только по IP, без HTTPS):  sudo bash install.sh
set -euo pipefail

DOMAIN=${1:-}
EMAIL=${2:-}
APP=/opt/fiberfleet
DATA=/var/lib/fiberfleet
REPO=${FF_REPO:-https://github.com/NeoBlau/FiberFleet.git}
BRANCH=${FF_BRANCH:-claude/fiberfleet-app}
SRC_DIR=$(cd "$(dirname "$0")/.." && pwd)

[ "$(id -u)" -eq 0 ] || { echo "Запустите через sudo"; exit 1; }

# Своего домена нет: «auto» → бесплатное имя <ip-через-дефисы>.sslip.io (указывает на IP сервера), с HTTPS
if [ "$DOMAIN" = "auto" ]; then
  PUBIP=$(curl -fsS4 --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')
  DOMAIN="$(echo "$PUBIP" | tr '.' '-').sslip.io"
  echo "   домен: $DOMAIN"
fi

echo "== 1/8 Системные пакеты"
apt-get update -y
apt-get install -y ca-certificates curl git nginx sqlite3 ufw build-essential python3

echo "== 2/8 Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "== 3/8 Пользователь и каталоги"
id fiberfleet >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin fiberfleet
mkdir -p "$DATA" /var/backups/fiberfleet
if [ -f "$SRC_DIR/package.json" ] && [ "$SRC_DIR" != "$APP" ]; then
  echo "   копирую программу из $SRC_DIR"
  mkdir -p "$APP"
  cp -a "$SRC_DIR"/. "$APP"/
  rm -rf "$APP/node_modules" "$APP/client/node_modules" "$APP/data"
elif [ ! -d "$APP/.git" ]; then
  git clone -b "$BRANCH" "$REPO" "$APP"
fi
chown -R fiberfleet:fiberfleet "$APP" "$DATA"

echo "== 4/8 Сборка"
cd "$APP"
runuser -u fiberfleet -- npm ci --omit=dev
runuser -u fiberfleet -- npm --prefix client ci
runuser -u fiberfleet -- npm --prefix client run build

echo "== 5/8 Настройки"
if [ ! -f /etc/fiberfleet.env ]; then
  PASS=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 14)
  cat > /etc/fiberfleet.env <<ENV
NODE_ENV=production
PORT=8080
FF_DATA_DIR=$DATA
FF_ADMIN_PASSWORD=$PASS
FF_DEMO_USERS=0
ENV
  chmod 600 /etc/fiberfleet.env
  echo "$PASS" > /root/fiberfleet-admin-password.txt
  chmod 600 /root/fiberfleet-admin-password.txt
fi

echo "== 6/8 Служба systemd"
cp "$APP/deploy/fiberfleet.service" /etc/systemd/system/fiberfleet.service
systemctl daemon-reload
systemctl enable --now fiberfleet
sleep 2
curl -fsS http://127.0.0.1:8080/api/health >/dev/null && echo "   сервис запущен"

echo "== 7/8 nginx и HTTPS"
sed "s/fleet.example.ru/${DOMAIN:-_}/" "$APP/deploy/nginx-fiberfleet.conf" > /etc/nginx/sites-available/fiberfleet
ln -sf /etc/nginx/sites-available/fiberfleet /etc/nginx/sites-enabled/fiberfleet
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
if [ -n "$DOMAIN" ]; then
  apt-get install -y certbot python3-certbot-nginx
  if [ -n "$EMAIL" ]; then MAILOPT=(-m "$EMAIL"); else MAILOPT=(--register-unsafely-without-email); fi
  certbot --nginx -d "$DOMAIN" "${MAILOPT[@]}" --agree-tos --redirect -n
fi

echo "== 8/8 Ежедневная резервная копия (03:30)"
chmod +x "$APP/deploy/"*.sh
echo "30 3 * * * root FF_DB=$DATA/fiberfleet.db bash $APP/deploy/backup.sh >/var/log/fiberfleet-backup.log 2>&1" > /etc/cron.d/fiberfleet-backup

IP=$(hostname -I | awk '{print $1}')
echo
echo "======================================================"
echo " FiberFleet установлен"
echo " Адрес:   ${DOMAIN:+https://$DOMAIN}${DOMAIN:-http://$IP}"
echo " Логин:   admin"
echo " Пароль:  $(cat /root/fiberfleet-admin-password.txt 2>/dev/null || echo 'см. /etc/fiberfleet.env')"
echo " Смените пароль после первого входа (клик по имени внизу меню)."
echo "======================================================"
