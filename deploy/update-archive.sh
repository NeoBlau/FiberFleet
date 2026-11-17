#!/usr/bin/env bash
# Обновление установки FiberFleet без .git. Конфигурация и рабочая база не заменяются.
# От root: bash update-archive.sh [полный SHA коммита]
set -Eeuo pipefail
APP=${FF_UPDATE_APP:-/opt/fiberfleet}
ENV_FILE=${FF_UPDATE_ENV:-/etc/fiberfleet.env}
BACKUPS=${FF_UPDATE_BACKUPS:-/var/backups/fiberfleet}
REV=${1:-a04cb0f4655f09e74ffd6a96cef8388022d018a4}
[[ $(id -u) == 0 ]] || { echo 'Запустите от root.' >&2; exit 1; }
[[ $REV =~ ^[0-9a-f]{40}$ ]] || { echo 'Нужен полный SHA коммита.' >&2; exit 1; }
[[ -d $APP && -f $APP/package.json && -f $ENV_FILE ]] || { echo 'Не найдены программа или файл настроек.' >&2; exit 1; }
for tool in curl tar npm node sqlite3 runuser systemctl flock; do command -v "$tool" >/dev/null; done
exec 9>/run/lock/fiberfleet-update.lock
flock -n 9 || { echo 'Другое обновление уже выполняется.' >&2; exit 1; }
[[ $(systemctl show fiberfleet --property=WorkingDirectory --value) == "$APP" ]] || { echo 'Рабочая папка службы отличается; обновление остановлено.' >&2; exit 1; }
id fiberfleet >/dev/null
# Файл создан установщиком и принадлежит администратору; содержимое не выводим.
source "$ENV_FILE"
cd "$APP"
DB=${FF_DB:-${FF_DATA_DIR:-$APP/data}/fiberfleet.db}
DB=$(realpath -m "$DB")
[[ -f $DB ]] || { echo 'Рабочая база не найдена; обновление остановлено.' >&2; exit 1; }
PARTS=(server client deploy tools node_modules package.json package-lock.json README.md)
for part in "${PARTS[@]}"; do
  [[ $DB != "$APP/$part" && $DB != "$APP/$part/"* ]] || { echo 'База находится внутри заменяемого каталога; обновление остановлено.' >&2; exit 1; }
done
STAGE=$(mktemp -d "$(dirname "$APP")/.fiberfleet-update.XXXXXXXX")
STAMP=$(date +%Y-%m-%d_%H%M%S)-$$
ORIG="$APP/orig/$STAMP"
STOPPED=0
SUCCESS=0
OLD=()
NEW=()
cleanup() {
  rc=$?
  trap - EXIT
  if [[ $SUCCESS == 0 && $STOPPED == 1 ]]; then
    echo 'Обновление не завершилось. Возвращаю предыдущие файлы программы.' >&2
    systemctl stop fiberfleet || true
    for part in "${NEW[@]}"; do rm -rf -- "$APP/$part"; done
    for part in "${OLD[@]}"; do mv -- "$ORIG/$part" "$APP/$part" || true; done
    systemctl start fiberfleet || echo 'Не удалось запустить службу; проверьте journalctl -u fiberfleet.' >&2
    echo "Резервная копия базы сохранена: ${DB_BACKUP:-не создавалась}. База автоматически не откатывается." >&2
  fi
  rm -rf -- "$STAGE"
  exit "$rc"
}
trap cleanup EXIT

echo "== Загрузка версии $REV и сборка отдельно от работающей программы"
curl --fail --location --retry 3 --connect-timeout 20 --max-time 180 \
  "https://codeload.github.com/NeoBlau/FiberFleet/tar.gz/$REV" -o "$STAGE/source.tgz"
tar -xzf "$STAGE/source.tgz" -C "$STAGE" --strip-components=1
rm "$STAGE/source.tgz"
for part in server client deploy tools package.json package-lock.json README.md; do test -e "$STAGE/$part"; done
chmod 755 "$STAGE"
chown -R fiberfleet:fiberfleet "$STAGE"
(cd "$STAGE" && runuser -u fiberfleet -- npm ci --omit=dev && \
  runuser -u fiberfleet -- npm --prefix client ci --include=dev && \
  runuser -u fiberfleet -- npm --prefix client run build)
test -s "$STAGE/client/dist/index.html"

echo '== Остановка службы и проверенная резервная копия базы'
systemctl stop fiberfleet
STOPPED=1
install -d -m 700 "$BACKUPS"
DB_BACKUP="$BACKUPS/fiberfleet_before_update_$STAMP.db"
sqlite3 "$DB" ".backup '$DB_BACKUP'"
chmod 600 "$DB_BACKUP"
[[ $(sqlite3 "$DB_BACKUP" 'PRAGMA integrity_check;') == ok ]] || { echo 'Резервная копия не прошла проверку.' >&2; exit 1; }
mkdir -p "$ORIG"
# Только программные компоненты; data, .env, .git и /etc не трогаем.
for part in "${PARTS[@]}"; do
  if [[ -e $APP/$part ]]; then mv -- "$APP/$part" "$ORIG/$part"; OLD+=("$part"); fi
  mv -- "$STAGE/$part" "$APP/$part"
  NEW+=("$part")
done
systemctl start fiberfleet
for attempt in {1..20}; do
  if systemctl is-active --quiet fiberfleet && curl --fail --silent --max-time 2 "http://127.0.0.1:${PORT:-8080}/api/health" >/dev/null; then
    SUCCESS=1
    echo "Готово. Версия: $REV"
    echo "База сохранена: $DB_BACKUP"
    echo "Предыдущие файлы: $ORIG"
    exit 0
  fi
  sleep 1
done
echo 'Сервис не ответил после обновления.' >&2
exit 1
