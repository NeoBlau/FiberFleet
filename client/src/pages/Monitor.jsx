import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Maximize2, ChevronLeft, ChevronRight, RefreshCw, Pencil, Lock } from 'lucide-react';
import * as api from '../api.js';
import { can, useApp } from '../App.jsx';
import { addDays, dayStartIso, fmtDate, fmtDateTime, fmtTime, inputToIso, isoToInput, isoToDateInput, dateToIso, weekday, plate, PRIORITY, TASK_STATUS, VEH } from '../format.js';
import { Button, ErrorBox, Field, Modal, Spinner, cx, useAction, useLoad } from '../ui/kit.jsx';

export default function Monitor() {
  const { user } = useApp();
  const [date,setDate]=useState(()=>isoToDateInput(dayStartIso(new Date())));
  const [days,setDays]=useState(3);
  const [editing,setEditing]=useState(false);
  const [edit,setEdit]=useState(null);
  const [result,setResult]=useState(null);
  const {data,error,reload}=useLoad(()=>api.get(`/schedule/monitor${api.qs({date,days})}`),[date,days]);
  const dash=useLoad(()=>api.get('/dashboard'));
  const [now,setNow]=useState(new Date());
  const [run,busy]=useAction();
  const canEdit=can(user,'plan.write')&&can(user,'tasks.reassign');
  useEffect(()=>{
    const t1=setInterval(()=>{reload(true);dash.reload(true);},30000);
    const t2=setInterval(()=>setNow(new Date()),1000);
    return()=>{clearInterval(t1);clearInterval(t2);};
  },[reload,dash.reload]);
  const refresh=()=>Promise.all([reload(true),dash.reload(true)]);
  const step=n=>setDate(addDays(date+'T12:00:00.000Z',n*days).slice(0,10));
  const full=()=>document.documentElement.requestFullscreen?.().catch(()=>{});
  const saved=async r=>{setEdit(null);setResult(r);await refresh();};
  return <div className="monitor">
    <header className="mon-head">
      <Link to="/schedule" className="mon-back" aria-label="К расписанию"><ArrowLeft size={18}/></Link>
      <img src="/icon.svg" alt="" width="28" height="28"/>
      <h1>FiberFleet · экран оператора</h1><span className="grow"/>
      {error&&<span className="mon-warn">нет связи — данные на {data?fmtTime(data.now):'—'}</span>}
      <span className="mon-clock">{now.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</span>
      <button className="mon-btn" onClick={full} title="Во весь экран"><Maximize2 size={18}/></button>
    </header>
    <div className="mon-toolbar">
      <Button icon={ChevronLeft} aria-label="Предыдущий период" onClick={()=>step(-1)}/>
      <input className="input" type="date" aria-label="Начальная дата" value={date} onChange={e=>e.target.value&&setDate(e.target.value)}/>
      <select className="input" aria-label="Период просмотра" value={days} onChange={e=>setDays(Number(e.target.value))}>
        <option value={1}>Один день</option><option value={3}>3 дня</option><option value={7}>Неделя</option><option value={14}>Две недели</option>
      </select>
      <Button icon={ChevronRight} aria-label="Следующий период" onClick={()=>step(1)}/>
      <Button onClick={()=>setDate(isoToDateInput(dayStartIso(new Date())))}>Сегодня</Button>
      <Button icon={RefreshCw} onClick={refresh}>Обновить</Button>
      {canEdit&&<Button icon={Pencil} variant={editing?'primary':'default'} onClick={()=>setEditing(v=>!v)}>{editing?'Закончить редактирование':'Редактировать расписание'}</Button>}
      {can(user,'plan.write')&&<Button loading={busy} icon={RefreshCw} onClick={()=>run(async()=>{const r=await api.post('/schedule/rebuild',{}, {offline:false});setResult({shifted_tasks:r.placed,warnings:r.unassigned.map(t=>({order_id:t.order_id,number:t.order_number,message:t.reason}))});await refresh();return r;},'Оставшиеся работы перепланированы')}>Пересчитать оставшиеся работы</Button>}
    </div>
    <p className="mon-help">Выбранный период: {data?.dates?.length?`${fmtDate(data.from)} — ${fmtDate(addDays(data.to,-1))}`:'…'}. Работа через несколько дней показана в каждом затронутом дне. {editing?'Нажмите на плановую работу для изменения. Выполняемые и завершённые работы доступны только для просмотра.':'Данные обновляются каждые 30 секунд.'}</p>
    {result&&<div className="mon-result" role="status">
      Изменено назначений: {result.shifted_tasks}. Ручные интервалы сохраняются при пересчёте.
      {!!result.warnings?.length&&<details><summary>Проверьте ограничения и сроки: {result.warnings.length}</summary>{result.warnings.map((w,i)=><p key={i}><Link to={`/orders/${w.order_id}`}>{w.number}</Link> · {w.message}</p>)}</details>}
    </div>}
    {!data?<div className="mon-help"><Spinner/></div>:<div className="mon-calendar-wrap">
      <table className="mon-calendar" style={{minWidth:180+data.dates.length*260}}><thead><tr><th>Сотрудник</th>{data.dates.map(d=><th key={d}>{weekday(dateToIso(d))}, {fmtDate(dateToIso(d))}</th>)}</tr></thead>
        <tbody>{data.board.map(e=><tr key={e.id}><th><b>{e.name}</b><div className="mon-pos">{e.position}</div>{e.overdue>0&&<div className="mon-overdue">Отставание: {e.overdue}</div>}</th>
          {e.days.map(day=><td key={day.date}><div className="mon-day-load">Плановая загрузка: {day.load}%</div>
            {!day.entries.length&&<div className="mon-empty">Нет назначенных работ</div>}
            {day.entries.map(x=><button type="button" key={x.task_id} className={cx('mon-slot',x.status==='in_progress'&&'running',x.locked&&'locked')}
              onClick={()=>editing&&x.status==='planned'?setEdit(x):null} disabled={!editing||x.status!=='planned'} aria-label={`${editing&&x.status==='planned'?'Изменить':'Просмотр'}: ${x.description}, ${e.name}, ${day.date}`}>
              <div className="mon-slot-time">{fmtDateTime(x.start_at)} — {fmtDateTime(x.end_at)}{!!x.locked&&<Lock size={13}/>}</div>
              <div className="mon-task">{x.description}</div><div>{VEH[x.vehicle_type]} {plate(x.plate)}</div>
              <div className="mon-slot-meta">{TASK_STATUS[x.status]?.label} · {PRIORITY[x.priority]?.label} · {x.order_number}</div>
              {editing&&x.status==='planned'&&<span className="mon-edit-label"><Pencil size={12}/> Изменить</span>}
            </button>)}
          </td>)}</tr>)}</tbody>
      </table>
    </div>}
    {dash.data&&<footer className="mon-foot">{dash.data.orders.map(o=><Link to={`/orders/${o.id}`} key={o.id} className={cx('mon-order',o.errors.length&&'err')}><b>{plate(o.tractor_plate||o.trailer_plate)}</b> {o.done}/{o.total}{o.planned_end?` · окончание ${fmtDateTime(o.planned_end)}`:''}{o.release_deadline?` · выпуск ${fmtDateTime(o.release_deadline)}`:''}</Link>)}</footer>}
    {edit&&<ManualScheduleDialog entry={edit} onClose={()=>setEdit(null)} onSaved={saved}/>}
  </div>;
}

function ManualScheduleDialog({entry,onClose,onSaved}) {
  const {data,error,reload}=useLoad(()=>api.get(`/schedule/tasks/${entry.task_id}/options`),[entry.task_id]);
  const [employee,setEmployee]=useState(entry.employee_id);
  const [start,setStart]=useState(isoToInput(entry.start_at));
  const [end,setEnd]=useState(isoToInput(entry.end_at));
  const [automatic,setAutomatic]=useState(true);
  const [priority,setPriority]=useState(entry.priority);
  const [run,busy]=useAction();
  const save=unlock=>run(async()=>{
    const body=unlock?{unlock:true}:{employee_id:Number(employee),start_at:inputToIso(start),...(automatic?{}:{end_at:inputToIso(end)}),priority:Number(priority)};
    body.version=entry.updated_at;
    const r=await api.put(`/schedule/tasks/${entry.task_id}`,body,{offline:false});
    await onSaved(r);return r;
  },unlock?'Работа возвращена в автопланирование':'Изменения сохранены, остальные работы пересчитаны');
  return <Modal title={`Расписание: ${entry.description}`} wide onClose={onClose} footer={<>
    {!!entry.locked&&<Button loading={busy} onClick={()=>save(true)}>Вернуть автопланирование</Button>}
    <span className="grow"/><Button onClick={onClose}>Закрыть</Button><Button loading={busy} variant="primary" disabled={!data||!!error||!employee||!start||(!automatic&&!end)} onClick={()=>save(false)}>Сохранить и пересчитать</Button>
  </>}>
    <ErrorBox error={error} onRetry={reload}/>
    <p>{plate(entry.plate)} · ремонт {entry.order_number}</p>
    <p className="small muted">Меняется назначение в общем расписании. Норма, цена, зарплата и выполненные работы сохраняются. Незакреплённые работы будут перестроены; ручной интервал останется зафиксированным.</p>
    {!data?(error?null:<Spinner/>):<div className="form-grid">
      <Field label="Слесарь" hint="Только активные сотрудники с допуском"><select className="input" value={employee} onChange={e=>setEmployee(e.target.value)}><option value="">Выберите сотрудника</option>{data.employees.map(e=><option key={e.id} value={e.id}>{e.name} · {e.position}</option>)}</select></Field>
      <Field label="Приоритет"><select className="input" value={priority} onChange={e=>setPriority(e.target.value)}>{Object.entries(PRIORITY).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select></Field>
      <Field label="Начало"><input className="input" type="datetime-local" value={start} onChange={e=>setStart(e.target.value)}/></Field>
      <Field label="Окончание" hint={automatic?'Рассчитается при сохранении по оставшейся норме и рабочему календарю':'Ручная оценка интервала; норма работы не меняется'}><input className="input" type="datetime-local" disabled={automatic} value={end} onChange={e=>setEnd(e.target.value)}/></Field>
      <label className="check span-2"><input type="checkbox" checked={automatic} onChange={e=>setAutomatic(e.target.checked)}/> Рассчитать окончание по оставшейся норме</label>
    </div>}
  </Modal>;
}
