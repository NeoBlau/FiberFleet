import express from 'express';
import { authMiddleware, createSession, hashPassword, PERMISSIONS, verifyPassword } from '../auth.js';
import { bad, HttpError } from '../util.js';

export default function authRoutes(db) {
  const r = express.Router();

  r.post('/login', (req, res) => {
    const { login, password } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE login = ? AND active = 1').get(String(login || '').trim().toLowerCase());
    if (!u || !verifyPassword(password || '', u.pass_hash)) throw new HttpError(401, 'Неверный логин или пароль');
    const token = createSession(db, u.id);
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
    res.json({ token, user: publicUser(u) });
  });

  r.use(authMiddleware(db));

  r.get('/me', (req, res) => res.json({ user: publicUser(req.user) }));

  r.post('/logout', (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    res.json({ ok: true });
  });

  r.post('/password', (req, res) => {
    const { current, next } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(current || '', u.pass_hash)) throw bad('Текущий пароль указан неверно');
    if (!next || String(next).length < 6) throw bad('Новый пароль — не короче 6 символов');
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(next), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(u.id, req.token);
    res.json({ ok: true });
  });

  return r;
}

export function publicUser(u) {
  return {
    id: u.id, login: u.login, name: u.name, role: u.role, employee_id: u.employee_id ?? null,
    permissions: PERMISSIONS[u.role] || [],
  };
}
