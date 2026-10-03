import express from 'express';
import compression from 'compression';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { seedIfEmpty } from './seed.js';
import { authMiddleware } from './auth.js';
import { HttpError } from './util.js';
import authRoutes from './routes/auth.js';
import vehicleRoutes from './routes/vehicles.js';
import orderRoutes from './routes/orders.js';
import scheduleRoutes from './routes/schedule.js';
import staffRoutes from './routes/staff.js';
import partsRoutes from './routes/parts.js';
import maintenanceRoutes from './routes/maintenance.js';
import reportRoutes from './routes/reports.js';
import adminRoutes from './routes/admin.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Идемпотентность для офлайн-очереди: повторная отправка операции с тем же X-Op-Id
// возвращает сохранённый ответ и не выполняется второй раз.
function syncOps(db) {
  return (req, res, next) => {
    const opId = req.get('x-op-id');
    if (!opId || req.method === 'GET') return next();
    const prev = db.prepare('SELECT status, response FROM sync_ops WHERE op_id = ?').get(opId);
    if (prev) return res.status(prev.status).type('json').send(prev.response || '{}');
    const origJson = res.json.bind(res);
    res.json = (body) => {
      try {
        db.prepare('INSERT OR IGNORE INTO sync_ops(op_id, user_id, status, response) VALUES (?, ?, ?, ?)')
          .run(opId, req.user?.id ?? null, res.statusCode, JSON.stringify(body ?? {}));
      } catch { /* не мешаем ответу */ }
      return origJson(body);
    };
    next();
  };
}

export function createApp({ dbFile } = {}) {
  const db = openDb(dbFile);
  seedIfEmpty(db);

  const app = express();
  app.locals.db = db;
  app.disable('x-powered-by');
  app.use(compression());
  app.use(express.json({ limit: '5mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.use('/api/auth', authRoutes(db));

  const api = express.Router();
  api.use(authMiddleware(db));
  api.use(syncOps(db));
  api.use(vehicleRoutes(db));
  api.use(orderRoutes(db));
  api.use(scheduleRoutes(db));
  api.use(staffRoutes(db));
  api.use(partsRoutes(db));
  api.use(maintenanceRoutes(db));
  api.use(reportRoutes(db));
  api.use(adminRoutes(db));
  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Метод API не найден')));

  // Клиент (собранный PWA)
  const dist = path.resolve(here, '..', 'client', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, {
      index: false,
      setHeaders: (res, file) => {
        if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    }));
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(dist, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => res.type('text').send('FiberFleet API работает. Соберите клиент: npm run build'));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    let message = err.message || 'Ошибка сервера';
    if (/UNIQUE constraint failed/.test(message)) message = 'Такая запись уже существует (дубликат)';
    else if (/FOREIGN KEY constraint failed/.test(message)) message = 'Запись используется в других данных';
    else if (status >= 500) message = 'Внутренняя ошибка сервера';
    res.status(status).json({ error: message, details: err.details });
  });

  return app;
}
