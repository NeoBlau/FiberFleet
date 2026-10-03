import express from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { requirePerm } from '../auth.js';
import { nowIso } from '../db.js';
import { getSettings } from '../settings.js';
import { audit } from '../services/orders.js';
import { bad, fmtDateTime, notFound, num } from '../util.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- Разбор файлов номенклатуры из 1С ----

const HEADERS = {
  code: ['код', 'код 1с', 'ид', 'id', 'code'],
  article: ['артикул', 'article', 'арт', 'арт.'],
  name: ['наименование', 'номенклатура', 'название', 'name', 'товар'],
  unit: ['ед', 'ед.', 'ед. изм.', 'ед.изм.', 'единица', 'единица измерения', 'unit'],
  price: ['цена', 'цена с ндс', 'цена продажи', 'price', 'стоимость'],
};

function mapHeader(cells) {
  const idx = {};
  cells.forEach((c, i) => {
    const h = String(c ?? '').trim().toLowerCase();
    for (const [k, names] of Object.entries(HEADERS)) if (idx[k] == null && names.includes(h)) idx[k] = i;
  });
  return idx;
}

function rowsToParts(rows) {
  let hi = rows.findIndex((r) => { const m = mapHeader(r); return m.name != null; });
  if (hi < 0) throw bad('Не найдена строка заголовков: нужна как минимум колонка «Наименование» (также: Код, Артикул, Ед. изм., Цена)');
  const m = mapHeader(rows[hi]);
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const name = String(r[m.name] ?? '').trim();
    if (!name) continue;
    out.push({
      code: m.code != null ? String(r[m.code] ?? '').trim() || null : null,
      article: m.article != null ? String(r[m.article] ?? '').trim() || null : null,
      name,
      unit: m.unit != null ? String(r[m.unit] ?? '').trim() || 'шт' : 'шт',
      price: m.price != null ? num(String(r[m.price] ?? '').replace(/\s/g, '').replace(',', '.')) : null,
    });
  }
  return out;
}

function parseCsv(text) {
  const sep = (text.split('\n')[0].match(/;/g) || []).length >= (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  const utf = buf.toString('utf8');
  if (!utf.includes('�')) return utf;
  return new TextDecoder('windows-1251').decode(buf); // выгрузки 1С часто в cp1251
}

const xmlText = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? xmlText(m[1]) : null; };

// CommerceML 2 (import.xml / offers.xml) — стандартный обмен 1С
function parseCommerceML(xml) {
  const parts = [];
  for (const m of xml.matchAll(/<Товар>([\s\S]*?)<\/Товар>/g)) {
    const b = m[1];
    const unitM = b.match(/<БазоваяЕдиница[^>]*?(?:НаименованиеПолное="([^"]*)")?[^>]*>([\s\S]*?)<\/БазоваяЕдиница>/);
    parts.push({ code: tag(b, 'Ид'), article: tag(b, 'Артикул'), name: tag(b, 'Наименование'), unit: unitM ? (xmlText(unitM[2]) || 'шт') : 'шт', price: null });
  }
  const prices = new Map();
  for (const m of xml.matchAll(/<Предложение>([\s\S]*?)<\/Предложение>/g)) {
    const id = tag(m[1], 'Ид');
    const price = num(tag(m[1], 'ЦенаЗаЕдиницу'));
    if (id && price != null) prices.set(id, price);
    if (id && !parts.some((p) => p.code === id)) {
      parts.push({ code: id, article: tag(m[1], 'Артикул'), name: tag(m[1], 'Наименование'), unit: 'шт', price });
    }
  }
  for (const p of parts) if (prices.has(p.code)) p.price = prices.get(p.code);
  return parts.filter((p) => p.name || p.code);
}

function upsertParts(db, parts) {
  let added = 0, updated = 0;
  const findByCode = db.prepare('SELECT id FROM parts WHERE code = ?');
  const findByArt = db.prepare("SELECT id FROM parts WHERE code IS NULL AND article = ? AND name = ?");
  const ins = db.prepare(`INSERT INTO parts(code, article, name, unit, price, source) VALUES (@code, @article, @name, @unit, @price, '1c')`);
  const upd = db.prepare(`UPDATE parts SET article = COALESCE(@article, article), name = COALESCE(@name, name), unit = COALESCE(@unit, unit),
    price = COALESCE(@price, price), source = '1c', updated_at = @ts WHERE id = @id`);
  db.transaction(() => {
    for (const p of parts) {
      const ex = (p.code && findByCode.get(p.code)) || (p.article && findByArt.get(p.article, p.name));
      if (ex) { upd.run({ ...p, id: ex.id, ts: nowIso() }); updated++; } else if (p.name) { ins.run(p); added++; }
    }
  })();
  return { added, updated, total: parts.length };
}

