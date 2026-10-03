import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { referencedWorkKeys } from '../domain/checklist.js';
import { WorkCalendar } from '../domain/calendar.js';

let server, base, token, db;

const api = async (method, url, body, { raw = false, tok = token } = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const data = await res.json();
  return { status: res.status, data };
};

before(async () => {
  const app = createApp({ dbFile: ':memory:' });
  db = app.locals.db;
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  const r = await api('POST', '/auth/login', { login: 'admin', password: 'admin' }, { tok: null });
  token = r.data.token;
});
after(() => server.close());

test('все работы из правил дефектовки есть в справочнике', () => {
  const missing = referencedWorkKeys().filter((k) => {
    const [c, n] = k.split('::');
    return !db.prepare('SELECT id FROM work_types WHERE category = ? AND name = ?').get(c, n);
  });
  assert.deepEqual(missing, []);
});

test('сид: парк ТС, справочник работ, сотрудники', async () => {
  const tr = await api('GET', '/vehicles/tractor');
  const tl = await api('GET', '/vehicles/trailer');
  const wt = await api('GET', '/work-types');
  assert.ok(tr.data.length >= 50, `тягачей ${tr.data.length}`);
  assert.ok(tl.data.length >= 45, `прицепов ${tl.data.length}`);
  assert.ok(wt.data.length >= 180, `работ ${wt.data.length}`);
  const t = tr.data.find((x) => x.plate === 'Т970ОН58');
  assert.equal(t.brand, 'FAW');
  assert.equal(t.trailer_plate, 'АЕ1043/95');
});

test('рабочий календарь: переход через обед и выходные', () => {
  const c = new WorkCalendar({ tz_offset_min: 180, work_start: '08:00', work_end: '17:00', lunch_start: '12:00', lunch_end: '13:00', work_days: [1, 2, 3, 4, 5] });
  // пятница 16:00 МСК + 2 рабочих часа = понедельник 09:00 МСК
  const w = c.toWork('2026-10-02T13:00:00Z');
  assert.equal(c.fromWork(w + 120, true), '2026-10-05T06:00:00.000Z');
  // 11:30 + 1 ч = 13:30 (обед пропущен)
  const w2 = c.toWork('2026-10-01T08:30:00Z');
  assert.equal(c.fromWork(w2 + 60, true), '2026-10-01T10:30:00.000Z');
});

let orderId;

test('дефектовка → план ремонта, зоны осмотра, связанные проверки, расписание', async () => {
  const tractor = (await api('GET', '/vehicles/tractor')).data.find((x) => x.plate === 'Т970ОН58');
  const body = {
    tractor_id: tractor.id, trailer_id: tractor.trailer_id, tractor_mileage: 157000,
    defects: {
      items: {
        br_calipers: { positions: ['tractor:1:L'] },
        el_generator: { value: 26.4 },
        br_leak_trailer: { state: 'defect', comment: 'шипит у головки' },
        wash_tanks: { state: 'defect' },
        sus_silent: { positions: ['trailer:2:R'] },
        dmg_body: { zones: ['Бампер'], comment: 'скол' },
      },
    },
  };
  const prev = await api('POST', '/orders/preview', body);
  assert.equal(prev.status, 200);
  const names = prev.data.tasks.map((t) => t.description);
  assert.ok(names.includes('С/у суппорта перед'), 'суппорт передней оси');
  assert.ok(names.includes('Осмотр оси (суппорта, колодки,диски,амортизатора)'), 'связанная проверка оси');
  assert.ok(names.includes('Диагностика тормозов прицепа'), 'связанная проверка тормозов прицепа');
  assert.ok(names.includes('Выставление соосности балки'), 'соосность после сайлентблоков');
  assert.ok(names.includes('Мойка тягач'));
  assert.ok(prev.data.inspection.some((z) => z.item === 'br_calipers' && z.zone_text.includes('Тягач, ось 1, лев.')));
  assert.ok(prev.data.recommendations.some((r) => r.item === 'br_pads'), 'рекомендация проверить колодки');
  assert.equal(prev.data.damages.length, 1);
  // ТО: истории нет → точка отсчёта оценочная (120 000), до ТО 3 000 км → «скоро», рекомендация
  assert.ok(prev.data.recommendations.some((r) => r.maint === 'to'), 'рекомендация ТО по пробегу');
  assert.ok(!names.includes('Полное ТО Faw'));

  const res = await api('POST', '/orders', body);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  orderId = res.data.id;
  const o = res.data;
  assert.equal(o.plan_errors.length, 0, JSON.stringify(o.plan_errors));
  assert.ok(o.tasks.every((t) => t.employee_id && t.start_at), 'все работы распределены');
  // мойка раньше ремонта
  const wash = o.tasks.find((t) => t.description === 'Мойка тягач');
  const caliper = o.tasks.find((t) => t.description === 'С/у суппорта перед');
  assert.ok(wash.end_at <= caliper.start_at, 'мойка до ремонта');
  // допуск: компьютерная диагностика — только Чешуин (проверим через назначение диагностики электросистемы — «Все»)
  const emp = db.prepare('SELECT name FROM employees WHERE id = ?').get(caliper.employee_id);
  assert.ok(emp.name !== 'Токарь' && emp.name !== 'Сторонний сервис');
  // пробег записан
  const tr2 = (await api('GET', `/vehicles/tractor/${tractor.id}`)).data;
  assert.equal(tr2.mileage, 157000);
});

