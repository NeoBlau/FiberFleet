#!/usr/bin/env bash
# Обновление FiberFleet до последней версии из git: резервная копия → сборка → перезапуск.
set -euo pipefail
APP=/opt/fiberfleet
cd "$APP"
echo "== Резервная копия базы"
bash "$APP/deploy/backup.sh"
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