// ---- Выгрузка установленных запчастей для 1С ----

function installedQuery(db, { from, to, onlyNew }) {
  const where = [];
  const p = {};
  if (from) { where.push('ip.installed_at >= @from'); p.from = from; }
  if (to) { where.push('ip.installed_at < @to'); p.to = to; }
  if (onlyNew) where.push('ip.exported_at IS NULL');
  return db.prepare(`SELECT ip.*, o.number AS order_number, t.description AS work,
      CASE ip.vehicle_type WHEN 'tractor' THEN tr.plate ELSE tl.plate END AS plate
    FROM installed_parts ip LEFT JOIN repair_orders o ON o.id = ip.order_id LEFT JOIN tasks t ON t.id = ip.task_id
    LEFT JOIN tractors tr ON ip.vehicle_type = 'tractor' AND tr.id = ip.vehicle_id
    LEFT JOIN trailers tl ON ip.vehicle_type = 'trailer' AND tl.id = ip.vehicle_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ip.installed_at`).all(p);
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function installedToXml(rows, off) {
  const docs = new Map();
  for (const r of rows) {
    const k = r.order_number || 'без-ремонта';
    if (!docs.has(k)) docs.set(k, []);
    docs.get(k).push(r);
  }
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
    `<ФайлОбмена ВерсияФормата="FiberFleet-1.0" ДатаФормирования="${new Date().toISOString()}" Программа="FiberFleet">`];
  for (const [num, items] of docs) {
    const first = items[0];
    lines.push(`  <Документ Вид="СписаниеЗапчастейВРемонт" Номер="${esc(num)}" Дата="${esc(fmtDateTime(first.installed_at, off))}" ТС="${esc(first.plate)}" ТипТС="${first.vehicle_type === 'tractor' ? 'Тягач' : 'Прицеп'}" Пробег="${first.mileage ?? ''}">`);
    for (const r of items) {
      lines.push(`    <Строка Код="${esc(r.code)}" Артикул="${esc(r.article)}" Наименование="${esc(r.name)}" ЕдиницаИзмерения="${esc(r.unit)}" Количество="${r.qty}" Цена="${r.price ?? ''}" Сумма="${r.price != null ? Math.round(r.price * r.qty * 100) / 100 : ''}" Работа="${esc(r.work)}" ДатаУстановки="${esc(fmtDateTime(r.installed_at, off))}" ИдЗаписи="${r.id}"/>`);
    }
    lines.push('  </Документ>');
  }
  lines.push('</ФайлОбмена>');
  return lines.join('\n');
}

