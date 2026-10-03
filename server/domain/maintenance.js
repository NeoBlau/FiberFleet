// Учёт пробега и плановое ТО: статус по каждому правилу, прогноз даты по среднесуточному пробегу.
const DAY = 86400000;

export function vehicleRow(db, type, id) {
  return db.prepare(`SELECT * FROM ${type === 'tractor' ? 'tractors' : 'trailers'} WHERE id = ?`).get(id);
}

export function rulesFor(db, type, vehicle) {
  const all = db.prepare('SELECT * FROM maintenance_rules WHERE active = 1 AND vehicle_type = ? ORDER BY id').all(type);
  const hay = `${vehicle.brand || ''} ${vehicle.model || ''}`.toUpperCase();
  const byKey = new Map();
  for (const r of all) {
    if (r.brand_match && !hay.includes(r.brand_match.toUpperCase())) continue;
    const prev = byKey.get(r.key);
    // правило под конкретную марку важнее общего
    if (!prev || (!prev.brand_match && r.brand_match)) byKey.set(r.key, r);
  }
  return [...byKey.values()];
}

// Среднесуточный пробег за последние 120 дней (км/сутки) по журналу пробега
export function dailyMileage(db, type, id) {
  const rows = db.prepare(`SELECT mileage, recorded_at FROM mileage_log
    WHERE vehicle_type = ? AND vehicle_id = ? AND recorded_at >= ? ORDER BY recorded_at`)
    .all(type, id, new Date(Date.now() - 120 * DAY).toISOString());
  if (rows.length < 2) return null;
  const first = rows[0], last = rows[rows.length - 1];
  const days = (new Date(last.recorded_at) - new Date(first.recorded_at)) / DAY;
  if (days < 3 || last.mileage <= first.mileage) return null;
  return Math.round((last.mileage - first.mileage) / days);
}

export function ruleStatus(db, type, vehicle, rule, now = new Date()) {
  const lastTask = rule.work_type_id ? db.prepare(`SELECT mileage, finished_at FROM tasks
    WHERE vehicle_type = ? AND vehicle_id = ? AND work_type_id = ? AND status = 'done'
    ORDER BY finished_at DESC LIMIT 1`).get(type, vehicle.id, rule.work_type_id) : null;
  const base = db.prepare('SELECT done_mileage, done_at FROM maintenance_baseline WHERE rule_id = ? AND vehicle_type = ? AND vehicle_id = ?')
    .get(rule.id, type, vehicle.id);

  let lastKm = null, lastAt = null, source = null;
  const cands = [];
  if (lastTask) cands.push({ km: lastTask.mileage, at: lastTask.finished_at, source: 'repair' });
  if (base) cands.push({ km: base.done_mileage, at: base.done_at, source: 'baseline' });
  cands.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  if (cands.length) ({ km: lastKm, at: lastAt, source } = cands[0]);

  const mileage = vehicle.mileage || 0;
  let estimated = false;
  if (lastKm == null && rule.interval_km && mileage > 0) {
    lastKm = Math.floor(mileage / rule.interval_km) * rule.interval_km;
    estimated = true;
    source = 'estimate';
  }

  const nextKm = rule.interval_km && lastKm != null ? lastKm + rule.interval_km : null;
  const remainingKm = nextKm != null ? nextKm - mileage : null;
  const nextDate = rule.interval_days && lastAt ? new Date(new Date(lastAt).getTime() + rule.interval_days * DAY).toISOString() : null;
  const daysLeft = nextDate ? Math.floor((new Date(nextDate) - now) / DAY) : null;

  const perDay = dailyMileage(db, type, vehicle.id);
  const forecastDate = remainingKm != null && perDay ? new Date(now.getTime() + Math.max(0, remainingKm / perDay) * DAY).toISOString() : null;
  const dueDate = [nextDate, forecastDate].filter(Boolean).sort()[0] || null;

  let status = 'ok';
  if (remainingKm == null && daysLeft == null) status = 'unknown';
  else if ((remainingKm != null && remainingKm <= 0) || (daysLeft != null && daysLeft <= 0)) status = 'overdue';
  else if ((remainingKm != null && remainingKm <= rule.warn_km) || (daysLeft != null && daysLeft <= rule.warn_days)) status = 'soon';

  return {
    rule_id: rule.id, key: rule.key, name: rule.name, work_type_id: rule.work_type_id,
    interval_km: rule.interval_km, interval_days: rule.interval_days,
    last_km: lastKm, last_at: lastAt, source, estimated,
    next_km: nextKm, remaining_km: remainingKm, next_date: nextDate, days_left: daysLeft,
    km_per_day: perDay, forecast_date: forecastDate, due_date: dueDate, status,
  };
}

export function vehicleMaintenance(db, type, vehicle, now) {
  return rulesFor(db, type, vehicle).map((r) => ruleStatus(db, type, vehicle, r, now));
}

export function fleetMaintenance(db, now = new Date()) {
  const out = [];
  for (const type of ['tractor', 'trailer']) {
    const rows = db.prepare(`SELECT * FROM ${type === 'tractor' ? 'tractors' : 'trailers'} WHERE archived = 0`).all();
    for (const v of rows) {
      for (const st of vehicleMaintenance(db, type, v, now)) {
        out.push({ vehicle_type: type, vehicle_id: v.id, plate: v.plate, brand: v.brand, model: v.model, mileage: v.mileage, ...st });
      }
    }
  }
  const order = { overdue: 0, soon: 1, unknown: 2, ok: 3 };
  return out.sort((a, b) => order[a.status] - order[b.status] || (a.remaining_km ?? 1e9) - (b.remaining_km ?? 1e9));
}

// Запись пробега: журнал + обновление текущего пробега ТС (пробег не уменьшается без явного флага)
export function recordMileage(db, { type, id, mileage, at, source, refId, userId, allowDecrease = false }) {
  if (mileage == null || Number.isNaN(Number(mileage))) return;
  const m = Math.round(Number(mileage));
  const table = type === 'tractor' ? 'tractors' : 'trailers';
  const v = db.prepare(`SELECT mileage FROM ${table} WHERE id = ?`).get(id);
  if (!v) return;
  db.prepare(`INSERT INTO mileage_log(vehicle_type, vehicle_id, mileage, recorded_at, source, ref_id, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(type, id, m, at || new Date().toISOString(), source, refId ?? null, userId ?? null);
  if (m > v.mileage || allowDecrease) {
    db.prepare(`UPDATE ${table} SET mileage = ?, updated_at = ? WHERE id = ?`).run(m, new Date().toISOString(), id);
  }
}
