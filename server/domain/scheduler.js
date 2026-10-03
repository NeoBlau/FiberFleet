// Автоматическое распределение задач между сотрудниками и построение расписания.
//
// Алгоритм — списочное планирование в рабочих минутах:
//  1. Задачи, которые уже выполняются / закреплены вручную / не входят в пересчёт, — фиксированная загрузка.
//  2. Готовой к постановке считается задача, у которой все предшественники (мойка → осмотр → ремонт
//     → регулировки по тому же ТС в том же ремонте) уже поставлены.
//  3. Из готовых берётся самая важная (эффективный приоритет с учётом последователей, затем срок).
//  4. Для каждого допущенного сотрудника считается длительность (норма × его средний коэффициент
//     времени) и самое раннее окно, где свободен и сотрудник, и ТС (не более N человек на одном ТС).
//  5. Выбирается сотрудник с самым ранним окончанием; профильная специализация даёт преимущество.
import { calendarFor, getSettings } from '../settings.js';
import { json } from '../db.js';

const ROUND = 5;
const ceilTo = (v, step) => Math.ceil(v / step) * step;

export function loadEmployees(db) {
  const emps = db.prepare('SELECT * FROM employees WHERE active = 1').all()
    .map((e) => ({ ...e, specializations: json(e.specializations, []) }));
  const access = new Map();
  for (const r of db.prepare('SELECT work_type_id, employee_id FROM work_type_access').all()) {
    if (!access.has(r.work_type_id)) access.set(r.work_type_id, new Set());
    access.get(r.work_type_id).add(r.employee_id);
  }
  return { emps, access };
}

// Кто допущен к работе
export function eligibleEmployees(wt, emps, access) {
  if (!wt) return emps.filter((e) => e.general_access && !e.is_external);
  const allowed = access.get(wt.id) || new Set();
  if (wt.external) return emps.filter((e) => e.is_external || allowed.has(e.id));
  if (wt.required_qualification) {
    const q = wt.required_qualification.toLowerCase();
    return emps.filter((e) => allowed.has(e.id) || `${e.qualification || ''} ${e.position || ''}`.toLowerCase().includes(q));
  }
  if (wt.access_all) return emps.filter((e) => (e.general_access && !e.is_external) || allowed.has(e.id));
  return emps.filter((e) => allowed.has(e.id));
}

// Средний коэффициент «факт / норма» по категориям работ (по выполненным задачам)
export function speedStats(db) {
  const rows = db.prepare(`SELECT t.employee_id, w.category, COUNT(*) n, AVG(t.actual_hours / t.hours) k
    FROM tasks t JOIN work_types w ON w.id = t.work_type_id
    WHERE t.status = 'done' AND t.actual_hours > 0 AND t.hours > 0 AND t.employee_id IS NOT NULL
    GROUP BY t.employee_id, w.category`).all();
  const m = new Map();
  for (const r of rows) m.set(`${r.employee_id}|${r.category}`, r);
  return m;
}

export function factorFor(emp, category, stats) {
  const s = stats.get(`${emp.id}|${category}`);
  if (s && s.n >= 3) return Math.min(2.5, Math.max(0.5, s.k));
  return emp.speed_factor || 1;
}

const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

function maxConcurrent(intervals, s, e) {
  const pts = [];
  for (const [a, b] of intervals) if (overlaps(a, b, s, e)) { pts.push([Math.max(a, s), 1], [Math.min(b, e), -1]); }
  pts.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0, max = 0;
  for (const [, d] of pts) { cur += d; max = Math.max(max, cur); }
  return max;
}

function earliestSlot({ est, dur, empBusy, vehBusy, maxVeh, checkEmp }) {
  const cands = new Set([est]);
  if (checkEmp) for (const [, b] of empBusy) if (b > est) cands.add(b);
  for (const [, b] of vehBusy) if (b > est) cands.add(b);
  for (const c of [...cands].sort((a, b) => a - b)) {
    const e = c + dur;
    if (checkEmp && empBusy.some(([a, b]) => overlaps(a, b, c, e))) continue;
    if (maxVeh > 0 && maxConcurrent(vehBusy, c, e) >= maxVeh) continue;
    return c;
  }
  return null;
}

