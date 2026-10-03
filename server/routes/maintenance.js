import express from 'express';
import { requirePerm } from '../auth.js';
import { fleetMaintenance } from '../domain/maintenance.js';
import { bad, notFound, num } from '../util.js';

export default function maintenanceRoutes(db) {
  const r = express.Router();

  r.get('/maintenance', (req, res) => {
    let rows = fleetMaintenance(db);
    if (req.query.status) rows = rows.filter((x) => x.status === req.query.status);
    res.json(rows);
  });

  r.get('/maintenance/rules', (_req, res) => {
    res.json(db.prepare(`SELECT m.*, w.name AS work_name FROM maintenance_rules m LEFT JOIN work_types w ON w.id = m.work_type_id
      ORDER BY m.vehicle_type, m.key, m.brand_match`).all());
  });

  const fields = (b) => ({
    key: String(b.key || '').trim() || 'custom',
    name: String(b.name || '').trim(),
    vehicle_type: b.vehicle_type === 'trailer' ? 'trailer' : 'tractor',
    brand_match: String(b.brand_match || '').trim() || null,
    interval_km: num(b.interval_km),
    interval_days: num(b.interval_days),
    warn_km: num(b.warn_km) ?? 5000,
    warn_days: num(b.warn_days) ?? 14,
    work_type_id: num(b.work_type_id),
    active: b.active === false || b.active === 0 ? 0 : 1,
  });

  const validate = (f) => {
    if (!f.name) throw bad('Укажите название правила');
    if (!f.interval_km && !f.interval_days) throw bad('Укажите интервал в км и/или в днях');
  };

  r.post('/maintenance/rules', requirePerm('maintenance.write'), (req, res) => {
    const f = fields(req.body || {});
    validate(f);
    const id = db.prepare(`INSERT INTO maintenance_rules(key, name, vehicle_type, brand_match, interval_km, interval_days, warn_km, warn_days, work_type_id, active)
      VALUES (@key, @name, @vehicle_type, @brand_match, @interval_km, @interval_days, @warn_km, @warn_days, @work_type_id, @active)`).run(f).lastInsertRowid;
    res.status(201).json({ id });
  });

  r.put('/maintenance/rules/:id', requirePerm('maintenance.write'), (req, res) => {
    const cur = db.prepare('SELECT id FROM maintenance_rules WHERE id = ?').get(req.params.id);
    if (!cur) throw notFound('Правило');
    const f = fields(req.body || {});
    validate(f);
    db.prepare(`UPDATE maintenance_rules SET key=@key, name=@name, vehicle_type=@vehicle_type, brand_match=@brand_match, interval_km=@interval_km,
      interval_days=@interval_days, warn_km=@warn_km, warn_days=@warn_days, work_type_id=@work_type_id, active=@active WHERE id=@id`).run({ ...f, id: cur.id });
    res.json({ ok: true });
  });

  r.delete('/maintenance/rules/:id', requirePerm('maintenance.write'), (req, res) => {
    db.prepare('DELETE FROM maintenance_rules WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // Отметить, что ТО выполнено ранее (до ведения учёта в системе)
  r.post('/maintenance/baseline', requirePerm('maintenance.write'), (req, res) => {
    const b = req.body || {};
    const rule = db.prepare('SELECT * FROM maintenance_rules WHERE id = ?').get(b.rule_id);
    if (!rule) throw notFound('Правило');
    const m = num(b.done_mileage);
    if (m == null && !b.done_at) throw bad('Укажите пробег и/или дату выполнения');
    db.prepare(`INSERT INTO maintenance_baseline(rule_id, vehicle_type, vehicle_id, done_mileage, done_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(rule_id, vehicle_type, vehicle_id) DO UPDATE SET done_mileage = excluded.done_mileage, done_at = excluded.done_at`)
      .run(rule.id, rule.vehicle_type, Number(b.vehicle_id), m, b.done_at || new Date().toISOString());
    res.json({ ok: true });
  });

  return r;
}
