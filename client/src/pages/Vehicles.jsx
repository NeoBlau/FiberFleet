import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Truck, Search } from 'lucide-react';
import * as api from '../api.js';
import { can, useApp } from '../App.jsx';
import { km, plate } from '../format.js';
import { Badge, Button, Empty, ErrorBox, Field, Modal, SearchSelect, Spinner, Tabs, useAction, useLoad } from '../ui/kit.jsx';

export default function Vehicles() {
  const { user } = useApp();
  const [params, setParams] = useSearchParams();
  const type = params.get('type') === 'trailer' ? 'trailer' : 'tractor';
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [edit, setEdit] = useState(null);
  const nav = useNavigate();
  const { data, loading, error, reload } = useLoad(() => api.get(`/vehicles/${type}${api.qs({ archived: archived ? 1 : '' })}`), [type, archived]);

  const words = q.toLowerCase().replace(/\s+/g, '');
  const rows = (data || []).filter((v) => !words || `${v.plate}${v.brand}${v.model}${v.trailer_plate || ''}${v.tractor_plate || ''}`.toLowerCase().replace(/\s+/g, '').includes(words));

  return (
    <div className="page">
      <div className="page-head">
        <h1>Тягачи и прицепы</h1>
        {can(user, 'vehicles.write') && <Button variant="primary" icon={Plus} onClick={() => setEdit({ type })}>{type === 'tractor' ? 'Добавить тягач' : 'Добавить прицеп'}</Button>}
      </div>
      <div className="toolbar">
        <Tabs value={type} onChange={(v) => setParams({ type: v })} items={[{ value: 'tractor', label: 'Тягачи' }, { value: 'trailer', label: 'Прицепы' }]} />
        <div className="search">
          <Search size={16} />
          <input className="input" placeholder="Госномер, марка, модель…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="check"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Архив</label>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : rows.length === 0 ? <Empty icon={Truck} title="Ничего не найдено" /> : (
        <div className="table-wrap card">
          <table className="table table-click">
            <thead>
              <tr>
                <th>Госномер</th><th>Марка / модель</th><th>Год</th><th>Пробег</th>
                <th>{type === 'tractor' ? 'Прицеп' : 'Тягач'}</th><th>Тормоза</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id} onClick={() => nav(`/vehicles/${type}/${v.id}`)}>
                  <td><b className="plate">{plate(v.plate)}</b></td>
                  <td>{v.brand} {v.model}{v.has_reefer ? <Badge tone="blue">реф</Badge> : null}</td>
                  <td>{v.year || '—'}</td>
                  <td className="nowrap">{v.mileage ? km(v.mileage) : <span className="muted">не указан</span>}</td>
                  <td>{type === 'tractor' ? plate(v.trailer_plate) : plate(v.tractor_plate)}</td>
                  <td>{v.brake_type === 'drum' ? 'барабанные' : 'дисковые'}</td>
                  <td>{v.open_orders > 0 && <Badge tone="amber">в ремонте</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">Всего: {rows.length}</p>
      {edit && <VehicleForm type={edit.type} vehicle={edit.vehicle} onClose={() => setEdit(null)} onSaved={(id) => { setEdit(null); reload(); if (id) nav(`/vehicles/${edit.type}/${id}`); }} />}
    </div>
  );
}

