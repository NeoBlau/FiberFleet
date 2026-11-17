import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';

let app, server, base, token;
const api = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};
const work = (id) => app.locals.db.prepare('SELECT * FROM work_types WHERE id = ?').get(id);
const create = async (hours = 1, hours_max = null) => {
  const r = await api('POST', '/work-types', { category: 'Проверка расчётов', name: 'Тест нормы', hours, hours_max });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
};
before(async () => {
  process.env.FF_ADMIN_PASSWORD = 'LocalPricingTestOnly2026';
  app = createApp({ dbFile: ':memory:' });
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  token = (await api('POST', '/auth/login', { login: 'admin', password: process.env.FF_ADMIN_PASSWORD })).data.token;
  const r = await api('PUT', '/settings', { norm_hour_price: 2640, salary_rate: 0.4 });
  assert.equal(r.status, 200);
});
after(() => { server?.close(); app?.locals.db.close(); });

test('норма 3 часа пересчитывает цену и ЗП даже с устаревшими суммами в полном payload формы', async () => {
  const id = await create(1, 1);
  const old = work(id);
  const r = await api('PUT', `/work-types/${id}`, { ...old, hours: 3 });
  assert.equal(r.status, 200);
  assert.equal(work(id).price, 7920);
  assert.equal(work(id).salary, 3168);
  assert.equal(work(id).hours_max, 3);
  assert.equal(work(id).price_max, 7920);
  assert.equal(work(id).salary_max, 3168);
});

test('ставка 2700 обновляет цены, ЗП, верхние границы и только ещё не начатые задания', async () => {
  const id = await create(3, 4);
  const db = app.locals.db;
  const states = ['planned', 'in_progress', 'paused', 'done', 'cancelled'];
  const ins = db.prepare("INSERT INTO tasks(vehicle_type, vehicle_id, work_type_id, description, hours, price, salary, status) VALUES ('tractor', 1, ?, 'Тест', 3, 7920, 3168, ?)");
  const ids = states.map(status => Number(ins.run(id, status).lastInsertRowid));
  const history = ids.slice(1).map(id => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  assert.equal((await api('PUT', '/settings', { norm_hour_price: 2700 })).status, 200);
  const w = work(id);
  assert.deepEqual([w.price, w.salary, w.price_max, w.salary_max], [8100, 3240, 10800, 4320]);
  const planned = db.prepare('SELECT price, salary FROM tasks WHERE id = ?').get(ids[0]);
  assert.deepEqual(planned, { price: 8100, salary: 3240 });
  assert.deepEqual(ids.slice(1).map(id => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)), history);
  assert.equal((await api('PUT', `/work-types/${id}`, { hours: 5 })).status, 200);
  assert.deepEqual(db.prepare('SELECT hours, price, salary FROM tasks WHERE id = ?').get(ids[0]), { hours: 5, price: 13500, salary: 5400 });
  assert.deepEqual(ids.slice(1).map(id => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)), history);
});

test('изменение только процента зарплаты и нулевая доля', async () => {
  const id = await create(3);
  assert.equal((await api('PUT', '/settings', { salary_rate: 0.35 })).status, 200);
  assert.deepEqual([work(id).price, work(id).salary], [8100, 2835]);
  assert.equal((await api('PUT', '/settings', { salary_rate: 0 })).status, 200);
  assert.equal(work(id).salary, 0);
  const tractor = app.locals.db.prepare('SELECT id FROM tractors LIMIT 1').get();
  const preview = await api('POST', '/orders/preview', { tractor_id: tractor.id, defects: { custom: [{ name: 'Вручную без ЗП', hours: 1, vehicle_type: 'tractor' }] } });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.tasks.find(t => t.description === 'Вручную без ЗП').salary, 0);
  assert.equal((await api('PUT', '/settings', { salary_rate: 0.4 })).status, 200);
});

test('диапазон норм и округление ЗП от рассчитанной цены', async () => {
  const id = await create(0.375, 1.125);
  assert.deepEqual([work(id).price, work(id).salary, work(id).price_max, work(id).salary_max], [1013, 405, 3038, 1215]);
  assert.equal((await api('PUT', `/work-types/${id}`, { hours_max: '' })).status, 200);
  assert.equal(work(id).price_max, null);
  assert.equal(work(id).salary_max, null);
});

test('неверная ставка и процент отклоняются без частичного изменения настроек и каталога', async () => {
  const before = (await api('GET', '/settings')).data;
  const rows = app.locals.db.prepare('SELECT * FROM work_types').all();
  for (const patch of [{ norm_hour_price: -1 }, { norm_hour_price: 0 }, { salary_rate: 40 }, { salary_rate: -0.1 }, { norm_hour_price: 'oops' }]) {
    assert.equal((await api('PUT', '/settings', patch)).status, 400);
  }
  assert.deepEqual((await api('GET', '/settings')).data, before);
  assert.deepEqual(app.locals.db.prepare('SELECT * FROM work_types').all(), rows);
});
