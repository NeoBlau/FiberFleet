import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, RefreshCw, MonitorPlay, CalendarDays } from 'lucide-react';
import * as api from '../api.js';
import { can, useApp } from '../App.jsx';
import { addDays, dayStartIso, weekStartIso, fmtDate, fmtTime, plate, PRIORITY, TASK_STATUS, VEH, weekday } from '../format.js';
import { Badge, Button, cx, Empty, ErrorBox, Spinner, Tabs, useAction, useLoad } from '../ui/kit.jsx';

const toMin = (hhmm) => { const [h, m] = String(hhmm || '08:00').split(':').map(Number); return h * 60 + (m || 0); };

export default function Schedule() {
  const { user, settings } = useApp();
  const nav = useNavigate();
  const [view, setView] = useState(() => (window.innerWidth < 760 ? 'list' : 'day'));
  const [day, setDay] = useState(() => dayStartIso(new Date()));
  const [emp, setEmp] = useState('');
  const span = view === 'week' ? 7 : view === 'list' ? 7 : 1;
  const from = view === 'week' ? weekStartIso(day) : day;
  const to = addDays(from, span);
  const { data, loading, error, reload } = useLoad(() => api.get(`/schedule${api.qs({ from, to, employee_id: emp })}`), [from, to, emp]);
  const [run, busy] = useAction();

  const ws = toMin(settings?.work_start), we = toMin(settings?.work_end);
  const offset = Number(settings?.tz_offset_min ?? 180);
  const minuteOfDay = (iso) => { const d = new Date(new Date(iso).getTime() + offset * 60000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

  const step = (n) => setDay((d) => addDays(d, n * (view === 'day' ? 1 : 7)));
  const isMech = user.role === 'mechanic';

  return (
    <div className="page">
      <div className="page-head">
        <h1>{isMech ? 'Мои задачи' : 'Расписание сотрудников'}</h1>
        <div className="row gap-s wrap">
          {can(user, 'plan.write') && <Button icon={RefreshCw} loading={busy} onClick={() => run(async () => { const r = await api.post('/schedule/rebuild', {}); reload(); return r; }, 'Расписание пересчитано с учётом текущих задач и приоритетов')}>Пересчитать</Button>}
          <Link to="/monitor"><Button icon={MonitorPlay}>Экран оператора</Button></Link>
        </div>
      </div>
      <div className="toolbar">
        <Tabs value={view} onChange={setView} items={[{ value: 'day', label: 'День' }, { value: 'week', label: 'Неделя' }, { value: 'list', label: 'Список' }]} />
        <div className="row gap-s">
          <Button icon={ChevronLeft} onClick={() => step(-1)} aria-label="Назад" />
          <Button icon={CalendarDays} onClick={() => setDay(dayStartIso(new Date()))}>Сегодня</Button>
          <Button icon={ChevronRight} onClick={() => step(1)} aria-label="Вперёд" />
          <b className="nowrap">{view === 'day' ? `${weekday(day)}, ${fmtDate(day)}` : `${fmtDate(from)} – ${fmtDate(addDays(to, -1))}`}</b>
        </div>
        {!isMech && data && (
          <select className="input w-auto" value={emp} onChange={(e) => setEmp(e.target.value)}>
            <option value="">Все сотрудники</option>
            {data.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        )}
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : !data ? null : view === 'day' ? (
        <DayGantt data={data} ws={ws} we={we} minuteOfDay={minuteOfDay} onOpen={(e) => nav(`/orders/${e.order_id}`)} />
      ) : view === 'week' ? (
        <Week data={data} from={from} onOpen={(e) => nav(`/orders/${e.order_id}`)} />
      ) : (
        <List data={data} />
      )}
      <div className="legend small muted">
        {Object.entries(TASK_STATUS).filter(([k]) => k !== 'cancelled').map(([k, v]) => <span key={k}><i className={`dot st-${k}`} /> {v.label}</span>)}
        <span><i className="dot pr-1" /> критично</span>
      </div>
    </div>
  );
}

function DayGantt({ data, ws, we, minuteOfDay, onOpen }) {
  const total = Math.max(60, we - ws);
  const hoursMarks = [];
  for (let m = Math.ceil(ws / 60) * 60; m <= we; m += 60) hoursMarks.push(m);
  const pos = (iso, clampEnd) => {
    let m = minuteOfDay(iso);
    if (clampEnd && m === 0) m = 24 * 60;
    return Math.min(100, Math.max(0, ((m - ws) / total) * 100));
  };
  const day0 = data.from;
  const day1 = data.to;
  if (!data.employees.length) return <Empty title="Нет сотрудников" />;
  return (
    <div className="gantt card">
      <div className="gantt-row gantt-head">
        <div className="gantt-name" />
        <div className="gantt-track">
          {hoursMarks.map((m) => <span key={m} className="gantt-hour" style={{ left: `${((m - ws) / total) * 100}%` }}>{String(m / 60).padStart(2, '0')}:00</span>)}
        </div>
      </div>
      {data.employees.map((e) => {
        const items = data.entries.filter((x) => x.employee_id === e.id);
        return (
          <div className="gantt-row" key={e.id}>
            <div className="gantt-name"><b>{e.name}</b><div className="muted small">{e.position}</div></div>
            <div className="gantt-track">
              {hoursMarks.map((m) => <span key={m} className="gantt-grid" style={{ left: `${((m - ws) / total) * 100}%` }} />)}
              {items.map((x) => {
                const l = x.start_at < day0 ? 0 : pos(x.start_at);
                const r = x.end_at > day1 ? 100 : pos(x.end_at, true);
                return (
                  <button key={x.id} className={cx('gbar', `st-${x.status}`, x.priority === 1 && 'pr-1')} style={{ left: `${l}%`, width: `${Math.max(1.5, r - l)}%` }}
                    title={`${x.description}\n${VEH[x.vehicle_type]} ${plate(x.plate)}${x.location ? ` · ${x.location}` : ''}\n${fmtTime(x.start_at)}–${fmtTime(x.end_at)} · ${x.order_number}`}
                    onClick={() => onOpen(x)}>
                    <span className="gbar-t">{plate(x.plate)} · {x.description}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Week({ data, from, onOpen }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  return (
    <div className="table-wrap card">
      <table className="table week">
        <thead><tr><th>Сотрудник</th>{days.map((d) => <th key={d}>{weekday(d)} {fmtDate(d).slice(0, 5)}</th>)}</tr></thead>
        <tbody>
          {data.employees.map((e) => (
            <tr key={e.id}>
              <td><b>{e.name}</b></td>
              {days.map((d) => {
                const end = addDays(d, 1);
                const items = data.entries.filter((x) => x.employee_id === e.id && x.start_at < end && x.end_at > d);
                return (
                  <td key={d} className="week-cell">
                    {items.map((x) => (
                      <button key={x.id} className={cx('wchip', `st-${x.status}`, x.priority === 1 && 'pr-1')} onClick={() => onOpen(x)} title={x.description}>
                        <span>{fmtTime(x.start_at < d ? d : x.start_at)}</span> {plate(x.plate)} · {x.description}
                      </button>
                    ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function List({ data }) {
  const groups = useMemo(() => {
    const m = new Map();
    for (const x of data.entries) {
      const k = fmtDate(x.start_at);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(x);
    }
    return [...m.entries()];
  }, [data]);
  if (!groups.length) return <Empty title="Задач на этот период нет" />;
  return groups.map(([d, list]) => (
    <div key={d} className="card">
      <div className="group-head">{weekday(list[0].start_at)}, {d}</div>
      <ul className="tasklist">
        {list.map((t) => (
          <li key={t.id}>
            <div className="tl-time">{fmtTime(t.start_at)}<br /><span className="muted">{fmtTime(t.end_at)}</span></div>
            <div className="tl-main">
              <div><Badge tone={PRIORITY[t.priority].tone}>{PRIORITY[t.priority].short}</Badge> <b>{t.description}</b></div>
              <div className="muted small">{VEH[t.vehicle_type]} {plate(t.plate)} {t.vehicle_name}{t.location ? ` · ${t.location}` : ''}</div>
              <div className="small"><Link to={`/orders/${t.order_id}`}>{t.order_number}</Link></div>
            </div>
            <div className="tl-side">
              <div>{t.employee_name}</div>
              <Badge tone={TASK_STATUS[t.status].tone}>{TASK_STATUS[t.status].label}</Badge>
            </div>
          </li>
        ))}
      </ul>
    </div>
  ));
}
