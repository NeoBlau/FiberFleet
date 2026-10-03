// Отчёты: построение табличных данных и выгрузка в Excel / PDF / CSV.
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetMaintenance } from '../domain/maintenance.js';
import { PRIORITIES } from '../domain/checklist.js';
import { getSettings } from '../settings.js';
import { bad, fmtDateTime } from '../util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FONT = path.join(here, '..', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(here, '..', 'fonts', 'DejaVuSans-Bold.ttf');

const STATUS = { planned: 'Запланирована', in_progress: 'В работе', paused: 'Приостановлена', done: 'Выполнена', cancelled: 'Отменена' };
const ORDER_STATUS = { draft: 'Черновик', planned: 'Запланирован', plan_error: 'Ошибка планирования', approved: 'Утверждён', in_progress: 'В ремонте', done: 'Завершён', cancelled: 'Отменён' };
const MAINT = { overdue: 'Просрочено', soon: 'Скоро', ok: 'В норме', unknown: 'Нет данных' };

export const REPORTS = {
  works: 'Выполненные работы',
  salary: 'Зарплата и выработка сотрудников',
  parts: 'Использованные запчасти',
  vehicles: 'Состояние тягачей и прицепов',
  orders: 'Ремонты за период',
};

const sum = (rows, k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
const r2 = (v) => Math.round(v * 100) / 100;

export function buildReport(db, type, q) {
  const off = Number(getSettings(db).tz_offset_min ?? 180);
  const from = q.from || '1970-01-01';
  const to = q.to || '9999-12-31';
  const period = `${q.from ? fmtDateTime(q.from, off, false) : 'начало учёта'} — ${q.to ? fmtDateTime(new Date(new Date(q.to).getTime() - 1).toISOString(), off, false) : 'сегодня'}`;
  const vehFilter = q.vehicle_type && q.vehicle_id ? ' AND t.vehicle_type = @vt AND t.vehicle_id = @vid' : '';
  const p = { from, to, vt: q.vehicle_type, vid: Number(q.vehicle_id) || null, emp: Number(q.employee_id) || null, cat: q.category || null };
  const plateSql = `CASE t.vehicle_type WHEN 'tractor' THEN tr.plate ELSE tl.plate END`;
  const vehJoin = `LEFT JOIN tractors tr ON t.vehicle_type = 'tractor' AND tr.id = t.vehicle_id
    LEFT JOIN trailers tl ON t.vehicle_type = 'trailer' AND tl.id = t.vehicle_id`;

  if (type === 'works') {
    const rows = db.prepare(`SELECT t.finished_at, o.number, ${plateSql} AS plate, t.vehicle_type, t.description, t.location, w.category,
        e.name AS employee, t.hours, t.actual_hours, t.mileage, t.price, t.salary
      FROM tasks t LEFT JOIN repair_orders o ON o.id = t.order_id LEFT JOIN employees e ON e.id = t.employee_id
      LEFT JOIN work_types w ON w.id = t.work_type_id ${vehJoin}
      WHERE t.status = 'done' AND t.finished_at >= @from AND t.finished_at < @to ${vehFilter}
      ${p.emp ? 'AND t.employee_id = @emp' : ''} ${p.cat ? 'AND w.category = @cat' : ''}
      ORDER BY t.finished_at`).all(p).map((r) => ({ ...r, finished_at: fmtDateTime(r.finished_at, off), veh: r.vehicle_type === 'tractor' ? 'Тягач' : 'Прицеп' }));
    return {
      title: REPORTS.works, period,
      columns: [
        { key: 'finished_at', title: 'Дата', width: 15 }, { key: 'number', title: 'Ремонт', width: 10 },
        { key: 'plate', title: 'Госномер', width: 12 }, { key: 'description', title: 'Работа', width: 38 },
        { key: 'location', title: 'Узел', width: 16 }, { key: 'employee', title: 'Исполнитель', width: 14 },
        { key: 'hours', title: 'Норма, ч', type: 'num', width: 8 }, { key: 'actual_hours', title: 'Факт, ч', type: 'num', width: 8 },
        { key: 'mileage', title: 'Пробег, км', type: 'int', width: 10 },
        { key: 'price', title: 'Цена, ₽', type: 'money', width: 11 }, { key: 'salary', title: 'ЗП, ₽', type: 'money', width: 10 },
      ],
      rows,
      totals: { description: `Итого работ: ${rows.length}`, hours: r2(sum(rows, 'hours')), actual_hours: r2(sum(rows, 'actual_hours')), price: sum(rows, 'price'), salary: sum(rows, 'salary') },
    };
  }

  if (type === 'salary') {
    const rows = db.prepare(`SELECT e.name AS employee, e.position, COUNT(t.id) AS tasks, COALESCE(SUM(t.hours),0) AS hours,
        COALESCE(SUM(t.actual_hours),0) AS actual_hours, COALESCE(SUM(t.price),0) AS price, COALESCE(SUM(t.salary),0) AS salary
      FROM employees e JOIN tasks t ON t.employee_id = e.id AND t.status = 'done' AND t.finished_at >= @from AND t.finished_at < @to ${vehFilter}
      ${p.emp ? 'WHERE e.id = @emp' : ''}
      GROUP BY e.id ORDER BY salary DESC`).all(p)
      .map((r) => ({ ...r, hours: r2(r.hours), actual_hours: r2(r.actual_hours), efficiency: r.actual_hours ? Math.round((r.hours / r.actual_hours) * 100) : null }));
    return {
      title: REPORTS.salary, period,
      columns: [
        { key: 'employee', title: 'Сотрудник', width: 20 }, { key: 'position', title: 'Должность', width: 22 },
        { key: 'tasks', title: 'Работ', type: 'int', width: 8 }, { key: 'hours', title: 'Норма, ч', type: 'num', width: 10 },
        { key: 'actual_hours', title: 'Факт, ч', type: 'num', width: 10 }, { key: 'efficiency', title: 'Выработка, %', type: 'int', width: 12 },
        { key: 'price', title: 'Сумма работ, ₽', type: 'money', width: 14 }, { key: 'salary', title: 'Зарплата, ₽', type: 'money', width: 13 },
      ],
      rows,
      totals: { employee: 'Итого', tasks: sum(rows, 'tasks'), hours: r2(sum(rows, 'hours')), actual_hours: r2(sum(rows, 'actual_hours')), price: sum(rows, 'price'), salary: sum(rows, 'salary') },
    };
  }

  if (type === 'parts') {
    const vf = q.vehicle_type && q.vehicle_id ? ' AND ip.vehicle_type = @vt AND ip.vehicle_id = @vid' : '';
    const rows = db.prepare(`SELECT ip.installed_at, o.number, CASE ip.vehicle_type WHEN 'tractor' THEN tr.plate ELSE tl.plate END AS plate,
        ip.code, ip.article, ip.name, ip.unit, ip.qty, ip.price, ip.qty * COALESCE(ip.price,0) AS total, ip.mileage, ip.exported_at, ip.source
      FROM installed_parts ip LEFT JOIN repair_orders o ON o.id = ip.order_id
      LEFT JOIN tractors tr ON ip.vehicle_type = 'tractor' AND tr.id = ip.vehicle_id
      LEFT JOIN trailers tl ON ip.vehicle_type = 'trailer' AND tl.id = ip.vehicle_id
      WHERE ip.installed_at >= @from AND ip.installed_at < @to ${vf} ORDER BY ip.installed_at`).all(p)
      .map((r) => ({ ...r, installed_at: fmtDateTime(r.installed_at, off), exported: r.exported_at ? fmtDateTime(r.exported_at, off) : 'нет', source: r.source === '1c' ? '1С' : 'вручную' }));
    return {
      title: REPORTS.parts, period,
      columns: [
        { key: 'installed_at', title: 'Дата', width: 15 }, { key: 'number', title: 'Ремонт', width: 10 }, { key: 'plate', title: 'Госномер', width: 12 },
        { key: 'code', title: 'Код 1С', width: 11 }, { key: 'article', title: 'Артикул', width: 13 }, { key: 'name', title: 'Наименование', width: 34 },
        { key: 'qty', title: 'Кол-во', type: 'num', width: 7 }, { key: 'unit', title: 'Ед.', width: 5 }, { key: 'price', title: 'Цена, ₽', type: 'money', width: 10 },
        { key: 'total', title: 'Сумма, ₽', type: 'money', width: 11 }, { key: 'source', title: 'Источник', width: 9 }, { key: 'exported', title: 'В 1С', width: 15 },
      ],
      rows,
      totals: { name: `Позиций: ${rows.length}`, total: sum(rows, 'total') },
    };
  }

  if (type === 'vehicles') {
    const maint = fleetMaintenance(db);
    const worst = new Map();
    const rank = { overdue: 0, soon: 1, unknown: 2, ok: 3 };
    for (const m of maint) {
      const k = `${m.vehicle_type}:${m.vehicle_id}`;
      const cur = worst.get(k);
      if (!cur || rank[m.status] < rank[cur.status]) worst.set(k, m);
    }
    const rows = [];
    for (const vt of ['tractor', 'trailer']) {
      if (q.vehicle_type && q.vehicle_type !== vt) continue;
      const list = db.prepare(`SELECT v.* FROM ${vt === 'tractor' ? 'tractors' : 'trailers'} v WHERE v.archived = 0 ${q.vehicle_id ? 'AND v.id = @vid' : ''} ORDER BY v.plate`).all(p);
      for (const v of list) {
        const st = db.prepare(`SELECT
            (SELECT COUNT(*) FROM tasks WHERE vehicle_type = @vt AND vehicle_id = @id AND status IN ('planned','in_progress','paused')) AS open_tasks,
            (SELECT COUNT(*) FROM tasks WHERE vehicle_type = @vt AND vehicle_id = @id AND status = 'done' AND finished_at >= @from AND finished_at < @to) AS done_tasks,
            (SELECT COALESCE(SUM(price),0) FROM tasks WHERE vehicle_type = @vt AND vehicle_id = @id AND status = 'done' AND finished_at >= @from AND finished_at < @to) AS works_sum,
            (SELECT COALESCE(SUM(qty * COALESCE(price,0)),0) FROM installed_parts WHERE vehicle_type = @vt AND vehicle_id = @id AND installed_at >= @from AND installed_at < @to) AS parts_sum,
            (SELECT MAX(finished_at) FROM tasks WHERE vehicle_type = @vt AND vehicle_id = @id AND status = 'done') AS last_repair`).get({ vt, id: v.id, from, to });
        const w = worst.get(`${vt}:${v.id}`);
        rows.push({
          veh: vt === 'tractor' ? 'Тягач' : 'Прицеп', plate: v.plate, name: `${v.brand || ''} ${v.model || ''}`.trim(), year: v.year,
          mileage: v.mileage, ...st, total: st.works_sum + st.parts_sum,
          last_repair: st.last_repair ? fmtDateTime(st.last_repair, off, false) : '—',
          maint: w ? `${MAINT[w.status]}${w.status !== 'unknown' && w.remaining_km != null ? ` (${w.name}: ${w.remaining_km.toLocaleString('ru-RU')} км)` : ''}` : '—',
        });
      }
    }
    return {
      title: REPORTS.vehicles, period,
      columns: [
        { key: 'veh', title: 'Тип', width: 8 }, { key: 'plate', title: 'Госномер', width: 12 }, { key: 'name', title: 'Марка / модель', width: 24 },
        { key: 'year', title: 'Год', type: 'int', width: 6 }, { key: 'mileage', title: 'Пробег, км', type: 'int', width: 11 },
        { key: 'open_tasks', title: 'Открытых работ', type: 'int', width: 9 }, { key: 'done_tasks', title: 'Выполнено', type: 'int', width: 9 },
        { key: 'works_sum', title: 'Работы, ₽', type: 'money', width: 11 }, { key: 'parts_sum', title: 'Запчасти, ₽', type: 'money', width: 11 },
        { key: 'total', title: 'Итого, ₽', type: 'money', width: 11 }, { key: 'last_repair', title: 'Посл. ремонт', width: 11 }, { key: 'maint', title: 'ТО', width: 30 },
      ],
      rows,
      totals: { plate: `ТС: ${rows.length}`, done_tasks: sum(rows, 'done_tasks'), works_sum: sum(rows, 'works_sum'), parts_sum: sum(rows, 'parts_sum'), total: sum(rows, 'total') },
    };
  }

  if (type === 'orders') {
    const vf = q.vehicle_type && q.vehicle_id ? (q.vehicle_type === 'tractor' ? ' AND o.tractor_id = @vid' : ' AND o.trailer_id = @vid') : '';
    const rows = db.prepare(`SELECT o.number, o.status, o.inspected_at, o.release_deadline, o.closed_at, tr.plate AS tractor, tl.plate AS trailer,
        (SELECT COUNT(*) FROM tasks t WHERE t.order_id = o.id AND t.status <> 'cancelled') AS tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.order_id = o.id AND t.status = 'done') AS done,
        (SELECT COALESCE(SUM(price),0) FROM tasks t WHERE t.order_id = o.id AND t.status = 'done') AS works_sum,
        (SELECT COALESCE(SUM(salary),0) FROM tasks t WHERE t.order_id = o.id AND t.status = 'done') AS salary,
        (SELECT COALESCE(SUM(qty * COALESCE(price,0)),0) FROM installed_parts ip WHERE ip.order_id = o.id) AS parts_sum
      FROM repair_orders o LEFT JOIN tractors tr ON tr.id = o.tractor_id LEFT JOIN trailers tl ON tl.id = o.trailer_id
      WHERE o.inspected_at >= @from AND o.inspected_at < @to ${vf} ORDER BY o.inspected_at`).all(p)
      .map((r) => ({
        ...r, status: ORDER_STATUS[r.status], inspected_at: fmtDateTime(r.inspected_at, off), release_deadline: fmtDateTime(r.release_deadline, off),
        closed_at: fmtDateTime(r.closed_at, off), total: r.works_sum + r.parts_sum, vehicle: [r.tractor, r.trailer].filter(Boolean).join(' + '),
      }));
    return {
      title: REPORTS.orders, period,
      columns: [
        { key: 'number', title: 'Ремонт', width: 10 }, { key: 'vehicle', title: 'ТС', width: 22 }, { key: 'status', title: 'Статус', width: 15 },
        { key: 'inspected_at', title: 'Дефектовка', width: 15 }, { key: 'release_deadline', title: 'Выпуск (план)', width: 15 }, { key: 'closed_at', title: 'Закрыт', width: 15 },
        { key: 'tasks', title: 'Работ', type: 'int', width: 7 }, { key: 'done', title: 'Выполнено', type: 'int', width: 9 },
        { key: 'works_sum', title: 'Работы, ₽', type: 'money', width: 11 }, { key: 'salary', title: 'ЗП, ₽', type: 'money', width: 10 },
        { key: 'parts_sum', title: 'Запчасти, ₽', type: 'money', width: 11 }, { key: 'total', title: 'Итого, ₽', type: 'money', width: 11 },
      ],
      rows,
      totals: { number: `Ремонтов: ${rows.length}`, tasks: sum(rows, 'tasks'), done: sum(rows, 'done'), works_sum: sum(rows, 'works_sum'), salary: sum(rows, 'salary'), parts_sum: sum(rows, 'parts_sum'), total: sum(rows, 'total') },
    };
  }
  throw bad('Неизвестный отчёт');
}

// ---------- Выгрузка ----------

const fmtCell = (v, type) => {
  if (v == null || v === '') return '';
  if (type === 'money') return Number(v).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  if (type === 'num') return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  if (type === 'int') return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 0 });
  return String(v);
};

