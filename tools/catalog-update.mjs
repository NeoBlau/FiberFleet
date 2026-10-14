// Актуализация справочника работ в существующей базе по файлу server/seed/catalog.json (прайс заказчика):
// обновляет нормы времени, цены, ЗП и допуски, добавляет новые работы и сотрудников из допусков.
// Ничего не удаляет: работы, которых нет в прайсе, только перечисляются. История ремонтов не меняется.
//
//   node tools/catalog-update.mjs                — применить
//   node tools/catalog-update.mjs --dry-run      — только показать изменения
//   node tools/catalog-update.mjs --apply-open   — также пересчитать норму/цену/ЗП в ещё не начатых работах
//
// База: FF_DB или FF_DATA_DIR (как у сервера). На сервере:
//   runuser -u fiberfleet -- env FF_DATA_DIR=/var/lib/fiberfleet node tools/catalog-update.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { appliesToFor, EMPLOYEES, EXTRA_WORKS, seedIfEmpty } from '../server/seed.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');
const APPLY_OPEN = process.argv.includes('--apply-open');

// Работы, которые в новом прайсе переименованы или разделены (старое → новое; история сохраняется)
const RENAMES = {
  'ДВС::с/у радиатора +интеркуллер': 'С/у радиатора +интеркуллер без сохранения фриона',
  'Тормозная система::c/у тормозного диска(перед)': 'C/у тормозного диска(перед) Мерседес МАН',
  'Тормозная система::c/у тормозного диска(зад)': 'C/у тормозного диска(зад) Мерседес МАН',
  'Тормозная система::замена/смазка ступичного подшипника/ступица снята': 'Замена ступичного подшипника/ступица снята',
  'Трансмиссия::замена креставины карданного вала': 'Замена крестовины карданного вала',
};

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/seed/catalog.json'), 'utf8'));
const db = openDb();
seedIfEmpty(db);
const now = new Date().toISOString();
const log = { renamed: [], added: [], changed: [], access: [], employees: [], extra: [], settings: [], open: 0 };
const k = (c, n) => `${c}::${String(n).trim().replace(/\.+$/, '').toLowerCase()}`;

