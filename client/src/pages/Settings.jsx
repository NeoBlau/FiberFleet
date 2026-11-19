import { useState } from 'react';
import { Plus, Download, Pencil } from 'lucide-react';
import * as api from '../api.js';
import { useApp } from '../App.jsx';
import { fmtDateTime, ROLES } from '../format.js';
import { Badge, Button, Card, ErrorBox, Field, Modal, SearchSelect, Spinner, Tabs, useAction, useLoad, useToast } from '../ui/kit.jsx';

const DAYS = [[1, 'Пн'], [2, 'Вт'], [3, 'Ср'], [4, 'Чт'], [5, 'Пт'], [6, 'Сб'], [7, 'Вс']];

export default function Settings() {
  const [tab, setTab] = useState('general');
  return (
    <div className="page">
      <div className="page-head"><h1>Настройки</h1></div>
      <Tabs value={tab} onChange={setTab} items={[
        { value: 'general', label: 'Рабочее время и планирование' },
        { value: 'users', label: 'Пользователи' },
        { value: 'audit', label: 'Журнал действий' },
        { value: 'backup', label: 'Резервная копия' },
      ]} />
      {tab === 'general' && <General />}
      {tab === 'users' && <UsersTab />}
      {tab === 'audit' && <Audit />}
      {tab === 'backup' && <Backup />}
    </div>
  );
}

function General() {
  const { settings, setSettings } = useApp();
  const [f, setF] = useState(() => ({ ...settings, holidays: (settings?.holidays || []).join(', ') }));
  const [run, busy] = useAction();
  if (!settings) return <Spinner />;
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = () => run(async () => {
    const body = {
      company: f.company, work_start: f.work_start, work_end: f.work_end, lunch_start: f.lunch_start, lunch_end: f.lunch_end,
      work_days: f.work_days, tz_offset_min: Number(f.tz_offset_min), max_workers_per_vehicle: Number(f.max_workers_per_vehicle),
      norm_hour_price: Number(f.norm_hour_price), salary_rate: Number(f.salary_rate),
      holidays: String(f.holidays || '').split(/[,\s]+/).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)),
    };
    const r = await api.put('/settings', body, { offline: false });
    setSettings(r);
    return r;
  }, 'Настройки сохранены, расписание пересчитано');
  return (
    <Card>
      <div className="form-grid form-grid-4">
        <Field label="Название организации" className="span-2"><input className="input" value={f.company} onChange={set('company')} /></Field>
        <Field label="Часовой пояс" hint="Смещение от UTC в минутах (Москва = 180)"><input className="input" type="number" value={f.tz_offset_min} onChange={set('tz_offset_min')} /></Field>
        <Field label="Человек на одном ТС одновременно" hint="0 — без ограничения"><input className="input" type="number" min="0" value={f.max_workers_per_vehicle} onChange={set('max_workers_per_vehicle')} /></Field>
        <Field label="Начало рабочего дня"><input className="input" type="time" value={f.work_start} onChange={set('work_start')} /></Field>
        <Field label="Конец рабочего дня"><input className="input" type="time" value={f.work_end} onChange={set('work_end')} /></Field>
        <Field label="Обед с"><input className="input" type="time" value={f.lunch_start || ''} onChange={set('lunch_start')} /></Field>
        <Field label="Обед до"><input className="input" type="time" value={f.lunch_end || ''} onChange={set('lunch_end')} /></Field>
        <div className="span-2">
          <div className="field-label">Рабочие дни</div>
          <div className="chips">
            {DAYS.map(([n, l]) => (
              <button type="button" key={n} className={`chip ${f.work_days.includes(n) ? 'on' : ''}`}
                onClick={() => setF((s) => ({ ...s, work_days: s.work_days.includes(n) ? s.work_days.filter((x) => x !== n) : [...s.work_days, n].sort() }))}>{l}</button>
            ))}
          </div>
        </div>
        <Field label="Праздники / нерабочие дни" hint="Через запятую: 2026-11-04, 2027-01-01" className="span-2"><input className="input" value={f.holidays} onChange={set('holidays')} /></Field>
        <Field label="Стоимость нормо-часа, ₽" hint="Пересчитает цены и ЗП в справочнике и ещё не начатых заданиях"><input className="input" type="number" value={f.norm_hour_price} onChange={set('norm_hour_price')} /></Field>
        <Field label="Зарплата от стоимости работы, %" hint="Например, 40 = 40 %. Завершённые и начатые задания не меняются."><input className="input" type="number" min="0" max="100" step="0.01" value={Math.round(Number(f.salary_rate) * 10000) / 100} onChange={(e) => setF((s) => ({ ...s, salary_rate: Number(e.target.value) / 100 }))} /></Field>
      </div>
      <Button variant="primary" loading={busy} onClick={save}>Сохранить</Button>
    </Card>
  );
}