export async function reportToXlsx(rep, res, company) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FiberFleet';
  const ws = wb.addWorksheet(rep.title.slice(0, 31));
  ws.addRow([`${company} — ${rep.title}`]).font = { bold: true, size: 14 };
  ws.addRow([`Период: ${rep.period}`]);
  ws.addRow([`Сформирован: ${new Date().toLocaleString('ru-RU')}`]);
  ws.addRow([]);
  const head = ws.addRow(rep.columns.map((c) => c.title));
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } }; c.border = { bottom: { style: 'thin' } }; });
  for (const r of rep.rows) {
    ws.addRow(rep.columns.map((c) => (['money', 'num', 'int'].includes(c.type) ? (r[c.key] == null ? null : Number(r[c.key])) : r[c.key] ?? '')));
  }
  if (rep.totals) {
    const t = ws.addRow(rep.columns.map((c) => rep.totals[c.key] ?? ''));
    t.font = { bold: true };
    t.eachCell((c) => { c.border = { top: { style: 'thin' } }; });
  }
  rep.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.width || 14;
    if (c.type === 'money') col.numFmt = '#,##0.00';
    if (c.type === 'num') col.numFmt = '0.00';
    if (c.type === 'int') col.numFmt = '#,##0';
  });
  ws.views = [{ state: 'frozen', ySplit: 5 }];
  await wb.xlsx.write(res);
}

