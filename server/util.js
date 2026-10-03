const LAT_TO_CYR = { A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', Y: 'У', X: 'Х' };

// Госномер: верхний регистр, без пробелов, латинские двойники → кириллица
export function normalizePlate(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[ABEKMHOPCTYX]/g, (c) => LAT_TO_CYR[c]);
}

const BRANDS = ['MERCEDES BENZ', 'MERCEDES-BENZ', 'MERCEDES', 'SCANIA', 'VOLVO', 'RENAULT', 'IVECO', 'KAMAZ', 'КАМАЗ',
  'SCHMITZ', 'KOGEL', 'KRONE', 'WIELTON', 'TONAR', 'НЕФАЗ', 'MAN', 'DAF', 'FAW', 'SITRAK', 'SHACMAN', 'HOWO'];

export function splitBrand(full) {
  let s = String(full || '').trim().replace(/\s+/g, ' ');
  // кириллические двойники в латинских моделях (DAF СF85)
  s = s.replace(/(?<=[A-Z ])С(?=[A-Z0-9])/g, 'C');
  const up = s.toUpperCase();
  for (const b of BRANDS) {
    if (up === b || up.startsWith(b + ' ')) {
      const brand = b === 'MERCEDES BENZ' || b === 'MERCEDES' ? 'MERCEDES-BENZ' : b;
      return { brand, model: s.slice(b.length).trim() };
    }
  }
  const [brand, ...rest] = s.split(' ');
  return { brand: brand || '', model: rest.join(' ') };
}

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const bad = (msg, details) => new HttpError(400, msg, details);
export const notFound = (what = 'Запись') => new HttpError(404, `${what} не найдена`);

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

const pad = (n) => String(n).padStart(2, '0');
// Формат даты/времени в часовом поясе сервиса (смещение в минутах)
export function fmtDateTime(iso, offsetMin = 180, withTime = true) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + offsetMin * 60000);
  const date = `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  return withTime ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : date;
}
