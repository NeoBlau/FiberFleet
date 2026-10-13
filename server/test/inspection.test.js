import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import { openDb } from '../db.js';

let server, base, token;
const api = async (method, url, body) => {
  const res = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

before(async () => {
  const app = createApp({ dbFile: ':memory:' });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'admin', password: 'admin' }) });
  token = (await r.json()).token;
});
after(() => server.close());

const tractorByPlate = async (p) => (await api('GET', '/vehicles/tractor')).data.find((t) => t.plate === p);

test('замеры: колодка и диск ниже нормы → замена на этой позиции; показания сохраняются', async () => {
  const t = await tractorByPlate('Т970ОН58');
  const r = await api('POST', '/orders/preview', {
    tractor_id: t.id,
    defects: { items: { br_measure: { measure: { 'tractor:2:L': { pad: 3, disc: 35 }, 'tractor:2:R': { pad: 12, disc: 42 } } } } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const pads = r.data.tasks.filter((x) => x.description === 'С/у колодок (диск) задние');
  assert.equal(pads.length, 1);
  assert.equal(pads[0].location, 'Тягач, ось 2, лев.');
  assert.ok(pads[0].reason.includes('по замеру'));
  assert.ok(r.data.tasks.some((x) => x.description === 'C/у тормозного диска(зад)' && x.location === 'Тягач, ось 2, лев.'));
  assert.ok(!r.data.tasks.some((x) => x.location === 'Тягач, ось 2, прав.' && /колодок|диска/.test(x.description)));
  const rd = r.data.readings.filter((x) => x.item === 'br_measure');
  assert.equal(rd.length, 2);
  assert.ok(rd.find((x) => x.label.includes('лев.')).bad);
  assert.ok(!rd.find((x) => x.label.includes('прав.')).bad);
});

test('давление в 3 контурах: вне нормы → поиск утечки воздуха; в норме → без работ', async () => {
  const t = await tractorByPlate('К531НК95');
  const low = await api('POST', '/orders/preview', { tractor_id: t.id, defects: { items: { br_pressure: { values: ['9.5', '9.4', '6.2'] } } } });
  assert.ok(low.data.tasks.some((x) => x.description === 'Поиск и устранение утечки воздуха'));
  assert.ok(low.data.readings.find((x) => x.item === 'br_pressure').bad);
  const okp = await api('POST', '/orders/preview', { tractor_id: t.id, defects: { items: { br_pressure: { values: ['9.5', '9.4', '9.1'] } } } });
  assert.equal(okp.data.tasks.length, 0);
  assert.equal(okp.data.readings.find((x) => x.item === 'br_pressure').bad, false);
  const delta = await api('POST', '/orders/preview', { tractor_id: t.id, defects: { items: { br_pressure: { values: ['10.5', '9.0', '9.2'] } } } });
  assert.ok(delta.data.tasks.length > 0, 'разница между контурами больше 1 бар');
});

test('ТО не требуется, но работы выбраны из справочника → попадают в план', async () => {
  const t = await tractorByPlate('В178МЕ164');
  const wts = (await api('GET', '/work-types')).data;
  const oil = wts.find((w) => w.name === 'Замена масла (1-2 фильтра)');
  const r = await api('POST', '/orders/preview', { tractor_id: t.id, defects: { items: { eng_to: { state: 'ok', works: [oil.id] } } } });
  assert.equal(r.data.tasks.length, 1);
  assert.equal(r.data.tasks[0].work_type_id, oil.id);
  assert.equal(r.data.tasks[0].source, 'maintenance');
});

test('выходной контроль: только после всех работ, обязательны проверки и исполнитель, замечание при неисправности', async () => {
  const t = await tractorByPlate('С070ВМ58');
  const o = (await api('POST', '/orders', { tractor_id: t.id, tractor_mileage: 700000, defects: { items: { el_lights: { state: 'defect' } } } })).data;
  const emp = (await api('GET', '/employees')).data.find((e) => e.name === 'Чешуин');
  const all = { heater: 'ok', autonomous: 'na', ac: 'ok' };
  let r = await api('PUT', `/orders/${o.id}/exit-control`, { checks: all, inspector_id: emp.id });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /после завершения всех работ/);
  for (const task of o.tasks) await api('POST', `/tasks/${task.id}/status`, { status: 'done', actual_hours: 0.5 });
  r = await api('PUT', `/orders/${o.id}/exit-control`, { checks: { heater: 'ok' }, inspector_id: emp.id });
  assert.equal(r.status, 400, 'не все проверки отмечены');
  r = await api('PUT', `/orders/${o.id}/exit-control`, { checks: { ...all, ac: 'defect' }, inspector_id: emp.id });
  assert.equal(r.status, 400, 'неисправность без замечания');
  r = await api('PUT', `/orders/${o.id}/exit-control`, { checks: { ...all, ac: 'defect' }, inspector_id: emp.id, comment: 'не холодит' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.exit_control.result, 'defect');
  assert.equal(r.data.exit_control.inspector_name, 'Чешуин');
  assert.ok(r.data.exit_control.works.length >= 1 && r.data.exit_control.works.every((w) => w.employee));
  const pdf = await fetch(`${base}/orders/${o.id}/pdf`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(pdf.status, 200);
});

test('обновление старой базы: поле выходного контроля добавляется без потери данных', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-')), 'old.db');
  const old = new Database(file);
  old.exec(`CREATE TABLE repair_orders (id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, tractor_id INTEGER, trailer_id INTEGER,
    tractor_mileage INTEGER, trailer_mileage INTEGER, reefer_hours INTEGER, inspected_at TEXT NOT NULL, release_deadline TEXT,
    status TEXT NOT NULL DEFAULT 'draft', defects TEXT NOT NULL DEFAULT '{}', inspection TEXT NOT NULL DEFAULT '[]',
    plan_errors TEXT NOT NULL DEFAULT '[]', notes TEXT, created_by INTEGER, created_at TEXT, updated_at TEXT, closed_at TEXT);
    INSERT INTO repair_orders(number, inspected_at) VALUES ('2026-0001', '2026-10-01');`);
  old.close();
  const db = openDb(file);
  const cols = db.prepare('PRAGMA table_info(repair_orders)').all().map((c) => c.name);
  assert.ok(cols.includes('exit_control'));
  assert.equal(db.prepare('SELECT number FROM repair_orders').get().number, '2026-0001');
  db.close();
});

test('работы, вписанные вручную (ТО и общий список), и кто провёл дефектовку', async () => {
  const t = await tractorByPlate('В301РХ164');
  const emp = (await api('GET', '/employees')).data.find((e) => e.name === 'Сластунов');
  const r = await api('POST', '/orders', {
    tractor_id: t.id, tractor_mileage: 1200000, inspector_id: emp.id,
    defects: {
      items: { eng_to: { state: 'ok', custom: [{ name: 'Замена фильтра салона', hours: 0.3 }] } },
      custom: [{ name: 'Ремонт замка двери', hours: 1.5, vehicle_type: 'tractor', priority: 3 }],
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const names = r.data.tasks.map((x) => x.description);
  assert.ok(names.includes('Замена фильтра салона'));
  assert.ok(names.includes('Ремонт замка двери'));
  const door = r.data.tasks.find((x) => x.description === 'Ремонт замка двери');
  assert.equal(door.work_type_id, null);
  assert.equal(door.hours, 1.5);
  assert.equal(door.price, 3000);
  assert.ok(door.employee_id, 'распределена на сотрудника');
  assert.equal(r.data.defects.inspector.name, 'Сластунов');
  assert.equal(r.data.plan_errors.length, 0, JSON.stringify(r.data.plan_errors));
});
