// Начальное наполнение базы: справочник работ (прайс заказчика), сотрудники и допуски,
// парк ТС (список тягачей и полуприцепов), правила ТО, пользователи.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.js';
import { normalizePlate, splitBrand } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(path.join(here, 'seed', f), 'utf8'));

const TRAILER_CATEGORIES = new Set(['Прицеп', 'Ходовая часть прицепа']);
const ANY_VEHICLE = new Set([
  'Тормозная система::Осмотр оси (суппорта, колодки,диски,амортизатора)',
  'Тормозная система::С/у колодок (диск) задние',
  'Тормозная система::C/у тормозного диска(зад)',
  'Тормозная система::С/у суппорта зад',
  'Тормозная система::С/у энергоаккумулятора',
  'Тормозная система::С/у тормозной камеры',
  'Прицеп::С/у пневмоподушки',
  'Прицеп::Слесарные работы за 1 н/ч',
  'Мойка::Мойка сцепка',
]);

// Работы, которых нет в прайсе, но которые нужны правилам дефектовки.
// Норма и цена рассчитаны от нормо-часа 2000 ₽ и ставки ЗП 32 % — проверьте и скорректируйте.
const EXTRA_WORKS = [
  ['Поиск и устранение утечки воздуха', 'any', 1],
  ['Слив конденсата, проверка осушителя воздуха', 'tractor', 0.5],
  ['Замена ламп/фонарей/фар', 'any', 0.5],
  ['Проверка и зарядка АКБ', 'tractor', 0.5],
  ['С/у АКБ', 'tractor', 0.5],
  ['Диагностика электросистемы (зарядка, проводка)', 'any', 1],
  ['Устранение течи антифриза (патрубки, хомуты)', 'tractor', 1],
  ['Устранение течи масла (поиск, замена уплотнений)', 'tractor', 1],
  ['Шиномонтаж (с/у, замена шины 1 колесо)', 'any', 0.6],
  ['Ремонт тента', 'trailer', 1],
  ['Сварочные работы (рама/платформа/борта) за 1 н/ч', 'trailer', 1],
  ['Ремонт/регулировка сдвижного устройства', 'trailer', 1.5],
  ['Замена таможенного троса/ленты', 'trailer', 0.5],
  ['Ремонт стойки', 'trailer', 1],
  ['Кузовной ремонт (по согласованию)', 'any', 1],
  ['Обслуживание реф. установки (по согласованию)', 'trailer', 1],
];

const EMPLOYEES = [
  { name: 'Чешуин', position: 'Диагност-электрик', qualification: 'Компьютерная диагностика, электрика', level: 3, specializations: ['Автомобиль', 'Дополнительные работы'] },
  { name: 'Жуйков', position: 'Моторист', qualification: 'Капитальный ремонт ДВС, топливная аппаратура', level: 3, specializations: ['ДВС'] },
  { name: 'Жужгин', position: 'Слесарь по ремонту а/м', qualification: 'ДВС, тормозная система', level: 2, specializations: ['ДВС', 'Тормозная система'] },
  { name: 'Сластунов', position: 'Слесарь-ходовик', qualification: 'Ходовая, трансмиссия, рулевое', level: 3, specializations: ['Трансмиссия', 'Подвеска', 'Рулевое управление'] },
  { name: 'Козырев', position: 'Слесарь по ремонту а/м', qualification: 'Трансмиссия, снятие/установка агрегатов', level: 3, specializations: ['Трансмиссия', 'Подвеска', 'ДВС'] },
  { name: 'Козлов', position: 'Слесарь по ремонту прицепов', qualification: 'Ходовая и тормоза прицепов', level: 2, specializations: ['Прицеп', 'Ходовая часть прицепа'] },
  { name: 'Токарь', position: 'Токарь', qualification: 'токарь', level: 2, specializations: [], general_access: 0 },
  { name: 'Сторонний сервис', position: 'Подрядчик', qualification: 'сервис', level: 2, specializations: [], general_access: 0, is_external: 1 },
];

