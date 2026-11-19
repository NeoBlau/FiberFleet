import { beforeEach,afterEach,test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
let app,db,server,base,token,works;
const api=async(method,path,body)=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
const catalog=async()=> (await api('GET','/work-types')).data;
async function repair(){const tr=db.prepare('SELECT id FROM tractors ORDER BY id LIMIT 1').get();const r=await api('POST','/orders',{tractor_id:tr.id,defects:{items:{cool_leak:{state:'defect'},tires:{positions:['tractor:1:L']}}}});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
beforeEach(async()=>{
 process.env.FF_ADMIN_PASSWORD='AllAccessLocal2026';process.env.FF_DEMO_USERS='0';app=createApp({dbFile:':memory:'});db=app.locals.db;
 await new Promise(r=>{server=app.listen(0,r);});base=`http://127.0.0.1:${server.address().port}/api`;
 token=(await api('POST','/auth/login',{login:'admin',password:process.env.FF_ADMIN_PASSWORD})).data.token;
 works=(await catalog()).filter(w=>w.name==='Шиномонтаж (с/у, замена шины 1 колесо)'||w.name==='Устранение течи антифриза (патрубки, хомуты)');assert.equal(works.length,2);
});
afterEach(async()=>{await new Promise(r=>server.close(r));db.close();});

test('шиномонтаж и антифриз с общим допуском штатно назначаются активным слесарям',async()=>{
 for(const w of works){assert.equal(w.access_all,1);assert.ok(w.eligibility.employees.length>0);assert.equal(w.eligibility.reason,null);}
 const o=await repair();for(const w of works){const t=o.tasks.find(t=>t.work_type_id===w.id);assert.ok(t);assert.ok(t.employee_id);assert.ok(w.eligibility.employees.some(e=>e.id===t.employee_id));assert.ok(t.start_at);assert.equal(t.work_code,w.code);}
 assert.ok(!o.plan_errors.some(e=>e.code==='no_executor'));
});

test('«Все» при выключенном общем допуске сотрудников объясняет причину; включение допуска исправляет очередь',async()=>{
 db.prepare('UPDATE employees SET general_access=0').run();const o=await repair();
 const rows=await catalog();for(const w of works){const row=rows.find(x=>x.id===w.id);assert.equal(row.access_all,1);assert.equal(row.eligibility.employees.length,0);assert.match(row.eligibility.reason,/флажок/);}
 assert.ok(o.plan_errors.some(e=>e.code==='no_executor'&&e.message.includes('флажок')));
 const e=db.prepare('SELECT id FROM employees WHERE active=1 AND is_external=0 LIMIT 1').get();
 assert.equal((await api('PUT',`/employees/${e.id}`,{general_access:true})).status,200);
 const after=(await api('GET',`/orders/${o.id}`)).data;
 for(const w of works)assert.equal(after.tasks.find(t=>t.work_type_id===w.id).employee_id,e.id);
 assert.ok(!after.plan_errors.some(e=>e.code==='no_executor'));
});

test('неактивные сотрудники и особая квалификация имеют разные объяснения',async()=>{
 db.prepare('UPDATE employees SET active=0').run();for(const w of (await catalog()).filter(w=>works.some(x=>x.id===w.id)))assert.match(w.eligibility.reason,/Нет активных сотрудников/);
 db.prepare('UPDATE employees SET active=1 WHERE is_external=0').run();const w=works[0];
 await api('PUT',`/work-types/${w.id}`,{required_qualification:'уникальная квалификация'});
 const updated=(await catalog()).find(x=>x.id===w.id);assert.equal(updated.eligibility.employees.length,0);assert.match(updated.eligibility.reason,/Требуется квалификация/);
});

test('занятость допущенного слесаря переносит работу на более позднее время, а не создаёт ошибку допуска',async()=>{
 const e=db.prepare('SELECT id FROM employees WHERE active=1 AND general_access=1 AND is_external=0 LIMIT 1').get();
 db.prepare('UPDATE employees SET active=0 WHERE id<>?').run(e.id);
 const tr=db.prepare('SELECT id FROM tractors ORDER BY id LIMIT 1').get();
 const busy=await api('POST','/orders',{tractor_id:tr.id,defects:{custom:[{name:'Длительная срочная работа',hours:16,vehicle_type:'tractor',priority:1}]}});assert.equal(busy.status,201);
 const end=busy.data.tasks.find(t=>t.description==='Длительная срочная работа').end_at;
 const o=await repair();for(const w of works){const t=o.tasks.find(t=>t.work_type_id===w.id);assert.equal(t.employee_id,e.id);assert.ok(t.start_at>=end);}
 assert.ok(!o.plan_errors.some(e=>e.code==='no_executor'));
});

test('одноимённая работа не подменяет реальный допуск; карточка сообщает код конкретной записи',async()=>{
 const original=works[0];const r=await api('POST','/work-types',{name:original.name,category:original.category,code:'DUPLICATE_TEST',hours:1,access_all:false,access:[]});assert.equal(r.status,201);
 const o=await repair();await api('POST',`/orders/${o.id}/tasks`,{work_type_id:r.data.id});
 const loaded=(await api('GET',`/orders/${o.id}`)).data;assert.equal(loaded.tasks.find(t=>t.work_type_id===r.data.id).work_code,'DUPLICATE_TEST');
 const rows=await catalog();assert.ok(rows.find(w=>w.id===original.id).eligibility.employees.length>0);assert.equal(rows.find(w=>w.id===r.data.id).eligibility.employees.length,0);assert.match(rows.find(w=>w.id===r.data.id).eligibility.reason,/список сотрудников пуст/);
});
