import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ClipboardCheck, Search, Wrench, Pause, Play, RefreshCw, Zap } from 'lucide-react';
import * as api from '../api.js';
import { can, useApp } from '../App.jsx';
import { fmtDateTime, fmtShort, money, ORDER_STATUS, plate, PRIORITY } from '../format.js';
import { Badge, Button, Empty, ErrorBox, Spinner, useAction, useLoad } from '../ui/kit.jsx';
import { Progress } from './Dashboard.jsx';

export default function Orders() {
  const { user } = useApp();
  const nav = useNavigate();
  const [status, setStatus] = useState('active');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState([]);
  const [reason, setReason] = useState('');
  const [run, busy] = useAction();
  const canPlan = can(user, 'plan.write');
  useEffect(() => setSelected([]), [status, q]);
  const { data, loading, error, reload } = useLoad(() => api.get(`/orders${api.qs({ status, q })}`), [status, q]);

  const selectable = (data || []).filter(o => !['done','cancelled','draft'].includes(o.status));
  const pause = (paused) => run(async () => {
    const result = await api.post('/orders/pause', { ids: selected, paused, reason }, { offline: false });
    setSelected([]); reload(); return result;
  }, paused ? 'Ремонты на паузе, слесари освобождены, расписание обновлено' : 'Ремонты возвращены в очередь');
  const urgent = (value) => run(async () => {
    const result = await api.post('/orders/urgent', { ids: selected, urgent: value }, { offline: false });
    setSelected([]); reload(); return result;
  }, value ? 'Отмечены срочными, очередь пересчитана' : 'Возвращены в обычную очередь');

  return (
    <div className="page">
      <div className="page-head">
        <h1>Ремонты</h1>
        {can(user, 'orders.write') && <Link to="/defect/new"><Button variant="primary" icon={ClipboardCheck}>Новая дефектовка</Button></Link>}
      </div>
      <div className="toolbar">
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Активные (включая паузу)</option><option value="paused">На паузе</option>
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
      {canPlan && <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div className="row gap-s wrap">
          <b>Выбрано ремонтов: {selected.length}</b>
          <input className="input" style={{ maxWidth: 300 }} aria-label="Причина паузы" placeholder="Причина паузы (необязательно)" value={reason} onChange={e => setReason(e.target.value)} />
          <Button icon={Pause} disabled={!selected.length} loading={busy} onClick={() => pause(true)}>Приостановить ремонт</Button>
          <Button icon={Play} disabled={!selected.length} loading={busy} onClick={() => pause(false)}>Возобновить ремонт</Button>
          <Button icon={Zap} disabled={!selected.length} loading={busy} onClick={() => urgent(true)}>Срочно</Button>
          <Button disabled={!selected.length} loading={busy} onClick={() => urgent(false)}>Обычная очередь</Button>
          <Link to="/schedule"><Button icon={RefreshCw}>План на сегодня</Button></Link>
        </div>
        <p className="small muted">Можно выбрать любое количество ремонтов. Завершённые работы сохраняются; пауза освобождает слесарей. Возобновлённые работы возвращаются в очередь, без автоматического запуска.</p>
      </div>}
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : !data?.length ? <Empty icon={Wrench} title="Ремонтов нет" /> : (
        <div className="table-wrap card">
          <table className="table table-click">
            <thead><tr>{canPlan && <th><input type="checkbox" aria-label="Выбрать все ремонты" checked={!!selectable.length && selectable.every(o => selected.includes(o.id))} onChange={e => setSelected(e.target.checked ? selectable.map(o => o.id) : [])} /></th>}<th>Ремонт</th><th>ТС</th><th>Дефектовка</th><th>Статус</th><th>Приоритет</th><th>Готовность</th><th>Окончание (план)</th><th>Выпуск</th><th>Сумма работ</th></tr></thead>
            <tbody>
              {data.map((o) => (
                <tr key={o.id} onClick={() => nav(`/orders/${o.id}`)}>
                  {canPlan && <td onClick={e => e.stopPropagation()}><input type="checkbox" aria-label={`Выбрать ремонт ${o.number}`} disabled={['done','cancelled','draft'].includes(o.status)} checked={selected.includes(o.id)} onChange={e => setSelected(s => e.target.checked ? [...s, o.id] : s.filter(id => id !== o.id))} /></td>}
                  <td><b>{o.number}</b>{!!o.dispatch_urgent && <div><Badge tone="red">Срочно</Badge></div>}</td>
                  <td>{o.tractor_plate && <div>{plate(o.tractor_plate)} <span className="muted small">{o.tractor_brand}</span></div>}{o.trailer_plate && <div className="muted">{plate(o.trailer_plate)}</div>}</td>
                  <td className="nowrap">{fmtDateTime(o.inspected_at)}</td>
                  <td><Badge tone={o.paused_at ? 'gray' : ORDER_STATUS[o.status].tone}>{o.paused_at ? 'На паузе' : ORDER_STATUS[o.status].label}</Badge>{o.paused_at && o.pause_reason && <div className="small muted">{o.pause_reason}</div>}{o.error_count > 0 && <div className="text-red small">{o.error_count} ош.</div>}</td>
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
