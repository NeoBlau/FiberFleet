import { Link } from 'react-router-dom';
import { AlertTriangle, ClipboardCheck, Gauge, Wrench, CalendarClock } from 'lucide-react';
import * as api from '../api.js';
import { can, useApp } from '../App.jsx';
import { fmtDateTime, fmtShort, fmtTime, km, MAINT_STATUS, money, ORDER_STATUS, plate, PRIORITY, TASK_STATUS, VEH } from '../format.js';
import { Badge, Button, Card, Empty, ErrorBox, Spinner, Stat, useLoad } from '../ui/kit.jsx';

export default function Dashboard() {
  const { user } = useApp();
  const { data, loading, error, reload } = useLoad(() => api.get('/dashboard'));
  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;
  const { orders, today, maintenance, maintenance_total: maintTotal, kpi } = data;
  const errs = orders.filter((o) => o.errors.length);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Главная</h1>
        {can(user, 'orders.write') && <Link to="/defect/new"><Button variant="primary" icon={ClipboardCheck}>Новая дефектовка</Button></Link>}
      </div>

      <div className="stats">
        <Stat label="ТС в ремонте" value={orders.length} hint={`${kpi.tractors} тягачей · ${kpi.trailers} прицепов в парке`} />
        <Stat label="Открытых работ" value={kpi.open_tasks} />
        <Stat label="Выполнено за 30 дней" value={kpi.done_30} hint={money(kpi.revenue_30)} />
        <Stat label="ТО: требуют внимания" value={maintTotal} tone={maintTotal ? 'amber' : undefined} />
      </div>

      {errs.length > 0 && (
        <div className="alert alert-red">
          <AlertTriangle size={18} />
          <div>
            <b>Ошибки планирования:</b>{' '}
            {errs.map((o, i) => <span key={o.id}>{i > 0 && ', '}<Link to={`/orders/${o.id}`}>{o.number}</Link> ({o.errors.length})</span>)}
          </div>
        </div>
      )}

      <div className="grid-2">
        <Card title="ТС в ремонте" actions={<Link to="/orders" className="link">Все ремонты</Link>} pad={false}>
          {orders.length === 0 ? <Empty icon={Wrench} title="Нет активных ремонтов" /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Ремонт</th><th>ТС</th><th>Статус</th><th>Готовность</th><th>Выпуск</th></tr></thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td><Link to={`/orders/${o.id}`}>{o.number}</Link></td>
                      <td>{[o.tractor_plate, o.trailer_plate].filter(Boolean).map(plate).join(' + ')}</td>
                      <td><Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge></td>
                      <td><Progress done={o.done} total={o.total} /></td>
                      <td className="nowrap">
                        {o.release_deadline ? fmtShort(o.release_deadline) : <span className="muted">план: {fmtShort(o.planned_end)}</span>}
                        {o.release_deadline && o.planned_end > o.release_deadline && <Badge tone="red">не успевает</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Работы на сегодня" actions={<Link to="/schedule" className="link">Расписание</Link>} pad={false}>
          {today.length === 0 ? <Empty icon={CalendarClock} title="На сегодня работ нет" /> : (
            <ul className="tasklist">
              {today.map((t) => (
                <li key={t.id}>
                  <div className="tl-time">{fmtTime(t.start_at)}<br /><span className="muted">{fmtTime(t.end_at)}</span></div>
                  <div className="tl-main">
                    <div><Badge tone={PRIORITY[t.priority].tone}>{PRIORITY[t.priority].short}</Badge> <b>{t.description}</b></div>
                    <div className="muted">{VEH[t.vehicle_type]} {plate(t.plate)}{t.location ? ` · ${t.location}` : ''} · <Link to={`/orders/${t.order_id}`}>{t.order_number}</Link></div>
                  </div>
                  <div className="tl-side">
                    <div>{t.employee_name}</div>
                    <Badge tone={TASK_STATUS[t.status].tone}>{TASK_STATUS[t.status].label}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Рекомендации по ТО" actions={<Link to="/maintenance" className="link">Пробег и ТО</Link>} pad={false}>
        {maintenance.length === 0 ? <Empty icon={Gauge} title="Просроченного и подходящего ТО нет" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>ТС</th><th>Работа</th><th>Пробег</th><th>Следующее</th><th>Осталось</th><th>Статус</th></tr></thead>
              <tbody>
                {maintenance.map((m) => (
                  <tr key={`${m.vehicle_type}-${m.vehicle_id}-${m.rule_id}`}>
                    <td><Link to={`/vehicles/${m.vehicle_type}/${m.vehicle_id}`}>{VEH[m.vehicle_type]} {plate(m.plate)}</Link></td>
                    <td>{m.name}</td>
                    <td>{km(m.mileage)}</td>
                    <td>{m.next_km != null ? km(m.next_km) : ''}{m.next_date ? ` / ${fmtDateTime(m.next_date).slice(0, 10)}` : ''}</td>
                    <td>{m.remaining_km != null ? km(m.remaining_km) : ''}{m.days_left != null ? ` · ${m.days_left} дн.` : ''}{m.estimated && <span className="muted" title="Точка отсчёта оценена по пробегу — отметьте фактическое ТО"> (оценка)</span>}</td>
                    <td><Badge tone={MAINT_STATUS[m.status].tone}>{MAINT_STATUS[m.status].label}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export function Progress({ done, total }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="progress" title={`${done} из ${total}`}>
      <div className="progress-bar"><div style={{ width: `${pct}%` }} /></div>
      <span>{done}/{total}</span>
    </div>
  );
}
