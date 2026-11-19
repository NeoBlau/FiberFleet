import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { calendarFor } from '../settings.js';
let app,db,server,base,token,employees;
const api=async(method,url,body,tok=token)=>{
  const r=await fetch(base+url,{method,headers:{'content-type':'application/json',authorization:`Bearer ${tok}`},body:body?JSON.stringify(body):undefined});
  return {status:r.status,data:await r.json()};
};
const task=id=>db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const slot=id=>db.prepare('SELECT * FROM schedule WHERE task_id=?').get(id);
const future=(minutes=10)=>{const cal=calendarFor(db);return cal.fromWork(Math.ceil(cal.toWork(new Date())/5)*5+minutes);};
const edit=(id,body)=>api('PUT',`/schedule/tasks/${id}`,body);
async function repair(n=0,hours=2){
  const tr=db.prepare('SELECT id FROM tractors ORDER BY id LIMIT 1 OFFSET ?').get(n);
  const r=await api('POST','/orders',{tractor_id:tr.id,defects:{custom:[{name:`План ${n}`,hours,priority:3,vehicle_type:'tractor'}]}});
  assert.equal(r.status,201,JSON.stringify(r.data));return r.data;
}
beforeEach(async()=>{
  process.env.FF_ADMIN_PASSWORD='OperatorScheduleTest2026';process.env.FF_DEMO_USERS='0';
  app=createApp({dbFile:':memory:'});db=app.locals.db;
  db.prepare('UPDATE employees SET active=0').run();employees=[];
  for(let n=1;n<=2;n++)employees.push(Number(db.prepare("INSERT INTO employees(name,position,level,general_access) VALUES (?,'Слесарь',2,1)").run(`Слесарь ${n}`).lastInsertRowid));
  await new Promise(r=>{server=app.listen(0,r);});base=`http://127.0.0.1:${server.address().port}/api`;
  token=(await api('POST','/auth/login',{login:'admin',password:process.env.FF_ADMIN_PASSWORD})).data.token;
});
afterEach(async()=>{await new Promise(r=>server.close(r));db.close();});

test('ручной перенос перестраивает соседние работы, обновляет срок ремонта и сохраняет нормы и суммы',async()=>{
  db.prepare('UPDATE employees SET active=0 WHERE id=?').run(employees[1]);
  const a=await repair(0),b=await repair(1);const x=a.tasks[0],y=b.tasks[0];const old={...task(y.id)};const start=future(10);
  const r=await edit(y.id,{employee_id:employees[0],start_at:start,priority:2,version:task(y.id).updated_at});
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(slot(y.id).locked,1);assert.equal(slot(y.id).start_at,start);
  assert.ok(slot(x.id).start_at>=slot(y.id).end_at);assert.ok(r.data.shifted_tasks>=2);
  assert.deepEqual([task(y.id).hours,task(y.id).price,task(y.id).salary],[old.hours,old.price,old.salary]);
  const dashboard=(await api('GET','/dashboard')).data;
  assert.equal(dashboard.orders.find(o=>o.id===b.id).planned_end,slot(y.id).end_at);
  await api('POST','/schedule/rebuild',{});assert.equal(slot(y.id).start_at,start);
  const shared=(await api('GET',`/schedule?from=${encodeURIComponent(start)}&to=${encodeURIComponent(future(1000))}`)).data;
  assert.equal(shared.entries.find(e=>e.task_id===y.id).start_at,start);
});

test('произвольное окончание задаёт окно в плане, а не меняет норму; можно вернуть автопланирование',async()=>{
  const o=await repair();const id=o.tasks[0].id;const start=future(30),end=future(75);
  assert.equal((await edit(id,{employee_id:employees[1],start_at:start,end_at:end})).status,200);
  assert.equal(slot(id).end_at,end);assert.equal(task(id).hours,2);assert.equal(task(id).assigned_manual,1);
  assert.equal((await edit(id,{unlock:true})).status,200);assert.equal(slot(id).locked,0);assert.equal(task(id).assigned_manual,0);
});

test('занятый закреплённый сотрудник, превышение людей на машине и неверные даты отклоняются атомарно',async()=>{
  const o=await repair();const a=o.tasks[0];const other=await repair(1);const b=other.tasks[0];
  const start=future(30),end=future(90);
  assert.equal((await edit(a.id,{employee_id:employees[0],start_at:start,end_at:end})).status,200);
  const before=JSON.stringify(db.prepare('SELECT * FROM schedule ORDER BY id').all());
  assert.equal((await edit(b.id,{employee_id:employees[0],start_at:start,end_at:end})).status,400);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM schedule ORDER BY id').all()),before);
  db.prepare("UPDATE settings SET value='1' WHERE key='max_workers_per_vehicle'").run();
  db.prepare('UPDATE tasks SET vehicle_id=? WHERE id=?').run(a.vehicle_id,b.id);
  assert.equal((await edit(b.id,{employee_id:employees[1],start_at:start,end_at:end})).status,400);
  for(const patch of [{start_at:'bad'}, {start_at:start,end_at:start},{start_at:'2020-01-06T05:00:00Z'},{start_at:start,end_at:'bad'}])assert.equal((await edit(b.id,{employee_id:employees[1],...patch})).status,400);
});

