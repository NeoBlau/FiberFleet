import express from 'express';
import { requirePerm } from '../auth.js';
import { getSettings } from '../settings.js';
import { buildReport, orderToPdf, reportToCsv, reportToPdf, reportToXlsx, REPORTS } from '../services/reports.js';
import { loadOrder } from '../services/orders.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const disp = (name) => `attachment; filename="report.${name.split('.').pop()}"; filename*=UTF-8''${encodeURIComponent(name)}`;

export default function reportRoutes(db) {
  const r = express.Router();

  r.get('/reports', (_req, res) => res.json(REPORTS));

  r.get('/reports/:type', requirePerm('reports.read'), wrap(async (req, res) => {
    const rep = buildReport(db, req.params.type, req.query);
    const company = getSettings(db).company || 'FiberFleet';
    const fmt = req.query.format || 'json';
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `${rep.title} ${stamp}`;
    if (fmt === 'json') return res.json(rep);
    if (fmt === 'csv') {
      res.setHeader('Content-Disposition', disp(`${base}.csv`));
      return res.type('text/csv; charset=utf-8').send(reportToCsv(rep));
    }
    if (fmt === 'xlsx') {
      res.setHeader('Content-Disposition', disp(`${base}.xlsx`));
      res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      await reportToXlsx(rep, res, company);
      return res.end();
    }
    if (fmt === 'pdf') {
      res.setHeader('Content-Disposition', disp(`${base}.pdf`));
      res.type('application/pdf');
      return reportToPdf(rep, res, company);
    }
    res.status(400).json({ error: 'Формат: json, xlsx, pdf, csv' });
  }));

  r.get('/orders/:id/pdf', (req, res) => {
    const order = loadOrder(db, req.params.id);
    const s = getSettings(db);
    res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="order-${order.number}.pdf"`);
    res.type('application/pdf');
    orderToPdf(order, res, { company: s.company || 'FiberFleet', off: Number(s.tz_offset_min ?? 180) });
  });

  return r;
}
