import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Gauge, Plus, Pencil, Trash2, Search } from 'lucide-react';
import * as api from '../api.js';
import { can, useApp } from '../App.jsx';
import { dateToIso, fmtDate, isoToDateInput, km, MAINT_STATUS, plate, VEH } from '../format.js';
import { Badge, Button, Empty, ErrorBox, Field, Modal, SearchSelect, Spinner, Tabs, useAction, useLoad } from '../ui/kit.jsx';

export default function Maintenance() {
  const { user } = useApp();
  const [tab, setTab] = useState('fleet');
  return (
    <div className="page">
      <div className="page-head"><h1>Пробег и плановое ТО</h1></div>
      <p className="muted">Система считает следующее ТО по пробегу и/или сроку, а по журналу пробега — среднесуточный пробег и прогноз даты. Если в системе ещё нет истории, точка отсчёта оценивается по пробегу — отметьте фактически выполненное ТО.</p>
      <Tabs value={tab} onChange={setTab} items={[{ value: 'fleet', label: 'Рекомендации по парку' }, { value: 'rules', label: 'Правила ТО' }]} />
      {tab === 'fleet' ? <Fleet canWrite={can(user, 'maintenance.write')} canMileage={can(user, 'vehicles.write')} /> : <Rules canWrite={can(user, 'maintenance.write')} />}
    </div>
  );
}

