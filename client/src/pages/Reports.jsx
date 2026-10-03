import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FileSpreadsheet, FileText, FileDown } from 'lucide-react';
import * as api from '../api.js';
import { dateToIso, isoToDateInput, num, plate } from '../format.js';
import { Button, Card, Empty, ErrorBox, Field, SearchSelect, Spinner, useLoad, useToast } from '../ui/kit.jsx';

const TYPES = [
  { value: 'works', label: 'Выполненные работы', hint: 'Работы с ценами и зарплатой исполнителей' },
  { value: 'salary', label: 'Зарплата и выработка', hint: 'По сотрудникам: работы, норма/факт, начисленная ЗП' },
  { value: 'parts', label: 'Использованные запчасти', hint: 'Установленные запчасти и отметка выгрузки в 1С' },
  { value: 'vehicles', label: 'Состояние ТС', hint: 'Пробег, открытые работы, затраты, статус ТО' },
  { value: 'orders', label: 'Ремонты за период', hint: 'Заказ-наряды: работы, ЗП, запчасти, итог' },
];

const d = (y, m, day) => isoToDateInput(new Date(Date.UTC(y, m, day, 12)).toISOString());
function presets() {
  const n = new Date();
  const y = n.getFullYear(), m = n.getMonth();
  const q = Math.floor(m / 3) * 3;
  return [
    { label: 'Этот месяц', from: d(y, m, 1), to: d(y, m + 1, 0) },
    { label: 'Прошлый месяц', from: d(y, m - 1, 1), to: d(y, m, 0) },
    { label: 'Квартал', from: d(y, q, 1), to: d(y, q + 3, 0) },
    { label: 'Год', from: d(y, 0, 1), to: d(y, 11, 31) },
  ];
}

const fmt = (v, type) => {
  if (v == null || v === '') return '';
  if (type === 'money') return `${num(v)} ₽`;
  if (type === 'num') return num(v);
  if (type === 'int') return num(v, 0);
  return String(v);
};

export default function Reports() {
  const [params] = useSearchParams();
  const toast = useToast();
  const p0 = presets()[0];
  const [type, setType] = useState(params.get('type') || 'works');
  const [from, setFrom] = useState(p0.from);
  const [to, setTo] = useState(p0.to);
  const [emp, setEmp] = useState(null);
  const [veh, setVeh] = useState(params.get('vehicle_id') ? `${params.get('vehicle_type')}:${params.get('vehicle_id')}` : null);
  const employees = useLoad(() => api.get('/employees'));
  const tractors = useLoad(() => api.get('/vehicles/tractor'));
  const trailers = useLoad(() => api.get('/vehicles/trailer'));

  const [vt, vid] = veh ? veh.split(':') : [];
  const query = {
    from: dateToIso(from), to: to ? new Date(new Date(dateToIso(to)).getTime() + 86400000).toISOString() : undefined,
    employee_id: emp || '', vehicle_type: vt || '', vehicle_id: vid || '',
  };
  const { data, loading, error, reload } = useLoad(() => api.get(`/reports/${type}${api.qs(query)}`), [type, from, to, emp, veh]);
  const dl = (format) => api.download(`/reports/${type}${api.qs({ ...query, format })}`, `report.${format}`).catch((e) => toast(e.message, 'red'));

  const vehOptions = [
    ...(tractors.data || []).map((t) => ({ value: `tractor:${t.id}`, label: `Тягач ${plate(t.plate)} — ${t.brand} ${t.model || ''}`, search: t.plate })),
    ...(trailers.data || []).map((t) => ({ value: `trailer:${t.id}`, label: `Прицеп ${plate(t.plate)} — ${t.model}`, search: t.plate })),
  ];

  return (
    <div className="page">
      <div className="page-head"><h1>Отчёты и аналитика</h1></div>
      <div className="report-types">
        {TYPES.map((t) => (
          <button key={t.value} className={`rtype ${type === t.value ? 'on' : ''}`} onClick={() => setType(t.value)}>
            <b>{t.label}</b><span>{t.hint}</span>
          </button>
        ))}
      </div>
      <Card>
        <div className="form-grid form-grid-4">
          <Field label="С"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="По"><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          {['works', 'salary'].includes(type) && (
            <Field label="Сотрудник">
              <SearchSelect clearable value={emp} onChange={setEmp} placeholder="Все" options={(employees.data || []).map((e) => ({ value: e.id, label: e.name }))} />
            </Field>
          )}
          {type !== 'salary' && (
            <Field label="Тягач / прицеп">
              <SearchSelect clearable value={veh} onChange={setVeh} placeholder="Все ТС" options={vehOptions} />
            </Field>
          )}
        </div>
        <div className="row gap-s wrap">
          {presets().map((p) => <Button key={p.label} size="sm" variant="ghost" onClick={() => { setFrom(p.from); setTo(p.to); }}>{p.label}</Button>)}
          <span className="grow" />
          <Button icon={FileSpreadsheet} onClick={() => dl('xlsx')}>Excel</Button>
          <Button icon={FileText} onClick={() => dl('pdf')}>PDF</Button>
          <Button icon={FileDown} onClick={() => dl('csv')}>CSV</Button>
        </div>
      </Card>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : data && (
        <Card title={`${data.title} · ${data.period}`} pad={false}>
          {data.rows.length === 0 ? <Empty title="Нет данных за выбранный период" /> : (
            <div className="table-wrap">
              <table className="table report">
                <thead><tr>{data.columns.map((c) => <th key={c.key} className={['money', 'num', 'int'].includes(c.type) ? 'num' : ''}>{c.title}</th>)}</tr></thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr key={i}>{data.columns.map((c) => <td key={c.key} className={['money', 'num', 'int'].includes(c.type) ? 'num nowrap' : ''}>{fmt(r[c.key], c.type)}</td>)}</tr>
                  ))}
                </tbody>
                {data.totals && <tfoot><tr>{data.columns.map((c) => <td key={c.key} className={['money', 'num', 'int'].includes(c.type) ? 'num nowrap' : ''}><b>{fmt(data.totals[c.key], c.type)}</b></td>)}</tr></tfoot>}
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
