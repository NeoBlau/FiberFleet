import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Users } from 'lucide-react';
import * as api from '../api.js';
import { can, useApp } from '../App.jsx';
import { fmtShort, hours, money, plate, PRIORITY, TASK_STATUS } from '../format.js';
import { Badge, Button, cx, Empty, ErrorBox, Field, Modal, Spinner, Tabs, useAction, useLoad } from '../ui/kit.jsx';

const LEVELS = { 1: 'Стажёр', 2: 'Слесарь', 3: 'Мастер' };

export default function Employees() {
  const { user } = useApp();
  const { data, loading, error, reload } = useLoad(() => api.get('/employees'));
  const [open, setOpen] = useState(null);
  const canWrite = can(user, 'employees.write');
  return (
    <div className="page">
      <div className="page-head">
        <h1>Сотрудники</h1>
        {canWrite && <Button variant="primary" icon={Plus} onClick={() => setOpen({ id: null })}>Добавить</Button>}
      </div>
      <p className="muted">Распределение задач учитывает допуски (кто может выполнять работу), специализацию, текущую загрузку и средний коэффициент времени: 1,0 — работает по норме, 1,2 — на 20 % дольше. По мере закрытия работ коэффициент по каждой категории уточняется по факту.</p>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : !data?.length ? <Empty icon={Users} title="Сотрудников нет" /> : (
        <div className="table-wrap card">
          <table className="table table-click">
            <thead><tr><th>Сотрудник</th><th>Квалификация</th><th>Специализация</th><th>Уровень</th><th>Коэфф. времени</th><th>Текущие задачи</th><th>Доступы</th></tr></thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id} className={e.active ? '' : 'dim'} onClick={() => setOpen(e)}>
                  <td><b>{e.name}</b><div className="muted small">{e.position}</div></td>
                  <td className="small">{e.qualification || '—'}</td>
                  <td>{e.specializations.map((s) => <Badge key={s}>{s}</Badge>)}</td>
                  <td>{LEVELS[e.level]}</td>
                  <td>{e.speed_factor}</td>
                  <td>{e.open_tasks} <span className="muted small">({hours(e.open_hours)})</span></td>
                  <td className="small">{e.is_external ? 'сторонний сервис' : e.general_access ? `общий допуск${e.access_count ? ` + ${e.access_count} спец.` : ''}` : `${e.access_count} работ`}{!e.active && <Badge>неактивен</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <EmployeeDialog id={open.id} canWrite={canWrite} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); reload(); }} />}
    </div>
  );
}

