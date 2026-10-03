# Установка FiberFleet на Linux-сервер

Инструкция для VPS или выделенного сервера с доступом по SSH и правами root.
Проверено для **Ubuntu 22.04 / 24.04** и **Debian 12**.

> **Обычный виртуальный хостинг (только PHP/сайты, панель cPanel/ISPmanager без SSH) не подойдёт** — FiberFleet это постоянно работающий сервер на Node.js. Нужен VPS. Если у хостера есть «Node.js-приложения» в панели, напишите — подскажу настройку отдельно.

## Что понадобится

| Что | Требование |
|---|---|
| Сервер | 1 vCPU, 1 ГБ RAM, 10 ГБ диска (для 50–200 ТС хватит с запасом) |
| ОС | Ubuntu 22.04/24.04 или Debian 12, 64-bit |
| Доступ | SSH под root или пользователем с `sudo` |
| Домен (желательно) | Например `fleet.вашадомен.ru` с A-записью на IP сервера — нужен для HTTPS. Без HTTPS не работают установка приложения на телефоны и офлайн-режим |

---

## Вариант А. Автоматическая установка (рекомендуется, ~10 минут)

### 1. Направьте домен на сервер
В панели регистратора домена создайте **A-запись**: `fleet` → `IP вашего сервера`. Проверка (через 5–30 минут):
```bash
ping fleet.вашадомен.ru
```

### 2. Подключитесь к серверу
Windows: PowerShell или PuTTY; macOS/Linux: терминал.
```bash
ssh root@IP_СЕРВЕРА
```

### 3. Скачайте программу на сервер

**Если репозиторий на GitHub публичный:**
```bash
apt-get update && apt-get install -y git
git clone -b claude/fiberfleet-app https://github.com/NeoBlau/FiberFleet.git /opt/fiberfleet
```

**Если репозиторий приватный** — один из способов:
- создайте на GitHub токен (Settings → Developer settings → Personal access tokens → Fine-grained, доступ *Contents: Read* к репозиторию FiberFleet) и выполните
  `git clone -b claude/fiberfleet-app https://ТОКЕН@github.com/NeoBlau/FiberFleet.git /opt/fiberfleet`
- или скачайте ZIP с GitHub на свой компьютер и загрузите на сервер:
  ```bash
  # на своём компьютере
  scp FiberFleet-claude-fiberfleet-app.zip root@IP_СЕРВЕРА:/root/
  # на сервере
  apt-get install -y unzip && unzip /root/FiberFleet-*.zip -d /root/ && mv /root/FiberFleet-* /opt/fiberfleet
  ```

### 4. Запустите установщик
```bash
cd /opt/fiberfleet
sudo bash deploy/install.sh fleet.вашадомен.ru you@почта.ru
```
Без домена (временно, только по IP и без HTTPS): `sudo bash deploy/install.sh`

Скрипт сам:
1. установит nginx, sqlite3, Node.js 22;
2. создаст системного пользователя `fiberfleet` (программа работает не от root);
3. соберёт программу;
4. создаст `/etc/fiberfleet.env` со случайным паролем администратора;
5. зарегистрирует службу `fiberfleet` (автозапуск, перезапуск при сбое);
6. настроит nginx и получит бесплатный HTTPS-сертификат Let's Encrypt (автопродление);
7. включит файрвол (открыты только SSH, 80, 443);
8. настроит ежедневную резервную копию базы в 03:30.

В конце будет выведен адрес и пароль администратора (он также сохранён в `/root/fiberfleet-admin-password.txt`).

### 5. Первый вход
Откройте `https://fleet.вашадомен.ru`, войдите как `admin`, **смените пароль** (клик по имени внизу меню) и заведите пользователей в «Настройки → Пользователи».

---

## Вариант Б. Ручная установка (по шагам)

Если хотите контролировать каждый шаг или ОС отличается.

```bash
# 1. Пакеты
apt-get update
apt-get install -y ca-certificates curl git nginx sqlite3 ufw build-essential python3

# 2. Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node -v        # v22.x

# 3. Пользователь и каталоги
useradd --system --home /opt/fiberfleet --shell /usr/sbin/nologin fiberfleet
mkdir -p /var/lib/fiberfleet /var/backups/fiberfleet
git clone -b claude/fiberfleet-app https://github.com/NeoBlau/FiberFleet.git /opt/fiberfleet   # или см. шаг 3 варианта А
chown -R fiberfleet:fiberfleet /opt/fiberfleet /var/lib/fiberfleet

# 4. Сборка
cd /opt/fiberfleet
runuser -u fiberfleet -- npm ci --omit=dev
runuser -u fiberfleet -- npm --prefix client ci
runuser -u fiberfleet -- npm --prefix client run build
```

**5. Настройки** — создайте `/etc/fiberfleet.env`:
```ini
NODE_ENV=production
PORT=8080
FF_DATA_DIR=/var/lib/fiberfleet
FF_ADMIN_PASSWORD=ПридумайтеНадёжныйПароль
FF_DEMO_USERS=0
```
```bash
chmod 600 /etc/fiberfleet.env
```
`FF_ADMIN_PASSWORD` и `FF_DEMO_USERS` действуют только при самом первом запуске (создании базы).

**6. Служба:**
```bash
cp deploy/fiberfleet.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fiberfleet
systemctl status fiberfleet            # active (running)
curl http://127.0.0.1:8080/api/health  # {"ok":true,...}
```

