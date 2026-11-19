import express from 'express';
import { requirePerm } from '../auth.js';
import { json } from '../db.js';
import { assignmentIssues } from '../domain/scheduler.js';
import { fleetMaintenance } from '../domain/maintenance.js';
import { calendarFor } from '../settings.js';
import { editSchedule, schedulingOptions } from '../services/manual-schedule.js';
import { bad } from '../util.js';
import { replan } from '../services/orders.js';

const DAY = 86400000;

export default function scheduleRoutes(db) {
  const r = express.Router();

  const entries = (from, to, employeeId) => { const rows=db.prepare(`SELECT s.id, s.task_id, s.employee_id, s.start_at, s.end_at, s.locked,
      t.work_type_id, t.updated_at, t.assigned_manual, t.elapsed_minutes, t.description, t.location, t.status, t.priority, t.deadline, t.hours, t.order_id, t.vehicle_type, t.vehicle_id, t.reason,
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
    const issues=new Map(assignmentIssues(db,rows.map(row=>({...row,id:row.task_id}))).map(e=>[e.task_id,e.message]));
    return rows.map(row=>({...row,access_issue:issues.get(row.task_id)||null}));
  };

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
    const cal = calendarFor(db);
    const now = new Date();
    const end = new Date(new Date(cal.localDayStart(now)).getTime() + DAY).toISOString();
    const remaining = db.prepare(`SELECT t.id, t.description, t.status, s.start_at, s.end_at, o.number AS order_number,
      COALESCE(tr.plate, tl.plate) AS plate FROM tasks t JOIN repair_orders o ON o.id = t.order_id
      LEFT JOIN schedule s ON s.task_id = t.id
      LEFT JOIN tractors tr ON t.vehicle_type = 'tractor' AND tr.id = t.vehicle_id
      LEFT JOIN trailers tl ON t.vehicle_type = 'trailer' AND tl.id = t.vehicle_id
      WHERE t.status IN ('planned','in_progress') AND o.paused_at IS NULL AND o.status IN ('planned','plan_error','approved','in_progress')
      ORDER BY s.start_at, t.id`).all();
    res.json({ placed: result.placed.size, unschedulable: result.unschedulable.size,
      today: remaining.filter(t => t.status === 'in_progress' || (t.start_at && t.start_at < end && t.end_at > now.toISOString())).length,
      deferred: remaining.filter(t => t.end_at && t.end_at > end),
      unassigned: remaining.filter(t => !t.start_at).map(t => ({ ...t, reason: result.unschedulable.get(t.id) || 'Не найдено свободное назначение' })) });
  });

  // Экран оператора: что каждый делает сейчас и что дальше
  r.get('/schedule/tasks/:id/options', requirePerm('plan.write'), requirePerm('tasks.reassign'), (req,res) => {
    const {task,employees}=schedulingOptions(db,Number(req.params.id));
    res.json({task,employees:employees.map(e=>({id:e.id,name:e.name,position:e.position}))});
  });
  r.put('/schedule/tasks/:id', requirePerm('plan.write'), requirePerm('tasks.reassign'), (req,res) => {
    res.json(editSchedule(db,Number(req.params.id),req.body||{},req.user));
  });

  r.get('/schedule/monitor', (req, res) => {
    const cal=calendarFor(db);const now=new Date();const nowIso=now.toISOString();
    const count=Number(req.query.days||1);
    if(!Number.isInteger(count)||count<1||count>31) throw bad('Выберите от 1 до 31 дня');
    let from=cal.localDayStart(now);
    if(req.query.date) {
      const date=String(req.query.date);
      if(!/^20\d{2}-\d{2}-\d{2}$/.test(date)||Number(date.slice(0,4))<2020||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date) throw bad('Некорректная дата');
      from=new Date(Date.parse(date+'T00:00:00Z')-cal.offset).toISOString();
    }
    const to=new Date(Date.parse(from)+count*DAY).toISOString();
    const emp=req.user.role==='mechanic'?(req.user.employee_id||-1):null;
    const list=entries(from,to,emp);
    const dates=Array.from({length:count},(_,i)=>new Date(Date.parse(from)+i*DAY+cal.offset).toISOString().slice(0,10));
    const employees=db.prepare('SELECT id,name,position,is_external FROM employees WHERE active=1 ORDER BY is_external,name').all().filter(e=>!emp||e.id===emp);
    const board=employees.map(e=>{
      const mine=list.filter(x=>x.employee_id===e.id);
      const days=dates.map((date,i)=>{
        const start=new Date(Date.parse(from)+i*DAY).toISOString();const end=new Date(Date.parse(start)+DAY).toISOString();
        const dayEntries=mine.filter(x=>x.start_at<end&&x.end_at>start&&cal.toWork(x.end_at<end?x.end_at:end)>cal.toWork(x.start_at>start?x.start_at:start));
        const minutes=dayEntries.reduce((n,x)=>n+Math.max(0,cal.toWork(x.end_at<end?x.end_at:end)-cal.toWork(x.start_at>start?x.start_at:start)),0);
        return {date,entries:dayEntries,load:cal.perDay?Math.round(minutes/cal.perDay*100):0};
      });
      const current=mine.find(x=>x.status==='in_progress')||mine.find(x=>x.status==='planned'&&x.start_at<=nowIso&&x.end_at>nowIso)||null;
      return {...e,days,current,next:mine.filter(x=>x!==current&&x.status==='planned'),today_count:days[0]?.entries.length||0,load:days[0]?.load||0,overdue:mine.filter(x=>x.status==='planned'&&x.end_at<nowIso).length};
    }).filter(e=>!e.is_external||e.days.some(d=>d.entries.length));
    res.json({now:nowIso,from,to,dates,board});
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
