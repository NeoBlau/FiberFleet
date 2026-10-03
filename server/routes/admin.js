import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hashPassword, requirePerm } from '../auth.js';
import { getSettings, saveSettings } from '../settings.js';
import { audit, replan } from '../services/orders.js';
import { bad, notFound } from '../util.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ROLES = ['admin', 'operator', 'master', 'mechanic'];

export default function adminRoutes(db) {
  const r = express.Router();

  r.get('/settings', (_req, res) => res.json(getSettings(db)));

  r.put('/settings', requirePerm('settings.write'), (req, res) => {
    const b = req.body || {};
    const re = /^\d{2}:\d{2}$/;
    for (const k of ['work_start', 'work_end', 'lunch_start', 'lunch_end']) if (b[k] && !re.test(b[k])) throw bad(`Время в формате ЧЧ:ММ (${k})`);
    if (b.work_start && b.work_end && b.work_start >= b.work_end) throw bad('Начало рабочего дня должно быть раньше конца');
    if (b.work_days && (!Array.isArray(b.work_days) || !b.work_days.length)) throw bad('Выберите рабочие дни');
    const s = saveSettings(db, b);
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

  // Резервная копия базы данных (консистентный снимок)
  r.get('/admin/backup', requirePerm('settings.write'), wrap(async (_req, res) => {
    const file = path.join(os.tmpdir(), `fiberfleet-backup-${Date.now()}.db`);
    await db.backup(file);
    res.download(file, `fiberfleet-${new Date().toISOString().slice(0, 10)}.db`, () => fs.rm(file, { force: true }, () => {}));
  }));

  return r;
}