export function reportToCsv(rep) {
  const lines = [rep.columns.map((c) => c.title), ...rep.rows.map((r) => rep.columns.map((c) => r[c.key] ?? ''))];
  if (rep.totals) lines.push(rep.columns.map((c) => rep.totals[c.key] ?? ''));
  return '﻿' + lines.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
}

function newPdf(res, { landscape = true } = {}) {
  const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 32, bufferPages: true, info: { Producer: 'FiberFleet' } });
  doc.registerFont('r', FONT);
  doc.registerFont('b', FONT_BOLD);
  doc.font('r');
  doc.pipe(res);
  return doc;
}

function pageNumbers(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('r').fontSize(7).fillColor('#777')
      .text(`FiberFleet · стр. ${i + 1} из ${range.count}`, doc.page.margins.left, doc.page.height - 20, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'right' });
    doc.page.margins.bottom = bottom;
  }
}

function pdfTable(doc, columns, rows, totals) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const totalW = columns.reduce((a, c) => a + (c.width || 12), 0);
  const ws = columns.map((c) => ((c.width || 12) / totalW) * width);
  const fs = 7.5;
  const drawRow = (vals, { bold = false, fill = null } = {}) => {
    doc.font(bold ? 'b' : 'r').fontSize(fs);
    const hs = vals.map((v, i) => doc.heightOfString(String(v), { width: ws[i] - 4 }));
    const h = Math.max(...hs, fs) + 5;
    if (doc.y + h > doc.page.height - doc.page.margins.bottom - 12) {
      doc.addPage();
      if (!bold || !fill) drawHead();
    }
    const y = doc.y;
    if (fill) doc.rect(left, y, width, h).fill(fill);
    let x = left;
    vals.forEach((v, i) => {
      const align = ['money', 'num', 'int'].includes(columns[i].type) ? 'right' : 'left';
      doc.fillColor('#111').font(bold ? 'b' : 'r').fontSize(fs).text(String(v), x + 2, y + 2.5, { width: ws[i] - 4, align });
      x += ws[i];
    });
    doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.3).strokeColor('#c8ced6').stroke();
    doc.x = left;
    doc.y = y + h;
  };
  const drawHead = () => drawRow(columns.map((c) => c.title), { bold: true, fill: '#e8eef5' });
  drawHead();
  rows.forEach((r) => drawRow(columns.map((c) => fmtCell(r[c.key], c.type))));
  if (totals) drawRow(columns.map((c) => fmtCell(totals[c.key], c.type)), { bold: true, fill: '#f3f5f8' });
}

