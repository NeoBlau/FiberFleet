// Актуализация парка в существующей базе FiberFleet по файлу server/seed/fleet.json:
// добавляет новые тягачи и прицепы, обновляет модель/год и сцепки, записывает пробег
// (в журнал пробега, источник «import») и заметки. Ничего не удаляет, историю ремонтов не трогает.
//
//   node tools/fleet-update.mjs              — применить
//   node tools/fleet-update.mjs --dry-run    — только показать, что изменится
//
// База: переменная FF_DB или FF_DATA_DIR (как у сервера), по умолчанию data/fiberfleet.db.
// На сервере после установки:  sudo -u fiberfleet env FF_DATA_DIR=/var/lib/fiberfleet node tools/fleet-update.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { seedIfEmpty } from '../server/seed.js';
import { recordMileage } from '../server/domain/maintenance.js';
import { normalizePlate, splitBrand } from '../server/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');
const AS_OF = process.env.FF_MILEAGE_DATE || '2026-10-02T09:00:00.000Z'; // дата сводки «АВТО»

const fleet = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/seed/fleet.json'), 'utf8'));
const db = openDb();
seedIfEmpty(db);

const log = { tractorsAdded: [], trailersAdded: [], updated: [], coupling: [], mileage: [], mileageSkipped: [], notes: [] };
const now = new Date().toISOString();

function upsertTrailer(row) {
  const plate = normalizePlate(row.trailer);
  const { brand, model } = splitBrand(row.trailer_model || '');
  const cur = db.prepare('SELECT * FROM trailers WHERE plate = ?').get(plate);
  if (!cur) {
    const isKogel = /KOGEL|KÖGEL/i.test(brand);
    const reefer = /SKO|реф/i.test(row.trailer_model || '') ? 1 : 0;
    const id = db.prepare(`INSERT INTO trailers(plate, brand, model, year, axles, brake_type, has_reefer, notes)
      VALUES (?, ?, ?, ?, 3, ?, ?, ?)`).run(plate, brand || null, model || row.trailer_model || plate, row.trailer_year || null,
      isKogel ? 'drum' : 'disc', reefer, row.trailer_note || null).lastInsertRowid;
    log.trailersAdded.push(`${plate} ${row.trailer_model || ''}`);
    return Number(id);
  }
  const upd = {};
  if (brand && brand !== cur.brand) { upd.brand = brand; upd.brake_type = /KOGEL|KÖGEL/i.test(brand) ? 'drum' : 'disc'; }
  if (model && model !== cur.model) upd.model = model;
  if (/SKO|реф/i.test(row.trailer_model || '') && !cur.has_reefer) upd.has_reefer = 1;
  if (row.trailer_year && row.trailer_year !== cur.year) upd.year = row.trailer_year;
  if (row.trailer_note && row.trailer_note !== cur.notes) { upd.notes = row.trailer_note; log.notes.push(`${plate}: ${row.trailer_note}`); }
  if (cur.archived) upd.archived = 0;
  if (Object.keys(upd).length) {
    db.prepare(`UPDATE trailers SET ${Object.keys(upd).map((k) => `${k} = @${k}`).join(', ')}, updated_at = @ts WHERE id = @id`).run({ ...upd, ts: now, id: cur.id });
    log.updated.push(`${plate}: ${Object.keys(upd).join(', ')}`);
  }
  return cur.id;
}