/**
 * Пересчитать расписание.
 * @param opts.orderIds — пересчитать только задачи этих ремонтов (остальные — фиксированная загрузка); null = все
 * @param opts.now — момент «сейчас»
 * @returns { placed: Map(taskId → {employee_id,start_at,end_at}), unschedulable: Map(taskId → причина) }
 */
export function rebuildSchedule(db, { orderIds = null, now = new Date() } = {}) {
  const settings = getSettings(db);
  const cal = calendarFor(db);
  const maxVeh = Number(settings.max_workers_per_vehicle) || 0;
  const { emps, access } = loadEmployees(db);
  const empById = new Map(emps.map((e) => [e.id, e]));
  const wts = new Map(db.prepare('SELECT * FROM work_types').all().map((w) => [w.id, w]));
  const stats = speedStats(db);
  const nowW = ceilTo(cal.toWork(now), ROUND);

  const activeOrders = db.prepare(`SELECT id FROM repair_orders WHERE status IN ('planned','plan_error','approved','in_progress')`).all().map((r) => r.id);
  const target = new Set(orderIds ? orderIds.filter((id) => activeOrders.includes(id)) : activeOrders);

  const allTasks = db.prepare(`SELECT t.*, s.employee_id AS s_emp, s.start_at AS s_start, s.end_at AS s_end, s.locked AS s_locked
    FROM tasks t LEFT JOIN schedule s ON s.task_id = t.id
    WHERE t.status IN ('planned','in_progress','paused')`).all();

  const empBusy = new Map(emps.map((e) => [e.id, []]));
  const vehBusy = new Map();
  const vkey = (t) => `${t.vehicle_type}:${t.vehicle_id}`;
  const addBusy = (t, empId, s, e) => {
    if (empBusy.has(empId) && !empById.get(empId)?.is_external) empBusy.get(empId).push([s, e]);
    if (!vehBusy.has(vkey(t))) vehBusy.set(vkey(t), []);
    vehBusy.get(vkey(t)).push([s, e]);
  };

  const toPlace = [];
  const fixedEnd = new Map(); // taskId → work-minute end (для предшественников)
  for (const t of allTasks) {
    const movable = target.has(t.order_id) && t.status === 'planned' && !t.s_locked;
    if (movable) { toPlace.push(t); continue; }
    if (t.s_start && t.s_end && t.s_emp) {
      const s = cal.toWork(t.s_start);
      let e = cal.toWork(t.s_end);
      // выполняется дольше плана — сотрудник и ТС заняты как минимум до «сейчас»
      if (t.status !== 'planned' && e < nowW) e = nowW + ROUND;
      addBusy(t, t.s_emp, s, e);
      fixedEnd.set(t.id, e);
    }
  }

  // Предшественники: та же заявка, то же ТС, меньший seq
  const groups = new Map();
  for (const t of allTasks) {
    const g = `${t.order_id}|${vkey(t)}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  const preds = new Map();
  const effPrio = new Map();
  const effDeadline = new Map();
  for (const t of toPlace) {
    const g = groups.get(`${t.order_id}|${vkey(t)}`) || [];
    preds.set(t.id, g.filter((x) => x.seq < t.seq).map((x) => x.id));
    const succ = g.filter((x) => x.seq >= t.seq);
    effPrio.set(t.id, Math.min(...succ.map((x) => x.priority)));
    effDeadline.set(t.id, succ.map((x) => x.deadline).filter(Boolean).sort()[0] || '9999');
  }

  const placed = new Map();
  const unschedulable = new Map();
  const endOf = (id) => (placed.has(id) ? placed.get(id).endW : fixedEnd.get(id));
  const remaining = new Set(toPlace.map((t) => t.id));
  const byId = new Map(toPlace.map((t) => [t.id, t]));

  while (remaining.size) {
    const ready = [...remaining].map((id) => byId.get(id)).filter((t) => preds.get(t.id).every((p) => !remaining.has(p)));
    if (!ready.length) { // защита от цикла
      for (const id of remaining) unschedulable.set(id, 'не удалось упорядочить задачи');
      break;
    }
    ready.sort((a, b) => effPrio.get(a.id) - effPrio.get(b.id)
      || effDeadline.get(a.id).localeCompare(effDeadline.get(b.id))
      || a.order_id - b.order_id || a.seq - b.seq || a.id - b.id);
    const t = ready[0];
    remaining.delete(t.id);

    const predEnds = preds.get(t.id).map(endOf).filter((x) => x != null);
    const est = Math.max(nowW, ...predEnds);
    const wt = wts.get(t.work_type_id);
    let cands = eligibleEmployees(wt, emps, access);
    if (t.assigned_manual && t.employee_id) {
      const m = empById.get(t.employee_id);
      cands = m ? [m] : [];
    }
    if (!cands.length) {
      unschedulable.set(t.id, t.assigned_manual ? 'назначенный сотрудник неактивен' : 'нет сотрудников с допуском к этой работе — настройте допуски в справочнике');
      continue;
    }

    let best = null;
    for (const emp of cands) {
      const factor = factorFor(emp, wt?.category, stats);
      const dur = Math.max(ROUND, ceilTo((t.hours || 1) * 60 * factor, ROUND));
      const s = earliestSlot({
        est, dur, empBusy: empBusy.get(emp.id) || [], vehBusy: vehBusy.get(vkey(t)) || [],
        maxVeh, checkEmp: !emp.is_external,
      });
      if (s == null) continue;
      const spec = wt && emp.specializations.includes(wt.category);
      // внешний сервис — только если сотрудники не справляются: штраф 1 рабочий день
      const score = s + dur + (spec ? 0 : 60) - (emp.level || 2) * 5 + (emp.is_external && !wt?.external ? cal.perDay : 0);
      if (!best || score < best.score) best = { emp, s, dur, score };
    }
    if (!best) { unschedulable.set(t.id, 'не найдено свободное окно'); continue; }
    addBusy(t, best.emp.id, best.s, best.s + best.dur);
    placed.set(t.id, {
      employee_id: best.emp.id, endW: best.s + best.dur,
      start_at: cal.fromWork(best.s), end_at: cal.fromWork(best.s + best.dur, true),
    });
  }

  // Запись результата
  const tx = db.transaction(() => {
    const upsert = db.prepare(`INSERT INTO schedule(task_id, employee_id, vehicle_type, vehicle_id, start_at, end_at, locked)
      VALUES (@task_id, @employee_id, @vehicle_type, @vehicle_id, @start_at, @end_at, 0)
      ON CONFLICT(task_id) DO UPDATE SET employee_id = excluded.employee_id, start_at = excluded.start_at, end_at = excluded.end_at`);
    const setEmp = db.prepare('UPDATE tasks SET employee_id = ?, updated_at = ? WHERE id = ?');
    const del = db.prepare('DELETE FROM schedule WHERE task_id = ?');
    const ts = new Date().toISOString();
    for (const t of toPlace) {
      const p = placed.get(t.id);
      if (!p) { del.run(t.id); if (!t.assigned_manual) setEmp.run(null, ts, t.id); continue; }
      upsert.run({ task_id: t.id, employee_id: p.employee_id, vehicle_type: t.vehicle_type, vehicle_id: t.vehicle_id, start_at: p.start_at, end_at: p.end_at });
      if (t.employee_id !== p.employee_id) setEmp.run(p.employee_id, ts, t.id);
    }
  });
  tx();
  return { placed, unschedulable, orderIds: [...target] };
}