function Fleet({ canWrite, canMileage }) {
  const { data, loading, error, reload } = useLoad(() => api.get('/maintenance'));
  const [status, setStatus] = useState('attention');
  const [q, setQ] = useState('');
  const [baseline, setBaseline] = useState(null);
  const [mileage, setMileage] = useState(null);
  const rows = useMemo(() => (data || []).filter((m) => (status === 'all' || (status === 'attention' ? ['overdue', 'soon'].includes(m.status) : m.status === status))
    && (!q || `${m.plate}${m.brand}${m.model}`.toLowerCase().replace(/\s/g, '').includes(q.toLowerCase().replace(/\s/g, '')))), [data, status, q]);
  const count = (s) => (data || []).filter((m) => m.status === s).length;

  if (loading && !data) return <Spinner />;
  return (
    <>
      <ErrorBox error={error} onRetry={reload} />
      <div className="toolbar">
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="attention">Требуют внимания ({count('overdue') + count('soon')})</option>
          <option value="overdue">Просрочено ({count('overdue')})</option>
          <option value="soon">Скоро ({count('soon')})</option>
          <option value="unknown">Нет данных о пробеге ({count('unknown')})</option>
          <option value="ok">В норме ({count('ok')})</option>
          <option value="all">Все</option>
        </select>
        <div className="search"><Search size={16} /><input className="input" placeholder="Госномер, марка…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>
      {rows.length === 0 ? <Empty icon={Gauge} title="Нет записей" /> : (
        <div className="table-wrap card">
          <table className="table">
            <thead><tr><th>ТС</th><th>Работа</th><th>Пробег</th><th>Последнее</th><th>Следующее</th><th>Осталось</th><th>Прогноз</th><th>Статус</th><th /></tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={`${m.vehicle_type}-${m.vehicle_id}-${m.rule_id}`}>
                  <td><Link to={`/vehicles/${m.vehicle_type}/${m.vehicle_id}`}>{VEH[m.vehicle_type]} <b>{plate(m.plate)}</b></Link><div className="muted small">{m.brand} {m.model}</div></td>
                  <td>{m.name}</td>
                  <td className="nowrap">{m.mileage ? km(m.mileage) : <span className="muted">—</span>}</td>
                  <td className="nowrap">{m.last_km != null ? km(m.last_km) : '—'}{m.estimated && <span className="muted small"> оценка</span>}{m.last_at ? <div className="small muted">{fmtDate(m.last_at)}</div> : null}</td>
                  <td className="nowrap">{m.next_km != null ? km(m.next_km) : '—'}{m.next_date ? <div className="small muted">до {fmtDate(m.next_date)}</div> : null}</td>
                  <td className="nowrap">{m.remaining_km != null ? km(m.remaining_km) : '—'}{m.days_left != null ? <div className="small muted">{m.days_left} дн.</div> : null}</td>
                  <td className="nowrap">{m.due_date ? fmtDate(m.due_date) : '—'}{m.km_per_day ? <div className="small muted">{m.km_per_day} км/сут</div> : null}</td>
                  <td><Badge tone={MAINT_STATUS[m.status].tone}>{MAINT_STATUS[m.status].label}</Badge></td>
                  <td className="nowrap">
                    {canMileage && <Button size="sm" variant="ghost" onClick={() => setMileage(m)}>Пробег</Button>}
                    {canWrite && <Button size="sm" variant="ghost" onClick={() => setBaseline(m)}>Выполнено</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {baseline && <BaselineDialog item={baseline} onClose={() => setBaseline(null)} onSaved={() => { setBaseline(null); reload(); }} />}
      {mileage && <MileageDialog type={mileage.vehicle_type} vehicle={{ id: mileage.vehicle_id, plate: mileage.plate, mileage: mileage.mileage }} onClose={() => setMileage(null)} onSaved={() => { setMileage(null); reload(); }} />}
    </>
  );
}

export function MileageDialog({ type, vehicle, onClose, onSaved }) {
  const [value, setValue] = useState('');
  const [date, setDate] = useState(isoToDateInput(new Date().toISOString()));
  const [allowDecrease, setAllowDecrease] = useState(false);
  const [run, busy] = useAction();
  const n = Number(value);
  const decrease = value !== '' && n < (vehicle.mileage || 0);
  return (
    <Modal title={`Пробег — ${plate(vehicle.plate)}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Отмена</Button><Button variant="primary" loading={busy} disabled={!value || (decrease && !allowDecrease)}
        onClick={() => run(async () => {
          const r = await api.post(`/vehicles/${type}/${vehicle.id}/mileage`, { mileage: n, at: dateToIso(date) || undefined, allow_decrease: allowDecrease }, { label: `Пробег ${plate(vehicle.plate)}: ${n}` });
          onSaved(); return r;
        }, 'Пробег записан')}>Сохранить</Button></>}>
      <p className="muted">Текущий пробег: {vehicle.mileage ? km(vehicle.mileage) : 'не указан'}</p>
      <div className="form-grid">
        <Field label="Пробег, км"><input className="input" type="number" inputMode="numeric" autoFocus value={value} onChange={(e) => setValue(e.target.value)} /></Field>
        <Field label="Дата"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      {decrease && <label className="check"><input type="checkbox" checked={allowDecrease} onChange={(e) => setAllowDecrease(e.target.checked)} /> Пробег меньше текущего — это исправление ошибки</label>}
    </Modal>
  );
}

export function BaselineDialog({ item, onClose, onSaved }) {
  const [km_, setKm] = useState(item.mileage || '');
  const [date, setDate] = useState(isoToDateInput(new Date().toISOString()));
  const [run, busy] = useAction();
  return (
    <Modal title={`${item.name} — ${plate(item.plate)}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Отмена</Button><Button variant="primary" loading={busy}
        onClick={() => run(async () => { const r = await api.post('/maintenance/baseline', { rule_id: item.rule_id, vehicle_id: item.vehicle_id, done_mileage: km_, done_at: dateToIso(date) }); onSaved(); return r; }, 'Отмечено')}>Сохранить</Button></>}>
      <p className="muted">Укажите, когда это ТО было выполнено в последний раз (если оно делалось до ведения учёта в FiberFleet). ТО, выполненное через систему, учитывается автоматически.</p>
      <div className="form-grid">
        <Field label="Пробег на момент ТО, км"><input className="input" type="number" value={km_} onChange={(e) => setKm(e.target.value)} /></Field>
        <Field label="Дата"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function Rules({ canWrite }) {
  const { data, loading, error, reload } = useLoad(() => api.get('/maintenance/rules'));
  const [edit, setEdit] = useState(null);
  const [run] = useAction();
  if (loading && !data) return <Spinner />;
  return (
    <>
      <ErrorBox error={error} onRetry={reload} />
      {canWrite && <div className="toolbar"><Button variant="primary" icon={Plus} onClick={() => setEdit({})}>Добавить правило</Button></div>}
      <div className="table-wrap card">
        <table className="table">
          <thead><tr><th>Правило</th><th>ТС</th><th>Марка</th><th>Интервал</th><th>Предупреждать</th><th>Работа</th><th>Ключ</th><th /></tr></thead>
          <tbody>
            {(data || []).map((r) => (
              <tr key={r.id} className={r.active ? '' : 'dim'}>
                <td>{r.name}</td><td>{VEH[r.vehicle_type]}</td><td>{r.brand_match || 'все'}</td>
                <td>{[r.interval_km && km(r.interval_km), r.interval_days && `${r.interval_days} дн.`].filter(Boolean).join(' / ')}</td>
                <td>{km(r.warn_km)} / {r.warn_days} дн.</td>
                <td>{r.work_name || '—'}</td><td><code>{r.key}</code></td>
                <td className="nowrap">{canWrite && <>
                  <button className="icon-btn" onClick={() => setEdit(r)} aria-label="Изменить"><Pencil size={15} /></button>
                  <button className="icon-btn" onClick={() => run(async () => { const x = await api.del(`/maintenance/rules/${r.id}`); reload(); return x; }, 'Удалено')} aria-label="Удалить"><Trash2 size={15} /></button>
                </>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Ключ связывает правило с пунктом дефектной ведомости: <code>to</code> — «ТО», <code>valves</code> — «Регулировка клапанов». Правило с указанной маркой важнее общего.</p>
      {edit && <RuleForm rule={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}

function RuleForm({ rule, onClose, onSaved }) {
  const [f, setF] = useState({ key: 'to', name: '', vehicle_type: 'tractor', brand_match: '', interval_km: '', interval_days: '', warn_km: 5000, warn_days: 14, work_type_id: null, active: 1, ...rule });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  const works = useLoad(() => api.get('/work-types'));
  const [run, busy] = useAction();
  return (
    <Modal title={rule.id ? 'Правило ТО' : 'Новое правило ТО'} onClose={onClose}
      footer={<><Button onClick={onClose}>Отмена</Button><Button variant="primary" loading={busy} onClick={() => run(async () => {
        const r = rule.id ? await api.put(`/maintenance/rules/${rule.id}`, f) : await api.post('/maintenance/rules', f);
        onSaved(); return r;
      }, 'Сохранено')}>Сохранить</Button></>}>
      <div className="form-grid">
        <Field label="Название"><input className="input" value={f.name} onChange={set('name')} placeholder="Полное ТО" /></Field>
        <Field label="Ключ" hint="to, valves или свой"><input className="input" value={f.key} onChange={set('key')} /></Field>
        <Field label="Тип ТС"><select className="input" value={f.vehicle_type} onChange={set('vehicle_type')}><option value="tractor">Тягач</option><option value="trailer">Прицеп</option></select></Field>
        <Field label="Марка/модель содержит" hint="Пусто — для всех"><input className="input" value={f.brand_match || ''} onChange={set('brand_match')} placeholder="MAN" /></Field>
        <Field label="Интервал, км"><input className="input" type="number" value={f.interval_km || ''} onChange={set('interval_km')} /></Field>
        <Field label="Интервал, дней"><input className="input" type="number" value={f.interval_days || ''} onChange={set('interval_days')} /></Field>
        <Field label="Предупреждать за, км"><input className="input" type="number" value={f.warn_km} onChange={set('warn_km')} /></Field>
        <Field label="Предупреждать за, дней"><input className="input" type="number" value={f.warn_days} onChange={set('warn_days')} /></Field>
        <Field label="Работа из справочника" className="span-2">
          <SearchSelect value={f.work_type_id} onChange={set('work_type_id')} groupBy="category"
            options={(works.data || []).map((w) => ({ value: w.id, label: w.name, category: w.category }))} />
        </Field>
        <label className="check"><input type="checkbox" checked={!!f.active} onChange={set('active')} /> Активно</label>
      </div>
    </Modal>
  );
}