const MAINTENANCE = [
  { key: 'to', name: 'Полное ТО', vehicle_type: 'tractor', brand_match: 'MAN', interval_km: 50000, interval_days: 365, wt: 'ДВС::Полное ТО Man, Scania, Mercedes' },
  { key: 'to', name: 'Полное ТО', vehicle_type: 'tractor', brand_match: 'SCANIA', interval_km: 50000, interval_days: 365, wt: 'ДВС::Полное ТО Man, Scania, Mercedes' },
  { key: 'to', name: 'Полное ТО', vehicle_type: 'tractor', brand_match: 'MERCEDES', interval_km: 50000, interval_days: 365, wt: 'ДВС::Полное ТО Man, Scania, Mercedes' },
  { key: 'to', name: 'Полное ТО', vehicle_type: 'tractor', brand_match: 'DAF', interval_km: 50000, interval_days: 365, wt: 'ДВС::Полное ТО Daf' },
  { key: 'to', name: 'Полное ТО', vehicle_type: 'tractor', brand_match: 'FAW', interval_km: 40000, interval_days: 365, wt: 'ДВС::Полное ТО Faw' },
  { key: 'valves', name: 'Регулировка клапанов', vehicle_type: 'tractor', brand_match: null, interval_km: 120000, interval_days: null, wt: 'ДВС::Регулировка клапанов' },
  { key: 'trailer_service', name: 'Обслуживание ходовой прицепа', vehicle_type: 'trailer', brand_match: null, interval_km: 50000, interval_days: 180, wt: 'Ходовая часть прицепа::Выставление соосности балки' },
  { key: 'trailer_brakes', name: 'Диагностика тормозов прицепа', vehicle_type: 'trailer', brand_match: null, interval_km: 50000, interval_days: 180, wt: 'Прицеп::Диагностика тормозов прицепа' },
];

export const DEFAULT_SETTINGS = {
  company: 'FiberFleet',
  tz_offset_min: 180,             // Москва (UTC+3)
  work_start: '08:00',
  work_end: '17:00',
  lunch_start: '12:00',
  lunch_end: '13:00',
  work_days: [1, 2, 3, 4, 5],     // пн–пт
  holidays: [],                   // ['2026-11-04', ...]
  max_workers_per_vehicle: 2,
  norm_hour_price: 2000,
  salary_rate: 0.32,
};

