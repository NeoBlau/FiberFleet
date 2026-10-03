import { json, nowIso } from '../db.js';
import { calendarFor, getSettings } from '../settings.js';
import { generatePlan, validatePlan } from '../domain/planner.js';
import { rebuildSchedule } from '../domain/scheduler.js';
import { recordMileage } from '../domain/maintenance.js';
import { bad, fmtDateTime, notFound } from '../util.js';

export function nextOrderNumber(db) {
  const year = new Date().getFullYear();
  const row = db.prepare(`SELECT number FROM repair_orders WHERE number LIKE ? ORDER BY id DESC LIMIT 1`).get(`${year}-%`);
  const n = row ? Number(row.number.split('-')[1]) + 1 : 1;
  return `${year}-${String(n).padStart(4, '0')}`;
}

const getTractor = (db, id) => (id ? db.prepare('SELECT * FROM tractors WHERE id = ?').get(id) : null);
const getTrailer = (db, id) => (id ? db.prepare('SELECT * FROM trailers WHERE id = ?').get(id) : null);

export function previewPlan(db, input) {
  const tractor = getTractor(db, input.tractor_id);
  const trailer = getTrailer(db, input.trailer_id);
  if (!tractor && !trailer) throw bad('Выберите тягач и/или прицеп');
  return generatePlan(db, {
    tractor, trailer, cal: calendarFor(db),
    defects: input.defects || {},
    inspected_at: input.inspected_at || nowIso(),
    release_deadline: input.release_deadline || null,
    tractor_mileage: input.tractor_mileage ?? null,
    trailer_mileage: input.trailer_mileage ?? null,
  });
}

function insertTasks(db, orderId, tasks) {
  const ins = db.prepare(`INSERT INTO tasks(order_id, vehicle_type, vehicle_id, work_type_id, description, location, reason,
    source, seq, priority, deadline, hours, price, salary, mileage, status, registered_at)
    VALUES (@order_id, @vehicle_type, @vehicle_id, @work_type_id, @description, @location, @reason,
    @source, @seq, @priority, @deadline, @hours, @price, @salary, @mileage, 'planned', @registered_at)`);
  const ts = nowIso();
  for (const t of tasks) {
    ins.run({
      order_id: orderId, vehicle_type: t.vehicle_type, vehicle_id: t.vehicle_id, work_type_id: t.work_type_id,
      description: t.description, location: t.location, reason: t.reason, source: t.source, seq: t.seq,
      priority: t.priority, deadline: t.deadline, hours: t.hours, price: t.price ?? null, salary: t.salary ?? null,
      mileage: t.mileage ?? null, registered_at: ts,
    });
  }
}

/** Создать ремонт из дефектовки: план ремонта + расписание. */
export function createOrder(db, input, user) {
  const plan = previewPlan(db, input);
  const tx = db.transaction(() => {
    const number = nextOrderNumber(db);
    const inspectedAt = input.inspected_at || nowIso();
    const res = db.prepare(`INSERT INTO repair_orders(number, tractor_id, trailer_id, tractor_mileage, trailer_mileage, reefer_hours,
      inspected_at, release_deadline, status, defects, inspection, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?)`).run(
      number, input.tractor_id || null, input.trailer_id || null,
      input.tractor_mileage ?? null, input.trailer_mileage ?? null, input.reefer_hours ?? null,
      inspectedAt, input.release_deadline || null,
      JSON.stringify(input.defects || {}),
      JSON.stringify({ zones: plan.inspection, damages: plan.damages, recommendations: plan.recommendations, warnings: plan.warnings }),
      input.notes || null, user?.id ?? null,
    );
    const orderId = Number(res.lastInsertRowid);
    insertTasks(db, orderId, plan.tasks);
    if (input.tractor_id && input.tractor_mileage) {
      recordMileage(db, { type: 'tractor', id: input.tractor_id, mileage: input.tractor_mileage, at: inspectedAt, source: 'defect', refId: orderId, userId: user?.id });
    }
    if (input.trailer_id && input.trailer_mileage) {
      recordMileage(db, { type: 'trailer', id: input.trailer_id, mileage: input.trailer_mileage, at: inspectedAt, source: 'defect', refId: orderId, userId: user?.id });
    }
    if (input.trailer_id && input.reefer_hours) {
      db.prepare('UPDATE trailers SET reefer_hours = ? WHERE id = ?').run(input.reefer_hours, input.trailer_id);
    }
    // если прицеп сцеплен с другим тягачом — обновить сцепку
    if (input.tractor_id && input.trailer_id) {
      db.prepare('UPDATE tractors SET trailer_id = NULL WHERE trailer_id = ? AND id <> ?').run(input.trailer_id, input.tractor_id);
      db.prepare('UPDATE tractors SET trailer_id = ? WHERE id = ?').run(input.trailer_id, input.tractor_id);
    }
    audit(db, user, 'order', orderId, 'create', `Ремонт ${number}: ${plan.tasks.length} работ`);
    return orderId;
  });
  const orderId = tx();
  replan(db, orderId);
  return orderId;
}

