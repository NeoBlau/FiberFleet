import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Maximize2 } from 'lucide-react';
import * as api from '../api.js';
import { fmtTime, plate, PRIORITY, VEH } from '../format.js';
import { cx, useLoad } from '../ui/kit.jsx';

// Экран оператора: расписание всех сотрудников на мониторе, обновляется каждые 30 секунд
export default function Monitor() {
  const { data, error, reload } = useLoad(() => api.get('/schedule/monitor'));
  const dash = useLoad(() => api.get('/dashboard'));
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t1 = setInterval(() => { reload(true); dash.reload(true); }, 30000);
    const t2 = setInterval(() => setNow(new Date()), 1000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const full = () => document.documentElement.requestFullscreen?.().catch(() => {});

  return (
    <div className="monitor">
      <header className="mon-head">
        <Link to="/schedule" className="mon-back"><ArrowLeft size={18} /></Link>
        <img src="/icon.svg" alt="" width="28" height="28" />
        <h1>FiberFleet · расписание</h1>
        <span className="grow" />
        {error && <span className="mon-warn">нет связи — данные на {data ? fmtTime(data.now) : '—'}</span>}
        <span className="mon-clock">{now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
        <button className="mon-btn" onClick={full} title="Во весь экран"><Maximize2 size={18} /></button>
      </header>
      <div className="mon-grid">
        {(data?.board || []).map((e) => (
          <section key={e.id} className={cx('mon-card', e.current ? 'busy' : 'free', e.overdue > 0 && 'late')}>
            <div className="mon-name">
              <b>{e.name}</b>
              <span className="mon-load" title="Загрузка на сегодня">{e.load}%</span>
            </div>
            <div className="mon-pos">{e.position}</div>
            {e.current ? (
              <div className="mon-current">
                <div className="mon-label">{e.current.status === 'in_progress' ? 'Выполняет' : e.current.status === 'paused' ? 'Пауза' : 'По плану сейчас'}</div>
                <div className="mon-task">{e.current.description}</div>
                <div className="mon-veh">{VEH[e.current.vehicle_type]} <b>{plate(e.current.plate)}</b>{e.current.location ? ` · ${e.current.location}` : ''}</div>
                <div className="mon-time">{fmtTime(e.current.start_at)} – {fmtTime(e.current.end_at)}
                  <span className={`mon-pr pr${e.current.priority}`}>{PRIORITY[e.current.priority].label}</span></div>
              </div>
            ) : <div className="mon-current idle">Свободен</div>}
            {e.next.length > 0 && (
              <ul className="mon-next">
                {e.next.map((x) => (
                  <li key={x.id}>
                    <span className="mon-t">{fmtTime(x.start_at)}</span>
                    <span className="mon-d">{plate(x.plate)} · {x.description}</span>
                    {x.priority === 1 && <span className="mon-pr pr1">!</span>}
                  </li>
                ))}
              </ul>
            )}
            {e.overdue > 0 && <div className="mon-overdue">Отставание: {e.overdue}</div>}
          </section>
        ))}
      </div>
      {dash.data && (
        <footer className="mon-foot">
          {dash.data.orders.map((o) => (
            <span key={o.id} className={cx('mon-order', o.errors.length && 'err')}>
              <b>{plate(o.tractor_plate || o.trailer_plate)}</b> {o.done}/{o.total}
              {o.release_deadline ? ` · выпуск ${fmtTime(o.release_deadline)}` : ''}
            </span>
          ))}
        </footer>
      )}
    </div>
  );
}
