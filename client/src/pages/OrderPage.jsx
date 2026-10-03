import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, RefreshCw, CheckCircle2, FileText, Ban, Plus, Play, Pause, Check, Trash2, MapPin, AlertTriangle, Lightbulb, Package, Lock, Unlock, Pencil,
} from 'lucide-react';
import * as api from '../api.js';
import { can, useApp } from '../App.jsx';
import {
  fmtDateTime, fmtShort, hours, inputToIso, isoToInput, km, money, ORDER_STATUS, plate, PRIORITY, SOURCE, TASK_STATUS, VEH,
} from '../format.js';
import { Badge, Button, Card, Confirm, cx, Empty, ErrorBox, Field, Modal, SearchSelect, Spinner, Stat, useAction, useLoad } from '../ui/kit.jsx';

export default function OrderPage() {
  const { id } = useParams();
  const { user } = useApp();
  const nav = useNavigate();
  const { data: o, loading, error, reload, setData } = useLoad(() => api.get(`/orders/${id}`), [id]);
  const employees = useLoad(() => (can(user, 'employees.read') || can(user, 'tasks.status') ? api.get('/employees') : Promise.resolve([])));
  const [run, busy] = useAction();
  const [taskEdit, setTaskEdit] = useState(null);
  const [addWork, setAddWork] = useState(false);
  const [addPart, setAddPart] = useState(null);
  const [done, setDone] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [editHead, setEditHead] = useState(false);

  const apply = (r) => { if (r && r.id) setData(r); else if (r?.queued) reload(true); return r; };
  const act = (fn, ok) => run(async () => apply(await fn()), ok);

  const byVehicle = useMemo(() => {
    if (!o) return [];
    const g = [];
    for (const vt of ['tractor', 'trailer']) {
      const list = o.tasks.filter((t) => t.vehicle_type === vt);
      if (list.length) g.push({ vt, list });
    }
    return g;
  }, [o]);

  if (loading && !o) return <Spinner />;
  if (error && !o) return <ErrorBox error={error} onRetry={reload} />;

  const closed = ['done', 'cancelled'].includes(o.status);
  const canPlan = can(user, 'plan.write') && !closed;
  const canStatus = can(user, 'tasks.status');
  const canReassign = can(user, 'tasks.reassign');
  const live = o.tasks.filter((t) => t.status !== 'cancelled');
  const totalH = live.reduce((a, t) => a + (t.hours || 0), 0);
  const totalP = live.reduce((a, t) => a + (t.price || 0), 0);
  const partsSum = o.parts.reduce((a, p) => a + (p.price || 0) * p.qty, 0);
  const plannedEnd = live.map((t) => t.end_at).filter(Boolean).sort().pop();
  const zones = o.inspection?.zones || [];
  const recs = o.inspection?.recommendations || [];

  const setStatus = (t, status, extra = {}) => act(() => api.post(`/tasks/${t.id}/status`, { status, ...extra }, { label: `${t.description}: ${TASK_STATUS[status].label}` }), `${TASK_STATUS[status].label}`);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Link to="/orders" className="back"><ArrowLeft size={16} /> Ремонты</Link>
          <h1>Ремонт {o.number} <Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge></h1>
          <div className="muted">
            {o.tractor_id && <Link to={`/vehicles/tractor/${o.tractor_id}`}>Тягач {plate(o.tractor_plate)}</Link>}
            {o.tractor_id && <> {o.tractor_brand} {o.tractor_model}</>}
            {o.trailer_id && <>{o.tractor_id ? ' + ' : ''}<Link to={`/vehicles/trailer/${o.trailer_id}`}>прицеп {plate(o.trailer_plate)}</Link></>}
            {' · '}дефектовка {fmtDateTime(o.inspected_at)}{o.created_by_name ? `, ${o.created_by_name}` : ''}
          </div>
        </div>
        <div className="row gap-s wrap">
          {canPlan && <Button icon={RefreshCw} loading={busy} onClick={() => act(() => api.post(`/orders/${o.id}/replan`, {}), 'Расписание пересчитано')}>Пересчитать</Button>}
          {canPlan && ['planned', 'plan_error'].includes(o.status) && (
            <Button variant="primary" icon={CheckCircle2} loading={busy} disabled={o.plan_errors.length > 0}
              title={o.plan_errors.length ? 'Сначала устраните ошибки планирования' : ''}
              onClick={() => act(() => api.post(`/orders/${o.id}/approve`, {}), 'План утверждён')}>Утвердить план</Button>
          )}
          <Button icon={FileText} onClick={() => api.openPdf(`/orders/${o.id}/pdf?inline=1`).catch((e) => alert(e.message))}>Заказ-наряд PDF</Button>
          {can(user, 'orders.write') && !closed && <Button variant="ghost" icon={Ban} onClick={() => setConfirm('cancel')}>Отменить</Button>}
          {can(user, 'orders.delete') && <Button variant="ghost" icon={Trash2} onClick={() => setConfirm('delete')}>Удалить</Button>}
        </div>
      </div>

      {o.plan_errors.length > 0 && (
        <div className="alert alert-red block">
          <div className="row gap-s"><AlertTriangle size={18} /><b>Планирование невозможно — исправьте план ({o.plan_errors.length}):</b></div>
          <ul>{o.plan_errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>
          <div className="small">Измените срок, приоритет или исполнителя работы (нажмите на строку), либо дату выпуска ТС.</div>
        </div>
      )}

      <div className="stats">
        <Stat label="Работ" value={`${live.filter((t) => t.status === 'done').length} / ${live.length}`} hint={`${hours(totalH)} по норме`} />
        <Stat label="Окончание по расписанию" value={plannedEnd ? fmtShort(plannedEnd) : '—'} tone={o.release_deadline && plannedEnd > o.release_deadline ? 'red' : undefined} />
        <Stat label="Выпуск с ремонта" value={o.release_deadline ? fmtShort(o.release_deadline) : 'не задан'}
          hint={can(user, 'orders.write') && !closed ? <button className="link" onClick={() => setEditHead(true)}>изменить</button> : null} />
        <Stat label="Стоимость" value={money(totalP + partsSum)} hint={`работы ${money(totalP)} · запчасти ${money(partsSum)}`} />
      </div>

      {(zones.length > 0 || recs.length > 0) && (
        <Card title="Куда смотреть — зоны осмотра и связанные проверки">
          <div className="zones-grid">
            {zones.map((z) => (
              <div key={z.item} className="zone-card">
                <div className="row between"><b>{z.label}</b><Badge tone={PRIORITY[z.priority].tone}>{PRIORITY[z.priority].short}</Badge></div>
                <div className="small muted">{z.section}{z.value != null && z.value !== '' ? ` · замер ${z.value} ${z.unit || ''}` : ''}</div>
                <div className="zone"><MapPin size={14} /> {z.zone_text}</div>
                {z.checks?.length > 0 && <div className="small">Проверить также: {z.checks.join('; ')}</div>}
                {z.related_labels?.length > 0 && <div className="small muted">Связанные пункты: {z.related_labels.join(', ')}</div>}
                {z.comment && <div className="small">Комментарий: {z.comment}</div>}
              </div>
            ))}
          </div>
          {recs.map((r, i) => <div key={i} className="text-amber small"><Lightbulb size={13} /> {r.text}</div>)}
          {(o.inspection?.damages || []).length > 0 && (
            <div className="small" style={{ marginTop: 8 }}><b>Повреждения при приёмке:</b> {o.inspection.damages.map((d) => `${d.label}: ${d.zones.join(', ')}${d.comment ? ` (${d.comment})` : ''}`).join('; ')}</div>
          )}
        </Card>
      )}

      <Card title="План ремонта" pad={false} actions={canPlan && <Button size="sm" icon={Plus} onClick={() => setAddWork(true)}>Добавить работу</Button>}>
        {o.tasks.length === 0 ? <Empty title="Работ нет">Добавьте работы из справочника</Empty> : byVehicle.map(({ vt, list }) => (
          <div key={vt}>
            <div className="group-head">{VEH[vt]} {plate(vt === 'tractor' ? o.tractor_plate : o.trailer_plate)}</div>
            <div className="table-wrap">
              <table className="table tasks-table">
                <thead><tr><th>Пр.</th><th>Работа</th><th>Исполнитель</th><th>Время по расписанию</th><th>Срок</th><th>Норма</th><th>Цена</th><th>Статус</th><th /></tr></thead>
                <tbody>
                  {list.map((t) => {
                    const late = t.end_at && t.deadline && t.end_at > t.deadline && !['done', 'cancelled'].includes(t.status);
                    const err = o.plan_errors.some((e) => e.task_id === t.id);
                    return (
                      <tr key={t.id} className={cx(t.status === 'cancelled' && 'dim', err && 'row-err')}>
                        <td data-l="Приоритет"><Badge tone={PRIORITY[t.priority].tone} title={PRIORITY[t.priority].label}>{PRIORITY[t.priority].short}</Badge></td>
                        <td data-l="Работа">
                          <button className="linklike" onClick={() => setTaskEdit(t)}><b>{t.description}</b></button>
                          <div className="small muted">{t.location ? `${t.location} · ` : ''}{SOURCE[t.source]}{t.seq === 0 ? ' · сначала' : t.seq === 1 ? ' · осмотр до ремонта' : t.seq === 3 ? ' · после ремонта' : ''}</div>
                          {t.reason && <div className="small muted reason">{t.reason}</div>}
                          {t.comment && <div className="small">💬 {t.comment}</div>}
                        </td>
                        <td data-l="Исполнитель">{t.employee_name || <span className="text-red">не назначен</span>}{t.assigned_manual ? <span title="Назначен вручную"> <Lock size={12} /></span> : null}</td>
                        <td data-l="Время" className="nowrap">{t.start_at ? <>{fmtShort(t.start_at)} – {fmtShort(t.end_at).slice(6)}</> : '—'}{t.locked ? <span title="Зафиксировано"> <Lock size={12} /></span> : null}</td>
                        <td data-l="Срок" className={cx('nowrap', late && 'text-red')}>{fmtShort(t.deadline)}{t.deadline_manual ? ' ✎' : ''}</td>
                        <td data-l="Норма" className="nowrap">{hours(t.hours)}{t.actual_hours ? <div className="small muted">факт {hours(t.actual_hours)}</div> : null}</td>
                        <td data-l="Цена" className="nowrap">{money(t.price)}</td>
                        <td data-l="Статус"><Badge tone={TASK_STATUS[t.status].tone}>{TASK_STATUS[t.status].label}</Badge></td>
                        <td className="nowrap actions">
                          {canStatus && t.status === 'planned' && <Button size="sm" icon={Play} title="Начать" onClick={() => setStatus(t, 'in_progress')} />}
                          {canStatus && t.status === 'in_progress' && <Button size="sm" icon={Pause} title="Пауза" onClick={() => setStatus(t, 'paused')} />}
                          {canStatus && t.status === 'paused' && <Button size="sm" icon={Play} title="Продолжить" onClick={() => setStatus(t, 'in_progress')} />}
                          {canStatus && ['planned', 'in_progress', 'paused'].includes(t.status) && <Button size="sm" variant="success" icon={Check} title="Выполнено" onClick={() => setDone(t)} />}
                          {can(user, 'parts.write') && t.status !== 'cancelled' && <Button size="sm" icon={Package} title="Запчасть" onClick={() => setAddPart({ task_id: t.id })} />}
                          <Button size="sm" variant="ghost" icon={Pencil} title="Подробнее" onClick={() => setTaskEdit(t)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </Card>

      <Card title="Установленные запчасти" pad={false} actions={can(user, 'parts.write') && !closed && <Button size="sm" icon={Plus} onClick={() => setAddPart({})}>Добавить</Button>}>
        {o.parts.length === 0 ? <Empty icon={Package} title="Запчасти не добавлены" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Код 1С</th><th>Артикул</th><th>Наименование</th><th>Работа</th><th>Кол-во</th><th>Цена</th><th>Сумма</th><th>1С</th><th /></tr></thead>
              <tbody>
                {o.parts.map((p) => (
                  <tr key={p.id}>
                    <td>{p.code || '—'}</td><td>{p.article || '—'}</td><td>{p.name}</td>
                    <td className="small">{o.tasks.find((t) => t.id === p.task_id)?.description || '—'}</td>
                    <td>{p.qty} {p.unit}</td><td>{money(p.price)}</td><td>{money((p.price || 0) * p.qty)}</td>
                    <td>{p.exported_at ? <Badge tone="green">выгружено</Badge> : <Badge>нет</Badge>}</td>
                    <td>{can(user, 'parts.write') && !p.exported_at && <button className="icon-btn" aria-label="Удалить" onClick={() => act(() => api.del(`/installed-parts/${p.id}`), 'Удалено')}><Trash2 size={15} /></button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {o.notes && <Card title="Примечание"><p>{o.notes}</p></Card>}

      {taskEdit && (
        <TaskDialog task={o.tasks.find((t) => t.id === taskEdit.id) || taskEdit} order={o} employees={employees.data || []}
          canPlan={canPlan} canReassign={canReassign && !closed} canStatus={canStatus}
          onClose={() => setTaskEdit(null)}
          onSave={(patch) => act(() => api.put(`/tasks/${taskEdit.id}`, patch, { label: `Изменение работы «${taskEdit.description}»` }), 'Сохранено')}
          onDelete={() => act(async () => { const r = await api.del(`/tasks/${taskEdit.id}`); setTaskEdit(null); return r; }, 'Работа удалена')}
          onStatus={(s) => setStatus(taskEdit, s)} />
      )}
      {addWork && <AddWorkDialog order={o} onClose={() => setAddWork(false)} onAdd={(b) => act(async () => { const r = await api.post(`/orders/${o.id}/tasks`, b, { label: 'Добавление работы' }); setAddWork(false); return r; }, 'Работа добавлена')} />}
      {addPart && <AddPartDialog order={o} initial={addPart} onClose={() => setAddPart(null)} onAdd={(b) => act(async () => { const r = await api.post(`/orders/${o.id}/parts`, b, { label: `Запчасть: ${b.name || ''}` }); setAddPart(null); return r; }, 'Запчасть добавлена')} />}
      {done && <DoneDialog task={done} order={o} employees={employees.data || []} onClose={() => setDone(null)} onDone={(b) => { setStatus(done, 'done', b); setDone(null); }} />}
      {editHead && <HeadDialog order={o} onClose={() => setEditHead(false)} onSave={(b) => act(async () => { const r = await api.put(`/orders/${o.id}`, b); setEditHead(false); return r; }, 'Сохранено')} />}
      {confirm === 'cancel' && <Confirm title="Отменить ремонт?" danger confirmText="Отменить ремонт" text="Все невыполненные работы будут отменены и сняты с расписания." onClose={() => setConfirm(null)} onConfirm={() => act(() => api.post(`/orders/${o.id}/cancel`, {}), 'Ремонт отменён')} />}
      {confirm === 'delete' && <Confirm title="Удалить ремонт безвозвратно?" danger confirmText="Удалить" text="Будут удалены ремонт, его работы и расписание. История по ТС потеряется." onClose={() => setConfirm(null)} onConfirm={() => run(async () => { const r = await api.del(`/orders/${o.id}`); nav('/orders'); return r; }, 'Удалено')} />}
    </div>
  );
}

function TaskDialog({ task: t, order, employees, canPlan, canReassign, canStatus, onClose, onSave, onDelete, onStatus }) {
  const editable = canPlan && !['done', 'cancelled'].includes(t.status);
  const [f, setF] = useState({
    priority: t.priority, deadline: isoToInput(t.deadline), hours: t.hours, description: t.description, location: t.location || '',
    comment: t.comment || '', price: t.price ?? '', salary: t.salary ?? '', seq: t.seq,
  });
  const [emp, setEmp] = useState(t.employee_id);
  const [start, setStart] = useState(isoToInput(t.start_at));
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = () => {
    const patch = {};
    if (Number(f.priority) !== t.priority) patch.priority = Number(f.priority);
    if (inputToIso(f.deadline) !== t.deadline) patch.deadline = inputToIso(f.deadline);
    if (Number(f.hours) !== t.hours) patch.hours = Number(f.hours);
    if (f.description !== t.description) patch.description = f.description;
    if ((f.location || null) !== (t.location || null)) patch.location = f.location;
    if ((f.comment || null) !== (t.comment || null)) patch.comment = f.comment;
    if (String(f.price) !== String(t.price ?? '')) patch.price = f.price;
    if (String(f.salary) !== String(t.salary ?? '')) patch.salary = f.salary;
    if (Number(f.seq) !== t.seq) patch.seq = Number(f.seq);
    if (canReassign && emp !== t.employee_id) patch.employee_id = emp;
    if (canReassign && start && inputToIso(start) !== t.start_at) patch.start_at = inputToIso(start);
    if (!Object.keys(patch).length) return onClose();
    onSave(patch);
    onClose();
  };
  return (
    <Modal title={t.description} onClose={onClose} wide footer={<>
      {canPlan && !['done', 'in_progress'].includes(t.status) && <Button variant="ghost" icon={Trash2} onClick={onDelete}>Удалить</Button>}
      <span className="grow" />
      {canStatus && t.status === 'cancelled' && <Button onClick={() => { onStatus('planned'); onClose(); }}>Вернуть в план</Button>}
      {canStatus && ['planned', 'paused'].includes(t.status) && <Button variant="ghost" onClick={() => { onStatus('cancelled'); onClose(); }}>Отменить работу</Button>}
      {canStatus && t.status === 'done' && <Button onClick={() => { onStatus('in_progress'); onClose(); }}>Вернуть в работу</Button>}
      <Button onClick={onClose}>Закрыть</Button>
      {(editable || canReassign) && <Button variant="primary" onClick={save}>Сохранить</Button>}
    </>}>
      <div className="row gap-s wrap" style={{ marginBottom: 12 }}>
        <Badge tone={TASK_STATUS[t.status].tone}>{TASK_STATUS[t.status].label}</Badge>
        <Badge>{SOURCE[t.source]}</Badge>
        {t.category && <Badge>{t.category}</Badge>}
        <span className="muted small">{VEH[t.vehicle_type]} · пробег {km(t.mileage)} · зарегистрирована {fmtDateTime(t.registered_at)}</span>
      </div>
      {t.reason && <p className="small muted">{t.reason}</p>}
      <div className="form-grid">
        <Field label="Приоритет">
          <select className="input" value={f.priority} onChange={set('priority')} disabled={!editable}>
            {[1, 2, 3, 4].map((p) => <option key={p} value={p}>{p} — {PRIORITY[p].label}</option>)}
          </select>
        </Field>
        <Field label="Срок выполнения"><input className="input" type="datetime-local" value={f.deadline} onChange={set('deadline')} disabled={!editable} /></Field>
        <Field label="Описание" className="span-2"><input className="input" value={f.description} onChange={set('description')} disabled={!editable} /></Field>
        <Field label="Узел / позиция"><input className="input" value={f.location} onChange={set('location')} disabled={!editable} /></Field>
        <Field label="Очерёдность">
          <select className="input" value={f.seq} onChange={set('seq')} disabled={!editable}>
            <option value={0}>0 — мойка (в первую очередь)</option>
            <option value={1}>1 — осмотр / диагностика</option>
            <option value={2}>2 — ремонт</option>
            <option value={3}>3 — регулировки после ремонта</option>
          </select>
        </Field>
        <Field label="Норма, ч"><input className="input" type="number" step="0.05" value={f.hours} onChange={set('hours')} disabled={!editable} /></Field>
        <Field label="Цена, ₽"><input className="input" type="number" value={f.price} onChange={set('price')} disabled={!editable} /></Field>
        <Field label="ЗП, ₽"><input className="input" type="number" value={f.salary} onChange={set('salary')} disabled={!editable} /></Field>
        <Field label="Комментарий" className="span-2"><input className="input" value={f.comment} onChange={set('comment')} disabled={!canPlan} /></Field>
      </div>
      <h4>Исполнитель и время</h4>
      <p className="small muted">По расписанию: {t.start_at ? `${fmtDateTime(t.start_at)} – ${fmtDateTime(t.end_at)}` : 'не поставлена'}{t.assigned_manual ? ' · исполнитель назначен вручную' : ' · назначено автоматически'}{t.locked ? ' · время зафиксировано' : ''}</p>
      {canReassign ? (
        <div className="form-grid">
          <Field label="Исполнитель" hint="Ручное назначение имеет приоритет над автоматическим">
            <SearchSelect value={emp} onChange={setEmp} clearable placeholder="Автоматически"
              options={employees.filter((e) => e.active).map((e) => ({ value: e.id, label: `${e.name}${e.position ? ` — ${e.position}` : ''}` }))} />
          </Field>
          <Field label="Начало (зафиксировать)" hint="Пусто — время подберёт планировщик">
            <div className="row gap-s">
              <input className="input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
              {t.locked ? <Button icon={Unlock} title="Снять фиксацию" onClick={() => { onSave({ unlock: true }); onClose(); }} /> : null}
            </div>
          </Field>
        </div>
      ) : <p className="small muted">Переназначать исполнителя может администратор.</p>}
      {order.parts.filter((p) => p.task_id === t.id).length > 0 && (
        <>
          <h4>Запчасти по работе</h4>
          <ul className="list">{order.parts.filter((p) => p.task_id === t.id).map((p) => <li key={p.id}>{p.name} — {p.qty} {p.unit} × {money(p.price)}</li>)}</ul>
        </>
      )}
    </Modal>
  );
}

function AddWorkDialog({ order, onClose, onAdd }) {
  const works = useLoad(() => api.get('/work-types'));
  const [vt, setVt] = useState(order.tractor_id ? 'tractor' : 'trailer');
  const [wt, setWt] = useState(null);
  const [priority, setPriority] = useState(2);
  const [deadline, setDeadline] = useState('');
  const [location, setLocation] = useState('');
  const [comment, setComment] = useState('');
  const selected = (works.data || []).find((w) => w.id === wt);
  return (
    <Modal title="Добавить работу из справочника" onClose={onClose} footer={<>
      <Button onClick={onClose}>Отмена</Button>
      <Button variant="primary" disabled={!wt} onClick={() => onAdd({ work_type_id: wt, vehicle_type: vt, priority, deadline: inputToIso(deadline), location, comment })}>Добавить</Button>
    </>}>
      <div className="form-grid">
        <Field label="ТС">
          <select className="input" value={vt} onChange={(e) => setVt(e.target.value)}>
            {order.tractor_id && <option value="tractor">Тягач {plate(order.tractor_plate)}</option>}
            {order.trailer_id && <option value="trailer">Прицеп {plate(order.trailer_plate)}</option>}
          </select>
        </Field>
        <Field label="Приоритет">
          <select className="input" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
            {[1, 2, 3, 4].map((p) => <option key={p} value={p}>{p} — {PRIORITY[p].label}</option>)}
          </select>
        </Field>
        <Field label="Работа" className="span-2">
          <SearchSelect value={wt} onChange={setWt} groupBy="category" autoFocus placeholder="Выберите работу…"
            options={(works.data || []).filter((w) => w.applies_to === 'any' || w.applies_to === vt).map((w) => ({ value: w.id, label: w.name, category: w.category, search: w.code }))}
            render={(o) => o.label} />
        </Field>
        {selected && <div className="span-2 small muted">Норма {hours(selected.hours)} · {money(selected.price)} · допуск: {selected.access_all ? 'все' : selected.external ? 'сторонний сервис' : 'ограничен'}{selected.note ? ` · ${selected.note}` : ''}</div>}
        <Field label="Узел / позиция"><input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="напр. Ось 2, лев." /></Field>
        <Field label="Срок" hint="Пусто — по дате выпуска или приоритету"><input className="input" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></Field>
        <Field label="Комментарий" className="span-2"><input className="input" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function AddPartDialog({ order, initial, onClose, onAdd }) {
  const parts = useLoad(() => api.get('/parts?limit=2000'));
  const [partId, setPartId] = useState(null);
  const [f, setF] = useState({ task_id: initial.task_id || '', name: '', code: '', article: '', unit: 'шт', qty: 1, price: '', save_to_catalog: false });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const choose = (id, opt) => {
    setPartId(id);
    const p = (parts.data || []).find((x) => x.id === id);
    if (p) setF((s) => ({ ...s, name: p.name, code: p.code || '', article: p.article || '', unit: p.unit, price: p.price ?? '' }));
    else if (!opt) setF((s) => ({ ...s, name: '', code: '', article: '' }));
  };
  return (
    <Modal title="Установленная запчасть" onClose={onClose} footer={<>
      <Button onClick={onClose}>Отмена</Button>
      <Button variant="primary" disabled={!f.name || !(Number(f.qty) > 0)} onClick={() => onAdd({ ...f, part_id: partId, task_id: f.task_id || null })}>Добавить</Button>
    </>}>
      <Field label="Из номенклатуры (1С)" hint="Или заполните поля вручную ниже">
        <SearchSelect value={partId} onChange={choose} clearable placeholder="Поиск по названию, коду, артикулу"
          options={(parts.data || []).map((p) => ({ value: p.id, label: `${p.name}`, search: `${p.code || ''} ${p.article || ''}` }))}
          render={(o) => { const p = (parts.data || []).find((x) => x.id === o.value); return <>{o.label} <span className="muted small">{p?.article || ''} {p?.code ? `· ${p.code}` : ''}</span></>; }} />
      </Field>
      <div className="form-grid">
        <Field label="Наименование" className="span-2"><input className="input" value={f.name} onChange={set('name')} disabled={!!partId} /></Field>
        <Field label="Код 1С"><input className="input" value={f.code} onChange={set('code')} disabled={!!partId} /></Field>
        <Field label="Артикул"><input className="input" value={f.article} onChange={set('article')} disabled={!!partId} /></Field>
        <Field label="Количество"><input className="input" type="number" step="0.01" value={f.qty} onChange={set('qty')} /></Field>
        <Field label="Ед."><input className="input" value={f.unit} onChange={set('unit')} disabled={!!partId} /></Field>
        <Field label="Цена, ₽"><input className="input" type="number" value={f.price} onChange={set('price')} /></Field>
        <Field label="Работа">
          <select className="input" value={f.task_id} onChange={set('task_id')}>
            <option value="">— к ремонту в целом —</option>
            {order.tasks.filter((t) => t.status !== 'cancelled').map((t) => <option key={t.id} value={t.id}>{t.description}{t.location ? ` (${t.location})` : ''}</option>)}
          </select>
        </Field>
      </div>
      {!partId && <label className="check"><input type="checkbox" checked={f.save_to_catalog} onChange={set('save_to_catalog')} /> Добавить в номенклатуру</label>}
    </Modal>
  );
}

function DoneDialog({ task, order, employees, onClose, onDone }) {
  const [actual, setActual] = useState('');
  const [mileage, setMileage] = useState(task.vehicle_type === 'tractor' ? order.tractor_mileage ?? '' : order.trailer_mileage ?? '');
  const [comment, setComment] = useState(task.comment || '');
  const [emp, setEmp] = useState(task.employee_id);
  return (
    <Modal title={`Выполнено: ${task.description}`} onClose={onClose} footer={<>
      <Button onClick={onClose}>Отмена</Button>
      <Button variant="success" icon={Check} disabled={!emp} onClick={() => onDone({ actual_hours: actual === '' ? undefined : Number(actual), mileage: mileage === '' ? undefined : Number(mileage), comment, employee_id: emp !== task.employee_id ? emp : undefined })}>Отметить выполненной</Button>
    </>}>
      <div className="form-grid">
        <Field label="Исполнитель">
          <SearchSelect value={emp} onChange={setEmp} options={employees.filter((e) => e.active).map((e) => ({ value: e.id, label: e.name }))} />
        </Field>
        <Field label="Фактическое время, ч" hint={`Норма ${hours(task.hours)}. Пусто — посчитать по отметкам начала/окончания`}>
          <input className="input" type="number" step="0.1" value={actual} onChange={(e) => setActual(e.target.value)} />
        </Field>
        <Field label="Пробег на момент ремонта, км"><input className="input" type="number" value={mileage} onChange={(e) => setMileage(e.target.value)} /></Field>
        <Field label="Комментарий" className="span-2"><input className="input" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </div>
      <p className="small muted">Фактическое время уточняет средний коэффициент сотрудника — по нему считается длительность будущих работ.</p>
    </Modal>
  );
}

function HeadDialog({ order, onClose, onSave }) {
  const [release, setRelease] = useState(isoToInput(order.release_deadline));
  const [trM, setTrM] = useState(order.tractor_mileage ?? '');
  const [tlM, setTlM] = useState(order.trailer_mileage ?? '');
  const [notes, setNotes] = useState(order.notes || '');
  return (
    <Modal title={`Ремонт ${order.number}`} onClose={onClose} footer={<>
      <Button onClick={onClose}>Отмена</Button>
      <Button variant="primary" onClick={() => onSave({
        release_deadline: inputToIso(release),
        ...(order.tractor_id ? { tractor_mileage: trM === '' ? null : Number(trM) } : {}),
        ...(order.trailer_id ? { trailer_mileage: tlM === '' ? null : Number(tlM) } : {}),
        notes,
      })}>Сохранить</Button>
    </>}>
      <div className="form-grid">
        <Field label="Дата/время выпуска с ремонта" hint="Автоматические сроки работ пересчитаются"><input className="input" type="datetime-local" value={release} onChange={(e) => setRelease(e.target.value)} /></Field>
        {order.tractor_id && <Field label="Пробег тягача, км"><input className="input" type="number" value={trM} onChange={(e) => setTrM(e.target.value)} /></Field>}
        {order.trailer_id && <Field label="Пробег прицепа, км"><input className="input" type="number" value={tlM} onChange={(e) => setTlM(e.target.value)} /></Field>}
        <Field label="Примечание" className="span-2"><textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