test('противоречие приоритета и сроков → ошибка, утверждение запрещено', async () => {
  const o = (await api('GET', `/orders/${orderId}`)).data;
  const p1 = o.tasks.find((t) => t.priority === 1);
  const p3 = o.tasks.find((t) => t.priority >= 3);
  const late = new Date(Date.now() + 20 * 86400000).toISOString();
  const early = new Date(Date.now() + 10 * 86400000).toISOString();
  await api('PUT', `/tasks/${p1.id}`, { deadline: late });
  const r = await api('PUT', `/tasks/${p3.id}`, { deadline: early });
  assert.ok(r.data.plan_errors.some((e) => e.code === 'priority_conflict'), JSON.stringify(r.data.plan_errors));
  assert.equal(r.data.status, 'plan_error');
  const ap = await api('POST', `/orders/${orderId}/approve`);
  assert.equal(ap.status, 409);
  // исправляем: возвращаем критичной работе исходный срок
  await api('PUT', `/tasks/${p1.id}`, { deadline: p1.deadline });
  const fixed = await api('POST', `/orders/${orderId}/approve`);
  assert.equal(fixed.status, 200, JSON.stringify(fixed.data));
  assert.equal(fixed.data.status, 'approved');
});

test('невозможность планирования: срок выпуска меньше объёма работ → ошибка', async () => {
  const tractor = (await api('GET', '/vehicles/tractor')).data.find((x) => x.plate === 'К531НК95');
  const res = await api('POST', '/orders', {
    tractor_id: tractor.id,
    release_deadline: new Date(Date.now() + 30 * 60000).toISOString(),
    defects: { items: { steer_cross: { state: 'defect' }, steer_long: { state: 'defect' }, dl_crosses: { state: 'defect' }, br_pads: { positions: ['tractor:2:L', 'tractor:2:R'] } } },
  });
  assert.equal(res.status, 201);
  assert.ok(res.data.plan_errors.some((e) => e.code === 'late'), JSON.stringify(res.data.plan_errors));
  assert.equal(res.data.status, 'plan_error');
});

