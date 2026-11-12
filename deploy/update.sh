#!/usr/bin/env bash
# Обновление FiberFleet: резервная копия базы и текущего кода → обновление → сборка → перезапуск.
set -euo pipefail
APP=/opt/fiberfleet
cd "$APP"
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Ошибка: /opt/fiberfleet не является Git-клоном. Этот скрипт работает для установки через git clone." >&2
  exit 1
fi
echo "== Резервная копия базы"
bash "$APP/deploy/backup.sh"
BACKUP=$(find /var/backups/fiberfleet -maxdepth 1 -type f -name 'fiberfleet_*.db.gz' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
test -n "$BACKUP" && test -s "$BACKUP"
gzip -t "$BACKUP"
echo "Проверена копия базы: $BACKUP"
echo "== Снимок текущей версии в orig"
STAMP=$(date +%Y-%m-%d_%H%M%S)
ORIG="$APP/orig/$STAMP"
mkdir -p "$ORIG"
tar -C "$APP" --exclude='./.git' --exclude='./orig' --exclude='./node_modules' \
  --exclude='./client/node_modules' --exclude='./data' -cf - . | tar -C "$ORIG" -xf -
chown -R fiberfleet:fiberfleet "$ORIG"
echo "Текущие файлы сохранены: $ORIG"
echo "== Получение обновлений"
runuser -u fiberfleet -- git pull --ff-only
echo "== Установка зависимостей и сборка"
runuser -u fiberfleet -- npm ci --omit=dev
runuser -u fiberfleet -- npm --prefix client ci
runuser -u fiberfleet -- npm --prefix client run build
echo "== Перезапуск"
systemctl restart fiberfleet
sleep 2
curl -fsS http://127.0.0.1:8080/api/health && echo && echo "Готово."