function EmployeeDialog({ id, canWrite, onClose, onSaved }) {
  const emp = useLoad(() => (id ? api.get(`/employees/${id}`) : Promise.resolve(null)), [id]);
  const works = useLoad(() => api.get('/work-types'));
  const [tab, setTab] = useState('main');
  const [f, setF] = useState(null);
  const [run, busy] = useAction();
  const cats = useMemo(() => [...new Set((works.data || []).map((w) => w.category))], [works.data]);

  if (id && !emp.data) return <Modal title="Сотрудник" onClose={onClose}><Spinner /></Modal>;
  const e = emp.data;
  const form = f || {
    name: e?.name || '', position: e?.position || '', qualification: e?.qualification || '', phone: e?.phone || '',
    level: e?.level || 2, speed_factor: e?.speed_factor || 1, specializations: e?.specializations || [],
    general_access: e ? !!e.general_access : true, is_external: !!e?.is_external, active: e ? !!e.active : true, access: e?.access || [],
  };
  const set = (k, v) => setF({ ...form, [k]: v });
  const restricted = (works.data || []).filter((w) => !w.access_all || w.external || w.required_qualification);

  const save = () => run(async () => {
    const r = id ? await api.put(`/employees/${id}`, form) : await api.post('/employees', form);
    onSaved(); return r;
  }, 'Сохранено');

  return (
    <Modal title={id ? e.name : 'Новый сотрудник'} onClose={onClose} wide footer={<>
      {id && canWrite && <Button variant="ghost" onClick={() => run(async () => { const r = await api.del(`/employees/${id}`); onSaved(); return r; }, 'Готово')}>Удалить</Button>}
      <span className="grow" />
      <Button onClick={onClose}>Закрыть</Button>
      {canWrite && <Button variant="primary" loading={busy} onClick={save}>Сохранить</Button>}
    </>}>
      <Tabs value={tab} onChange={setTab} items={[
        { value: 'main', label: 'Данные' },
        { value: 'access', label: 'Доступы', count: form.access.length },
        ...(id ? [{ value: 'tasks', label: 'Текущие задачи', count: e.current_tasks.length }, { value: 'stats', label: 'Статистика' }] : []),
      ]} />
      {tab === 'main' && (
        <div className="form-grid">
          <Field label="Имя / фамилия"><input className="input" value={form.name} onChange={(x) => set('name', x.target.value)} disabled={!canWrite} /></Field>
          <Field label="Должность"><input className="input" value={form.position} onChange={(x) => set('position', x.target.value)} disabled={!canWrite} /></Field>
          <Field label="Квалификация" hint="Для работ с особым допуском (напр. «токарь») ищется здесь" className="span-2"><input className="input" value={form.qualification} onChange={(x) => set('qualification', x.target.value)} disabled={!canWrite} /></Field>
          <Field label="Уровень">
            <select className="input" value={form.level} onChange={(x) => set('level', Number(x.target.value))} disabled={!canWrite}>
              {Object.entries(LEVELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Средний коэффициент времени" hint="Факт / норма; используется, пока нет статистики">
            <input className="input" type="number" step="0.05" min="0.3" max="3" value={form.speed_factor} onChange={(x) => set('speed_factor', x.target.value)} disabled={!canWrite} />
          </Field>
          <Field label="Телефон"><input className="input" value={form.phone} onChange={(x) => set('phone', x.target.value)} disabled={!canWrite} /></Field>
          <div className="span-2">
            <div className="field-label">Специализация (профильные категории — приоритет при распределении)</div>
            <div className="chips">
              {cats.map((c) => (
                <button type="button" key={c} disabled={!canWrite} className={cx('chip', form.specializations.includes(c) && 'on')}
                  onClick={() => set('specializations', form.specializations.includes(c) ? form.specializations.filter((x) => x !== c) : [...form.specializations, c])}>{c}</button>
              ))}
            </div>
          </div>
          <label className="check"><input type="checkbox" checked={form.general_access} onChange={(x) => set('general_access', x.target.checked)} disabled={!canWrite} /> Допущен к работам с допуском «Все»</label>
          <label className="check"><input type="checkbox" checked={form.is_external} onChange={(x) => set('is_external', x.target.checked)} disabled={!canWrite} /> Сторонний сервис (без ограничения загрузки)</label>
          <label className="check"><input type="checkbox" checked={form.active} onChange={(x) => set('active', x.target.checked)} disabled={!canWrite} /> Активен</label>
        </div>
      )}
      {tab === 'access' && (
        <>
          <p className="small muted">Работы с ограниченным допуском. Отметьте, какие из них может выполнять сотрудник. Работы с допуском «Все» доступны всем, у кого включён общий допуск.</p>
          {cats.map((c) => {
            const list = restricted.filter((w) => w.category === c);
            if (!list.length) return null;
            return (
              <div key={c} className="access-group">
                <div className="group-head">{c}</div>
                {list.map((w) => (
                  <label key={w.id} className="check">
                    <input type="checkbox" disabled={!canWrite} checked={form.access.includes(w.id)}
                      onChange={() => set('access', form.access.includes(w.id) ? form.access.filter((x) => x !== w.id) : [...form.access, w.id])} />
                    {w.name} {w.external ? <Badge>сервис</Badge> : null}{w.required_qualification ? <Badge>{w.required_qualification}</Badge> : null}
                  </label>
                ))}
              </div>
            );
          })}
        </>
      )}
      {tab === 'tasks' && (e.current_tasks.length === 0 ? <Empty title="Нет открытых задач" /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Начало</th><th>Работа</th><th>ТС</th><th>Пр.</th><th>Статус</th></tr></thead>
          <tbody>{e.current_tasks.map((t) => (
            <tr key={t.id}><td className="nowrap">{fmtShort(t.start_at)}</td><td><Link to={`/orders/${t.order_id}`} onClick={onClose}>{t.description}</Link></td>
              <td>{plate(t.plate)}</td><td><Badge tone={PRIORITY[t.priority].tone}>{PRIORITY[t.priority].short}</Badge></td>
              <td><Badge tone={TASK_STATUS[t.status].tone}>{TASK_STATUS[t.status].label}</Badge></td></tr>
          ))}</tbody>
        </table></div>
      ))}
      {tab === 'stats' && (
        <>
          <div className="stats">
            <div className="stat"><div className="stat-label">Выполнено работ</div><div className="stat-value">{e.totals.tasks}</div></div>
            <div className="stat"><div className="stat-label">Норма / факт</div><div className="stat-value">{hours(e.totals.norm_hours)} / {hours(e.totals.actual_hours)}</div></div>
            <div className="stat"><div className="stat-label">Начислено ЗП</div><div className="stat-value">{money(e.totals.salary)}</div></div>
          </div>
          {e.speed_by_category.length === 0 ? <p className="muted">Статистики по категориям пока нет.</p> : (
            <table className="table"><thead><tr><th>Категория</th><th>Работ</th><th>Факт / норма</th></tr></thead>
              <tbody>{e.speed_by_category.map((s) => <tr key={s.category}><td>{s.category}</td><td>{s.tasks}</td><td>{s.factor}{s.tasks < 3 && <span className="muted small"> (мало данных, не учитывается)</span>}</td></tr>)}</tbody>
            </table>
          )}
        </>
      )}
    </Modal>
  );
}