export default function partsRoutes(db) {
  const r = express.Router();

  r.get('/parts', (req, res) => {
    const q = `%${String(req.query.q || '').trim()}%`;
    res.json(db.prepare(`SELECT p.*, (SELECT COALESCE(SUM(qty),0) FROM installed_parts i WHERE i.part_id = p.id) AS installed_qty
      FROM parts p WHERE p.name LIKE @q OR p.code LIKE @q OR p.article LIKE @q ORDER BY p.name LIMIT @lim`)
      .all({ q, lim: Math.min(Number(req.query.limit) || 300, 2000) }));
  });

  r.post('/parts', requirePerm('parts.write'), (req, res) => {
    const b = req.body || {};
    if (!b.name?.trim()) throw bad('Укажите наименование');
    const id = db.prepare(`INSERT INTO parts(code, article, name, unit, price, source) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(b.code?.trim() || null, b.article?.trim() || null, b.name.trim(), b.unit || 'шт', num(b.price), b.source === '1c' ? '1c' : 'manual').lastInsertRowid;
    res.status(201).json({ id });
  });

  r.put('/parts/:id', requirePerm('parts.write'), (req, res) => {
    const p = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
    if (!p) throw notFound('Запчасть');
    const b = req.body || {};
    db.prepare(`UPDATE parts SET code = ?, article = ?, name = ?, unit = ?, price = ?, updated_at = ? WHERE id = ?`)
      .run(b.code?.trim() || null, b.article?.trim() || null, (b.name || p.name).trim(), b.unit || p.unit, num(b.price), nowIso(), p.id);
    res.json({ ok: true });
  });

  r.delete('/parts/:id', requirePerm('parts.write'), (req, res) => {
    db.prepare('DELETE FROM parts WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // Импорт номенклатуры из 1С: XLSX / CSV / CommerceML XML
  r.post('/parts/import', requirePerm('parts.write'), upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw bad('Файл не получен');
    const name = req.file.originalname.toLowerCase();
    let parts;
    if (name.endsWith('.xlsx')) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.file.buffer);
      const ws = wb.worksheets[0];
      const rows = [];
      ws.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1).map((v) => (v && typeof v === 'object' ? v.result ?? v.text ?? '' : v))));
      parts = rowsToParts(rows);
    } else if (name.endsWith('.xml')) {
      parts = parseCommerceML(decodeText(req.file.buffer));
    } else if (name.endsWith('.csv') || name.endsWith('.txt')) {
      parts = rowsToParts(parseCsv(decodeText(req.file.buffer)));
    } else {
      throw bad('Поддерживаются файлы .xlsx, .csv, .xml (CommerceML)');
    }
    if (!parts.length) throw bad('В файле не найдено ни одной позиции');
    const result = upsertParts(db, parts);
    audit(db, req.user, 'parts', null, 'import', JSON.stringify(result));
    res.json(result);
  }));

  // HTTP-обмен с 1С: загрузка номенклатуры JSON-массивом [{code, article, name, unit, price}]
  r.post('/onec/parts', requirePerm('parts.write'), (req, res) => {
    const list = Array.isArray(req.body) ? req.body : req.body?.items;
    if (!Array.isArray(list)) throw bad('Ожидается массив позиций');
    res.json(upsertParts(db, list.map((p) => ({
      code: p.code ? String(p.code) : null, article: p.article || null, name: p.name ? String(p.name) : null, unit: p.unit || 'шт', price: num(p.price),
    }))));
  });

  r.get('/installed-parts', (req, res) => {
    res.json(installedQuery(db, { from: req.query.from, to: req.query.to, onlyNew: req.query.only_new === '1' }));
  });

  // Выгрузка в 1С: xml | xlsx | csv | json; mark=1 — отметить выгруженные
  r.get('/onec/export', requirePerm('parts.write'), wrap(async (req, res) => {
    const off = Number(getSettings(db).tz_offset_min ?? 180);
    const rows = installedQuery(db, { from: req.query.from, to: req.query.to, onlyNew: req.query.only_new === '1' });
    const fmt = req.query.format || 'xml';
    if (req.query.mark === '1' && rows.length) {
      const ids = rows.map((r) => r.id);
      db.prepare(`UPDATE installed_parts SET exported_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(nowIso(), ...ids);
      audit(db, req.user, 'parts', null, 'export_1c', `${rows.length} строк, ${fmt}`);
    }
    const stamp = new Date().toISOString().slice(0, 10);
    if (fmt === 'json') return res.json(rows);
    if (fmt === 'xml') {
      res.setHeader('Content-Disposition', `attachment; filename="fiberfleet-1c-${stamp}.xml"`);
      return res.type('application/xml').send(installedToXml(rows, off));
    }
    const header = ['Дата', 'Документ', 'Тип ТС', 'Госномер', 'Код 1С', 'Артикул', 'Наименование', 'Ед.', 'Количество', 'Цена', 'Сумма', 'Пробег', 'Работа'];
    const data = rows.map((r) => [fmtDateTime(r.installed_at, off), r.order_number, r.vehicle_type === 'tractor' ? 'Тягач' : 'Прицеп', r.plate, r.code, r.article, r.name, r.unit, r.qty, r.price, r.price != null ? r.price * r.qty : null, r.mileage, r.work]);
    if (fmt === 'csv') {
      const csv = [header, ...data].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
      res.setHeader('Content-Disposition', `attachment; filename="fiberfleet-1c-${stamp}.csv"`);
      return res.type('text/csv; charset=utf-8').send('﻿' + csv);
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Установленные запчасти');
    ws.addRow(header).font = { bold: true };
    data.forEach((d) => ws.addRow(d));
    ws.columns.forEach((c, i) => { c.width = [17, 12, 9, 14, 12, 14, 40, 6, 10, 10, 12, 10, 40][i]; });
    res.setHeader('Content-Disposition', `attachment; filename="fiberfleet-1c-${stamp}.xlsx"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await wb.xlsx.write(res);
    res.end();
  }));

  return r;
}
