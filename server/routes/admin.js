import Database from 'better-sqlite3';
import multer from 'multer';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const requireFromExcel = createRequire(createRequire(import.meta.url).resolve('exceljs'));
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hashPassword, requirePerm } from '../auth.js';
import { getSettings, saveSettings } from '../settings.js';
import { audit, replan } from '../services/orders.js';
import { catalogAmounts, syncPlannedCatalogTasks } from '../domain/catalog-pricing.js';
import { bad, notFound } from '../util.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ROLES = ['admin', 'operator', 'master', 'mechanic'];

export default function adminRoutes(db) {
  const r = express.Router();

  r.get('/settings', (_req, res) => res.json(getSettings(db)));

  r.put('/settings', requirePerm('settings.write'), (req, res) => {
    const b = req.body || {};
    const old = getSettings(db);
    const re = /^\d{2}:\d{2}$/;
    for (const k of ['work_start', 'work_end', 'lunch_start', 'lunch_end']) if (b[k] && !re.test(b[k])) throw bad(`Время в формате ЧЧ:ММ (${k})`);
    if (b.work_start && b.work_end && b.work_start >= b.work_end) throw bad('Начало рабочего дня должно быть раньше конца');
    if (b.work_days && (!Array.isArray(b.work_days) || !b.work_days.length)) throw bad('Выберите рабочие дни');
    if (b.norm_hour_price !== undefined && (!Number.isFinite(Number(b.norm_hour_price)) || Number(b.norm_hour_price) <= 0)) throw bad('Стоимость нормо-часа должна быть больше 0');
    if (b.salary_rate !== undefined && (!Number.isFinite(Number(b.salary_rate)) || Number(b.salary_rate) < 0 || Number(b.salary_rate) > 1)) throw bad('Доля зарплаты должна быть от 0 до 1 (0–100 %)');
    const s = db.transaction(() => {
      const saved = saveSettings(db, b);
      if ((b.norm_hour_price !== undefined && Number(b.norm_hour_price) !== Number(old.norm_hour_price))
        || (b.salary_rate !== undefined && Number(b.salary_rate) !== Number(old.salary_rate))) {
        const update = db.prepare(`UPDATE work_types SET price = @price, price_max = @price_max,
          salary = @salary, salary_max = @salary_max, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`);
        for (const work of db.prepare('SELECT id, hours, hours_max FROM work_types').all()) {
          update.run({ id: work.id, ...catalogAmounts(work.hours, work.hours_max, saved) });
        }
        syncPlannedCatalogTasks(db);
      }
      return saved;
    })();
    audit(db, req.user, 'settings', null, 'update', JSON.stringify(b));
    replan(db);
    res.json(s);
  });

  r.get('/users', requirePerm('users.write'), (_req, res) => {
    res.json(db.prepare(`SELECT u.id, u.login, u.name, u.role, u.employee_id, u.active, u.created_at, e.name AS employee_name
      FROM users u LEFT JOIN employees e ON e.id = u.employee_id ORDER BY u.active DESC, u.role, u.login`).all());
  });

  r.post('/users', requirePerm('users.write'), (req, res) => {
    const b = req.body || {};
    const login = String(b.login || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(login)) throw bad('Логин: 3–32 символа, латиница, цифры, . _ -');
    if (!ROLES.includes(b.role)) throw bad('Неверная роль');
    if (!b.password || String(b.password).length < 6) throw bad('Пароль — не короче 6 символов');
    const id = db.prepare('INSERT INTO users(login, name, pass_hash, role, employee_id) VALUES (?, ?, ?, ?, ?)')
      .run(login, String(b.name || login).trim(), hashPassword(b.password), b.role, b.employee_id || null).lastInsertRowid;
    audit(db, req.user, 'user', id, 'create', login);
    res.status(201).json({ id });
  });

  r.put('/users/:id', requirePerm('users.write'), (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) throw notFound('Пользователь');
    const b = req.body || {};
    if (b.role && !ROLES.includes(b.role)) throw bad('Неверная роль');
    if (u.id === req.user.id && (b.role && b.role !== 'admin' || b.active === false)) throw bad('Нельзя лишить прав самого себя');
    db.prepare('UPDATE users SET name = ?, role = ?, employee_id = ?, active = ? WHERE id = ?').run(
      b.name ?? u.name, b.role ?? u.role, b.employee_id !== undefined ? b.employee_id || null : u.employee_id,
      b.active !== undefined ? (b.active ? 1 : 0) : u.active, u.id,
    );
    if (b.password) {
      if (String(b.password).length < 6) throw bad('Пароль — не короче 6 символов');
      db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(b.password), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    if (b.active === false) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    audit(db, req.user, 'user', u.id, 'update', JSON.stringify({ ...b, password: b.password ? '***' : undefined }));
    res.json({ ok: true });
  });

  r.get('/audit', requirePerm('users.write'), (req, res) => {
    res.json(db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT ?`).all(Math.min(Number(req.query.limit) || 200, 2000)));
  });

  // Backups are private, consistent SQLite snapshots.
  const adminOnly = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Только администратор' });
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
  const clean = dir => fs.rmSync(dir, { recursive: true, force: true });
  const verify = file => {
    const copy = new Database(file, { readonly: true, fileMustExist: true });
    try {
      if (copy.pragma('integrity_check', { simple: true }) !== 'ok') throw bad('Повреждённая база SQLite');
      const schema = d => d.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      if (JSON.stringify(schema(copy)) !== JSON.stringify(schema(db))) throw bad('Несовместимая схема базы — используйте соответствующую версию FiberFleet');
      if (copy.pragma('foreign_key_check').length) throw bad('Нарушены связи в базе');
      if (!copy.prepare("SELECT 1 FROM users WHERE role='admin' AND active=1 LIMIT 1").get()) throw bad('В копии нет активного администратора');
    } finally { copy.close(); }
  };
  async function exportBackup(req, res, next, full) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiberfleet-'));
    try {
      const file = path.join(dir, 'fiberfleet.db');
      await db.backup(file);
      verify(file);
      let output = file;
      if (full) {
        output = path.join(dir, 'fiberfleet.zip');
        const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
        const archive = requireFromExcel('archiver')('zip', { zlib: { level: 6 } });
        const stream = fs.createWriteStream(output, { mode: 0o600 });
        const finished = new Promise((resolve, reject) => {
          stream.on('close', resolve); stream.on('error', reject);
          archive.on('error', reject); archive.on('warning', reject);
        });
        archive.pipe(stream);
        for (const name of ['server','client','deploy','tools','docs','package.json','package-lock.json','README.md','Dockerfile','docker-compose.yml','compose.yml']) {
          const source = path.join(root, name);
          if (!fs.existsSync(source)) continue;
          if (fs.statSync(source).isDirectory()) archive.glob('**/*', { cwd: source, dot: true, ignore: ['**/node_modules/**','**/.git/**','**/.env*','**/*.db','**/*.db-wal','**/*.db-shm'] }, { prefix: name });
          else archive.file(source, { name });
        }
        archive.file(file, { name: 'data/fiberfleet.db' });
        archive.append(JSON.stringify({ format: 'FiberFleet', version: 1, createdAt: new Date().toISOString(), database: 'data/fiberfleet.db' }), { name: 'backup-manifest.json' });
        await Promise.all([archive.finalize(), finished]);
      }
      res.set('Cache-Control', 'no-store');
      res.download(output, 'fiberfleet-' + stamp() + (full ? '.zip' : '.db'), err => {
        clean(dir);
        if (err && !res.headersSent) next(err);
      });
    } catch (err) {
      clean(dir); console.error('FiberFleet backup:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Не удалось создать резервную копию: ' + (err.code || 'проверьте журнал сервера') });
      else next(err);
    }
  }
  r.get('/admin/backup', adminOnly, wrap((req,res,next) => exportBackup(req,res,next,false)));
  r.get('/admin/backup/full', adminOnly, wrap((req,res,next) => exportBackup(req,res,next,true)));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 128 * 1024 * 1024, files: 1 } });
  r.post('/admin/backup/restore', adminOnly, upload.single('backup'), wrap(async (req,res) => {
    if (!req.file || req.body.confirm !== 'RESTORE') throw bad('Выберите копию и подтвердите восстановление');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiberfleet-restore-'));
    try {
      const incoming = path.join(dir, 'incoming.db');
      let bytes = req.file.buffer;
      if (bytes.subarray(0,2).toString() === 'PK') {
        const zip = await requireFromExcel('unzipper').Open.buffer(bytes);
        const entries = zip.files.filter(x => x.path === 'data/fiberfleet.db');
        if (entries.length !== 1 || entries[0].uncompressedSize > 128 * 1024 * 1024) throw bad('Неверный архив FiberFleet');
        bytes = await entries[0].buffer();
      }
      if (bytes.subarray(0,16).toString() !== 'SQLite format 3\0') throw bad('Неверный формат базы');
      fs.writeFileSync(incoming, bytes, { mode: 0o600 });
      verify(incoming);
      if (db.name === ':memory:') throw bad('Восстановление временной базы запрещено');
      const safety = path.join(path.dirname(path.resolve(db.name)), 'backups');
      fs.mkdirSync(safety, { recursive: true, mode: 0o700 });
      const old = path.join(safety, 'before-restore-' + stamp() + '-' + path.basename(dir) + '.db');
      await db.backup(old);
      // No awaits during the replacement: one atomic SQLite transaction.
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x => x.name);
      const quote = s => '"' + s.replaceAll('"','""') + '"';
      db.prepare('ATTACH DATABASE ? AS incoming').run(incoming);
      try {
        db.pragma('foreign_keys = OFF');
        db.transaction(() => {
          for (const t of tables) db.exec('DELETE FROM main.' + quote(t));
          for (const t of tables) if (t !== 'sessions') db.exec('INSERT INTO main.' + quote(t) + ' SELECT * FROM incoming.' + quote(t));
          if (db.pragma('foreign_key_check').length) throw bad('Нарушены связи после восстановления');
        })();
      } finally {
        db.pragma('foreign_keys = ON');
        db.exec('DETACH DATABASE incoming');
      }
      res.json({ ok: true, message: 'Данные восстановлены. Войдите снова.', safetyBackup: path.basename(old) });
    } finally { clean(dir); }
  }));

  return r;
}
