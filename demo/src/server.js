// Демо-версия: серверная часть FiberFleet (те же модули server/*) работает в браузере.
// База SQLite (sql.js) сохраняется в IndexedDB этого браузера.
import './globals.js';
import initSqlJs from 'sql.js/dist/sql-asm-memory-growth.js';
import { setSqlJs } from './sqlite-adapter.js';
import { Router } from './express-shim.js';

const KEY = 'ff-demo-db-v1';

function idb() {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open('fiberfleet-demo', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
async function loadBytes() {
  const db = await idb();
  if (!db) return null;
  return new Promise((res) => {
    try {
      const q = db.transaction('kv').objectStore('kv').get(KEY);
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    } catch { res(null); }
  });
}
async function saveBytes(bytes) {
  const db = await idb();
  if (!db) return;
  try { db.transaction('kv', 'readwrite').objectStore('kv').put(bytes, KEY); } catch { /* хранилище недоступно */ }
}
export async function resetDemo() {
  const db = await idb();
  if (db) await new Promise((res) => { try { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(KEY); t.oncomplete = res; t.onerror = res; } catch { res(); } });
  try { localStorage.clear(); } catch { /* */ }
}

let api = null;
let authApi = null;
let dbRef = null;
let saveTimer = null;

function persistSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { saveBytes(dbRef.exportBytes()); } catch { /* */ } }, 800);
}

export async function bootDemoServer() {
  const SQL = await initSqlJs();
  const bytes = await loadBytes();
  setSqlJs(SQL, bytes);
  const { openDb } = await import('../../server/db.js');
  const { seedIfEmpty } = await import('../../server/seed.js');
  const { authMiddleware } = await import('../../server/auth.js');
  const mods = await Promise.all([
    import('../../server/routes/auth.js'), import('../../server/routes/vehicles.js'),
    import('../../server/routes/orders.js'), import('../../server/routes/schedule.js'),
    import('../../server/routes/staff.js'), import('../../server/routes/parts.js'),
    import('../../server/routes/maintenance.js'), import('../../server/routes/reports.js'),
    import('../../server/routes/admin.js'),
  ]);
  const db = openDb(':memory:');
  const fresh = seedIfEmpty(db);
  dbRef = globalThis.__ffDb;

  authApi = mods[0].default(db);
  api = Router();
  api.use(authMiddleware(db));
  for (const m of mods.slice(1)) api.use(m.default(db));

  if (fresh) {
    const { fillDemoData } = await import('./sample.js');
    await fillDemoData(db, handle);
  }
  try { saveBytes(dbRef.exportBytes()); } catch { /* */ }
}

function errorBody(err) {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  let message = err.message || 'Ошибка сервера';
  if (/UNIQUE constraint failed/.test(message)) message = 'Такая запись уже существует (дубликат)';
  else if (/FOREIGN KEY constraint failed/.test(message)) message = 'Запись используется в других данных';
  else if (status >= 500) message = 'Внутренняя ошибка: ' + message;
  return { status, body: { error: message, details: err.details } };
}

/** Обработать запрос к /api/... так же, как это делает сервер */
export function handle(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url, 'http://demo.local');
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const req = {
      method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: body ?? {}, params: {},
      get: (name) => h[String(name).toLowerCase()],
    };
    let type = 'application/json';
    const extra = {};
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      type(t) { type = t; return this; },
      setHeader(k, v) { extra[k] = v; return this; },
      json(b) { finish(this.statusCode, JSON.stringify(b ?? {}), 'application/json'); return this; },
      send(s) { finish(this.statusCode, typeof s === 'string' ? s : JSON.stringify(s), type); return this; },
      end() { finish(this.statusCode, '', type); return this; },
      download() { const e = new Error('В демо-версии файлы не скачиваются'); e.status = 400; throw e; },
    };
    let done = false;
    const finish = (status, text, ctype) => {
      if (done) return;
      done = true;
      if (method !== 'GET' && status < 400) persistSoon();
      resolve({ status, text, headers: { 'content-type': ctype, ...extra } });
    };
    const out = (err) => {
      if (done) return;
      const { status, body: b } = err ? errorBody(err) : { status: 404, body: { error: 'Метод API не найден' } };
      finish(status, JSON.stringify(b), 'application/json');
    };
    try {
      if (u.pathname.startsWith('/api/auth')) { req.path = u.pathname.slice(9) || '/'; authApi(req, res, out); }
      else if (u.pathname === '/api/health') res.json({ ok: true, demo: true });
      else if (u.pathname.startsWith('/api/')) { req.path = u.pathname.slice(4); api(req, res, out); }
      else out();
    } catch (e) { out(e); }
  });
}

// Перехват fetch('/api/...') клиента
export function installFetch() {
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return orig(input, init);
    let body;
    if (init.body instanceof FormData) body = {};
    else if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = {}; } }
    const r = await handle((init.method || 'GET').toUpperCase(), url, { headers: init.headers || {}, body });
    return new Response(r.text, { status: r.status, headers: r.headers });
  };
}