test('выполнение работ, запчасти, переназначение', async () => {
  let o = (await api('GET', `/orders/${orderId}`)).data;
  const t = o.tasks[0];
  let r = await api('POST', `/tasks/${t.id}/status`, { status: 'in_progress' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'in_progress');
  r = await api('POST', `/tasks/${t.id}/status`, { status: 'done', actual_hours: 0.5, mileage: 157010 });
  assert.equal(r.status, 200);
  assert.equal(r.data.tasks.find((x) => x.id === t.id).status, 'done');

  r = await api('POST', `/orders/${orderId}/parts`, { task_id: o.tasks[1].id, name: 'Суппорт тормозной', code: '00-123', article: 'K012345', qty: 1, price: 45000 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.parts.length, 1);

  const emp = db.prepare("SELECT id FROM employees WHERE name = 'Козлов'").get();
  const other = o.tasks.find((x) => x.status === 'planned' && x.vehicle_type === 'trailer');
  r = await api('PUT', `/tasks/${other.id}`, { employee_id: emp.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.tasks.find((x) => x.id === other.id).employee_id, emp.id);

  // слесарь не может переназначать
  const m = await api('POST', '/auth/login', { login: 'slastunov', password: 'slastunov' }, { tok: null });
  const denied = await api('PUT', `/tasks/${other.id}`, { employee_id: null }, { tok: m.data.token });
  assert.equal(denied.status, 403);
});

test('отчёты: JSON, Excel, PDF, CSV', async () => {
  for (const type of ['works', 'salary', 'parts', 'vehicles', 'orders']) {
    const j = await api('GET', `/reports/${type}`);
    assert.equal(j.status, 200, type);
    assert.ok(Array.isArray(j.data.rows));
  }
  const works = await api('GET', '/reports/works');
  assert.equal(works.data.rows.length, 1);
  assert.ok(works.data.totals.price > 0);
  for (const fmt of ['xlsx', 'pdf', 'csv']) {
    const res = await api('GET', `/reports/works?format=${fmt}`, null, { raw: true });
    assert.equal(res.status, 200, fmt);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 200, `${fmt} size ${buf.length}`);
  }
  const pdf = await api('GET', `/orders/${orderId}/pdf`, null, { raw: true });
  assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
});

test('1С: импорт номенклатуры (CSV, CommerceML) и выгрузка установленных запчастей', async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['Код;Артикул;Наименование;Ед. изм.;Цена\n00-001;WVA29087;Колодки тормозные;компл;8 500,50\n00-002;;Фильтр масляный;шт;1200\n']), 'nom.csv');
  let res = await fetch(`${base}/parts/import`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  let data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.added, 2);

  const xml = `<?xml version="1.0"?><КоммерческаяИнформация><Каталог><Товары>
    <Товар><Ид>00-001</Ид><Артикул>WVA29087</Артикул><Наименование>Колодки тормозные дисковые</Наименование><БазоваяЕдиница>компл</БазоваяЕдиница></Товар>
    <Товар><Ид>00-003</Ид><Наименование>Пневмоподушка</Наименование></Товар>
  </Товары></Каталог><ПакетПредложений><Предложения><Предложение><Ид>00-003</Ид><Цены><Цена><ЦенаЗаЕдиницу>15400</ЦенаЗаЕдиницу></Цена></Цены></Предложение></Предложения></ПакетПредложений></КоммерческаяИнформация>`;
  const fd2 = new FormData();
  fd2.append('file', new Blob([xml]), 'import.xml');
  res = await fetch(`${base}/parts/import`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd2 });
  data = await res.json();
  assert.deepEqual([data.added, data.updated], [1, 1]);
  const p = (await api('GET', '/parts?q=Пневмоподушка')).data[0];
  assert.equal(p.price, 15400);

  const ex = await api('GET', '/onec/export?format=xml&only_new=1&mark=1', null, { raw: true });
  const text = await ex.text();
  assert.ok(text.includes('<Строка Код="00-123"'), text);
  const again = await api('GET', '/onec/export?format=json&only_new=1');
  assert.equal(again.data.length, 0, 'повторно не выгружается');
});

test('офлайн-синхронизация: повтор операции с тем же X-Op-Id не дублирует', async () => {
  const send = () => fetch(`${base}/parts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-op-id': 'op-test-1' },
    body: JSON.stringify({ name: 'Лампа H7 24V' }),
  }).then((r) => r.json());
  const a = await send();
  const b = await send();
  assert.equal(a.id, b.id);
  assert.equal((await api('GET', '/parts?q=Лампа H7')).data.length, 1);
});

test('ТО: рекомендации по пробегу', async () => {
  const m = await api('GET', '/maintenance');
  const row = m.data.find((x) => x.plate === 'Т970ОН58' && x.key === 'to');
  assert.ok(row);
  assert.equal(row.next_km, 160000);
  assert.equal(row.status, 'soon');
});