export function seedIfEmpty(db) {
  const has = db.prepare('SELECT COUNT(*) c FROM work_types').get().c > 0;
  if (has) return false;
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)').run(k, JSON.stringify(v));
    }

    // Сотрудники
    const empIds = {};
    const insEmp = db.prepare(`INSERT INTO employees(name, position, qualification, level, specializations, general_access, is_external)
      VALUES (@name, @position, @qualification, @level, @specializations, @general_access, @is_external)`);
    for (const e of EMPLOYEES) {
      empIds[e.name] = insEmp.run({
        general_access: 1, is_external: 0, ...e, specializations: JSON.stringify(e.specializations),
      }).lastInsertRowid;
    }

    // Справочник работ
    const insWt = db.prepare(`INSERT INTO work_types(code, category, name, applies_to, hours, hours_max, price, price_max,
      salary, salary_max, access_all, external, required_qualification, note)
      VALUES (@code, @category, @name, @applies_to, @hours, @hours_max, @price, @price_max, @salary, @salary_max,
      @access_all, @external, @required_qualification, @note)`);
    const insAcc = db.prepare('INSERT OR IGNORE INTO work_type_access(work_type_id, employee_id) VALUES (?, ?)');
    const catalog = load('catalog.json');
    let n = 0;
    const codeFor = () => `W${String(++n).padStart(3, '0')}`;
    for (const w of catalog) {
      const key = `${w.category}::${w.name}`;
      const appliesTo = ANY_VEHICLE.has(key) || w.category === 'Мойка' ? 'any'
        : TRAILER_CATEGORIES.has(w.category) ? 'trailer' : 'tractor';
      const access = (w.access || []).filter((a) => a.toLowerCase() !== 'токарь');
      const turner = (w.access || []).some((a) => a.toLowerCase() === 'токарь');
      const id = insWt.run({
        code: codeFor(), category: w.category, name: w.name, applies_to: appliesTo,
        hours: w.hours, hours_max: w.hours_max, price: w.price, price_max: w.price_max,
        salary: w.salary, salary_max: w.salary_max,
        access_all: w.access_all ? 1 : 0, external: w.external ? 1 : 0,
        required_qualification: turner ? 'токарь' : null, note: w.note,
      }).lastInsertRowid;
      for (const a of access) if (empIds[a]) insAcc.run(id, empIds[a]);
      if (turner) insAcc.run(id, empIds['Токарь']);
      if (w.external) insAcc.run(id, empIds['Сторонний сервис']);
    }
    for (const [name, appliesTo, hours] of EXTRA_WORKS) {
      const price = Math.round(hours * DEFAULT_SETTINGS.norm_hour_price);
      insWt.run({
        code: codeFor(), category: 'Дополнительные работы', name, applies_to: appliesTo,
        hours, hours_max: hours, price, price_max: price,
        salary: Math.round(price * DEFAULT_SETTINGS.salary_rate), salary_max: null,
        access_all: 1, external: 0, required_qualification: null,
        note: 'Добавлено FiberFleet (нет в прайсе): проверьте норму и цену',
      });
    }

    // Парк ТС
    const insTrailer = db.prepare(`INSERT INTO trailers(plate, brand, model, year, axles, brake_type, has_reefer)
      VALUES (?, ?, ?, ?, 3, ?, ?)`);
    const insTractor = db.prepare(`INSERT INTO tractors(plate, brand, model, year, axles, brake_type, trailer_id)
      VALUES (?, ?, ?, ?, 2, ?, ?)`);
    for (const row of load('fleet.json')) {
      let trailerId = null;
      if (row.trailer) {
        const plate = normalizePlate(row.trailer);
        const ex = db.prepare('SELECT id FROM trailers WHERE plate = ?').get(plate);
        if (ex) trailerId = ex.id;
        else {
          const { brand, model } = splitBrand(row.trailer_model);
          const isKogel = /KOGEL|KÖGEL/i.test(brand);
          const reefer = /SKO/i.test(row.trailer_model) ? 1 : 0;
          trailerId = insTrailer.run(plate, brand, model || row.trailer_model, row.trailer_year || null,
            isKogel ? 'drum' : 'disc', reefer).lastInsertRowid;
        }
      }
      if (row.tractor) {
        const { brand, model } = splitBrand(row.tractor_model);
        const plate = normalizePlate(row.tractor);
        if (db.prepare('SELECT id FROM tractors WHERE plate = ?').get(plate)) continue;
        const drum = /CF85/i.test(model) ? 'drum' : 'disc';
        insTractor.run(plate, brand, model, row.tractor_year || null, drum, trailerId);
      }
    }

    // Правила ТО
    const wtByKey = (key) => {
      const [category, name] = key.split('::');
      return db.prepare('SELECT id FROM work_types WHERE category = ? AND name = ?').get(category, name)?.id ?? null;
    };
    const insRule = db.prepare(`INSERT INTO maintenance_rules(key, name, vehicle_type, brand_match, interval_km, interval_days, work_type_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const r of MAINTENANCE) {
      insRule.run(r.key, r.name, r.vehicle_type, r.brand_match, r.interval_km, r.interval_days, wtByKey(r.wt));
    }

    // Пользователи
    const insUser = db.prepare('INSERT INTO users(login, name, pass_hash, role, employee_id) VALUES (?, ?, ?, ?, ?)');
    const adminPass = process.env.FF_ADMIN_PASSWORD || 'admin';
    insUser.run('admin', 'Администратор', hashPassword(adminPass), 'admin', null);
    if (process.env.FF_DEMO_USERS !== '0') {
      insUser.run('operator', 'Оператор', hashPassword('operator'), 'operator', null);
      insUser.run('master', 'Мастер-приёмщик', hashPassword('master'), 'master', null);
      insUser.run('slastunov', 'Сластунов', hashPassword('slastunov'), 'mechanic', empIds['Сластунов']);
    }
  });
  tx();
  return true;
}
