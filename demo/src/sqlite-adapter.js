// Совместимый с better-sqlite3 (в нужном FiberFleet объёме) адаптер поверх sql.js
const state = { SQL: null, initialBytes: null };
export const setSqlJs = (SQL, bytes) => { state.SQL = SQL; state.initialBytes = bytes || null; };

const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

class Statement {
  constructor(owner, sql) { this.owner = owner; this.sql = sql; }
  _stmt() {
    const c = this.owner._cache;
    let s = c.get(this.sql);
    if (!s) { s = this.owner._db.prepare(this.sql); c.set(this.sql, s); }
    return s;
  }
  _params(args) {
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      const obj = args[0];
      const out = {};
      for (const m of this.sql.matchAll(/([@:$])(\w+)/g)) {
        if (m[1] === ':' && /\d/.test(m[2][0])) continue;
        out[m[1] + m[2]] = norm(obj[m[2]]);
      }
      return out;
    }
    return args.flat().map(norm);
  }
  get(...args) {
    const s = this._stmt();
    try {
      s.bind(this._params(args));
      return s.step() ? s.getAsObject() : undefined;
    } finally { s.reset(); }
  }
  all(...args) {
    const s = this._stmt();
    const rows = [];
    try {
      s.bind(this._params(args));
      while (s.step()) rows.push(s.getAsObject());
    } finally { s.reset(); }
    return rows;
  }
  run(...args) {
    const s = this._stmt();
    try {
      s.bind(this._params(args));
      s.step();
    } finally { s.reset(); }
    const db = this.owner._db;
    const changes = db.getRowsModified();
    const id = db.exec('SELECT last_insert_rowid() AS id')[0]?.values?.[0]?.[0] ?? 0;
    return { changes, lastInsertRowid: id };
  }
}

export default class Database {
  constructor() {
    if (!state.SQL) throw new Error('sql.js не инициализирован');
    this._db = state.initialBytes ? new state.SQL.Database(state.initialBytes) : new state.SQL.Database();
    this._cache = new Map();
    this._depth = 0;
    globalThis.__ffDb = this;
  }
  pragma(s) {
    if (/journal_mode|busy_timeout/i.test(s)) return;
    this._db.run(`PRAGMA ${s}`);
  }
  exec(sql) { this._db.exec(sql); return this; }
  prepare(sql) { return new Statement(this, sql); }
  transaction(fn) {
    return (...args) => {
      const d = this._depth++;
      this._db.run(d ? `SAVEPOINT sp${d}` : 'BEGIN');
      try {
        const r = fn(...args);
        this._db.run(d ? `RELEASE sp${d}` : 'COMMIT');
        return r;
      } catch (e) {
        this._db.run(d ? `ROLLBACK TO sp${d}` : 'ROLLBACK');
        if (d) this._db.run(`RELEASE sp${d}`);
        throw e;
      } finally { this._depth--; }
    };
  }
  backup() {
    const e = new Error('В демо-версии резервная копия недоступна — она работает на сервере');
    e.status = 400;
    throw e;
  }
  // Снимок базы для сохранения в браузере. sql.js при экспорте закрывает подготовленные запросы.
  exportBytes() {
    const bytes = this._db.export();
    this._cache = new Map();
    this._db.run('PRAGMA foreign_keys = ON');
    return bytes;
  }
}
