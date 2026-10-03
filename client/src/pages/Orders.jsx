import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ClipboardCheck, Search, Wrench } from 'lucide-react';
import * as api from '../api.js';
import { can, useApp } from '../App.jsx';
import { fmtDateTime, fmtShort, money, ORDER_STATUS, plate, PRIORITY } from '../format.js';
import { Badge, Button, Empty, ErrorBox, Spinner, useLoad } from '../ui/kit.jsx';
import { Progress } from './Dashboard.jsx';

export default function Orders() {
  const { user } = useApp();
  const nav = useNavigate();
  const [status, setStatus] = useState('active');
  const [q, setQ] = useState('');
  const { data, loading, error, reload } = useLoad(() => api.get(`/orders${api.qs({ status, q })}`), [status, q]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Ремонты</h1>
        {can(user, 'orders.write') && <Link to="/defect/new"><Button variant="primary" icon={ClipboardCheck}>Новая дефектовка</Button></Link>}
      </div>
      <div className="toolbar">
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Активные</option>
          <option value="plan_error">С ошибками планирования</option>
          <option value="planned">Запланированные</option>
          <option value="approved">Утверждённые</option>
          <option value="in_progress">В ремонте</option>
          <option value="done">Завершённые</option>
          <option value="cancelled">Отменённые</option>
          <option value="all">Все</option>
        </select>
        <div className="search"><Search size={16} /><input className="input" placeholder="Номер ремонта или госномер" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : !data?.length ? <Empty icon={Wrench} title="Ремонтов нет" /> : (
        <div className="table-wrap card">
          <table className="table table-click">
            <thead><tr><th>Ремонт</th><th>ТС</th><th>Дефектовка</th><th>Статус</th><th>Приоритет</th><th>Готовность</th><th>Окончание (план)</th><th>Выпуск</th><th>Сумма работ</th></tr></thead>
            <tbody>
              {data.map((o) => (
                <tr key={o.id} onClick={() => nav(`/orders/${o.id}`)}>
                  <td><b>{o.number}</b></td>
                  <td>{o.tractor_plate && <div>{plate(o.tractor_plate)} <span className="muted small">{o.tractor_brand}</span></div>}{o.trailer_plate && <div className="muted">{plate(o.trailer_plate)}</div>}</td>
                  <td className="nowrap">{fmtDateTime(o.inspected_at)}</td>
                  <td><Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge>{o.error_count > 0 && <div className="text-red small">{o.error_count} ош.</div>}</td>
                  <td>{o.top_priority ? <Badge tone={PRIORITY[o.top_priority].tone}>{PRIORITY[o.top_priority].label}</Badge> : '—'}</td>
                  <td><Progress done={o.tasks_done} total={o.tasks_total} /></td>
                  <td className="nowrap">{fmtShort(o.planned_end)}</td>
                  <td className="nowrap">{o.release_deadline ? <>{fmtShort(o.release_deadline)}{o.planned_end > o.release_deadline && <div><Badge tone="red">не успевает</Badge></div>}</> : '—'}</td>
                  <td className="nowrap">{money(o.total_price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
