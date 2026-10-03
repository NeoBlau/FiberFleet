// Клиент API с поддержкой работы без сети:
//  • GET-ответы кэшируются в IndexedDB; без сети показываются последние сохранённые данные;
//  • изменения без сети ставятся в очередь и отправляются при восстановлении связи;
//  • каждая операция несёт X-Op-Id — повторная отправка не создаёт дублей на сервере.

const TOKEN_KEY = 'ff_token';
const QUEUE_KEY = 'ff_queue';
const FAILED_KEY = 'ff_failed';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const uid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* */ } };

// ---------- IndexedDB-кэш ----------
let dbp = null;
function idb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open('fiberfleet', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('cache');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}
async function cacheGet(key) {
  const db = await idb();
  if (!db) return undefined;
  return new Promise((res) => {
    const r = db.transaction('cache').objectStore('cache').get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(undefined);
  });
}
async function cachePut(key, value) {
  const db = await idb();
  if (!db) return;
  try { db.transaction('cache', 'readwrite').objectStore('cache').put(value, key); } catch { /* */ }
}
export async function cacheClear() {
  const db = await idb();
  if (!db) return;
  try { db.transaction('cache', 'readwrite').objectStore('cache').clear(); } catch { /* */ }
}

// ---------- Состояние связи / очередь ----------
const listeners = new Set();
const state = { online: navigator.onLine, pending: 0, failed: [], syncing: false, stale: false };
const readList = (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } };
const writeList = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } };
function emit() {
  state.pending = readList(QUEUE_KEY).length;
  state.failed = readList(FAILED_KEY);
  listeners.forEach((fn) => fn({ ...state }));
}
export function onNetState(fn) { listeners.add(fn); fn({ ...state, pending: readList(QUEUE_KEY).length, failed: readList(FAILED_KEY) }); return () => listeners.delete(fn); }
const setOnline = (v) => { if (state.online !== v) { state.online = v; emit(); if (v) flushQueue(); } };

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function send(method, url, body, opId) {
  const headers = {};
  const t = getToken();
  if (t) headers.authorization = `Bearer ${t}`;
  if (opId) headers['x-op-id'] = opId;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`/api${url}`, { method, headers, body: payload });
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    throw new ApiError(res.status, data?.error || `Ошибка ${res.status}`, data?.details);
  }
  return data;
}

const isNetworkError = (e) => !(e instanceof ApiError);

export async function get(url) {
  try {
    const data = await send('GET', url);
    setOnline(true);
    state.stale = false;
    cachePut(url, { at: Date.now(), data });
    return data;
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    setOnline(false);
    const hit = await cacheGet(url);
    if (hit) { state.stale = true; emit(); return hit.data; }
    throw new ApiError(0, 'Нет связи с сервером, а сохранённых данных для этого раздела нет');
  }
}

/** Изменение данных. Без сети операция попадает в очередь: возвращается { queued: true }. */
export async function mutate(method, url, body, { label, offline = true } = {}) {
  const opId = uid();
  try {
    const data = await send(method, url, body, opId);
    setOnline(true);
    return data;
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    setOnline(false);
    if (!offline || body instanceof FormData) throw new ApiError(0, 'Нет связи с сервером — действие доступно только онлайн');
    const q = readList(QUEUE_KEY);
    q.push({ opId, method, url, body, label: label || `${method} ${url}`, at: new Date().toISOString() });
    writeList(QUEUE_KEY, q);
    emit();
    return { queued: true };
  }
}

export const post = (url, body, o) => mutate('POST', url, body, o);
export const put = (url, body, o) => mutate('PUT', url, body, o);
export const del = (url, o) => mutate('DELETE', url, undefined, o);

let flushing = null;
export function flushQueue() {
  if (flushing) return flushing;
  flushing = (async () => {
    state.syncing = true; emit();
    try {
      for (;;) {
        const q = readList(QUEUE_KEY);
        if (!q.length) break;
        const op = q[0];
        try {
          await send(op.method, op.url, op.body, op.opId);
          setOnline(true);
        } catch (e) {
          if (isNetworkError(e)) { setOnline(false); break; }
          if (e.status === 401) break;
          writeList(FAILED_KEY, [...readList(FAILED_KEY), { ...op, error: e.message, failedAt: new Date().toISOString() }]);
        }
        writeList(QUEUE_KEY, readList(QUEUE_KEY).filter((x) => x.opId !== op.opId));
        emit();
      }
    } finally {
      state.syncing = false; flushing = null; emit();
    }
  })();
  return flushing;
}
export const clearFailed = () => { writeList(FAILED_KEY, []); emit(); };

window.addEventListener('online', () => setOnline(true));
window.addEventListener('offline', () => setOnline(false));
setInterval(() => { if (readList(QUEUE_KEY).length) flushQueue(); }, 30000);

// Скачивание файла (отчёты, выгрузки)
export async function download(url, fallbackName = 'file') {
  const t = getToken();
  const res = await fetch(`/api${url}`, { headers: t ? { authorization: `Bearer ${t}` } : {} });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || `Ошибка ${res.status}`);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/) || cd.match(/filename="([^"]+)"/);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export async function openPdf(url) {
  const t = getToken();
  const win = window.open('', '_blank');
  const res = await fetch(`/api${url}`, { headers: t ? { authorization: `Bearer ${t}` } : {} });
  if (!res.ok) { win?.close(); throw new ApiError(res.status, 'Не удалось сформировать PDF'); }
  const blobUrl = URL.createObjectURL(await res.blob());
  if (win) win.location.href = blobUrl; else window.location.href = blobUrl;
}

export const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
