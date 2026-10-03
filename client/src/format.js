// Форматирование в часовом поясе сервиса (настройка tz_offset_min), чтобы все видели одинаковое время.
let OFFSET = 180;
export const setTzOffset = (m) => { OFFSET = Number(m ?? 180); };

const pad = (n) => String(n).padStart(2, '0');
const shift = (iso) => new Date(new Date(iso).getTime() + OFFSET * 60000);

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = shift(iso);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}
export function fmtTime(iso) {
  if (!iso) return '';
  const d = shift(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export const fmtDateTime = (iso) => (iso ? `${fmtDate(iso)} ${fmtTime(iso)}` : '—');
export function fmtShort(iso) {
  if (!iso) return '—';
  const d = shift(iso);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
export const weekday = (iso) => WD[shift(iso).getUTCDay()];

// <input type="datetime-local"> ↔ ISO
export function isoToInput(iso) {
  if (!iso) return '';
  const d = shift(iso);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function inputToIso(v) {
  if (!v) return null;
  const [date, time = '00:00'] = v.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - OFFSET * 60000).toISOString();
}
export const dateToIso = (v) => (v ? inputToIso(`${v}T00:00`) : null);
export function isoToDateInput(iso) { return iso ? isoToInput(iso).slice(0, 10) : ''; }
export function dayStartIso(date = new Date()) {
  const d = shift(date.toISOString ? date.toISOString() : date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - OFFSET * 60000).toISOString();
}
export const addDays = (iso, n) => new Date(new Date(iso).getTime() + n * 86400000).toISOString();

export const money = (v) => (v == null || v === '' ? '—' : `${Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`);
export const num = (v, d = 2) => (v == null || v === '' ? '—' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: d }));
export const km = (v) => (v == null ? '—' : `${Number(v).toLocaleString('ru-RU')} км`);
export const hours = (h) => {
  if (h == null) return '—';
  const total = Math.round(Number(h) * 60);
  const hh = Math.floor(total / 60), mm = total % 60;
  return hh ? `${hh} ч${mm ? ` ${mm} мин` : ''}` : `${mm} мин`;
};

// Госномер для показа: «Т970ОН58» → «Т 970 ОН 58»
export function plate(p) {
  if (!p) return '—';
  const m = String(p).match(/^([А-ЯA-Z])(\d{3})([А-ЯA-Z]{2})(\d{2,3})$/);
  if (m) return `${m[1]} ${m[2]} ${m[3]} ${m[4]}`;
  const t = String(p).match(/^([А-ЯA-Z]{2})(\d{4})\/?(\d{2,3})$/);
  if (t) return `${t[1]} ${t[2]}/${t[3]}`;
  return p;
}

export const VEH = { tractor: 'Тягач', trailer: 'Прицеп' };

export const ORDER_STATUS = {
  draft: { label: 'Черновик', tone: 'gray' },
  planned: { label: 'Запланирован', tone: 'blue' },
  plan_error: { label: 'Ошибка планирования', tone: 'red' },
  approved: { label: 'Утверждён', tone: 'green' },
  in_progress: { label: 'В ремонте', tone: 'amber' },
  done: { label: 'Завершён', tone: 'gray' },
  cancelled: { label: 'Отменён', tone: 'gray' },
};

export const TASK_STATUS = {
  planned: { label: 'Запланирована', tone: 'blue' },
  in_progress: { label: 'В работе', tone: 'amber' },
  paused: { label: 'Пауза', tone: 'gray' },
  done: { label: 'Выполнена', tone: 'green' },
  cancelled: { label: 'Отменена', tone: 'gray' },
};

export const PRIORITY = {
  1: { label: 'Критично', short: 'P1', tone: 'red' },
  2: { label: 'Высокий', short: 'P2', tone: 'amber' },
  3: { label: 'Плановый', short: 'P3', tone: 'blue' },
  4: { label: 'По согласованию', short: 'P4', tone: 'gray' },
};

export const MAINT_STATUS = {
  overdue: { label: 'Просрочено', tone: 'red' },
  soon: { label: 'Скоро', tone: 'amber' },
  ok: { label: 'В норме', tone: 'green' },
  unknown: { label: 'Нет данных', tone: 'gray' },
};

export const ROLES = {
  admin: 'Администратор',
  operator: 'Оператор',
  master: 'Мастер-приёмщик',
  mechanic: 'Слесарь',
};

export const SOURCE = { defect: 'Дефект', related: 'Связанная проверка', inspection: 'Осмотр', maintenance: 'ТО', manual: 'Вручную' };

// Понедельник недели (начало суток в часовом поясе сервиса)
export function weekStartIso(iso) {
  const d = shift(iso);
  const dow = d.getUTCDay() || 7;
  return addDays(dayStartIso(new Date(iso)), -(dow - 1));
}
