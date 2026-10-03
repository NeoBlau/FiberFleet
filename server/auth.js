import crypto from 'node:crypto';
import { HttpError } from './util.js';

export function hashPassword(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pass), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(pass, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(pass), salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

const SESSION_DAYS = 30;

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now.toISOString(), exp.toISOString());
  return token;
}

// Права по ролям
export const PERMISSIONS = {
  admin: ['*'],
  operator: ['vehicles.write', 'orders.write', 'plan.write', 'tasks.status', 'parts.write', 'reports.read', 'catalog.read', 'employees.read', 'maintenance.write'],
  master: ['vehicles.write', 'orders.write', 'reports.read', 'catalog.read', 'employees.read'],
  mechanic: ['catalog.read'],
};
// Только администратор: tasks.reassign, catalog.write, employees.write, users.write, settings.write

export function can(user, perm) {
  const p = PERMISSIONS[user?.role] || [];
  return p.includes('*') || p.includes(perm);
}

export function authMiddleware(db) {
  return (req, _res, next) => {
    const h = req.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
    if (!token) return next(new HttpError(401, 'Требуется вход в систему'));
    const row = db.prepare(`SELECT u.id, u.login, u.name, u.role, u.employee_id, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1`).get(token);
    if (!row || row.expires_at < new Date().toISOString()) return next(new HttpError(401, 'Сессия истекла, войдите снова'));
    req.user = row;
    req.token = token;
    next();
  };
}

export const requirePerm = (perm) => (req, _res, next) => {
  if (!can(req.user, perm)) return next(new HttpError(403, 'Недостаточно прав для этого действия'));
  next();
};
