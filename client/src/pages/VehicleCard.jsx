import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Gauge, Archive, ClipboardCheck, FileBarChart } from 'lucide-react';
import * as api from '../api.js';
import { can, useApp } from '../App.jsx';
import { fmtDate, fmtDateTime, hours, km, MAINT_STATUS, money, ORDER_STATUS, plate, TASK_STATUS, VEH } from '../format.js';
import { Badge, Button, Card, Confirm, Empty, ErrorBox, Spinner, Stat, Tabs, useAction, useLoad } from '../ui/kit.jsx';
import { VehicleForm } from './Vehicles.jsx';
import { MileageDialog, BaselineDialog } from './Maintenance.jsx';

export default function VehicleCard() {
  const { type, id } = useParams();
  const { user } = useApp();
  const nav = useNavigate();
  const { data: v, loading, error, reload } = useLoad(() => api.get(`/vehicles/${type}/${id}`), [type, id]);
  const [tab, setTab] = useState('history');
  const [edit, setEdit] = useState(false);
  const [mileage, setMileage] = useState(false);
  const [baseline, setBaseline] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [run] = useAction();

  if (loading && !v) return <Spinner />;
  if (error && !v) return <ErrorBox error={error} onRetry={reload} />;
  const canWrite = can(user, 'vehicles.write');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Link to={`/vehicles?type=${type}`} className="back"><ArrowLeft size={16} /> {type === 'tractor' ? 'Тягачи' : 'Прицепы'}</Link>
          <h1><span className="plate">{plate(v.plate)}</span> <span className="muted h-sub">{v.brand} {v.model}{v.year ? `, ${v.year}` : ''}</span></h1>
          {v.archived ? <Badge tone="gray">в архиве</Badge> : null}
        </div>
        <div className="row gap-s wrap">
          {can(user, 'orders.write') && !v.archived && (
            <Link to={`/defect/new?${type}=${v.id}`}><Button variant="primary" icon={ClipboardCheck}>Дефектовка</Button></Link>
          )}
          {canWrite && <Button icon={Gauge} onClick={() => setMileage(true)}>Пробег</Button>}
          {canWrite && <Button icon={Pencil} onClick={() => setEdit(true)}>Изменить</Button>}
          {can(user, 'reports.read') && <Link to={`/reports?type=works&vehicle_type=${type}&vehicle_id=${v.id}`}><Button icon={FileBarChart}>Отчёт</Button></Link>}
          {canWrite && !v.archived && <Button variant="ghost" icon={Archive} onClick={() => setConfirm(true)}>Удалить</Button>}
        </div>
      </div>

      <div className="stats">
        <Stat label="Пробег" value={v.mileage ? km(v.mileage) : '—'} />
        <Stat label="Выполнено работ" value={v.totals.works} hint={money(v.totals.price)} />
        <Stat label={type === 'tractor' ? 'Прицеп' : 'Тягач'} value={type === 'tractor'
          ? (v.trailer ? <Link to={`/vehicles/trailer/${v.trailer.id}`}>{plate(v.trailer.plate)}</Link> : '—')
          : (v.tractor ? <Link to={`/vehicles/tractor/${v.tractor.id}`}>{plate(v.tractor.plate)}</Link> : '—')} />
        <Stat label="Конфигурация" value={`${v.axles} ос${v.axles === 1 ? 'ь' : 'и'}`} hint={`${v.brake_type === 'drum' ? 'барабанные' : 'дисковые'} тормоза${v.has_reefer ? ` · реф ${v.reefer_hours ?? '—'} м/ч` : ''}`} />
      </div>

      <Card title="Плановое ТО" pad={false}>
        {v.maintenance.length === 0 ? <Empty title="Для этой марки нет правил ТО" >Добавьте правило в разделе «Пробег и ТО»</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Работа</th><th>Интервал</th><th>Последнее</th><th>Следующее</th><th>Осталось</th><th>Прогноз</th><th>Статус</th><th /></tr></thead>
              <tbody>
                {v.maintenance.map((m) => (
                  <tr key={m.rule_id}>
                    <td>{m.name}</td>
                    <td>{[m.interval_km && km(m.interval_km), m.interval_days && `${m.interval_days} дн.`].filter(Boolean).join(' / ')}</td>
                    <td>{m.last_km != null ? km(m.last_km) : '—'}{m.last_at ? ` · ${fmtDate(m.last_at)}` : ''}{m.estimated && <span className="muted"> (оценка)</span>}</td>
                    <td>{m.next_km != null ? km(m.next_km) : '—'}</td>
                    <td>{m.remaining_km != null ? km(m.remaining_km) : '—'}{m.days_left != null ? ` · ${m.days_left} дн.` : ''}</td>
                    <td>{m.due_date ? fmtDate(m.due_date) : <span className="muted">{m.km_per_day ? '' : 'мало данных'}</span>}{m.km_per_day ? <div className="muted small">{m.km_per_day} км/сут</div> : null}</td>
                    <td><Badge tone={MAINT_STATUS[m.status].tone}>{MAINT_STATUS[m.status].label}</Badge></td>
                    <td>{can(user, 'maintenance.write') && <Button size="sm" variant="ghost" onClick={() => setBaseline(m)}>Отметить выполненным</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Tabs value={tab} onChange={setTab} items={[
        { value: 'history', label: 'История работ', count: v.history.length },
        { value: 'orders', label: 'Ремонты', count: v.orders.length },
        { value: 'parts', label: 'Запчасти', count: v.parts.length },
        { value: 'mileage', label: 'Журнал пробега', count: v.mileage_log.length },
      ]} />

      <div className="card">
        {tab === 'history' && (v.history.length === 0 ? <Empty title="Работ ещё не было" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Дата</th><th>Работа</th><th>Узел</th><th>Причина</th><th>Пробег</th><th>Исполнитель</th><th>Время</th><th>Цена</th><th>Статус</th></tr></thead>
            <tbody>{v.history.map((t) => (
              <tr key={t.id}>
                <td className="nowrap">{fmtDate(t.finished_at || t.registered_at)}</td>
                <td>{t.description}{t.order_number && <div className="small"><Link to={`/orders/${t.order_id}`}>{t.order_number}</Link></div>}</td>
                <td>{t.location || '—'}</td>
                <td className="small muted">{t.reason}</td>
                <td className="nowrap">{km(t.mileage)}</td>
                <td>{t.employee_name || '—'}</td>
                <td className="nowrap">{t.actual_hours ? hours(t.actual_hours) : hours(t.hours)}</td>
                <td className="nowrap">{money(t.price)}</td>
                <td><Badge tone={TASK_STATUS[t.status].tone}>{TASK_STATUS[t.status].label}</Badge></td>
              </tr>
            ))}</tbody>
          </table></div>
        ))}
        {tab === 'orders' && (v.orders.length === 0 ? <Empty title="Ремонтов не было" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Ремонт</th><th>Дефектовка</th><th>Пробег</th><th>Работ</th><th>Статус</th><th>Закрыт</th></tr></thead>
            <tbody>{v.orders.map((o) => (
              <tr key={o.id}>
                <td><Link to={`/orders/${o.id}`}>{o.number}</Link></td>
                <td>{fmtDateTime(o.inspected_at)}</td><td>{km(o.mileage)}</td><td>{o.tasks_done}/{o.tasks_total}</td>
                <td><Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge></td>
                <td>{fmtDate(o.closed_at)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ))}
        {tab === 'parts' && (v.parts.length === 0 ? <Empty title="Запчасти не устанавливались" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Дата</th><th>Код 1С</th><th>Артикул</th><th>Наименование</th><th>Кол-во</th><th>Цена</th><th>Пробег</th><th>В 1С</th></tr></thead>
            <tbody>{v.parts.map((p) => (
              <tr key={p.id}>
                <td>{fmtDate(p.installed_at)}</td><td>{p.code || '—'}</td><td>{p.article || '—'}</td><td>{p.name}</td>
                <td>{p.qty} {p.unit}</td><td>{money(p.price)}</td><td>{km(p.mileage)}</td>
                <td>{p.exported_at ? <Badge tone="green">{fmtDate(p.exported_at)}</Badge> : <Badge>нет</Badge>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ))}
        {tab === 'mileage' && (v.mileage_log.length === 0 ? <Empty title="Записей нет" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Дата</th><th>Пробег</th><th>Источник</th></tr></thead>
            <tbody>{v.mileage_log.map((m) => (
              <tr key={m.id}><td>{fmtDateTime(m.recorded_at)}</td><td>{km(m.mileage)}</td>
                <td>{{ defect: 'Дефектовка', repair: 'Ремонт', manual: 'Вручную', import: 'Импорт' }[m.source] || m.source}</td></tr>
            ))}</tbody>
          </table></div>
        ))}
      </div>

      {edit && <VehicleForm type={type} vehicle={v} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); reload(); }} />}
      {mileage && <MileageDialog type={type} vehicle={v} onClose={() => setMileage(false)} onSaved={() => { setMileage(false); reload(); }} />}
      {baseline && <BaselineDialog item={{ ...baseline, vehicle_id: v.id, plate: v.plate, mileage: v.mileage }} onClose={() => setBaseline(null)} onSaved={() => { setBaseline(null); reload(); }} />}
      {confirm && <Confirm title="Удалить ТС?" danger confirmText="Удалить"
        text="Если у ТС есть история ремонтов, оно будет перенесено в архив (история сохранится). Иначе — удалено."
        onClose={() => setConfirm(false)}
        onConfirm={() => run(async () => { const r = await api.del(`/vehicles/${type}/${v.id}`); nav(`/vehicles?type=${type}`); return r; }, 'Готово')} />}
    </div>
  );
}

