import express from 'express';
import { requirePerm } from '../auth.js';
import { json, nowIso } from '../db.js';
import { eligibleEmployees, loadEmployees, speedStats } from '../domain/scheduler.js';
import { audit, replan } from '../services/orders.js';
import { bad, notFound, num } from '../util.js';

export default function staffRoutes(db) {
  const r = express.Router();

  // ---------- Сотрудники ----------
  r.get('/employees', (_req, res) => {
    const rows = db.prepare(`SELECT e.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.employee_id = e.id AND t.status IN ('planned','in_progress','paused')) AS open_tasks,
        (SELECT COALESCE(SUM(t.hours),0) FROM tasks t WHERE t.employee_id = e.id AND t.status IN ('planned','in_progress','paused')) AS open_hours,
        (SELECT COUNT(*) FROM work_type_access a WHERE a.employee_id = e.id) AS access_count
      FROM employees e ORDER BY e.active DESC, e.is_external, e.name`).all();
    res.json(rows.map((e) => ({ ...e, specializations: json(e.specializations, []) })));
  });

  r.get('/employees/:id', (req, res) => {
    const e = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    if (!e) throw notFound('Сотрудник');
    e.specializations = json(e.specializations, []);
    e.access = db.prepare('SELECT work_type_id FROM work_type_access WHERE employee_id = ?').all(e.id).map((x) => x.work_type_id);
    // работы, к которым сотрудник допущен (с учётом «Все»)
    const { emps, access } = loadEmployees(db);
    const me = emps.find((x) => x.id === e.id);
    e.allowed_work_ids = me ? db.prepare('SELECT * FROM work_types WHERE active = 1').all()
      .filter((w) => eligibleEmployees(w, emps, access).some((x) => x.id === e.id)).map((w) => w.id) : [];
    e.current_tasks = db.prepare(`SELECT t.id, t.description, t.status, t.priority, t.deadline, t.order_id, o.number AS order_number,
        s.start_at, s.end_at, CASE t.vehicle_type WHEN 'tractor' THEN tr.plate ELSE tl.plate END AS plate
      FROM tasks t LEFT JOIN schedule s ON s.task_id = t.id LEFT JOIN repair_orders o ON o.id = t.order_id
      LEFT JOIN tractors tr ON t.vehicle_type = 'tractor' AND tr.id = t.vehicle_id
      LEFT JOIN trailers tl ON t.vehicle_type = 'trailer' AND tl.id = t.vehicle_id
      WHERE t.employee_id = ? AND t.status IN ('planned','in_progress','paused') ORDER BY COALESCE(s.start_at, t.deadline)`).all(e.id);
    const stats = speedStats(db);
    e.speed_by_category = [...stats.values()].filter((s) => s.employee_id === e.id)
      .map((s) => ({ category: s.category, tasks: s.n, factor: Math.round(s.k * 100) / 100 }));
    e.totals = db.prepare(`SELECT COUNT(*) tasks, COALESCE(SUM(hours),0) norm_hours, COALESCE(SUM(actual_hours),0) actual_hours,
        COALESCE(SUM(salary),0) salary FROM tasks WHERE employee_id = ? AND status = 'done'`).get(e.id);
    res.json(e);
  });

  const empFields = (b) => {
    const out = {};
    for (const f of ['name', 'position', 'qualification', 'phone']) if (b[f] !== undefined) out[f] = (b[f] || '').trim() || null;
    if (b.level !== undefined) out.level = Math.min(3, Math.max(1, Number(b.level) || 2));
    if (b.speed_factor !== undefined) {
      const k = num(b.speed_factor);
      if (!(k >= 0.3 && k <= 3)) throw bad('Коэффициент времени — от 0,3 до 3');
      out.speed_factor = k;
    }
    if (b.specializations !== undefined) out.specializations = JSON.stringify(Array.isArray(b.specializations) ? b.specializations : []);
    for (const f of ['is_external', 'general_access', 'active']) if (b[f] !== undefined) out[f] = b[f] ? 1 : 0;
    return out;
  };

  r.post('/employees', requirePerm('employees.write'), (req, res) => {
    const data = empFields(req.body || {});
    if (!data.name) throw bad('Укажите имя сотрудника');
    const cols = Object.keys(data);
    const id = db.prepare(`INSERT INTO employees(${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(data).lastInsertRowid;
    if (Array.isArray(req.body.access)) setEmployeeAccess(db, id, req.body.access);
    audit(db, req.user, 'employee', id, 'create', data.name);
    replan(db);
    res.status(201).json({ id });
  });

  r.put('/employees/:id', requirePerm('employees.write'), (req, res) => {
    const e = db.prepare('SELECT id FROM employees WHERE id = ?').get(req.params.id);
    if (!e) throw notFound('Сотрудник');
    const data = empFields(req.body || {});
    if ('name' in data && !data.name) throw bad('Укажите имя сотрудника');
    if (Object.keys(data).length) {
      db.prepare(`UPDATE employees SET ${Object.keys(data).map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...data, id: e.id });
    }
    if (Array.isArray(req.body.access)) setEmployeeAccess(db, e.id, req.body.access);
    if (data.active === 0) {
      // уволен/неактивен — снять с непринятых в работу задач
      db.prepare(`UPDATE tasks SET employee_id = NULL, assigned_manual = 0 WHERE employee_id = ? AND status = 'planned'`).run(e.id);
      db.prepare(`DELETE FROM schedule WHERE employee_id = ? AND task_id IN (SELECT id FROM tasks WHERE status = 'planned')`).run(e.id);
    }
    audit(db, req.user, 'employee', e.id, 'update', JSON.stringify(req.body));
    replan(db);
    res.json({ ok: true });
  });

  r.delete('/employees/:id', requirePerm('employees.write'), (req, res) => {
    const id = Number(req.params.id);
    const used = db.prepare('SELECT COUNT(*) c FROM tasks WHERE employee_id = ? AND status = \'done\'').get(id).c;
    if (used) {
      db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(id);
    } else {
      db.prepare('UPDATE tasks SET employee_id = NULL, assigned_manual = 0 WHERE employee_id = ?').run(id);
      db.prepare('DELETE FROM employees WHERE id = ?').run(id);
    }
    audit(db, req.user, 'employee', id, used ? 'deactivate' : 'delete');
    replan(db);
    res.json({ ok: true, deactivated: !!used });
  });

  // ---------- Справочник работ ----------
  r.get('/work-types', (req, res) => {
    const rows = db.prepare(`SELECT w.*, (SELECT group_concat(employee_id) FROM work_type_access a WHERE a.work_type_id = w.id) AS access_ids,
        (SELECT COUNT(*) FROM tasks t WHERE t.work_type_id = w.id) AS used
      FROM work_types w ${req.query.all === '1' ? '' : 'WHERE w.active = 1'} ORDER BY w.category, w.name`).all();
    res.json(rows.map((w) => ({ ...w, access: w.access_ids ? String(w.access_ids).split(',').map(Number) : [], access_ids: undefined })));
  });

  const wtFields = (b) => {
    const out = {};
    for (const f of ['category', 'name', 'note', 'required_qualification']) if (b[f] !== undefined) out[f] = (b[f] || '').trim() || null;
    if (b.applies_to !== undefined) out.applies_to = ['tractor', 'trailer', 'any'].includes(b.applies_to) ? b.applies_to : 'any';
    for (const f of ['hours', 'hours_max', 'price', 'price_max', 'salary', 'salary_max']) if (b[f] !== undefined) out[f] = num(b[f]);
    for (const f of ['access_all', 'external', 'active']) if (b[f] !== undefined) out[f] = b[f] ? 1 : 0;
    if ('hours' in out && !(out.hours > 0)) throw bad('Норма времени должна быть больше 0');
    return out;
  };

  r.post('/work-types', requirePerm('catalog.write'), (req, res) => {
    const data = wtFields(req.body || {});
    if (!data.name || !data.category) throw bad('Укажите категорию и название работы');
    if (!data.hours) throw bad('Укажите норму времени');
    const last = db.prepare("SELECT code FROM work_types WHERE code LIKE 'W%' ORDER BY CAST(SUBSTR(code, 2) AS INTEGER) DESC LIMIT 1").get();
    data.code = req.body.code?.trim() || `W${String((last ? Number(last.code.slice(1)) : 0) + 1).padStart(3, '0')}`;
    const cols = Object.keys(data);
    const id = db.prepare(`INSERT INTO work_types(${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(data).lastInsertRowid;
    if (Array.isArray(req.body.access)) setWorkAccess(db, id, req.body.access);
    audit(db, req.user, 'work_type', id, 'create', data.name);
    res.status(201).json({ id });
  });

  r.put('/work-types/:id', requirePerm('catalog.write'), (req, res) => {
    const w = db.prepare('SELECT * FROM work_types WHERE id = ?').get(req.params.id);
    if (!w) throw notFound('Работа');
    const data = wtFields(req.body || {});
    if (req.body.code !== undefined && req.body.code.trim()) data.code = req.body.code.trim();
    if (Object.keys(data).length) {
      db.prepare(`UPDATE work_types SET ${Object.keys(data).map((c) => `${c} = @${c}`).join(', ')}, updated_at = @ts WHERE id = @id`)
        .run({ ...data, ts: nowIso(), id: w.id });
    }
    if (Array.isArray(req.body.access)) setWorkAccess(db, w.id, req.body.access);
    // обновить цену/норму в ещё не начатых работах
    if (req.body.apply_to_open) {
      db.prepare(`UPDATE tasks SET hours = @hours, price = @price, salary = @salary WHERE work_type_id = @id AND status = 'planned'`)
        .run({ id: w.id, hours: data.hours ?? w.hours, price: data.price ?? w.price, salary: data.salary ?? w.salary });
    }
    audit(db, req.user, 'work_type', w.id, 'update', JSON.stringify(req.body));
    if (req.body.access || 'access_all' in data || 'external' in data || req.body.apply_to_open) replan(db);
    res.json({ ok: true });
  });

  r.delete('/work-types/:id', requirePerm('catalog.write'), (req, res) => {
    const id = Number(req.params.id);
    const used = db.prepare('SELECT COUNT(*) c FROM tasks WHERE work_type_id = ?').get(id).c;
    if (used) db.prepare('UPDATE work_types SET active = 0 WHERE id = ?').run(id);
    else db.prepare('DELETE FROM work_types WHERE id = ?').run(id);
    audit(db, req.user, 'work_type', id, used ? 'deactivate' : 'delete');
    res.json({ ok: true, deactivated: !!used });
  });

  return r;
}

function setEmployeeAccess(db, employeeId, workTypeIds) {
  db.transaction(() => {
    db.prepare('DELETE FROM work_type_access WHERE employee_id = ?').run(employeeId);
    const ins = db.prepare('INSERT OR IGNORE INTO work_type_access(work_type_id, employee_id) VALUES (?, ?)');
    for (const w of workTypeIds) ins.run(Number(w), employeeId);
  })();
}

function setWorkAccess(db, workTypeId, employeeIds) {
  db.transaction(() => {
    db.prepare('DELETE FROM work_type_access WHERE work_type_id = ?').run(workTypeId);
    const ins = db.prepare('INSERT OR IGNORE INTO work_type_access(work_type_id, employee_id) VALUES (?, ?)');
    for (const e of employeeIds) ins.run(workTypeId, Number(e));
  })();
}
