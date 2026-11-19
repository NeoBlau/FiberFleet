import { nowIso } from '../db.js';
import { calendarFor, getSettings } from '../settings.js';
import { eligibleEmployees, factorFor, loadEmployees, speedStats } from '../domain/scheduler.js';
import { audit, loadOrder, replan } from './orders.js';
import { bad, HttpError, notFound } from '../util.js';

export function schedulingOptions(db, id) {
  const task = db.prepare(`SELECT t.*, s.start_at, s.end_at, s.locked, o.paused_at, o.status AS order_status
    FROM tasks t LEFT JOIN schedule s ON s.task_id=t.id JOIN repair_orders o ON o.id=t.order_id WHERE t.id=?`).get(id);
  if (!task) throw notFound('Работа');
  const wt = task.work_type_id ? db.prepare('SELECT * FROM work_types WHERE id=?').get(task.work_type_id) : null;
  const { emps, access } = loadEmployees(db);
  return { task, employees: eligibleEmployees(wt, emps, access), wt };
}

export function editSchedule(db, id, body, user) {
  return db.transaction(() => {
    const { task, employees, wt } = schedulingOptions(db, id);
    if (task.status !== 'planned' || task.paused_at || !['planned','plan_error','approved','in_progress'].includes(task.order_status)) throw bad('Изменять план можно только для ещё не начатой работы в активном ремонте');
    if (body.version && body.version !== task.updated_at) throw new HttpError(409, 'Расписание уже изменилось. Обновите данные и повторите корректировку.');
    const before = db.prepare('SELECT * FROM schedule').all();
    if (body.unlock === true) {
      db.prepare('UPDATE schedule SET locked=0 WHERE task_id=?').run(id);
      db.prepare('UPDATE tasks SET assigned_manual=0, updated_at=? WHERE id=?').run(nowIso(),id);
    } else {
      const employee = employees.find(e=>e.id===Number(body.employee_id));
      if (!employee) throw bad('Сотрудник неактивен или не имеет допуска к этой работе');
      const cal = calendarFor(db);
      const parse = (value) => {
        if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw bad('Укажите корректные дату и время');
        return new Date(value).toISOString();
      };
      const start = parse(body.start_at);
      const startW = cal.toWork(start);
      if (cal.fromWork(startW)!==start) throw bad('Начало должно приходиться на рабочее время по календарю');
      if (start < new Date(Math.floor(Date.now()/60000)*60000).toISOString()) throw bad('Нельзя перенести плановую работу в прошлое');
      const duration = Math.max(5,Math.ceil(Math.max(0,task.hours*60*factorFor(employee,wt?.category,speedStats(db))-(task.elapsed_minutes||0))/5)*5);
      const end = body.end_at ? parse(body.end_at) : cal.fromWork(startW+duration,true);
      const endW = cal.toWork(end);
      if (endW<=startW || Date.parse(end)-Date.parse(start)>366*86400000) throw bad('Окончание должно быть позже начала, интервал — не больше года');
      if (cal.fromWork(endW,true)!==end) throw bad('Окончание должно приходиться на рабочее время по календарю');
      const fixed = db.prepare(`SELECT s.*, t.description, t.order_id, t.seq, t.status FROM schedule s JOIN tasks t ON t.id=s.task_id
        LEFT JOIN repair_orders o ON o.id=t.order_id WHERE s.task_id<>? AND t.status IN ('planned','in_progress')
        AND o.paused_at IS NULL AND (s.locked=1 OR t.status='in_progress')`).all(id);
      const fixedEnd=s=>s.status==='in_progress'?Math.max(cal.toWork(s.end_at),Math.ceil(cal.toWork(new Date())/5)*5+5):cal.toWork(s.end_at);
      const overlap = s => cal.toWork(s.start_at)<endW && fixedEnd(s)>startW;
      const employeeConflict = fixed.find(s=>s.employee_id===employee.id && overlap(s));
      if (employeeConflict) throw bad(`Сотрудник уже занят закреплённой или выполняемой работой: «${employeeConflict.description}»`);
      const max = Number(getSettings(db).max_workers_per_vehicle)||0;
      if (max>0) {
        const points=[[startW,1],[endW,-1]];
        for (const s of fixed.filter(s=>s.vehicle_type===task.vehicle_type && s.vehicle_id===task.vehicle_id && overlap(s))) points.push([Math.max(startW,cal.toWork(s.start_at)),1],[Math.min(endW,fixedEnd(s)),-1]);
        points.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let count=0;
        for(const [,delta] of points) {count+=delta;if(count>max) throw bad('Превышено допустимое число сотрудников одновременно на одном автомобиле');}
      }
      if(fixed.some(s=>s.order_id===task.order_id&&s.vehicle_type===task.vehicle_type&&s.vehicle_id===task.vehicle_id&&((s.seq<task.seq&&fixedEnd(s)>startW)||(s.seq>task.seq&&cal.toWork(s.start_at)<endW)))) throw bad('Выбранное время нарушает порядок закреплённых или выполняемых операций');
      const previous = db.prepare(`SELECT t.id,t.description,t.status,s.end_at FROM tasks t LEFT JOIN schedule s ON s.task_id=t.id
        WHERE t.order_id=? AND t.vehicle_type=? AND t.vehicle_id=? AND t.seq<? AND t.status NOT IN ('done','cancelled')`).all(task.order_id,task.vehicle_type,task.vehicle_id,task.seq);
      if(previous.some(t=>t.status==='paused')) throw bad('Предыдущая операция находится на паузе. Сначала возобновите её.');
      if (body.priority!==undefined && ![1,2,3,4].includes(Number(body.priority))) throw bad('Приоритет: от 1 до 4');
      const at=nowIso();
      db.prepare(`UPDATE tasks SET employee_id=?, assigned_manual=1, priority=?, priority_manual=?, updated_at=? WHERE id=?`)
        .run(employee.id,body.priority===undefined?task.priority:Number(body.priority),body.priority===undefined?task.priority_manual:1,at,id);
      db.prepare(`INSERT INTO schedule(task_id,employee_id,vehicle_type,vehicle_id,start_at,end_at,locked) VALUES (?,?,?,?,?,?,1)
        ON CONFLICT(task_id) DO UPDATE SET employee_id=excluded.employee_id,start_at=excluded.start_at,end_at=excluded.end_at,locked=1`)
        .run(id,employee.id,task.vehicle_type,task.vehicle_id,start,end);
    }
    replan(db);
    const order=loadOrder(db,task.order_id);
    // A manual reservation must not move a repair before its unfinished prerequisites.
    const sequence=order.plan_errors.filter(e=>e.code==='sequence');
    const lower=db.prepare(`SELECT t.id,s.end_at FROM tasks t LEFT JOIN schedule s ON s.task_id=t.id WHERE t.order_id=? AND t.vehicle_type=?
      AND t.vehicle_id=? AND t.seq<? AND t.status NOT IN ('done','cancelled')`).all(task.order_id,task.vehicle_type,task.vehicle_id,task.seq);
    if(!body.unlock && (sequence.length || lower.some(t=>!t.end_at))) throw new HttpError(409,'Не удаётся разместить предыдущие операции до выбранного начала. Выберите более позднее время.');
    const after=db.prepare('SELECT * FROM schedule').all();const old=new Map(before.map(s=>[s.task_id,s]));
    const newIds=new Set(after.map(s=>s.task_id));
    const shifted=before.filter(s=>!newIds.has(s.task_id)).length+after.filter(s=>{const p=old.get(s.task_id);return !p||s.employee_id!==p.employee_id||s.start_at!==p.start_at||s.end_at!==p.end_at;}).length;
    audit(db,user,'task',id,body.unlock?'schedule_auto':'schedule_manual',JSON.stringify({before:before.find(s=>s.task_id===id),after:after.find(s=>s.task_id===id)}));
    const warnings=db.prepare(`SELECT id,number,plan_errors FROM repair_orders WHERE paused_at IS NULL AND status IN ('planned','plan_error','approved','in_progress')`)
      .all().flatMap(o=>JSON.parse(o.plan_errors||'[]').map(e=>({order_id:o.id,number:o.number,message:e.message})));
    return {ok:true,shifted_tasks:shifted,warnings,order};
  })();
}