export function reportToPdf(rep, res, company) {
  const doc = newPdf(res);
  doc.font('b').fontSize(14).text(`${company} — ${rep.title}`);
  doc.font('r').fontSize(9).fillColor('#444').text(`Период: ${rep.period}   ·   Сформирован: ${new Date().toLocaleString('ru-RU')}`);
  doc.moveDown(0.6);
  if (!rep.rows.length) doc.fontSize(10).fillColor('#111').text('Нет данных за выбранный период.');
  else pdfTable(doc, rep.columns, rep.rows, rep.totals);
  pageNumbers(doc);
  doc.end();
}

// Заказ-наряд / дефектная ведомость по ремонту
export function orderToPdf(order, res, { company, off }) {
  const doc = newPdf(res, { landscape: false });
  const f = (iso, t = true) => fmtDateTime(iso, off, t);
  doc.font('b').fontSize(15).text(`Заказ-наряд № ${order.number}`);
  doc.font('r').fontSize(9).fillColor('#444').text(`${company} · дефектовка ${f(order.inspected_at)} · статус: ${ORDER_STATUS[order.status]}`);
  doc.moveDown(0.5).fillColor('#111').fontSize(10);
  if (order.tractor_plate) doc.text(`Тягач: ${order.tractor_plate} — ${order.tractor_brand || ''} ${order.tractor_model || ''}; пробег: ${order.tractor_mileage?.toLocaleString('ru-RU') ?? '—'} км`);
  if (order.trailer_plate) doc.text(`Прицеп: ${order.trailer_plate} — ${order.trailer_brand || ''} ${order.trailer_model || ''}${order.trailer_mileage ? `; пробег: ${order.trailer_mileage.toLocaleString('ru-RU')} км` : ''}${order.reefer_hours ? `; реф. м/ч: ${order.reefer_hours}` : ''}`);
  if (order.release_deadline) doc.text(`Плановый выпуск с ремонта: ${f(order.release_deadline)}`);
  if (order.created_by_name) doc.text(`Мастер-приёмщик: ${order.created_by_name}`);

  const zones = order.inspection?.zones || [];
  if (zones.length) {
    doc.moveDown(0.6).font('b').fontSize(11).text('Выявленные неисправности и зоны осмотра');
    doc.font('r').fontSize(8.5);
    for (const z of zones) {
      doc.font('b').text(`• ${z.section}: ${z.label}${z.value != null && z.value !== '' ? ` (${z.value} ${z.unit || ''})` : ''} — ${PRIORITIES[z.priority]?.label || ''}`, { continued: false });
      doc.font('r').text(`   Где смотреть: ${z.zone_text}${z.comment ? `. Примечание: ${z.comment}` : ''}`);
      if (z.checks?.length) doc.text(`   Проверить также: ${z.checks.join('; ')}`);
    }
  }
  const dmg = order.inspection?.damages || [];
  if (dmg.length) {
    doc.moveDown(0.4).font('b').fontSize(11).text('Зафиксированные повреждения');
    doc.font('r').fontSize(8.5);
    for (const d of dmg) doc.text(`• ${d.label}: ${(d.zones || []).join(', ') || '—'}${d.comment ? ` — ${d.comment}` : ''}`);
  }

  doc.moveDown(0.6).font('b').fontSize(11).text('План работ');
  doc.moveDown(0.2);
  const tasks = order.tasks.filter((t) => t.status !== 'cancelled').map((t) => ({
    ...t, veh: t.vehicle_type === 'tractor' ? 'Тягач' : 'Прицеп', when: t.start_at ? `${f(t.start_at)}` : '—',
    st: STATUS[t.status], pr: t.priority,
  }));
  pdfTable(doc, [
    { key: 'pr', title: 'Пр.', width: 3, type: 'int' }, { key: 'description', title: 'Работа', width: 28 }, { key: 'location', title: 'Узел', width: 14 },
    { key: 'employee_name', title: 'Исполнитель', width: 12 }, { key: 'when', title: 'Начало', width: 12 },
    { key: 'hours', title: 'Н/ч', width: 5, type: 'num' }, { key: 'price', title: 'Цена, ₽', width: 8, type: 'money' }, { key: 'st', title: 'Статус', width: 14 },
  ], tasks, { description: `Работ: ${tasks.length}`, hours: sum(tasks, 'hours'), price: sum(tasks, 'price') });

  if (order.parts?.length) {
    doc.moveDown(0.6).font('b').fontSize(11).text('Установленные запчасти');
    doc.moveDown(0.2);
    const parts = order.parts.map((p) => ({ ...p, total: (p.price || 0) * p.qty }));
    pdfTable(doc, [
      { key: 'code', title: 'Код 1С', width: 10 }, { key: 'article', title: 'Артикул', width: 12 }, { key: 'name', title: 'Наименование', width: 34 },
      { key: 'qty', title: 'Кол-во', width: 6, type: 'num' }, { key: 'price', title: 'Цена, ₽', width: 9, type: 'money' }, { key: 'total', title: 'Сумма, ₽', width: 10, type: 'money' },
    ], parts, { name: 'Итого', total: sum(parts, 'total') });
  }
  if (order.notes) doc.moveDown(0.5).font('r').fontSize(9).text(`Примечание: ${order.notes}`);

  doc.moveDown(2).font('r').fontSize(9);
  const y = doc.y;
  doc.text('Мастер-приёмщик: ____________________', doc.page.margins.left, y);
  doc.text('Водитель (ТС сдал/принял): ____________________', 300, y);
  pageNumbers(doc);
  doc.end();
}

