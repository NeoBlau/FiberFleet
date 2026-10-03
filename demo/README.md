# FiberFleet — демо-версия

Один HTML-файл (`dist/index.html`), в котором работает вся программа: серверная часть FiberFleet
(те же модули `server/`) запускается прямо в браузере на SQLite (sql.js), данные хранятся в браузере.
Полная версия (`server/`, `client/`) этой сборкой не изменяется.

Ограничения демо: файлы (Excel, PDF, импорт из 1С) не формируются, данные не общие между устройствами.

## Выложить на Vercel
- Через сайт: vercel.com → Add New → Project → импортировать репозиторий, **Root Directory: `demo`**,
  Framework Preset: Other, Build Command — пусто, Output Directory: `dist` → Deploy.
- Или просто перетащить папку `demo/dist` на vercel.com/new (раздел «Deploy» без Git).
- Или CLI: `cd demo && npx vercel --prod`.

## Пересобрать
```bash
cd demo && npm install && npm run build
```
