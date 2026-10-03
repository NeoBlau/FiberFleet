import express from 'express';
import { requirePerm } from '../auth.js';
import { nowIso } from '../db.js';
import { recordMileage, vehicleMaintenance } from '../domain/maintenance.js';
import { audit } from '../services/orders.js';
import { bad, normalizePlate, notFound, num } from '../util.js';

const TABLE = { tractor: 'tractors', trailer: 'trailers' };
const FIELDS = {
  tractor: ['plate', 'brand', 'model', 'year', 'vin', 'mileage', 'axles', 'brake_type', 'trailer_id', 'notes', 'archived'],
  trailer: ['plate', 'brand', 'model', 'year', 'vin', 'mileage', 'axles', 'brake_type', 'has_reefer', 'reefer_hours', 'notes', 'archived'],
};

function clean(type, body) {
  const out = {};
  for (const f of FIELDS[type]) {
    if (body[f] === undefined) continue;
    let v = body[f];
    if (['year', 'mileage', 'axles', 'trailer_id', 'reefer_hours'].includes(f)) v = num(v);
    if (['archived', 'has_reefer'].includes(f)) v = v ? 1 : 0;
    if (f === 'plate') v = normalizePlate(v);
    if (typeof v === 'string') v = v.trim() || null;
    out[f] = v;
  }
  if ('plate' in out && !out.plate) throw bad('Укажите госномер');
  if ('axles' in out && (out.axles < 1 || out.axles > 5)) throw bad('Количество осей: от 1 до 5');
  if ('brake_type' in out && !['disc', 'drum'].includes(out.brake_type)) out.brake_type = 'disc';
  return out;
}

