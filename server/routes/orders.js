import express from 'express';
import { can, requirePerm } from '../auth.js';
import { nowIso } from '../db.js';
import { publicTemplate, PRIORITIES } from '../domain/checklist.js';
import { factorFor, loadEmployees, speedStats } from '../domain/scheduler.js';
import { recordMileage } from '../domain/maintenance.js';
import { calendarFor } from '../settings.js';
import { audit, createOrder, loadOrder, previewPlan, refreshOrderState, replan } from '../services/orders.js';
import { bad, HttpError, notFound, num } from '../util.js';

const ACTIVE = ['planned', 'plan_error', 'approved', 'in_progress'];

export default function orderRoutes(db) {
  const r = express.Router();

  r.get('/checklist', (_req, res) => res.json(publicTemplate()));

  r.get('/orders', (req, res) => {
    const where = [];
    const p = {};
    const st = req.query.status || 'active';
    if (st === 'active') where.push(`o.status IN (${ACTIVE.map((s) => `'${s}'`).join(',')})`);
    else if (st !== 'all') { where.push('o.status = @status'); p.status = st; }
    if (req.query.q) {
      where.push(`(o.number LIKE @q OR tr.plate LIKE @q OR tl.plate LIKE @q)`);
      p.q = `%${String(req.query.q).toUpperCase().replace(/\s+/g, '')}%`;
    }
    if (req.query.from) { where.push('o.inspected_at >= @from'); p.from = req.query.from; }
    if (req.query.to) { where.push('o.inspected_at < @to'); p.to = req.query.to; }
    if (req.query.vehicle_type && req.query.vehicle_id) {
      where.push(req.query.vehicle_type === 'tractor' ? 'o.tractor_id = @vid' : 'o.trailer_id = @vid');
      p.vid = Number(req.query.vehicle_id);
    }
    const rows = db.prepare(`SELECT o.id, o.number, o.status, o.inspected_at, o.release_deadline, o.closed_at, o.plan_errors,
        o.tractor_id, o.trailer_id, tr.plate AS tractor_plate, tr.brand AS tractor_brand, tr.model AS tractor_model,
        tl.plate AS trailer_plate, tl.model AS trailer_model,
        (SELECT COUNT(*) FROM tasks t WHERE t.order_id = o.id AND t.status <> 'cancelled') AS tasks_total,
        (SELECT COUNT(*) FROM tasks t WHERE t.order_id = o.id AND t.status = 'done') AS tasks_done,
        (SELECT MIN(priority) FROM tasks t WHERE t.order_id = o.id AND t.status NOT IN ('done','cancelled')) AS top_priority,
        (SELECT MAX(s.end_at) FROM schedule s JOIN tasks t ON t.id = s.task_id WHERE t.order_id = o.id AND t.status <> 'cancelled') AS planned_end,
        (SELECT COALESCE(SUM(price),0) FROM tasks t WHERE t.order_id = o.id AND t.status <> 'cancelled') AS total_price
      FROM repair_orders o LEFT JOIN tractors tr ON tr.id = o.tractor_id LEFT JOIN trailers tl ON tl.id = o.trailer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY o.inspected_at DESC LIMIT 500`).all(p);
    for (const o of rows) o.error_count = JSON.parse(o.plan_errors || '[]').length, delete o.plan_errors;
    res.json(rows);
  });

  r.post('/orders/preview', requirePerm('orders.write'), (req, res) => {
    res.json(previewPlan(db, req.body || {}));
  });

  r.post('/orders', requirePerm('orders.write'), (req, res) => {
    const b = req.body || {};
    if (!b.tractor_id && !b.trailer_id) throw bad('Выберите тягач и/или прицеп');
    if (b.release_deadline && b.release_deadline < nowIso()) throw bad('Дата выпуска с ремонта уже прошла');
    const id = createOrder(db, {
      ...b,
      tractor_mileage: num(b.tractor_mileage), trailer_mileage: num(b.trailer_mileage), reefer_hours: num(b.reefer_hours),
    }, req.user);
    res.status(201).json(loadOrder(db, id));
  });

  r.get('/orders/:id', (req, res) => res.json(loadOrder(db, req.params.id)));

  r.put('/orders/:id', requirePerm('orders.write'), (req, res) => {
    const o = db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(req.params.id);
    if (!o) throw notFound('Ремонт');
    const b = req.body || {};
    const tx = db.transaction(() => {
      if (b.notes !== undefined) db.prepare('UPDATE repair_orders SET notes = ? WHERE id = ?').run(b.notes || null, o.id);
      if (b.release_deadline !== undefined && b.release_deadline !== o.release_deadline) {
        db.prepare('UPDATE repair_orders SET release_deadline = ? WHERE id = ?').run(b.release_deadline || null, o.id);
        // пересчитать автоматические сроки
        const cal = calendarFor(db);
        for (const t of db.prepare(`SELECT id, priority FROM tasks WHERE order_id = ? AND deadline_manual = 0 AND status NOT IN ('done','cancelled')`).all(o.id)) {
          const dl = b.release_deadline || cal.addWorkDays(o.inspected_at, PRIORITIES[t.priority]?.days ?? 5);
          db.prepare('UPDATE tasks SET deadline = ? WHERE id = ?').run(dl, t.id);
        }
      }
      for (const [k, type] of [['tractor_mileage', 'tractor'], ['trailer_mileage', 'trailer']]) {
        if (b[k] === undefined) continue;
        const m = num(b[k]);
        db.prepare(`UPDATE repair_orders SET ${k} = ? WHERE id = ?`).run(m, o.id);
        db.prepare(`UPDATE tasks SET mileage = ? WHERE order_id = ? AND vehicle_type = ? AND status <> 'done'`).run(m, o.id, type);
        const vid = type === 'tractor' ? o.tractor_id : o.trailer_id;
        if (m && vid) recordMileage(db, { type, id: vid, mileage: m, source: 'repair', refId: o.id, userId: req.user.id });
      }
    });
    tx();
    audit(db, req.user, 'order', o.id, 'update', JSON.stringify(b));
    replan(db, o.id);
    res.json(loadOrder(db, o.id));
  });

  r.post('/orders/:id/replan', requirePerm('plan.write'), (req, res) => {
    loadOrder(db, req.params.id);
    replan(db, Number(req.params.id));
    res.json(loadOrder(db, req.params.id));
  });

  r.post('/orders/:id/approve', requirePerm('plan.write'), (req, res) => {
    const id = Number(req.params.id);
    replan(db, id);
    const o = loadOrder(db, id);
    if (o.plan_errors.length) {
      throw new HttpError(409, 'План нельзя утвердить: есть ошибки планирования', o.plan_errors);
    }
    if (['planned', 'plan_error'].includes(o.status)) {
      db.prepare("UPDATE repair_orders SET status = 'approved', updated_at = ? WHERE id = ?").run(nowIso(), id);
    }
    audit(db, req.user, 'order', id, 'approve');
    res.json(loadOrder(db, id));
  });

  r.post('/orders/:id/cancel', requirePerm('orders.write'), (req, res) => {
    const id = Number(req.params.id);
    loadOrder(db, id);
    db.transaction(() => {
      db.prepare(`DELETE FROM schedule WHERE task_id IN (SELECT id FROM tasks WHERE order_id = ? AND status <> 'done')`).run(id);
      db.prepare(`UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE order_id = ? AND status NOT IN ('done')`).run(nowIso(), id);
      db.prepare(`UPDATE repair_orders SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ?`).run(nowIso(), nowIso(), id);
    })();
    audit(db, req.user, 'order', id, 'cancel');
    replan(db);
    res.json(loadOrder(db, id));
  });

  r.delete('/orders/:id', requirePerm('orders.delete'), (req, res) => {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM repair_orders WHERE id = ?').run(id);
    audit(db, req.user, 'order', id, 'delete');
    replan(db);
    res.json({ ok: true });
  });

  // ---- Работы (задачи) ----

  r.post('/orders/:id/tasks', requirePerm('plan.write'), (req, res) => {
    const o = db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(req.params.id);
    if (!o) throw notFound('Ремонт');
    if (['done', 'cancelled'].includes(o.status)) throw bad('Ремонт закрыт — добавление работ невозможно');
    const b = req.body || {};
    const wt = db.prepare('SELECT * FROM work_types WHERE id = ?').get(b.work_type_id);
    if (!wt) throw bad('Выберите работу из справочника');
    const vt = b.vehicle_type === 'trailer' ? 'trailer' : 'tractor';
    const vid = vt === 'tractor' ? o.tractor_id : o.trailer_id;
    if (!vid) throw bad(vt === 'tractor' ? 'В ремонте нет тягача' : 'В ремонте нет прицепа');
    const priority = Math.min(4, Math.max(1, Number(b.priority) || 2));
    const cal = calendarFor(db);
    const deadline = b.deadline || o.release_deadline || cal.addWorkDays(nowIso(), PRIORITIES[priority].days);
    const id = db.prepare(`INSERT INTO tasks(order_id, vehicle_type, vehicle_id, work_type_id, description, location, reason, source, seq,
        priority, priority_manual, deadline, deadline_manual, hours, price, salary, mileage, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, 1, ?, ?, ?, ?, ?, ?, 'planned')`).run(
      o.id, vt, vid, wt.id, wt.name, b.location || null, b.comment ? `Добавлено вручную: ${b.comment}` : 'Добавлено вручную',
      /^(диагност|осмотр|тест)/i.test(wt.name) ? 1 : 2, priority, deadline, b.deadline ? 1 : 0,
      num(b.hours) ?? wt.hours, wt.price, wt.salary, vt === 'tractor' ? o.tractor_mileage : o.trailer_mileage,
    ).lastInsertRowid;
    if (o.status === 'approved') db.prepare("UPDATE repair_orders SET status = 'planned' WHERE id = ?").run(o.id);
    audit(db, req.user, 'task', id, 'create', wt.name);
    replan(db, o.id);
    res.status(201).json(loadOrder(db, o.id));
  });

  r.put('/tasks/:id', (req, res) => {
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!t) throw notFound('Работа');
    const b = req.body || {};
    const planFields = ['priority', 'deadline', 'hours', 'description', 'location', 'comment', 'price', 'salary', 'seq'];
    const reassign = b.employee_id !== undefined || b.start_at !== undefined || b.unlock !== undefined;
    if (planFields.some((f) => b[f] !== undefined) && !can(req.user, 'plan.write')) throw new HttpError(403, 'Недостаточно прав для корректировки плана');
    if (reassign && !can(req.user, 'tasks.reassign')) throw new HttpError(403, 'Переназначать задачи может только администратор');
    if (['done', 'cancelled'].includes(t.status) && planFields.some((f) => ['priority', 'deadline', 'hours'].includes(f) && b[f] !== undefined)) {
      throw bad('Работа уже закрыта');
    }

    const tx = db.transaction(() => {
      const set = {};
      if (b.priority !== undefined) {
        const p = Number(b.priority);
        if (!(p >= 1 && p <= 4)) throw bad('Приоритет: от 1 до 4');
        set.priority = p; set.priority_manual = 1;
      }
      if (b.deadline !== undefined) { set.deadline = b.deadline || null; set.deadline_manual = 1; }
      if (b.hours !== undefined) { const h = num(b.hours); if (!(h > 0)) throw bad('Норма времени должна быть больше 0'); set.hours = h; }
      for (const f of ['description', 'location', 'comment']) if (b[f] !== undefined) set[f] = b[f] || null;
      for (const f of ['price', 'salary']) if (b[f] !== undefined) set[f] = num(b[f]);
      if (b.seq !== undefined) set.seq = Math.max(0, Math.min(3, Number(b.seq) || 0));
      if (set.description === null) throw bad('Описание работы не может быть пустым');

      if (b.employee_id !== undefined) {
        if (b.employee_id) {
          const e = db.prepare('SELECT id FROM employees WHERE id = ? AND active = 1').get(b.employee_id);
          if (!e) throw bad('Сотрудник не найден');
          set.employee_id = e.id; set.assigned_manual = 1;
        } else {
          set.assigned_manual = 0;
          db.prepare('UPDATE schedule SET locked = 0 WHERE task_id = ?').run(t.id);
        }
      }
      if (Object.keys(set).length) {
        db.prepare(`UPDATE tasks SET ${Object.keys(set).map((k) => `${k} = @${k}`).join(', ')}, updated_at = @ts WHERE id = @id`)
          .run({ ...set, ts: nowIso(), id: t.id });
      }
      // ручная установка времени начала — фиксирует задачу в расписании
      if (b.start_at) {
        const cur = db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id);
        if (!cur.employee_id) throw bad('Сначала выберите исполнителя');
        const cal = calendarFor(db);
        const { emps } = loadEmployees(db);
        const emp = emps.find((e) => e.id === cur.employee_id);
        const wt = cur.work_type_id ? db.prepare('SELECT category FROM work_types WHERE id = ?').get(cur.work_type_id) : null;
        const dur = Math.max(5, Math.ceil(((cur.hours || 1) * 60 * factorFor(emp || {}, wt?.category, speedStats(db))) / 5) * 5);
        const s = cal.toWork(b.start_at);
        const start = cal.fromWork(s), end = cal.fromWork(s + dur, true);
        const overlap = db.prepare(`SELECT t.description FROM schedule s JOIN tasks t ON t.id = s.task_id
          WHERE s.employee_id = ? AND s.task_id <> ? AND t.status IN ('planned','in_progress','paused')
          AND s.start_at < ? AND s.end_at > ? AND (s.locked = 1 OR t.status <> 'planned')`).get(cur.employee_id, t.id, end, start);
        if (overlap) throw bad(`Сотрудник в это время занят: «${overlap.description}»`);
        db.prepare(`INSERT INTO schedule(task_id, employee_id, vehicle_type, vehicle_id, start_at, end_at, locked)
          VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(task_id) DO UPDATE SET employee_id = excluded.employee_id,
          start_at = excluded.start_at, end_at = excluded.end_at, locked = 1`)
          .run(t.id, cur.employee_id, cur.vehicle_type, cur.vehicle_id, start, end);
      } else if (b.unlock) {
        db.prepare('UPDATE schedule SET locked = 0 WHERE task_id = ?').run(t.id);
      }
    });
    tx();
    audit(db, req.user, 'task', t.id, 'update', JSON.stringify(b));
    if (t.order_id) {
      const o = db.prepare('SELECT status FROM repair_orders WHERE id = ?').get(t.order_id);
      if (o?.status === 'approved' && !reassign) db.prepare("UPDATE repair_orders SET status = 'planned' WHERE id = ?").run(t.order_id);
    }
    // ручное назначение влияет на загрузку — пересчитываем всех
    replan(db, reassign ? null : t.order_id);
    res.json(t.order_id ? loadOrder(db, t.order_id) : { ok: true });
  });

  r.post('/tasks/:id/status', requirePerm('tasks.status'), (req, res) => {
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!t) throw notFound('Работа');
    const { status, comment } = req.body || {};
    const allowed = { planned: ['in_progress', 'cancelled', 'done'], in_progress: ['paused', 'done', 'cancelled', 'planned'], paused: ['in_progress', 'done', 'cancelled'], done: ['in_progress'], cancelled: ['planned'] };
    if (!allowed[t.status]?.includes(status)) throw bad(`Нельзя перевести работу из «${t.status}» в «${status}»`);
    const ts = req.body.at || nowIso();
    const cal = calendarFor(db);
    db.transaction(() => {
      const upd = { status, ts: nowIso(), id: t.id, comment: comment ?? t.comment };
      let extra = '';
      if (status === 'in_progress' && !t.started_at) { extra += ', started_at = @started_at'; upd.started_at = ts; }
      if (status === 'done') {
        const started = t.started_at || db.prepare('SELECT start_at FROM schedule WHERE task_id = ?').get(t.id)?.start_at || ts;
        let actual = num(req.body.actual_hours);
        if (actual == null) actual = Math.max(0.1, Math.round(((cal.toWork(ts) - cal.toWork(started)) / 60) * 100) / 100);
        if (!t.employee_id && !req.body.employee_id) throw bad('Укажите исполнителя работы');
        extra += ', finished_at = @finished_at, actual_hours = @actual_hours, started_at = COALESCE(started_at, @started_at)';
        Object.assign(upd, { finished_at: ts, actual_hours: actual, started_at: started });
        if (req.body.employee_id) { extra += ', employee_id = @employee_id'; upd.employee_id = Number(req.body.employee_id); }
        const m = num(req.body.mileage);
        if (m != null) { extra += ', mileage = @mileage'; upd.mileage = m; }
        // факт в расписании
        db.prepare('UPDATE schedule SET start_at = ?, end_at = ?, locked = 1 WHERE task_id = ?').run(started, ts, t.id);
        if (m != null) recordMileage(db, { type: t.vehicle_type, id: t.vehicle_id, mileage: m, at: ts, source: 'repair', refId: t.order_id, userId: req.user.id });
      }
      if (status === 'in_progress' && t.status === 'done') { extra += ', finished_at = NULL, actual_hours = NULL'; }
      if (status === 'cancelled') db.prepare('DELETE FROM schedule WHERE task_id = ?').run(t.id);
      if (status === 'in_progress') {
        // работа началась: зафиксировать начало в расписании
        const s = db.prepare('SELECT * FROM schedule WHERE task_id = ?').get(t.id);
        if (s) {
          const len = Math.max(5, cal.toWork(s.end_at) - cal.toWork(s.start_at));
          const st = t.started_at || ts;
          db.prepare('UPDATE schedule SET start_at = ?, end_at = ?, locked = 1 WHERE task_id = ?')
            .run(st, cal.fromWork(cal.toWork(st) + len, true), t.id);
        } else if (t.employee_id) {
          const st = t.started_at || ts;
          db.prepare(`INSERT INTO schedule(task_id, employee_id, vehicle_type, vehicle_id, start_at, end_at, locked) VALUES (?, ?, ?, ?, ?, ?, 1)`)
            .run(t.id, t.employee_id, t.vehicle_type, t.vehicle_id, st, cal.fromWork(cal.toWork(st) + Math.ceil((t.hours || 1) * 60), true));
        }
      }
      if (status === 'planned') db.prepare('UPDATE schedule SET locked = 0 WHERE task_id = ?').run(t.id);
      db.prepare(`UPDATE tasks SET status = @status, comment = @comment, updated_at = @ts${extra} WHERE id = @id`).run(upd);
    })();
    audit(db, req.user, 'task', t.id, 'status', `${t.status} → ${status}`);
    replan(db);
    if (t.order_id) refreshOrderState(db, t.order_id);
    res.json(t.order_id ? loadOrder(db, t.order_id) : { ok: true });
  });

  r.delete('/tasks/:id', requirePerm('plan.write'), (req, res) => {
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!t) throw notFound('Работа');
    if (t.status === 'done') throw bad('Выполненную работу удалить нельзя');
    if (t.status === 'in_progress') throw bad('Работа выполняется — сначала остановите её или отмените');
    db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
    audit(db, req.user, 'task', t.id, 'delete', t.description);
    replan(db, t.order_id);
    res.json(t.order_id ? loadOrder(db, t.order_id) : { ok: true });
  });

  // ---- Установленные запчасти ----

  r.post('/orders/:id/parts', requirePerm('parts.write'), (req, res) => {
    const o = db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(req.params.id);
    if (!o) throw notFound('Ремонт');
    const b = req.body || {};
    let task = null;
    if (b.task_id) {
      task = db.prepare('SELECT * FROM tasks WHERE id = ? AND order_id = ?').get(b.task_id, o.id);
      if (!task) throw bad('Работа не найдена в этом ремонте');
    }
    let part = b.part_id ? db.prepare('SELECT * FROM parts WHERE id = ?').get(b.part_id) : null;
    const name = (part?.name || b.name || '').trim();
    if (!name) throw bad('Укажите запчасть');
    const qty = num(b.qty) ?? 1;
    if (!(qty > 0)) throw bad('Количество должно быть больше 0');
    if (!part && b.save_to_catalog) {
      const pid = db.prepare(`INSERT INTO parts(code, article, name, unit, price, source) VALUES (?, ?, ?, ?, ?, 'manual')`)
        .run(b.code || null, b.article || null, name, b.unit || 'шт', num(b.price)).lastInsertRowid;
      part = db.prepare('SELECT * FROM parts WHERE id = ?').get(pid);
    }
    const vt = task?.vehicle_type || (b.vehicle_type === 'trailer' ? 'trailer' : (o.tractor_id ? 'tractor' : 'trailer'));
    const vid = task?.vehicle_id || (vt === 'tractor' ? o.tractor_id : o.trailer_id);
    if (!vid) throw bad('Не определено ТС для установки');
    db.prepare(`INSERT INTO installed_parts(task_id, order_id, vehicle_type, vehicle_id, part_id, code, article, name, unit, qty, price, source, mileage, installed_at, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      task?.id ?? null, o.id, vt, vid, part?.id ?? null, part?.code ?? b.code ?? null, part?.article ?? b.article ?? null,
      name, part?.unit || b.unit || 'шт', qty, num(b.price) ?? part?.price ?? null, part?.source || 'manual',
      vt === 'tractor' ? o.tractor_mileage : o.trailer_mileage, b.installed_at || nowIso(), req.user.id,
    );
    audit(db, req.user, 'installed_part', o.id, 'create', name);
    res.status(201).json(loadOrder(db, o.id));
  });

  r.delete('/installed-parts/:id', requirePerm('parts.write'), (req, res) => {
    const p = db.prepare('SELECT * FROM installed_parts WHERE id = ?').get(req.params.id);
    if (!p) throw notFound('Запчасть');
    if (p.exported_at) throw bad('Запчасть уже выгружена в 1С — удаление запрещено');
    db.prepare('DELETE FROM installed_parts WHERE id = ?').run(p.id);
    res.json(p.order_id ? loadOrder(db, p.order_id) : { ok: true });
  });

  return r;
}