**7. nginx:**
```bash
cp deploy/nginx-fiberfleet.conf /etc/nginx/sites-available/fiberfleet
nano /etc/nginx/sites-available/fiberfleet        # замените fleet.example.ru на свой домен
ln -s /etc/nginx/sites-available/fiberfleet /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

**8. HTTPS:**
```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d fleet.вашадомен.ru -m you@почта.ru --agree-tos --redirect
```

**9. Файрвол:**
```bash
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable
```

**10. Резервное копирование:**
```bash
chmod +x deploy/*.sh
echo "30 3 * * * root FF_DB=/var/lib/fiberfleet/fiberfleet.db bash /opt/fiberfleet/deploy/backup.sh >/var/log/fiberfleet-backup.log 2>&1" > /etc/cron.d/fiberfleet-backup
```

---

## Вариант В. Через Docker

Если на сервере уже есть Docker:
```bash
git clone -b claude/fiberfleet-app https://github.com/NeoBlau/FiberFleet.git /opt/fiberfleet
cd /opt/fiberfleet
nano docker-compose.yml      # задайте FF_ADMIN_PASSWORD
docker compose up -d --build
```
Программа слушает порт 8080, база — в `/opt/fiberfleet/data`. Для HTTPS настройте nginx из шагов 7–8 варианта Б (он проксирует на 127.0.0.1:8080).

---

## Обслуживание

| Задача | Команда |
|---|---|
| Статус | `systemctl status fiberfleet` |
| Журнал (последние 100 строк / в реальном времени) | `journalctl -u fiberfleet -n 100` / `journalctl -u fiberfleet -f` |
| Перезапуск | `systemctl restart fiberfleet` |
| Обновление до новой версии | `sudo bash /opt/fiberfleet/deploy/update.sh` (сначала делает резервную копию) |
| Резервная копия вручную | `sudo bash /opt/fiberfleet/deploy/backup.sh` |
| Список копий | `ls -lh /var/backups/fiberfleet` |
| Скачать копию на свой компьютер | `scp root@IP:/var/backups/fiberfleet/fiberfleet_ДАТА.db.gz .` или «Настройки → Резервная копия» в программе |

> `update.sh` работает, если программа ставилась через `git clone`. Если загружали ZIP — загрузите новый архив, распакуйте поверх `/opt/fiberfleet` (папку `/var/lib/fiberfleet` не трогайте) и выполните шаги 4 и `systemctl restart fiberfleet`.

### Восстановление из резервной копии
```bash
systemctl stop fiberfleet
gunzip -c /var/backups/fiberfleet/fiberfleet_2026-10-03_0330.db.gz > /var/lib/fiberfleet/fiberfleet.db
rm -f /var/lib/fiberfleet/fiberfleet.db-wal /var/lib/fiberfleet/fiberfleet.db-shm
chown fiberfleet:fiberfleet /var/lib/fiberfleet/fiberfleet.db
systemctl start fiberfleet
```

Храните копии **не только на этом сервере**: раз в неделю скачивайте их к себе или настройте копирование в облачное хранилище (S3, Яндекс Object Storage, rclone).

### Забыли пароль администратора
```bash
cd /opt/fiberfleet
runuser -u fiberfleet -- node -e "
const D=require('better-sqlite3');import('./server/auth.js').then(({hashPassword})=>{
const db=new D('/var/lib/fiberfleet/fiberfleet.db');
db.prepare(\"UPDATE users SET pass_hash=?, active=1 WHERE login='admin'\").run(hashPassword('НовыйПароль123'));
console.log('ok')})"
```

---

## Подключение 1С

1С обращается к FiberFleet по HTTPS:
- заведите в «Настройки → Пользователи» отдельного пользователя, например `onec` с ролью **Оператор**;
- обработка 1С получает токен: `POST https://fleet.вашадомен.ru/api/auth/login` с телом `{"login":"onec","password":"..."}`;
- выгрузка установленных запчастей: `GET /api/onec/export?format=json&only_new=1&mark=1`;
- загрузка номенклатуры: `POST /api/onec/parts` (JSON-массив `[{code, article, name, unit, price}]`);
- в запросах заголовок `Authorization: Bearer <токен>`.

Если 1С стоит в локальной сети без интернета, разместите FiberFleet на сервере в той же сети (варианты А/Б без домена) или используйте файловый обмен (XML/Excel) в разделе «Запчасти и 1С».

---

## Решение проблем

| Симптом | Что проверить |
|---|---|
| `502 Bad Gateway` | Служба не запущена: `systemctl status fiberfleet`, `journalctl -u fiberfleet -n 50` |
| Ошибка при `npm ci` про `better-sqlite3` / `node-gyp` | Установлены ли `build-essential python3`; версия Node ≥ 20 (`node -v`) |
| certbot: `Challenge failed` | A-запись домена ещё не обновилась или порт 80 закрыт у хостера (проверьте файрвол в панели VPS) |
| Не открывается снаружи, локально `curl 127.0.0.1:8080` работает | `ufw status`, файрвол/группы безопасности в панели хостинга (порты 80/443) |
| На телефоне нет «Установить приложение» | Нужен HTTPS (адрес начинается с `https://`) |
| Время в расписании сдвинуто | «Настройки → Часовой пояс» (смещение от UTC в минутах; Москва — 180) |
| `database is locked` | Не запускайте две копии программы на одну базу; проверьте `ps aux | grep server/index.js` |

## Где что лежит

| Путь | Что |
|---|---|
| `/opt/fiberfleet` | Программа |
| `/var/lib/fiberfleet/fiberfleet.db` | База данных (все данные) |
| `/etc/fiberfleet.env` | Настройки запуска |
| `/etc/systemd/system/fiberfleet.service` | Служба |
| `/etc/nginx/sites-available/fiberfleet` | Веб-сервер |
| `/var/backups/fiberfleet` | Резервные копии (14 дней) |