const run = db.transaction(() => {
  // 1. Сотрудники из допусков, которых нет в базе
  const empByName = () => new Map(db.prepare('SELECT id, name FROM employees').all().map((e) => [e.name, e.id]));
  let emps = empByName();
  const wanted = new Set(catalog.flatMap((w) => w.access || []).filter((a) => a.toLowerCase() !== 'токарь'));
  for (const name of wanted) {
    if (emps.has(name)) continue;
    const tpl = EMPLOYEES.find((e) => e.name === name) || { name, position: 'Слесарь по ремонту а/м', qualification: null, level: 2, specializations: [] };
    db.prepare(`INSERT INTO employees(name, position, qualification, level, specializations) VALUES (?, ?, ?, ?, ?)`)
      .run(tpl.name, tpl.position, tpl.qualification, tpl.level, JSON.stringify(tpl.specializations || []));
    log.employees.push(name);
  }
  emps = empByName();

  // 2. Переименования
  const rows = () => db.prepare('SELECT * FROM work_types').all();
  for (const w of rows()) {
    const to = RENAMES[k(w.category, w.name)];
    if (to && !rows().some((x) => k(x.category, x.name) === k(w.category, to))) {
      db.prepare('UPDATE work_types SET name = ?, updated_at = ? WHERE id = ?').run(to, now, w.id);
      log.renamed.push(`${w.category}: «${w.name}» → «${to}»`);
    }
  }

  // 3. Цены, нормы, допуски; новые работы
  const byKey = new Map(rows().map((w) => [k(w.category, w.name), w]));
  let maxCode = Math.max(0, ...rows().map((w) => Number(String(w.code).replace(/\D/g, '')) || 0));
  for (const n of catalog) {
    const turner = (n.access || []).some((a) => a.toLowerCase() === 'токарь');
    const fields = {
      name: n.name, category: n.category, hours: n.hours, hours_max: n.hours_max, price: n.price, price_max: n.price_max,
      salary: n.salary, salary_max: n.salary_max, access_all: n.access_all ? 1 : 0, external: n.external ? 1 : 0,
      required_qualification: turner ? 'токарь' : null, note: n.note, active: 1,
    };
    let w = byKey.get(k(n.category, n.name));
    if (!w) {
      const id = db.prepare(`INSERT INTO work_types(code, category, name, applies_to, hours, hours_max, price, price_max, salary, salary_max,
        access_all, external, required_qualification, note) VALUES (@code, @category, @name, @applies_to, @hours, @hours_max, @price, @price_max,
        @salary, @salary_max, @access_all, @external, @required_qualification, @note)`)
        .run({ ...fields, code: `W${String(++maxCode).padStart(3, '0')}`, applies_to: appliesToFor(n.category, n.name) }).lastInsertRowid;
      w = db.prepare('SELECT * FROM work_types WHERE id = ?').get(id);
      log.added.push(`${n.category}: ${n.name} — ${n.hours} ч, ${n.price ?? 'к/д'} ₽`);
    } else {
      const diff = Object.keys(fields).filter((f) => (w[f] ?? null) !== (fields[f] ?? null));
      if (diff.length) {
        db.prepare(`UPDATE work_types SET ${diff.map((f) => `${f} = @${f}`).join(', ')}, updated_at = @ts WHERE id = @id`).run({ ...fields, ts: now, id: w.id });
        if (diff.some((f) => ['hours', 'price', 'salary'].includes(f))) {
          log.changed.push(`${n.name}: ${w.hours} ч / ${w.price ?? 'к/д'} ₽ → ${n.hours} ч / ${n.price ?? 'к/д'} ₽`);
        }
      }
    }
    // допуски: как в прайсе
    const want = new Set((n.access || []).map((a) => (a.toLowerCase() === 'токарь' ? emps.get('Токарь') : emps.get(a))).filter(Boolean));
    if (n.external && emps.get('Сторонний сервис')) want.add(emps.get('Сторонний сервис'));
    const have = new Set(db.prepare('SELECT employee_id FROM work_type_access WHERE work_type_id = ?').all(w.id).map((r) => r.employee_id));
    if (want.size !== have.size || [...want].some((x) => !have.has(x))) {
      db.prepare('DELETE FROM work_type_access WHERE work_type_id = ?').run(w.id);
      for (const e of want) db.prepare('INSERT INTO work_type_access(work_type_id, employee_id) VALUES (?, ?)').run(w.id, e);
      log.access.push(`${n.name}: ${n.access_all ? 'все' : n.external ? 'сервис' : (n.access || []).join(', ')}`);
    }
  }

  // 4. Стоимость нормо-часа и доля ЗП (если не меняли вручную)
  const get = (key) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? JSON.parse(r.value) : null; };
  const set = (key, v) => db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(v));
  if (get('norm_hour_price') === 2000) { set('norm_hour_price', 2640); log.settings.push('стоимость нормо-часа 2000 → 2640 ₽ (с НДС)'); }
  if (get('salary_rate') === 0.32) { set('salary_rate', 0.2424); log.settings.push('доля ЗП 32 % → 24,24 % (640 ₽ с нормо-часа)'); }

  // 5. Дополнительные работы FiberFleet (нет в прайсе): пересчёт по новой стоимости нормо-часа, если их не правили
  for (const [name, , hours] of EXTRA_WORKS) {
    const w = db.prepare("SELECT * FROM work_types WHERE category = 'Дополнительные работы' AND name = ?").get(name);
    if (!w || w.price !== Math.round(hours * 2000)) continue;
    const price = Math.round(hours * 2640);
    db.prepare('UPDATE work_types SET price = ?, price_max = ?, salary = ?, note = ?, updated_at = ? WHERE id = ?')
      .run(price, price, Math.round(hours * 640), 'Добавлено FiberFleet (нет в прайсе): рассчитано от 2640 ₽/н-ч — проверьте', now, w.id);
    log.extra.push(`${name}: ${w.price} → ${price} ₽`);
  }

  // 6. По желанию — ещё не начатые работы получают новые норму и цену
  if (APPLY_OPEN) {
    log.open = db.prepare(`UPDATE tasks SET hours = (SELECT hours FROM work_types w WHERE w.id = tasks.work_type_id),
      price = (SELECT price FROM work_types w WHERE w.id = tasks.work_type_id), salary = (SELECT salary FROM work_types w WHERE w.id = tasks.work_type_id),
      updated_at = ? WHERE status = 'planned' AND work_type_id IS NOT NULL`).run(now).changes;
  }
  if (DRY) throw Object.assign(new Error('dry'), { dry: true });
});

try { run(); } catch (e) { if (!e.dry) throw e; }

const inPrice = new Set(catalog.map((n) => k(n.category, n.name)));
const notInPrice = db.prepare("SELECT category, name FROM work_types WHERE active = 1 AND category <> 'Дополнительные работы'").all()
  .filter((w) => !inPrice.has(k(w.category, w.name))).map((w) => `${w.category}: ${w.name}`);

const sec = (t, l) => { if (l.length) console.log(`\n${t} (${l.length}):\n  ${l.join('\n  ')}`); };
console.log(DRY ? '=== ПРОВЕРКА (--dry-run): изменения НЕ сохранены ===' : '=== Справочник работ актуализирован ===');
sec('Новые сотрудники (из допусков)', log.employees);
sec('Переименованы (история сохранена)', log.renamed);
sec('Новые работы', log.added);
sec('Изменены норма/цена', log.changed);
sec('Изменены допуски', log.access);
sec('Настройки', log.settings);
sec('Дополнительные работы пересчитаны', log.extra);
if (APPLY_OPEN) console.log(`\nОбновлено незапущенных работ: ${log.open}`);
sec('Есть в справочнике, но нет в прайсе (не изменялись)', notInPrice);