function UsersTab() {
  const { user: me } = useApp();
  const { data, loading, error, reload } = useLoad(() => api.get('/users'));
  const emps = useLoad(() => api.get('/employees'));
  const [edit, setEdit] = useState(null);
  return (
    <>
      <ErrorBox error={error} onRetry={reload} />
      <div className="toolbar"><Button variant="primary" icon={Plus} onClick={() => setEdit({})}>Новый пользователь</Button></div>
      <Card pad={false}>
        {loading && !data ? <Spinner /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Логин</th><th>Имя</th><th>Роль</th><th>Сотрудник</th><th>Статус</th><th /></tr></thead>
            <tbody>{(data || []).map((u) => (
              <tr key={u.id} className={u.active ? '' : 'dim'}>
                <td><code>{u.login}</code></td><td>{u.name}{u.id === me.id && <Badge tone="blue">вы</Badge>}</td><td>{ROLES[u.role]}</td>
                <td>{u.employee_name || '—'}</td><td>{u.active ? <Badge tone="green">активен</Badge> : <Badge>заблокирован</Badge>}</td>
                <td><button className="icon-btn" onClick={() => setEdit(u)} aria-label="Изменить"><Pencil size={15} /></button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <Card title="Роли">
        <ul className="list small">
          <li><b>Администратор</b> — всё, включая справочник работ, сотрудников, допуски, ручное переназначение задач, пользователей и настройки.</li>
          <li><b>Оператор</b> — ТС, дефектовка, план ремонта и его корректировка, статусы работ, запчасти и 1С, ТО, отчёты.</li>
          <li><b>Мастер-приёмщик</b> — ТС, дефектовка, просмотр ремонтов и отчётов.</li>
          <li><b>Слесарь</b> — просмотр своего расписания и задач.</li>
        </ul>
      </Card>
      {edit && <UserDialog u={edit} emps={emps.data || []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}

function UserDialog({ u, emps, onClose, onSaved }) {
  const [f, setF] = useState({ login: u.login || '', name: u.name || '', role: u.role || 'operator', employee_id: u.employee_id || null, active: u.id ? !!u.active : true, password: '' });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  const [run, busy] = useAction();
  return (
    <Modal title={u.id ? `Пользователь ${u.login}` : 'Новый пользователь'} onClose={onClose} footer={<>
      <Button onClick={onClose}>Отмена</Button>
      <Button variant="primary" loading={busy} onClick={() => run(async () => {
        const body = { ...f };
        if (u.id && !body.password) delete body.password;
        const r = u.id ? await api.put(`/users/${u.id}`, body, { offline: false }) : await api.post('/users', body, { offline: false });
        onSaved(); return r;
      }, 'Сохранено')}>Сохранить</Button>
    </>}>
      <div className="form-grid">
        <Field label="Логин"><input className="input" value={f.login} onChange={set('login')} disabled={!!u.id} autoCapitalize="none" /></Field>
        <Field label="Имя"><input className="input" value={f.name} onChange={set('name')} /></Field>
        <Field label="Роль">
          <select className="input" value={f.role} onChange={set('role')}>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </Field>
        <Field label="Сотрудник" hint="Для слесаря — чьё расписание показывать">
          <SearchSelect clearable value={f.employee_id} onChange={set('employee_id')} options={emps.map((e) => ({ value: e.id, label: e.name }))} placeholder="—" />
        </Field>
        <Field label={u.id ? 'Новый пароль' : 'Пароль'} hint="Не короче 6 символов"><input className="input" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
        {u.id && <label className="check"><input type="checkbox" checked={f.active} onChange={set('active')} /> Активен</label>}
      </div>
    </Modal>
  );
}

function Audit() {
  const { data, loading, error, reload } = useLoad(() => api.get('/audit?limit=300'));
  if (loading && !data) return <Spinner />;
  return (
    <Card pad={false}>
      <ErrorBox error={error} onRetry={reload} />
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Время</th><th>Пользователь</th><th>Объект</th><th>Действие</th><th>Подробности</th></tr></thead>
        <tbody>{(data || []).map((a) => (
          <tr key={a.id}><td className="nowrap">{fmtDateTime(a.at)}</td><td>{a.user_name || '—'}</td><td>{a.entity} {a.entity_id ? `#${a.entity_id}` : ''}</td><td>{a.action}</td><td className="small muted trunc">{a.details}</td></tr>
        ))}</tbody>
      </table></div>
    </Card>
  );
}

function Backup() {
  const toast = useToast();
  const { user } = useApp();
  const [busy, setBusy] = useState('');
  const [file, setFile] = useState(null);
  const run = async (kind, fn) => {
    setBusy(kind);
    try { await fn(); } catch (e) { toast(e.message, 'red'); } finally { setBusy(''); }
  };
  if (user?.role !== 'admin') return <Card>Доступно только администратору.</Card>;
  return <>
    <Card title="1. Резервная копия данных">
      <p>Согласованный снимок SQLite: все записи, история, настройки и архивные данные.</p>
      <Button variant="primary" icon={Download} disabled={!!busy} loading={busy === 'db'} onClick={() => run('db', () => api.download('/admin/backup', 'fiberfleet.db'))}>Скачать базу данных</Button>
    </Card>
    <Card title="2. Полная резервная копия FiberFleet">
      <p>ZIP с исходным кодом, сборкой интерфейса, инструкциями и базой данных. Зависимости устанавливаются заново. Храните архив в защищённом месте.</p>
      <Button variant="primary" icon={Download} disabled={!!busy} loading={busy === 'zip'} onClick={() => run('zip', () => api.download('/admin/backup/full', 'fiberfleet.zip'))}>Скачать полный архив</Button>
    </Card>
    <Card title="3. Восстановление данных">
      <p>Заменяет данные на сервере содержимым DB или ZIP. Текущая база сохраняется отдельно. Код программы из ZIP автоматически не устанавливается. Перед восстановлением синхронизируйте изменения на всех устройствах.</p>
      <input type="file" accept=".db,.zip" disabled={!!busy} onChange={e => setFile(e.target.files?.[0] || null)} />
      <Button disabled={!file || !!busy} loading={busy === 'restore'} onClick={() => {
        if (busy || !file || !window.confirm('Заменить все текущие данные? После восстановления потребуется повторный вход.')) return;
        run('restore', async () => {
          const body = new FormData(); body.append('backup', file); body.append('confirm', 'RESTORE');
          await api.post('/admin/backup/restore', body, { offline: false });
          toast('Данные восстановлены. Войдите снова.');
          window.location.reload();
        });
      }}>Восстановить данные</Button>
    </Card>
    {busy && <p>Операция выполняется. Не закрывайте страницу.</p>}
  </>;
}
