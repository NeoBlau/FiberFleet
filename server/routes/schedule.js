import express from 'express';
import { requirePerm } from '../auth.js';
import { json } from '../db.js';
import { fleetMaintenance } from '../domain/maintenance.js';
import { calendarFor } from '../settings.js';
import { replan } from '../services/orders.js';

const DAY = 86400000;

export default function scheduleRoutes(db) {
  const r = express.Router();

  const entries = (from, to, employeeId) => db.prepare(`SELECT s.id, s.task_id, s.employee_id, s.start_at, s.end_at, s.locked,
      t.description, t.location, t.status, t.priority, t.deadline, t.hours, t.order_id, t.vehicle_type, t.vehicle_id, t.reason,
      o.number AS order_number, e.name AS employee_name,
      CASE t.vehicle_type WHEN 'tractor' THEN tr.plate ELSE tl.plate END AS plate,
      CASE t.vehicle_type WHEN 'tractor' THEN tr.brand || ' ' || COALESCE(tr.model,'') ELSE COALESCE(tl.brand,'') || ' ' || tl.model END AS vehicle_name
    FROM schedule s JOIN tasks t ON t.id = s.task_id
    LEFT JOIN repair_orders o ON o.id = t.order_id
    LEFT JOIN employees e ON e.id = s.employee_id
    LEFT JOIN tractors tr ON t.vehicle_type = 'tractor' AND tr.id = t.vehicle_id
    LEFT JOIN trailers tl ON t.vehicle_type = 'trailer' AND tl.id = t.vehicle_id
    WHERE s.end_at > @from AND s.start_at < @to AND t.status <> 'cancelled' ${employeeId ? 'AND s.employee_id = @emp' : ''}
    ORDER BY s.start_at`).all({ from, to, emp: employeeId });

  r.get('/schedule', (req, res) => {
    const cal = calendarFor(db);
    const from = req.query.from || cal.localDayStart(new Date());
    const to = req.query.to || new Date(new Date(from).getTime() + 7 * DAY).toISOString();
    let emp = req.query.employee_id ? Number(req.query.employee_id) : null;
    if (req.user.role === 'mechanic') emp = req.user.employee_id || -1; // слесарь видит только своё расписание
    const employees = db.prepare('SELECT id, name, position, is_external FROM employees WHERE active = 1 ORDER BY is_external, name').all()
      .filter((e) => !emp || e.id === emp);
    res.json({ from, to, employees, entries: entries(from, to, emp) });
  });

  r.post('/schedule/rebuild', requirePerm('plan.write'), (_req, res) => {
    const result = replan(db);
    res.json({ placed: result.placed.size, unschedulable: result.unschedulable.size });
  });

  // Экран оператора: что каждый делает сейчас и что дальше
  r.get('/schedule/monitor', (_req, res) => {
    const cal = calendarFor(db);
    const now = new Date();
    const dayStart = cal.localDayStart(now);
    const dayEnd = new Date(new Date(dayStart).getTime() + DAY).toISOString();
    const nowIso = now.toISOString();
    const list = entries(dayStart, new Date(now.getTime() + 3 * DAY).toISOString(), null);
    const employees = db.prepare('SELECT id, name, position, is_external FROM employees WHERE active = 1 ORDER BY is_external, name').all();
    const board = employees.map((e) => {
      const mine = list.filter((x) => x.employee_id === e.id);
      const current = mine.find((x) => x.status === 'in_progress' || x.status === 'paused')
        || mine.find((x) => x.status === 'planned' && x.start_at <= nowIso && x.end_at > nowIso) || null;
      const next = mine.filter((x) => x.status === 'planned' && x !== current && x.start_at >= (current?.start_at || nowIso)).slice(0, 4);
      const today = mine.filter((x) => x.start_at < dayEnd);
      const busyMin = today.reduce((a, x) => a + Math.max(0, cal.toWork(x.end_at) - cal.toWork(x.start_at)), 0);
      const overdue = mine.filter((x) => x.status === 'planned' && x.end_at < nowIso);
      return { ...e, current, next, today_count: today.length, load: cal.perDay ? Math.round((busyMin / cal.perDay) * 100) : 0, overdue: overdue.length };
    }).filter((e) => !e.is_external || e.current || e.next.length);
    res.json({ now: nowIso, board });
  });

  r.get('/dashboard', (req, res) => {
    const cal = calendarFor(db);
    const now = new Date();
    const dayStart = cal.localDayStart(now);
    const dayEnd = new Date(new Date(dayStart).getTime() + DAY).toISOString();
    const orders = db.prepare(`SELECT o.id, o.number, o.status, o.release_deadline, o.plan_errors, tr.plate AS tractor_plate, tl.plate AS trailer_plate,
        (SELECT COUNT(*) FROM tasks t WHERE t.order_id = o.id AND t.status <> 'cancelled') AS total,
        (SELECT COUNT(*) FROM tasks t WHERE t.order_id = o.id AND t.status = 'done') AS done,
        (SELECT MAX(s.end_at) FROM schedule s JOIN tasks t ON t.id = s.task_id WHERE t.order_id = o.id AND t.status <> 'cancelled') AS planned_end
      FROM repair_orders o LEFT JOIN tractors tr ON tr.id = o.tractor_id LEFT JOIN trailers tl ON tl.id = o.trailer_id
      WHERE o.status IN ('planned','plan_error','approved','in_progress') ORDER BY o.inspected_at`).all()
      .map((o) => ({ ...o, errors: json(o.plan_errors, []), plan_errors: undefined }));
    const today = entries(dayStart, dayEnd, req.user.role === 'mechanic' ? req.user.employee_id || -1 : null);
    const maint = fleetMaintenance(db, now).filter((m) => m.status === 'overdue' || m.status === 'soon');
    const kpi = db.prepare(`SELECT
        (SELECT COUNT(*) FROM tasks WHERE status = 'done' AND finished_at >= ?) AS done_30,
        (SELECT COALESCE(SUM(price),0) FROM tasks WHERE status = 'done' AND finished_at >= ?) AS revenue_30,
        (SELECT COUNT(*) FROM tasks WHERE status IN ('planned','in_progress','paused')) AS open_tasks,
        (SELECT COUNT(*) FROM tractors WHERE archived = 0) AS tractors,
        (SELECT COUNT(*) FROM trailers WHERE archived = 0) AS trailers`).get(
      new Date(now.getTime() - 30 * DAY).toISOString(), new Date(now.getTime() - 30 * DAY).toISOString());
    res.json({ orders, today, maintenance: maint.slice(0, 20), maintenance_total: maint.length, kpi });
  });

  return r;
}