export function VehicleForm({ type, vehicle, onClose, onSaved }) {
  const isNew = !vehicle;
  const [f, setF] = useState(() => ({
    plate: vehicle?.plate || '', brand: vehicle?.brand || '', model: vehicle?.model || '', year: vehicle?.year || '',
    vin: vehicle?.vin || '', mileage: vehicle?.mileage || '', axles: vehicle?.axles || (type === 'tractor' ? 2 : 3),
    brake_type: vehicle?.brake_type || 'disc', trailer_id: vehicle?.trailer_id || null, tractor_id: vehicle?.tractor?.id || null,
    has_reefer: !!vehicle?.has_reefer, reefer_hours: vehicle?.reefer_hours || '', notes: vehicle?.notes || '',
  }));
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  const other = useLoad(() => api.get(`/vehicles/${type === 'tractor' ? 'trailer' : 'tractor'}`), [type]);
  const [run, busy] = useAction();
  const brands = type === 'tractor' ? ['MAN', 'SCANIA', 'DAF', 'MERCEDES-BENZ', 'FAW', 'VOLVO', 'RENAULT', 'IVECO', 'КАМАЗ', 'SITRAK'] : ['SCHMITZ', 'KOGEL', 'KRONE', 'WIELTON', 'ТОНАР'];

  const save = () => run(async () => {
    const body = { ...f };
    if (type === 'trailer') delete body.trailer_id; else { delete body.tractor_id; delete body.has_reefer; delete body.reefer_hours; }
    if (isNew) {
      const r = await api.post(`/vehicles/${type}`, body, { label: `Новое ТС ${f.plate}` });
      onSaved(r?.id);
      return r;
    }
    const r = await api.put(`/vehicles/${type}/${vehicle.id}`, body, { label: `Изменение ТС ${f.plate}` });
    onSaved();
    return r;
  }, 'Сохранено');

  return (
    <Modal title={isNew ? (type === 'tractor' ? 'Новый тягач' : 'Новый прицеп') : `${type === 'tractor' ? 'Тягач' : 'Прицеп'} ${plate(vehicle.plate)}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Отмена</Button><Button variant="primary" loading={busy} onClick={save}>Сохранить</Button></>}>
      <div className="form-grid">
        <Field label="Госномер *"><input className="input" value={f.plate} onChange={set('plate')} placeholder={type === 'tractor' ? 'Т 970 ОН 58' : 'АЕ 1043/95'} /></Field>
        <Field label={type === 'tractor' ? 'Марка *' : 'Марка'}>
          <input className="input" list="brands" value={f.brand} onChange={set('brand')} placeholder="Выберите или впишите" />
          <datalist id="brands">{brands.map((b) => <option key={b} value={b} />)}</datalist>
        </Field>
        <Field label={type === 'trailer' ? 'Модель *' : 'Модель'}><input className="input" value={f.model} onChange={set('model')} /></Field>
        <Field label="Год выпуска"><input className="input" type="number" value={f.year} onChange={set('year')} /></Field>
        <Field label="Пробег, км" hint={isNew ? '' : 'Изменение пробега попадёт в журнал'}><input className="input" type="number" inputMode="numeric" value={f.mileage} onChange={set('mileage')} /></Field>
        <Field label="VIN"><input className="input" value={f.vin} onChange={set('vin')} /></Field>
        <Field label="Осей"><input className="input" type="number" min="1" max="5" value={f.axles} onChange={set('axles')} /></Field>
        <Field label="Тормоза">
          <select className="input" value={f.brake_type} onChange={set('brake_type')}>
            <option value="disc">Дисковые</option><option value="drum">Барабанные</option>
          </select>
        </Field>
        {type === 'tractor' ? (
          <Field label="Закреплённый прицеп" className="span-2">
            <SearchSelect clearable value={f.trailer_id} onChange={set('trailer_id')}
              options={(other.data || []).map((t) => ({ value: t.id, label: `${plate(t.plate)} — ${t.brand || ''} ${t.model}` }))} placeholder="Без прицепа" />
          </Field>
        ) : (
          <>
            <Field label="Тягач (сцепка)" className="span-2">
              <SearchSelect clearable value={f.tractor_id} onChange={set('tractor_id')}
                options={(other.data || []).map((t) => ({ value: t.id, label: `${plate(t.plate)} — ${t.brand} ${t.model || ''}` }))} placeholder="Не сцеплен" />
            </Field>
            <label className="check"><input type="checkbox" checked={f.has_reefer} onChange={set('has_reefer')} /> Рефрижераторная установка</label>
            {f.has_reefer && <Field label="Моточасы реф."><input className="input" type="number" value={f.reefer_hours} onChange={set('reefer_hours')} /></Field>}
          </>
        )}
        <Field label="Примечание" className="span-2"><textarea className="input" rows={2} value={f.notes} onChange={set('notes')} /></Field>
      </div>
    </Modal>
  );
}

export function VehicleLink({ type, id, p }) {
  return <Link to={`/vehicles/${type}/${id}`}>{plate(p)}</Link>;
}
