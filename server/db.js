import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.FF_DATA_DIR || path.resolve('data');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Таблица "Тягачи"
CREATE TABLE IF NOT EXISTS tractors (
  id INTEGER PRIMARY KEY,
  plate TEXT NOT NULL UNIQUE,            -- госномер
  brand TEXT NOT NULL,                   -- марка
  model TEXT,                            -- модель
  year INTEGER,
  vin TEXT,
  mileage INTEGER NOT NULL DEFAULT 0,    -- текущий пробег, км
  axles INTEGER NOT NULL DEFAULT 2,
  brake_type TEXT NOT NULL DEFAULT 'disc' CHECK (brake_type IN ('disc','drum')),
  trailer_id INTEGER REFERENCES trailers(id) ON DELETE SET NULL, -- закреплённый прицеп
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Таблица "Прицепы"
CREATE TABLE IF NOT EXISTS trailers (
  id INTEGER PRIMARY KEY,
  plate TEXT NOT NULL UNIQUE,
  brand TEXT,
  model TEXT NOT NULL,
  year INTEGER,
  vin TEXT,
  axles INTEGER NOT NULL DEFAULT 3,
  brake_type TEXT NOT NULL DEFAULT 'disc' CHECK (brake_type IN ('disc','drum')),
  has_reefer INTEGER NOT NULL DEFAULT 0,
  reefer_hours INTEGER,                  -- моточасы реф. установки
  mileage INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Журнал пробега (фиксация пробега на момент ремонта/поломки/ручного ввода)
CREATE TABLE IF NOT EXISTS mileage_log (
  id INTEGER PRIMARY KEY,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('tractor','trailer')),
  vehicle_id INTEGER NOT NULL,
  mileage INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  source TEXT NOT NULL,                  -- defect | repair | manual | import
  ref_id INTEGER,
  user_id INTEGER
);
CREATE INDEX IF NOT EXISTS ix_mileage_vehicle ON mileage_log(vehicle_type, vehicle_id, recorded_at);

-- Справочник фиксированных работ (прайс)
CREATE TABLE IF NOT EXISTS work_types (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  applies_to TEXT NOT NULL DEFAULT 'tractor' CHECK (applies_to IN ('tractor','trailer','any')),
  hours REAL NOT NULL,                   -- норма времени, н/ч
  hours_max REAL,
  price REAL,                            -- цена с НДС
  price_max REAL,
  salary REAL,                           -- ЗП исполнителя
  salary_max REAL,
  access_all INTEGER NOT NULL DEFAULT 1, -- допуск: все сотрудники
  external INTEGER NOT NULL DEFAULT 0,   -- выполняется сторонним сервисом
  required_qualification TEXT,           -- например «токарь»
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Таблица "Сотрудники"
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  position TEXT,
  qualification TEXT,                    -- квалификация (свободный текст / разряд)
  level INTEGER NOT NULL DEFAULT 2,      -- 1 стажёр, 2 слесарь, 3 мастер
  speed_factor REAL NOT NULL DEFAULT 1,  -- среднее фактическое время / норма (1 = по норме)
  specializations TEXT NOT NULL DEFAULT '[]', -- JSON: категории работ
  is_external INTEGER NOT NULL DEFAULT 0, -- сторонний сервис (без ограничения загрузки)
  general_access INTEGER NOT NULL DEFAULT 1, -- допущен к работам с допуском «Все»
  active INTEGER NOT NULL DEFAULT 1,
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Доступы: какие сотрудники допущены к работам с ограниченным допуском
CREATE TABLE IF NOT EXISTS work_type_access (
  work_type_id INTEGER NOT NULL REFERENCES work_types(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (work_type_id, employee_id)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','operator','master','mechanic')),
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Ремонт (дефектовка + план ремонта)
CREATE TABLE IF NOT EXISTS repair_orders (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  tractor_id INTEGER REFERENCES tractors(id) ON DELETE SET NULL,
  trailer_id INTEGER REFERENCES trailers(id) ON DELETE SET NULL,
  tractor_mileage INTEGER,
  trailer_mileage INTEGER,
  reefer_hours INTEGER,
  inspected_at TEXT NOT NULL,            -- дата составления дефектовки
  release_deadline TEXT,                 -- дата/время выпуска с ремонта
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','planned','plan_error','approved','in_progress','done','cancelled')),
  defects TEXT NOT NULL DEFAULT '{}',    -- JSON: ответы по дефектной ведомости
  inspection TEXT NOT NULL DEFAULT '[]', -- JSON: зоны осмотра (куда залезть, что проверить)
  plan_errors TEXT NOT NULL DEFAULT '[]',-- JSON: ошибки планирования
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT
);

-- Таблица "Работы" (конкретные работы по ТС)
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  order_id INTEGER REFERENCES repair_orders(id) ON DELETE CASCADE,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('tractor','trailer')),
  vehicle_id INTEGER NOT NULL,
  work_type_id INTEGER REFERENCES work_types(id) ON DELETE SET NULL,
  description TEXT NOT NULL,             -- описание
  location TEXT,                         -- узел/позиция (ось, сторона)
  reason TEXT,                           -- почему добавлена (дефект, связанная проверка, ТО)
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('defect','related','inspection','maintenance','manual')),
  seq INTEGER NOT NULL DEFAULT 0,        -- порядок: осмотр раньше ремонта
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
  priority_manual INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,
  deadline_manual INTEGER NOT NULL DEFAULT 0,
  hours REAL NOT NULL DEFAULT 1,         -- норма, н/ч
  price REAL,
  salary REAL,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','in_progress','paused','done','cancelled')),
  registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), -- дата регистрации
  mileage INTEGER,                       -- пробег на момент ремонта
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL, -- исполнитель
  assigned_manual INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  actual_hours REAL,
  comment TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_tasks_order ON tasks(order_id);
CREATE INDEX IF NOT EXISTS ix_tasks_vehicle ON tasks(vehicle_type, vehicle_id);
CREATE INDEX IF NOT EXISTS ix_tasks_employee ON tasks(employee_id, status);

-- Таблица "Расписание"
CREATE TABLE IF NOT EXISTS schedule (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  vehicle_type TEXT NOT NULL,
  vehicle_id INTEGER NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0      -- зафиксировано вручную
);
CREATE INDEX IF NOT EXISTS ix_schedule_emp ON schedule(employee_id, start_at);

-- Таблица "Запчасти" (номенклатура; источник — 1С или ручной ввод)
CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE,                      -- код 1С
  article TEXT,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'шт',
  price REAL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('1c','manual')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Установленные запчасти
CREATE TABLE IF NOT EXISTS installed_parts (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES repair_orders(id) ON DELETE SET NULL,
  vehicle_type TEXT NOT NULL,
  vehicle_id INTEGER NOT NULL,
  part_id INTEGER REFERENCES parts(id) ON DELETE SET NULL,
  code TEXT,
  article TEXT,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'шт',
  qty REAL NOT NULL DEFAULT 1,
  price REAL,
  source TEXT NOT NULL DEFAULT 'manual',
  mileage INTEGER,
  installed_at TEXT NOT NULL,
  user_id INTEGER,
  exported_at TEXT                       -- когда выгружено в 1С
);
CREATE INDEX IF NOT EXISTS ix_parts_vehicle ON installed_parts(vehicle_type, vehicle_id);

-- Правила планового ТО по пробегу/времени
CREATE TABLE IF NOT EXISTS maintenance_rules (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,                     -- to | valves | trailer_service | ... (связь с пунктом ведомости)
  name TEXT NOT NULL,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('tractor','trailer')),
  brand_match TEXT,                      -- подстрока марки/модели; пусто = все
  interval_km INTEGER,
  interval_days INTEGER,
  warn_km INTEGER NOT NULL DEFAULT 5000,
  warn_days INTEGER NOT NULL DEFAULT 14,
  work_type_id INTEGER REFERENCES work_types(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1
);

-- Отметки «ТО выполнено» для базовой точки отсчёта (кроме работ из системы)
CREATE TABLE IF NOT EXISTS maintenance_baseline (
  rule_id INTEGER NOT NULL REFERENCES maintenance_rules(id) ON DELETE CASCADE,
  vehicle_type TEXT NOT NULL,
  vehicle_id INTEGER NOT NULL,
  done_mileage INTEGER,
  done_at TEXT,
  PRIMARY KEY (rule_id, vehicle_type, vehicle_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id INTEGER,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  details TEXT
);

-- Идемпотентность офлайн-синхронизации
CREATE TABLE IF NOT EXISTS sync_ops (
  op_id TEXT PRIMARY KEY,
  user_id INTEGER,
  status INTEGER NOT NULL,
  response TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

export function openDb(file) {
  const target = file || process.env.FF_DB || path.join(DATA_DIR, 'fiberfleet.db');
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

export const json = (v, fallback) => {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
};

export const nowIso = () => new Date().toISOString();
