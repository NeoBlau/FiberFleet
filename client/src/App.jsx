import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Truck, ClipboardCheck, Wrench, CalendarClock, Users, BookOpen, Package, Gauge, FileBarChart,
  Settings as SettingsIcon, LogOut, Menu, X, WifiOff, RefreshCw, MonitorPlay, AlertTriangle,
} from 'lucide-react';
import * as api from './api.js';
import { setTzOffset, ROLES } from './format.js';
import { Button, cx, Field, Modal, Spinner, ToastProvider } from './ui/kit.jsx';
import Login from './pages/Login.jsx';

const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Vehicles = lazy(() => import('./pages/Vehicles.jsx'));
const VehicleCard = lazy(() => import('./pages/VehicleCard.jsx'));
const DefectSheet = lazy(() => import('./pages/DefectSheet.jsx'));
const Orders = lazy(() => import('./pages/Orders.jsx'));
const OrderPage = lazy(() => import('./pages/OrderPage.jsx'));
const Schedule = lazy(() => import('./pages/Schedule.jsx'));
const Monitor = lazy(() => import('./pages/Monitor.jsx'));
const Employees = lazy(() => import('./pages/Employees.jsx'));
const Catalog = lazy(() => import('./pages/Catalog.jsx'));
const Parts = lazy(() => import('./pages/Parts.jsx'));
const Maintenance = lazy(() => import('./pages/Maintenance.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export function can(user, perm) {
  const p = user?.permissions || [];
  return p.includes('*') || p.includes(perm);
}

const NAV = [
  { to: '/', label: 'Главная', icon: LayoutDashboard, end: true },
  { to: '/defect/new', label: 'Дефектовка', icon: ClipboardCheck, perm: 'orders.write' },
  { to: '/orders', label: 'Ремонты', icon: Wrench },
  { to: '/schedule', label: 'Расписание', icon: CalendarClock },
  { to: '/vehicles', label: 'Тягачи и прицепы', icon: Truck },
  { to: '/maintenance', label: 'Пробег и ТО', icon: Gauge },
  { to: '/employees', label: 'Сотрудники', icon: Users, perm: 'employees.read' },
  { to: '/catalog', label: 'Справочник работ', icon: BookOpen, perm: 'catalog.read' },
  { to: '/parts', label: 'Запчасти и 1С', icon: Package, perm: 'parts.write' },
  { to: '/reports', label: 'Отчёты', icon: FileBarChart, perm: 'reports.read' },
  { to: '/settings', label: 'Настройки', icon: SettingsIcon, perm: 'settings.write' },
];

function NetBadge() {
  const [st, setSt] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => api.onNetState(setSt), []);
  if (!st) return null;
  const problem = !st.online || st.pending > 0 || st.failed.length > 0;
  if (!problem && !st.syncing) return null;
  return (
    <>
      <button className={cx('net', !st.online ? 'net-off' : st.failed.length ? 'net-err' : 'net-sync')} onClick={() => setOpen(true)}>
        {!st.online ? <WifiOff size={15} /> : st.failed.length ? <AlertTriangle size={15} /> : <RefreshCw size={15} className={st.syncing ? 'spin' : ''} />}
        <span>{!st.online ? 'Нет связи' : st.failed.length ? 'Ошибки синхронизации' : 'Синхронизация'}{st.pending ? ` · ${st.pending}` : ''}</span>
      </button>
      {open && (
        <Modal title="Синхронизация" onClose={() => setOpen(false)} footer={<>
          {st.failed.length > 0 && <Button onClick={() => api.clearFailed()}>Очистить ошибки</Button>}
          <Button variant="primary" icon={RefreshCw} onClick={() => api.flushQueue()}>Отправить сейчас</Button>
        </>}>
          <p>{st.online ? 'Связь с сервером есть.' : 'Связи с сервером нет. Данные показываются из последней сохранённой копии; изменения копятся на устройстве и будут отправлены автоматически.'}</p>
          <p><b>В очереди:</b> {st.pending}</p>
          {st.failed.length > 0 && (
            <>
              <p><b>Не приняты сервером</b> (данные изменились, пока устройство было офлайн):</p>
              <ul className="list">{st.failed.map((f) => <li key={f.opId}><b>{f.label}</b><br /><span className="muted">{f.error}</span></li>)}</ul>
            </>
          )}
        </Modal>
      )}
    </>
  );
}

function PasswordDialog({ onClose }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(false);
  const save = async () => {
    setErr(null);
    try { await api.post('/auth/password', { current: cur, next }, { offline: false }); setOk(true); } catch (e) { setErr(e.message); }
  };
  return (
    <Modal title="Смена пароля" onClose={onClose} footer={ok ? <Button onClick={onClose}>Готово</Button> : <><Button onClick={onClose}>Отмена</Button><Button variant="primary" onClick={save}>Сменить</Button></>}>
      {ok ? <p>Пароль изменён. Другие сеансы завершены.</p> : (
        <>
          <Field label="Текущий пароль"><input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></Field>
          <Field label="Новый пароль" hint="Не короче 6 символов"><input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field>
          {err && <div className="alert alert-red">{err}</div>}
        </>
      )}
    </Modal>
  );
}