const apply = db.transaction(() => {
  for (const row of fleet) {
    const trailerId = row.trailer ? upsertTrailer(row) : null;
    if (!row.tractor) continue;
    const plate = normalizePlate(row.tractor);
    const { brand, model } = splitBrand(row.tractor_model || '');
    let cur = db.prepare('SELECT * FROM tractors WHERE plate = ?').get(plate);
    if (!cur) {
      const id = db.prepare(`INSERT INTO tractors(plate, brand, model, year, axles, brake_type, notes) VALUES (?, ?, ?, ?, 2, ?, ?)`)
        .run(plate, brand || '—', model || null, row.tractor_year || null, /CF85/i.test(model) ? 'drum' : 'disc', row.tractor_note || null).lastInsertRowid;
      cur = db.prepare('SELECT * FROM tractors WHERE id = ?').get(id);
      log.tractorsAdded.push(`${plate} ${row.tractor_model || ''}`);
    } else {
      const upd = {};
      if (brand && brand !== cur.brand) upd.brand = brand;
      if (model && model !== cur.model) upd.model = model;
      if (row.tractor_year && row.tractor_year !== cur.year) upd.year = row.tractor_year;
      if (row.tractor_note && row.tractor_note !== cur.notes) { upd.notes = row.tractor_note; log.notes.push(`${plate}: ${row.tractor_note}`); }
      if (cur.archived) upd.archived = 0;
      if (Object.keys(upd).length) {
        db.prepare(`UPDATE tractors SET ${Object.keys(upd).map((k) => `${k} = @${k}`).join(', ')}, updated_at = @ts WHERE id = @id`).run({ ...upd, ts: now, id: cur.id });
        log.updated.push(`${plate}: ${Object.keys(upd).join(', ')}`);
      }
    }
    // сцепка по сводке: прицеп из строки (или без прицепа)
    if ((cur.trailer_id || null) !== trailerId) {
      if (trailerId) db.prepare('UPDATE tractors SET trailer_id = NULL WHERE trailer_id = ? AND id <> ?').run(trailerId, cur.id);
      db.prepare('UPDATE tractors SET trailer_id = ?, updated_at = ? WHERE id = ?').run(trailerId, now, cur.id);
      log.coupling.push(`${plate} → ${row.trailer ? normalizePlate(row.trailer) : 'без прицепа'}`);
    }
    // пробег: в системе пробег не уменьшается — меньшее значение только фиксируется в журнале
    if (row.tractor_mileage) {
      const before = db.prepare('SELECT mileage FROM tractors WHERE id = ?').get(cur.id).mileage;
      if (row.tractor_mileage < before) log.mileageSkipped.push(`${plate}: ${row.tractor_mileage} < текущего ${before}`);
      else if (row.tractor_mileage !== before) {
        recordMileage(db, { type: 'tractor', id: cur.id, mileage: row.tractor_mileage, at: AS_OF, source: 'import' });
        log.mileage.push(`${plate}: ${before || 0} → ${row.tractor_mileage}`);
      }
    }
  }
  if (DRY) throw Object.assign(new Error('dry-run'), { dry: true });
});

try {
  apply();
} catch (e) {
  if (!e.dry) throw e;
}

const inFile = new Set(fleet.filter((r) => r.tractor).map((r) => normalizePlate(r.tractor)));
const inFileTr = new Set(fleet.filter((r) => r.trailer).map((r) => normalizePlate(r.trailer)));
const missing = db.prepare('SELECT plate FROM tractors WHERE archived = 0').all().map((r) => r.plate).filter((p) => !inFile.has(p));
const missingTr = db.prepare('SELECT plate FROM trailers WHERE archived = 0').all().map((r) => r.plate).filter((p) => !inFileTr.has(p));

const sec = (title, list) => { if (list.length) console.log(`\n${title} (${list.length}):\n  ${list.join('\n  ')}`); };
console.log(DRY ? '=== ПРОВЕРКА (--dry-run): изменения НЕ сохранены ===' : '=== Парк актуализирован ===');
sec('Добавлены тягачи', log.tractorsAdded);
sec('Добавлены прицепы', log.trailersAdded);
sec('Обновлены данные ТС', log.updated);
sec('Изменены сцепки', log.coupling);
sec('Записан пробег', log.mileage);
sec('Пробег не применён (меньше текущего)', log.mileageSkipped);
sec('Заметки', log.notes);
sec('Есть в базе, но нет в сводке (не изменялись — при необходимости перенесите в архив вручную)', [...missing, ...missingTr]);
