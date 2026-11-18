import { calendarFor } from '../settings.js';
import { nowIso } from '../db.js';
import { bad, notFound } from '../util.js';

export function stopTaskClock(db, task, at) {
  const start = task.active_since || task.started_at;
  const cal = calendarFor(db);
  const minutes = task.status === 'in_progress' && start ? Math.max(0, cal.toWork(at) - cal.toWork(start)) : 0;
  if (minutes > 0) db.prepare(`INSERT INTO task_work_sessions(task_id, employee_id, started_at, ended_at, minutes)
    VALUES (?, ?, ?, ?, ?)`).run(task.id, task.employee_id, start, at, minutes);
  const elapsed = (task.elapsed_minutes || 0) + minutes;
  db.prepare('UPDATE tasks SET elapsed_minutes = ?, active_since = NULL WHERE id = ?').run(elapsed, task.id);
  return elapsed;
}

// All selected repairs are checked before any changes: no partial batch updates.
export function setRepairPause(db, ids, paused, reason = '') {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw bad('Выберите ремонты');
  const unique = [...new Set(ids)];
  return db.transaction(() => {
    const orders = unique.map(id => db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(id));
    if (orders.some(o => !o)) throw notFound('Ремонт');
    if (orders.some(o => ['done', 'cancelled', 'draft'].includes(o.status))) throw bad('Можно приостановить или возобновить только открытые ремонты');
    const at = nowIso();
    for (const order of orders) {
      if (!!order.paused_at === paused) continue;
      if (paused) {
        for (const task of db.prepare("SELECT * FROM tasks WHERE order_id = ? AND status IN ('planned','in_progress')").all(order.id)) {
          if (task.status === 'in_progress') stopTaskClock(db, task, at);
          db.prepare(`UPDATE tasks SET order_pause_state = status,
            status = CASE WHEN status = 'in_progress' THEN 'paused' ELSE status END, updated_at = ? WHERE id = ?`).run(at, task.id);
        }
        db.prepare(`DELETE FROM schedule WHERE task_id IN (SELECT id FROM tasks WHERE order_id = ? AND status NOT IN ('done','cancelled'))`).run(order.id);
      } else {
        db.prepare(`UPDATE tasks SET status = 'planned', order_pause_state = NULL, active_since = NULL, updated_at = ?
          WHERE order_id = ? AND order_pause_state IS NOT NULL AND status NOT IN ('done','cancelled')`).run(at, order.id);
      }
      db.prepare('UPDATE repair_orders SET paused_at = ?, pause_reason = ?, updated_at = ? WHERE id = ?')
        .run(paused ? at : null, paused ? String(reason).trim().slice(0, 1000) : null, at, order.id);
    }
    return unique;
  })();
}
