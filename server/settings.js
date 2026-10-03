import { DEFAULT_SETTINGS } from './seed.js';
import { WorkCalendar } from './domain/calendar.js';

export function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    try { out[key] = JSON.parse(value); } catch { out[key] = value; }
  }
  return out;
}

export function saveSettings(db, patch) {
  const allowed = Object.keys(DEFAULT_SETTINGS);
  const stmt = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) if (allowed.includes(k)) stmt.run(k, JSON.stringify(v));
  return getSettings(db);
}

export const calendarFor = (db) => new WorkCalendar(getSettings(db));
