import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { calendarFor } from '../settings.js';
let app,db,server,base,token,vagner,zhuzhgin,work;
const api=async(method,url,body)=>{const r=await fetch(base+url,{method,headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
const task=id=>db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const slot=id=>db.prepare('SELECT * FROM schedule WHERE task_id=?').get(id);
const restrict=()=>api('PUT',`/work-types/${work.id}`,{access_all:false,access:[zhuzhgin]});
async function repair(){const tr=db.prepare('SELECT id FROM tractors LIMIT 1').get();const r=await api('POST','/orders',{tractor_id:tr.id,defects:{items:{el_lights:{state:'defect'}}}});assert.equal(r.status,201,JSON.stringify(r.data));const t=r.data.tasks.find(t=>t.work_type_id===work.id);assert.ok(t);assert.equal(t.employee_id,vagner);return {order:r.data,id:t.id};}
beforeEach(async()=>{
 process.env.FF_ADMIN_PASSWORD='AccessReplanLocal2026';process.env.FF_DEMO_USERS='0';app=createApp({dbFile:':memory:'});db=app.locals.db;
 db.prepare('UPDATE employees SET active=0').run();
 vagner=Number(db.prepare("INSERT INTO employees(name,position,general_access,level) VALUES ('Вагнер (тест)','Слесарь',1,2)").run().lastInsertRowid);
 zhuzhgin=Number(db.prepare("INSERT INTO employees(name,position,qualification,general_access,level) VALUES ('Жужгин (тест)','Слесарь','электрик',1,2)").run().lastInsertRowid);
 work=db.prepare("SELECT * FROM work_types WHERE name='Замена ламп/фонарей/фар'").get();
 await new Promise(r=>{server=app.listen(0,r);});base=`http://127.0.0.1:${server.address().port}/api`;
 token=(await api('POST','/auth/login',{login:'admin',password:process.env.FF_ADMIN_PASSWORD})).data.token;
});
afterEach(async()=>{await new Promise(r=>server.close(r));db.close();});

test('автоматическая плановая замена ламп переназначается Жужгину при сохранении допуска',async()=>{
 const {order,id}=await repair();const saved=await restrict();assert.equal(saved.status,200);assert.equal(saved.data.reassigned,1);
 assert.equal(task(id).employee_id,zhuzhgin);assert.equal(slot(id).employee_id,zhuzhgin);
 assert.equal((await api('GET',`/orders/${order.id}`)).data.tasks.find(t=>t.id===id).access_issue,null);
 await api('POST','/schedule/rebuild',{});assert.equal(slot(id).employee_id,zhuzhgin);
});

test('ручное закрепление не обходит допуск: конфликт виден, недопустимая работа не занимает расписание',async()=>{
 const {order,id}=await repair();assert.equal((await api('PUT',`/tasks/${id}`,{employee_id:vagner})).status,200);
 const saved=await restrict();assert.equal(saved.status,200);assert.ok(saved.data.access_conflicts.some(e=>e.task_id===id));assert.ok(!slot(id));
 assert.equal(task(id).employee_id,vagner);const o=(await api('GET',`/orders/${order.id}`)).data;
 assert.ok(o.plan_errors.some(e=>e.code==='access_conflict'));assert.match(o.tasks.find(t=>t.id===id).access_issue,/Вагнер/);
 const dashboard=(await api('GET','/dashboard')).data;assert.ok(!dashboard.today.some(t=>t.task_id===id));assert.ok(dashboard.orders.find(o=>o.id===order.id).errors.some(e=>e.code==='access_conflict'));
 assert.equal((await api('POST',`/tasks/${id}/status`,{status:'in_progress'})).status,400);
 assert.equal((await api('PUT',`/tasks/${id}`,{employee_id:zhuzhgin})).status,200);assert.equal(slot(id).employee_id,zhuzhgin);
});

test('зафиксированное время тоже не сохраняет недопустимого слесаря; автопланирование исправляет назначение',async()=>{
 const {id}=await repair();const cal=calendarFor(db);const start=cal.fromWork(Math.ceil(cal.toWork(new Date())/5)*5+10);
 assert.equal((await api('PUT',`/schedule/tasks/${id}`,{employee_id:vagner,start_at:start})).status,200);assert.equal(slot(id).locked,1);
 await restrict();assert.ok(!slot(id));await api('POST','/schedule/rebuild',{});assert.ok(!slot(id));
 assert.equal((await api('PUT',`/tasks/${id}`,{employee_id:null,unlock:true})).status,200);assert.equal(slot(id).employee_id,zhuzhgin);
});

test('начатая работа не переносится молча: конфликт виден, пауза и переназначение сохраняют факт',async()=>{
 const {order,id}=await repair();const cal=calendarFor(db);const start=cal.fromWork(cal.toWork(new Date())-30);
 assert.equal((await api('POST',`/tasks/${id}/status`,{status:'in_progress',at:start})).status,200);
 const saved=await restrict();assert.ok(saved.data.access_conflicts.some(e=>e.task_id===id));assert.equal(task(id).employee_id,vagner);assert.equal(task(id).status,'in_progress');assert.equal(slot(id).employee_id,vagner);
 const o=(await api('GET',`/orders/${order.id}`)).data;assert.match(o.tasks.find(t=>t.id===id).access_issue,/Работа уже начата/);
 const dashboard=(await api('GET','/dashboard')).data;assert.ok(dashboard.orders.find(o=>o.id===order.id).errors.some(e=>e.code==='access_conflict'));
 assert.equal((await api('PUT',`/tasks/${id}`,{employee_id:zhuzhgin})).status,400);
 assert.equal((await api('POST',`/tasks/${id}/status`,{status:'paused'})).status,200);assert.equal(task(id).elapsed_minutes,30);
 assert.equal((await api('POST',`/tasks/${id}/status`,{status:'in_progress'})).status,400);
 assert.equal((await api('PUT',`/tasks/${id}`,{employee_id:zhuzhgin})).status,200);
 assert.equal((await api('POST',`/tasks/${id}/status`,{status:'in_progress'})).status,200);assert.equal(task(id).employee_id,zhuzhgin);assert.equal(task(id).elapsed_minutes,30);
 assert.equal(db.prepare('SELECT employee_id FROM task_work_sessions WHERE task_id=?').get(id).employee_id,vagner);
});

test('если допущенных сотрудников нет, работа остаётся без назначения, а не у прежнего исполнителя',async()=>{
 const {order,id}=await repair();assert.equal((await api('PUT',`/work-types/${work.id}`,{access_all:false,access:[]})).status,200);
 assert.ok(!slot(id));assert.equal(task(id).employee_id,null);assert.ok((await api('GET',`/orders/${order.id}`)).data.plan_errors.some(e=>e.code==='no_executor'));
 assert.equal((await api('PUT',`/tasks/${id}`,{employee_id:vagner})).status,400);
 await restrict();assert.equal(slot(id).employee_id,zhuzhgin);
});

test('изменение только квалификации запускает пересчёт, а завершённые задания сохраняют историю',async()=>{
 const {id}=await repair();assert.equal((await api('PUT',`/work-types/${work.id}`,{required_qualification:'электрик'})).status,200);assert.equal(slot(id).employee_id,zhuzhgin);
 assert.equal((await api('POST',`/tasks/${id}/status`,{status:'done',actual_hours:0.5})).status,200);const done=task(id);
 await api('PUT',`/work-types/${work.id}`,{access_all:false,access:[],required_qualification:''});assert.deepEqual(task(id),done);
});

test('явный допуск только Жужгину нельзя обойти совпадающей квалификацией Вагнера',async()=>{
 db.prepare("UPDATE employees SET qualification='электрик' WHERE id=?").run(vagner);
 await api('PUT',`/work-types/${work.id}`,{required_qualification:'электрик'});
 const {id}=await repair();await restrict();assert.equal(task(id).employee_id,zhuzhgin);assert.equal(slot(id).employee_id,zhuzhgin);
 assert.equal((await api('PUT',`/tasks/${id}`,{employee_id:vagner})).status,400);
});
