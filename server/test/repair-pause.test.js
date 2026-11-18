import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { calendarFor } from '../settings.js';

let app, db, server, base, token, employee;
const api = async (method, url, body, tok = token) => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};
const get = id => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const slot = id => db.prepare('SELECT * FROM schedule WHERE task_id = ?').get(id);
async function repair(n = 0, hours = 2) {
  const tractor = db.prepare('SELECT id FROM tractors ORDER BY id LIMIT 1 OFFSET ?').get(n);
  const r = await api('POST', '/orders', { tractor_id: tractor.id, defects: { custom: [{ name: `Работа ${n}`, hours, vehicle_type: 'tractor', priority: 3 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
beforeEach(async () => {
  process.env.FF_ADMIN_PASSWORD = 'PauseLocalTests2026';
  process.env.FF_DEMO_USERS = '0';
  app = createApp({ dbFile: ':memory:' }); db = app.locals.db;
  db.prepare('UPDATE employees SET active = 0').run();
  employee = Number(db.prepare("INSERT INTO employees(name, position, general_access, level) VALUES ('Тестовый слесарь', 'Слесарь', 1, 2)").run().lastInsertRowid);
  await new Promise(r => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}/api`;
  token = (await api('POST', '/auth/login', { login: 'admin', password: process.env.FF_ADMIN_PASSWORD })).data.token;
});
afterEach(async () => { await new Promise(r => server.close(r)); db.close(); });

test('пять ремонтов освобождают слесаря для шестого срочного; можно поставить на паузу все шесть', async () => {
  const orders = []; for (let n = 0; n < 6; n++) orders.push(await repair(n));
  const urgent = orders[5], task = urgent.tasks[0];
  const oldStart = slot(task.id).start_at;
  assert.equal((await api('POST', '/orders/urgent', { ids: [urgent.id], urgent: true })).status, 200);
  assert.equal((await api('POST', '/orders/pause', { ids: orders.slice(0,5).map(o=>o.id), paused: true, reason: 'Срочная машина' })).status, 200);
  for (const o of orders.slice(0,5)) { assert.ok(!slot(o.tasks[0].id)); assert.ok(db.prepare('SELECT paused_at FROM repair_orders WHERE id = ?').get(o.id).paused_at); }
  assert.ok(slot(task.id).start_at < oldStart);
  assert.equal(slot(task.id).employee_id, employee);
  const summary = await api('POST', '/schedule/rebuild', {});
  assert.equal(summary.status, 200);
  assert.ok(Array.isArray(summary.data.deferred)); assert.ok(Array.isArray(summary.data.unassigned));
  assert.equal((await api('POST', '/orders/pause', { ids: orders.map(o=>o.id), paused: true })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schedule').get().n, 0);
  assert.equal((await api('POST', '/orders/pause', { ids: orders.map(o=>o.id), paused: false })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schedule').get().n, 6);
});

test('время до паузы и завершённые работы сохраняются; в очередь возвращается только остаток', async () => {
  const o = await repair(); const t = o.tasks[0];
  const cal = calendarFor(db); const start = cal.fromWork(cal.toWork(new Date()) - 30);
  assert.equal((await api('POST', `/tasks/${t.id}/status`, { status: 'in_progress', at: start })).status, 200);
  const doneId = Number(db.prepare(`INSERT INTO tasks(order_id, vehicle_type, vehicle_id, description, hours, actual_hours, price, salary, status, employee_id)
    VALUES (?, 'tractor', ?, 'Уже выполнено', 1, 1.5, 1000, 400, 'done', ?)`).run(o.id,t.vehicle_id,employee).lastInsertRowid);
  const done = get(doneId); const norm = get(t.id).hours;
  assert.equal((await api('POST', '/orders/pause', { ids: [o.id], paused: true })).status, 200);
  const paused = get(t.id);
  assert.equal(paused.status, 'paused'); assert.equal(paused.elapsed_minutes, 30);
  assert.equal(paused.started_at, start); assert.equal(paused.hours, norm); assert.ok(!slot(t.id));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_work_sessions').get().n,1);
  assert.equal((await api('POST', '/orders/pause', { ids: [o.id], paused: true })).status, 200);
  assert.equal(get(t.id).elapsed_minutes,30);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_work_sessions').get().n,1);
  assert.equal((await api('POST', `/tasks/${t.id}/status`, { status: 'in_progress' })).status,400);
  assert.equal((await api('POST', '/orders/pause', { ids: [o.id], paused: false })).status,200);
  assert.equal(get(t.id).status,'planned'); assert.equal(get(t.id).active_since,null);
  assert.equal(cal.toWork(slot(t.id).end_at)-cal.toWork(slot(t.id).start_at),90);
  assert.deepEqual(get(doneId),done);
  // Час ожидания после паузы не добавляет фактическое время работы.
  assert.equal((await api('POST', `/tasks/${t.id}/status`, { status: 'done' })).status,200);
  assert.equal(get(t.id).actual_hours,0.5);
});

test('отдельная пауза задачи тоже освобождает расписание; возобновление ремонта не снимает ручную паузу', async () => {
  const o = await repair();const t = o.tasks[0];
  assert.equal((await api('POST', `/tasks/${t.id}/status`, { status: 'in_progress' })).status,200);
  assert.equal((await api('POST', `/tasks/${t.id}/status`, { status: 'paused' })).status,200);
  assert.ok(!slot(t.id));
  await api('POST', '/orders/pause', { ids:[o.id],paused:true });
  await api('POST', '/orders/pause', { ids:[o.id],paused:false });
  assert.equal(get(t.id).status,'paused'); assert.ok(!slot(t.id));
});

test('ошибка выбора не меняет часть ремонтов; права механика не позволяют менять очередь', async () => {
  const o=await repair();
  assert.equal((await api('POST','/orders/pause',{ids:[o.id,999999],paused:true})).status,404);
  assert.equal(db.prepare('SELECT paused_at FROM repair_orders WHERE id=?').get(o.id).paused_at,null);
  assert.ok(slot(o.tasks[0].id));
  assert.equal((await api('POST','/orders/pause',{ids:[],paused:true})).status,400);
  db.prepare("INSERT INTO users(login,name,pass_hash,role,employee_id) SELECT 'mech','Механик',pass_hash,'mechanic',? FROM users WHERE login='admin'").run(employee);
  const mech=(await api('POST','/auth/login',{login:'mech',password:process.env.FF_ADMIN_PASSWORD})).data.token;
  assert.equal((await api('POST','/orders/pause',{ids:[o.id],paused:true},mech)).status,403);
  assert.equal((await api('POST','/orders/urgent',{ids:[o.id],urgent:true},mech)).status,403);
});

test('критическая работа остаётся впереди срочного ремонта, назначения не пересекаются', async () => {
  const critical=await repair(0); const urgent=await repair(1);
  db.prepare('UPDATE tasks SET priority=1 WHERE id=?').run(critical.tasks[0].id);
  await api('POST','/orders/urgent',{ids:[urgent.id],urgent:true});
  assert.ok(slot(critical.tasks[0].id).end_at <= slot(urgent.tasks[0].id).start_at);
});

test('повторные рабочие интервалы не включают ожидание в паузе', async () => {
  const o=await repair();const id=o.tasks[0].id; const cal=calendarFor(db);const now=cal.toWork(new Date());
  const change=(status,minute)=>api('POST',`/tasks/${id}/status`,{status,at:cal.fromWork(minute)});
  assert.equal((await change('in_progress',now-120)).status,200);
  assert.equal((await change('paused',now-90)).status,200);
  assert.equal((await change('in_progress',now-15)).status,200);
  assert.equal((await change('done',now)).status,200);
  assert.equal(get(id).actual_hours,0.75);
  assert.equal(db.prepare('SELECT SUM(minutes) n FROM task_work_sessions WHERE task_id=?').get(id).n,45);
  assert.equal((await api('GET',`/orders/${o.id}`)).data.work_sessions.length,2);
});

test('обновление старой базы добавляет поля паузы без изменения существующих ремонтов', async () => {
  const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');const Database=(await import('better-sqlite3')).default;
  const o=await repair();const original=get(o.tasks[0].id);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pause-migration-')); const file=path.join(dir,'old.db');
  try {
    fs.writeFileSync(file,db.serialize());const old=new Database(file);
    for (const name of ['paused_at','pause_reason','dispatch_urgent']) old.exec(`ALTER TABLE repair_orders DROP COLUMN ${name}`);
    for (const name of ['active_since','elapsed_minutes','order_pause_state']) old.exec(`ALTER TABLE tasks DROP COLUMN ${name}`);
    old.close();
    const migrated=createApp({dbFile:file}).locals.db;
    const task=migrated.prepare('SELECT * FROM tasks WHERE id=?').get(original.id);
    assert.equal(task.hours,original.hours);assert.equal(task.price,original.price);assert.equal(task.salary,original.salary);assert.equal(task.status,original.status);
    assert.equal(task.elapsed_minutes,0);assert.equal(migrated.prepare('SELECT paused_at FROM repair_orders WHERE id=?').get(o.id).paused_at,null);
    migrated.close();
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