export default function vehicleRoutes(db) {
  const r = express.Router();

  r.get('/vehicles/:type(tractor|trailer)', (req, res) => {
    const { type } = req.params;
    const q = `%${normalizePlate(req.query.q || '')}%`;
    const qText = `%${String(req.query.q || '').toUpperCase()}%`;
    const archived = req.query.archived === '1' ? 1 : 0;
    const rows = type === 'tractor'
      ? db.prepare(`SELECT v.*, t.plate AS trailer_plate, t.model AS trailer_model,
            (SELECT COUNT(*) FROM repair_orders o WHERE o.tractor_id = v.id AND o.status IN ('planned','plan_error','approved','in_progress')) AS open_orders
          FROM tractors v LEFT JOIN trailers t ON t.id = v.trailer_id
          WHERE v.archived = ? AND (v.plate LIKE ? OR UPPER(v.brand || ' ' || COALESCE(v.model,'')) LIKE ?)
          ORDER BY v.brand, v.plate`).all(archived, q, qText)
      : db.prepare(`SELECT v.*, t.id AS tractor_id, t.plate AS tractor_plate,
            (SELECT COUNT(*) FROM repair_orders o WHERE o.trailer_id = v.id AND o.status IN ('planned','plan_error','approved','in_progress')) AS open_orders
          FROM trailers v LEFT JOIN tractors t ON t.trailer_id = v.id
          WHERE v.archived = ? AND (v.plate LIKE ? OR UPPER(COALESCE(v.brand,'') || ' ' || v.model) LIKE ?)
          ORDER BY v.brand, v.plate`).all(archived, q, qText);
    res.json(rows);
  });

  r.get('/vehicles/:type(tractor|trailer)/:id', (req, res) => {
    const { type, id } = req.params;
    const v = db.prepare(`SELECT * FROM ${TABLE[type]} WHERE id = ?`).get(id);
    if (!v) throw notFound('ТС');
    if (type === 'tractor' && v.trailer_id) v.trailer = db.prepare('SELECT id, plate, model FROM trailers WHERE id = ?').get(v.trailer_id);
    if (type === 'trailer') v.tractor = db.prepare('SELECT id, plate, brand, model FROM tractors WHERE trailer_id = ?').get(v.id) || null;
    const col = type === 'tractor' ? 'tractor_id' : 'trailer_id';
    v.orders = db.prepare(`SELECT id, number, status, inspected_at, release_deadline, closed_at,
        ${type === 'tractor' ? 'tractor_mileage' : 'trailer_mileage'} AS mileage,
        (SELECT COUNT(*) FROM tasks t WHERE t.order_id = o.id) AS tasks_total,
        (SELECT COUNT(*) FROM tasks t WHERE t.order_id = o.id AND t.status = 'done') AS tasks_done
      FROM repair_orders o WHERE ${col} = ? ORDER BY inspected_at DESC`).all(id);
    v.history = db.prepare(`SELECT t.id, t.order_id, o.number AS order_number, t.description, t.location, t.status, t.registered_at,
        t.finished_at, t.mileage, t.price, t.hours, t.actual_hours, t.reason, e.name AS employee_name, w.category
      FROM tasks t LEFT JOIN repair_orders o ON o.id = t.order_id LEFT JOIN employees e ON e.id = t.employee_id
      LEFT JOIN work_types w ON w.id = t.work_type_id
      WHERE t.vehicle_type = ? AND t.vehicle_id = ? ORDER BY COALESCE(t.finished_at, t.registered_at) DESC`).all(type, id);
    v.mileage_log = db.prepare(`SELECT * FROM mileage_log WHERE vehicle_type = ? AND vehicle_id = ? ORDER BY recorded_at DESC LIMIT 100`).all(type, id);
    v.parts = db.prepare(`SELECT * FROM installed_parts WHERE vehicle_type = ? AND vehicle_id = ? ORDER BY installed_at DESC`).all(type, id);
    v.maintenance = vehicleMaintenance(db, type, v);
    v.totals = db.prepare(`SELECT COUNT(*) works, COALESCE(SUM(price),0) price FROM tasks WHERE vehicle_type = ? AND vehicle_id = ? AND status = 'done'`).get(type, id);
    res.json(v);
  });

  r.post('/vehicles/:type(tractor|trailer)', requirePerm('vehicles.write'), (req, res) => {
    const { type } = req.params;
    const data = clean(type, req.body || {});
    if (!data.plate) throw bad('Укажите госномер');
    if (type === 'tractor' && !data.brand) throw bad('Укажите марку');
    if (type === 'trailer' && !data.model) throw bad('Укажите модель');
    const cols = Object.keys(data);
    const id = db.prepare(`INSERT INTO ${TABLE[type]}(${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(data).lastInsertRowid;
    if (data.mileage) recordMileage(db, { type, id, mileage: data.mileage, source: 'manual', userId: req.user.id });
    if (type === 'tractor' && data.trailer_id) db.prepare('UPDATE tractors SET trailer_id = NULL WHERE trailer_id = ? AND id <> ?').run(data.trailer_id, id);
    audit(db, req.user, type, id, 'create', data.plate);
    res.status(201).json({ id });
  });

  r.put('/vehicles/:type(tractor|trailer)/:id', requirePerm('vehicles.write'), (req, res) => {
    const { type, id } = req.params;
    const cur = db.prepare(`SELECT * FROM ${TABLE[type]} WHERE id = ?`).get(id);
    if (!cur) throw notFound('ТС');
    const data = clean(type, req.body || {});
    const mileage = data.mileage;
    delete data.mileage; // пробег — только через журнал
    if (Object.keys(data).length) {
      db.prepare(`UPDATE ${TABLE[type]} SET ${Object.keys(data).map((c) => `${c} = @${c}`).join(', ')}, updated_at = @ts WHERE id = @id`)
        .run({ ...data, ts: nowIso(), id });
    }
    if (mileage != null && mileage !== cur.mileage) {
      recordMileage(db, { type, id: Number(id), mileage, source: 'manual', userId: req.user.id, allowDecrease: req.body.allow_decrease === true });
    }
    if (type === 'tractor' && data.trailer_id) db.prepare('UPDATE tractors SET trailer_id = NULL WHERE trailer_id = ? AND id <> ?').run(data.trailer_id, id);
    // сцепка со стороны прицепа
    if (type === 'trailer' && req.body.tractor_id !== undefined) {
      db.prepare('UPDATE tractors SET trailer_id = NULL WHERE trailer_id = ?').run(id);
      if (req.body.tractor_id) db.prepare('UPDATE tractors SET trailer_id = ? WHERE id = ?').run(id, req.body.tractor_id);
    }
    audit(db, req.user, type, Number(id), 'update', JSON.stringify(req.body));
    res.json({ ok: true });
  });

  r.delete('/vehicles/:type(tractor|trailer)/:id', requirePerm('vehicles.write'), (req, res) => {
    const { type, id } = req.params;
    const used = db.prepare('SELECT COUNT(*) c FROM tasks WHERE vehicle_type = ? AND vehicle_id = ?').get(type, id).c
      + db.prepare(`SELECT COUNT(*) c FROM repair_orders WHERE ${type === 'tractor' ? 'tractor_id' : 'trailer_id'} = ?`).get(id).c;
    if (used && req.query.hard !== '1') {
      // есть история ремонтов — переносим в архив, чтобы не потерять историю
      db.prepare(`UPDATE ${TABLE[type]} SET archived = 1, updated_at = ? WHERE id = ?`).run(nowIso(), id);
      audit(db, req.user, type, Number(id), 'archive');
      return res.json({ ok: true, archived: true });
    }
    if (type === 'trailer') db.prepare('UPDATE tractors SET trailer_id = NULL WHERE trailer_id = ?').run(id);
    db.prepare('DELETE FROM mileage_log WHERE vehicle_type = ? AND vehicle_id = ?').run(type, id);
    db.prepare(`DELETE FROM ${TABLE[type]} WHERE id = ?`).run(id);
    audit(db, req.user, type, Number(id), 'delete');
    res.json({ ok: true, deleted: true });
  });

  r.post('/vehicles/:type(tractor|trailer)/:id/mileage', requirePerm('vehicles.write'), (req, res) => {
    const { type, id } = req.params;
    const mileage = num(req.body?.mileage);
    if (mileage == null || mileage < 0) throw bad('Укажите пробег');
    const cur = db.prepare(`SELECT mileage FROM ${TABLE[type]} WHERE id = ?`).get(id);
    if (!cur) throw notFound('ТС');
    if (mileage < cur.mileage && !req.body.allow_decrease) {
      throw bad(`Пробег ${mileage} км меньше текущего (${cur.mileage} км). Если это исправление ошибки — подтвердите уменьшение`);
    }
    recordMileage(db, { type, id: Number(id), mileage, at: req.body.at || nowIso(), source: 'manual', userId: req.user.id, allowDecrease: !!req.body.allow_decrease });
    res.json({ ok: true });
  });

  return r;
}