test('допуски, права, закрытые и приостановленные задания защищены',async()=>{
  const o=await repair();const id=o.tasks[0].id;
  const wt=Number(db.prepare("INSERT INTO work_types(code,name,category,hours,access_all) VALUES ('TEST_ACCESS','Особый допуск','Тест',2,0)").run().lastInsertRowid);
  db.prepare('INSERT INTO work_type_access(work_type_id,employee_id) VALUES (?,?)').run(wt,employees[0]);db.prepare('UPDATE tasks SET work_type_id=? WHERE id=?').run(wt,id);
  const options=await api('GET',`/schedule/tasks/${id}/options`);assert.deepEqual(options.data.employees.map(e=>e.id),[employees[0]]);
  assert.equal((await edit(id,{employee_id:employees[1],start_at:future()})).status,400);
  db.prepare("INSERT INTO users(login,name,pass_hash,role,employee_id) SELECT 'mech','Механик',pass_hash,'mechanic',? FROM users WHERE login='admin'").run(employees[0]);
  const mech=(await api('POST','/auth/login',{login:'mech',password:process.env.FF_ADMIN_PASSWORD})).data.token;
  assert.equal((await api('PUT',`/schedule/tasks/${id}`,{unlock:true},mech)).status,403);
  const board=(await api('GET','/schedule/monitor?days=3',undefined,mech)).data;assert.ok(board.board.every(e=>e.id===employees[0]));
  await api('POST','/orders/pause',{ids:[o.id],paused:true});assert.equal((await edit(id,{unlock:true})).status,400);
  await api('POST','/orders/pause',{ids:[o.id],paused:false});db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(id);
  assert.equal((await edit(id,{unlock:true})).status,400);
  for(const status of ['cancelled','in_progress','paused']) {db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status,id);assert.equal((await edit(id,{unlock:true})).status,400);}
  db.prepare("UPDATE tasks SET status='planned' WHERE id=?").run(id);db.prepare("UPDATE repair_orders SET status='draft' WHERE id=?").run(o.id);assert.equal((await edit(id,{unlock:true})).status,400);
});

test('нельзя нарушить порядок операций или затереть свежую правку другого оператора',async()=>{
  const o=await repair();const a=o.tasks[0];
  const b=Number(db.prepare(`INSERT INTO tasks(order_id,vehicle_type,vehicle_id,description,hours,seq,priority) VALUES (?,'tractor',?,'Ремонт после осмотра',1,2,3)`).run(o.id,a.vehicle_id).lastInsertRowid);
  db.prepare('UPDATE tasks SET seq=1 WHERE id=?').run(a.id);
  assert.equal((await edit(b,{employee_id:employees[1],start_at:future(5)})).status,409);
  const r=await edit(b,{employee_id:employees[1],start_at:future(300)});assert.equal(r.status,200,JSON.stringify(r.data));
  assert.ok(slot(a.id).end_at<=slot(b).start_at);
  assert.equal((await edit(b,{unlock:true,version:'old-version'})).status,409);
});

test('многодневный экран не обрезает список до четырёх задач и правильно делит загрузку по дням',async()=>{
  const o=await repair(0,16);const id=o.tasks[0].id;const start=future(30);
  const r=await edit(id,{employee_id:employees[0],start_at:start});assert.equal(r.status,200,JSON.stringify(r.data));
  const cal=calendarFor(db);const date=new Date(Date.parse(start)+cal.offset).toISOString().slice(0,10);
  for(let n=1;n<=6;n++)await repair(n,1);
  const view=await api('GET',`/schedule/monitor?date=${date}&days=7`);assert.equal(view.status,200);assert.equal(view.data.dates.length,7);
  const days=view.data.board.find(e=>e.id===employees[0]).days.filter(d=>d.entries.some(t=>t.task_id===id));assert.ok(days.length>=2);
  for(const d of days)assert.ok(d.load<=100);
  assert.ok(view.data.board.some(e=>new Set(e.days.flatMap(d=>d.entries.map(t=>t.task_id))).size>4));
  for(const url of ['/schedule/monitor?days=0','/schedule/monitor?days=99','/schedule/monitor?date=2026-02-31'])assert.equal((await api('GET',url)).status,400);
});