function Layout({ children }) {
  const { user, logout, settings } = useApp();
  const [menu, setMenu] = useState(false);
  const [pwd, setPwd] = useState(false);
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname]);
  const items = NAV.filter((n) => !n.perm || can(user, n.perm));
  return (
    <div className="shell">
      <aside className={cx('side', menu && 'open')}>
        <div className="brand">
          <img src="/icon.svg" alt="" width="30" height="30" />
          <div>
            <div className="brand-name">FiberFleet</div>
            <div className="brand-sub">{settings?.company && settings.company !== 'FiberFleet' ? settings.company : 'сервис тягачей и прицепов'}</div>
          </div>
          <button className="icon-btn only-mobile" onClick={() => setMenu(false)} aria-label="Закрыть меню"><X size={18} /></button>
        </div>
        <nav>
          {items.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => cx('nav', isActive && 'active')}>
              <Icon size={18} /> <span>{label}</span>
            </NavLink>
          ))}
          <NavLink to="/monitor" className="nav"><MonitorPlay size={18} /> <span>Экран оператора</span></NavLink>
        </nav>
        <div className="side-foot">
          <div className="me" onClick={() => setPwd(true)} title="Сменить пароль">
            <div className="me-name">{user.name}</div>
            <div className="me-role">{ROLES[user.role]}</div>
          </div>
          <button className="icon-btn" onClick={logout} title="Выйти" aria-label="Выйти"><LogOut size={18} /></button>
        </div>
      </aside>
      {menu && <div className="side-back" onClick={() => setMenu(false)} />}
      {pwd && <PasswordDialog onClose={() => setPwd(false)} />}
      <div className="main">
        <header className="top only-mobile">
          <button className="icon-btn" onClick={() => setMenu(true)} aria-label="Меню"><Menu size={20} /></button>
          <span className="brand-name">FiberFleet</span>
          <NetBadge />
        </header>
        <div className="top-net only-desktop"><NetBadge /></div>
        <main className="content">
          <Suspense fallback={<Spinner />}>{children}</Suspense>
        </main>
      </div>
    </div>
  );
}

function Guard({ perm, children }) {
  const { user } = useApp();
  if (perm && !can(user, perm)) return <div className="alert alert-amber">Раздел недоступен для вашей роли.</div>;
  return children;
}

function AppRoutes() {
  const { user } = useApp();
  const nav = useNavigate();
  useEffect(() => { if (user?.role === 'mechanic' && window.location.pathname === '/') nav('/schedule', { replace: true }); }, [user, nav]);
  return (
    <Routes>
      <Route path="/monitor" element={<Suspense fallback={<Spinner />}><Monitor /></Suspense>} />
      <Route path="*" element={
        <Layout>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/defect/new" element={<Guard perm="orders.write"><DefectSheet /></Guard>} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/orders/:id" element={<OrderPage />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/vehicles" element={<Vehicles />} />
            <Route path="/vehicles/:type/:id" element={<VehicleCard />} />
            <Route path="/maintenance" element={<Maintenance />} />
            <Route path="/employees" element={<Guard perm="employees.read"><Employees /></Guard>} />
            <Route path="/catalog" element={<Guard perm="catalog.read"><Catalog /></Guard>} />
            <Route path="/parts" element={<Guard perm="parts.write"><Parts /></Guard>} />
            <Route path="/reports" element={<Guard perm="reports.read"><Reports /></Guard>} />
            <Route path="/settings" element={<Guard perm="settings.write"><Settings /></Guard>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      } />
    </Routes>
  );
}

export default function App() {
  const [user, setUser] = useState(undefined);
  const [settings, setSettings] = useState(null);
  const [checklist, setChecklist] = useState(null);

  const logout = useCallback(async () => {
    try { await api.post('/auth/logout', {}, { offline: false }); } catch { /* */ }
    api.setToken(null);
    await api.cacheClear();
    setUser(null);
  }, []);

  const loadMeta = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([api.get('/settings'), api.get('/checklist')]);
      setTzOffset(s.tz_offset_min);
      setSettings(s);
      setChecklist(c);
    } catch { /* офлайн без кэша */ }
  }, []);

  useEffect(() => {
    api.setUnauthorizedHandler(() => { api.setToken(null); setUser(null); });
    if (!api.getToken()) { setUser(null); return; }
    api.get('/auth/me').then((r) => { setUser(r.user); loadMeta(); }).catch((e) => {
      if (e.status === 401) setUser(null);
      else setUser(null);
    });
    api.flushQueue();
  }, [loadMeta]);

  if (user === undefined) return <div className="boot"><Spinner /></div>;

  return (
    <ToastProvider>
      {!user ? (
        <Login onLogin={(u) => { setUser(u); loadMeta(); }} />
      ) : (
        <AppCtx.Provider value={{ user, logout, settings, setSettings: (s) => { setTzOffset(s.tz_offset_min); setSettings(s); }, checklist }}>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </AppCtx.Provider>
      )}
    </ToastProvider>
  );
}