/** Пересчитать расписание по ремонту (или по всем) и сохранить ошибки планирования. */
export function replan(db, orderId = null, { now = new Date() } = {}) {
  const result = rebuildSchedule(db, { orderIds: orderId ? [orderId] : null, now });
  const ids = orderId ? [orderId] : result.orderIds;
  for (const id of ids) refreshOrderState(db, id, { unschedulable: result.unschedulable, now });
  return result;
}

export function refreshOrderState(db, orderId, { unschedulable = new Map(), now = new Date() } = {}) {
  const order = db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(orderId);
  if (!order) return null;
  const tasks = db.prepare('SELECT * FROM tasks WHERE order_id = ?').all(orderId);
  const sched = db.prepare('SELECT s.* FROM schedule s JOIN tasks t ON t.id = s.task_id WHERE t.order_id = ?').all(orderId);
  const scheduleByTask = new Map(sched.map((s) => [s.task_id, s]));
  const off = Number(getSettings(db).tz_offset_min ?? 180);
  // задачи без строки расписания, но в статусе planned — тоже ошибка
  for (const t of tasks) {
    if (t.status === 'planned' && !scheduleByTask.has(t.id) && !unschedulable.has(t.id)
      && ['planned', 'plan_error', 'approved', 'in_progress'].includes(order.status)) {
      unschedulable.set(t.id, 'не поставлена в расписание — нажмите «Пересчитать расписание»');
    }
  }
  const errors = validatePlan(order, tasks, { scheduleByTask, unschedulable, now, fmtDate: (iso) => fmtDateTime(iso, off) });

  let status = order.status;
  const live = tasks.filter((t) => t.status !== 'cancelled');
  if (['planned', 'plan_error', 'approved', 'in_progress'].includes(status)) {
    if (live.length && live.every((t) => t.status === 'done')) status = 'done';
    else if (live.some((t) => ['in_progress', 'paused', 'done'].includes(t.status))) status = 'in_progress';
    else if (status !== 'approved') status = errors.length ? 'plan_error' : 'planned';
  }
  if (status === 'done' && order.status !== 'done') {
    db.prepare('UPDATE repair_orders SET closed_at = ? WHERE id = ?').run(nowIso(), orderId);
  }
  db.prepare('UPDATE repair_orders SET plan_errors = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(errors), status, nowIso(), orderId);
  return { status, errors };
}

export function loadOrder(db, id) {
  const o = db.prepare(`SELECT o.*, tr.plate AS tractor_plate, tr.brand AS tractor_brand, tr.model AS tractor_model,
      tl.plate AS trailer_plate, tl.brand AS trailer_brand, tl.model AS trailer_model, u.name AS created_by_name
    FROM repair_orders o
    LEFT JOIN tractors tr ON tr.id = o.tractor_id
    LEFT JOIN trailers tl ON tl.id = o.trailer_id
    LEFT JOIN users u ON u.id = o.created_by
    WHERE o.id = ?`).get(id);
  if (!o) throw notFound('Ремонт');
  o.defects = json(o.defects, {});
  o.inspection = json(o.inspection, {});
  o.plan_errors = json(o.plan_errors, []);
  o.tasks = db.prepare(`SELECT t.*, w.category, w.code AS work_code, e.name AS employee_name,
      s.start_at, s.end_at, s.locked, s.employee_id AS scheduled_employee_id
    FROM tasks t
    LEFT JOIN work_types w ON w.id = t.work_type_id
    LEFT JOIN employees e ON e.id = t.employee_id
    LEFT JOIN schedule s ON s.task_id = t.id
    WHERE t.order_id = ? ORDER BY t.seq, t.priority, COALESCE(s.start_at, '9999'), t.id`).all(id);
  o.parts = db.prepare('SELECT * FROM installed_parts WHERE order_id = ? ORDER BY installed_at').all(id);
  return o;
}

export function audit(db, user, entity, entityId, action, details) {
  db.prepare('INSERT INTO audit_log(user_id, entity, entity_id, action, details) VALUES (?, ?, ?, ?, ?)')
    .run(user?.id ?? null, entity, entityId ?? null, action, details ?? null);
}
