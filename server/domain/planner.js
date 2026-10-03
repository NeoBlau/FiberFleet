// Формирование плана ремонта из дефектовки: работы, зоны осмотра, связанные проверки,
// приоритеты и сроки; проверка плана на противоречия.
import { ITEMS, PRIORITIES, SECTIONS, parsePosition, positionLabel } from './checklist.js';
import { vehicleMaintenance } from './maintenance.js';
import { fmtDateTime } from '../util.js';

export function workTypeIndex(db) {
  const rows = db.prepare('SELECT * FROM work_types WHERE active = 1').all();
  const byKey = new Map(rows.map((r) => [`${r.category}::${r.name}`, r]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { byKey, byId };
}

const axleLabel = (veh, axle) => `${veh === 'tractor' ? 'Тягач' : 'Прицеп'}, ось ${axle}`;

function isDefect(item, ans, maintByKey) {
  if (!ans) ans = {};
  switch (item.kind) {
    case 'pm':
    case 'yesno':
      return ans.state === 'defect';
    case 'volt': {
      if (ans.state === 'defect') return true;
      const v = ans.value === '' || ans.value == null ? null : Number(ans.value);
      return v != null && !Number.isNaN(v) && (v < item.min || v > item.max);
    }
    case 'mileage': {
      if (ans.state === 'defect') return true;
      if (ans.state === 'ok') return false;
      const st = maintByKey?.[item.maint];
      return st?.status === 'overdue';
    }
    case 'positions':
      return Array.isArray(ans.positions) && ans.positions.length > 0;
    default:
      return false;
  }
}

function matchWorks(item, veh, vehicleRec, axle) {
  return (item.works || []).filter((w) => {
    if (w.veh && w.veh !== veh) return false;
    if (w.brake && w.brake !== (vehicleRec?.brake_type || 'disc')) return false;
    if (w.axle) {
      const isFront = veh === 'tractor' && axle === 1;
      if ((w.axle === 'front') !== isFront) return false;
    }
    return true;
  });
}

/**
 * @param ctx { tractor, trailer, defects, release_deadline, inspected_at, tractor_mileage, trailer_mileage, cal }
 * @returns { tasks, inspection, damages, recommendations, warnings }
 */
export function generatePlan(db, ctx) {
  const { byKey, byId } = workTypeIndex(db);
  const { tractor, trailer, cal } = ctx;
  const defects = ctx.defects || {};
  const answers = defects.items || {};
  const inspectedAt = ctx.inspected_at || new Date().toISOString();
  const vehicles = { tractor, trailer };

  const maint = {};
  if (tractor) {
    maint.tractor = Object.fromEntries(vehicleMaintenance(db, 'tractor', { ...tractor, mileage: Math.max(tractor.mileage || 0, ctx.tractor_mileage || 0) }).map((s) => [s.key, s]));
  }
  if (trailer) {
    maint.trailer = Object.fromEntries(vehicleMaintenance(db, 'trailer', { ...trailer, mileage: Math.max(trailer.mileage || 0, ctx.trailer_mileage || 0) }).map((s) => [s.key, s]));
  }

  const tasks = new Map(); // key → task
  const warnings = [];
  const inspection = [];
  const damages = [];
  const recommendations = [];

  const deadlineFor = (priority) => ctx.release_deadline || cal.addWorkDays(inspectedAt, PRIORITIES[priority]?.days ?? 5);

  const addTask = ({ wt, veh, location, reason, source, seq, priority }) => {
    const vrec = vehicles[veh];
    if (!vrec) return null;
    const key = `${wt.id}|${veh}|${location || ''}`;
    const prev = tasks.get(key);
    if (prev) {
      if (!prev.reasons.includes(reason)) prev.reasons.push(reason);
      if (priority < prev.priority) { prev.priority = priority; prev.deadline = deadlineFor(priority); }
      if (source === 'defect' && prev.source !== 'defect') { prev.source = 'defect'; prev.seq = seq; }
      return prev;
    }
    const t = {
      key, work_type_id: wt.id, category: wt.category, description: wt.name,
      vehicle_type: veh, vehicle_id: vrec.id, location: location || null,
      reasons: [reason], source, seq, priority,
      deadline: deadlineFor(priority), hours: wt.hours, price: wt.price, salary: wt.salary,
      mileage: veh === 'tractor' ? ctx.tractor_mileage ?? tractor?.mileage : ctx.trailer_mileage ?? trailer?.mileage,
    };
    tasks.set(key, t);
    return t;
  };

  const resolveWt = (key, itemLabel) => {
    const wt = byKey.get(key);
    if (!wt) warnings.push(`Работа «${key.split('::')[1]}» (пункт «${itemLabel}») не найдена в справочнике — обновите справочник работ`);
    return wt;
  };

  // Сначала — дефекты, затем связанные проверки (чтобы не дублировать уже назначенные работы)
  const relatedQueue = [];

  for (const section of SECTIONS) {
    for (const raw of section.items) {
      const item = ITEMS[raw.id];
      const ans = answers[item.id] || {};

      if (item.kind === 'damage') {
        if (ans.state === 'defect' || (ans.zones && ans.zones.length)) {
          damages.push({ item: item.id, label: item.label, zones: ans.zones || [], comment: ans.comment || '' });
        }
        continue;
      }
      if (!isDefect(item, ans, maint[item.vehicle === 'trailer' ? 'trailer' : 'tractor'])) continue;

      const comment = ans.comment ? ` — ${ans.comment}` : '';
      const reason = `Дефектовка: ${item.label}${comment}`;

      // Сгруппировать по ТС и оси
      let targets;
      if (item.kind === 'positions') {
        targets = ans.positions.map((code) => {
          const p = parsePosition(code);
          return { veh: p.veh, axle: p.axle, location: positionLabel(code), code };
        });
      } else {
        const veh = item.vehicle === 'any' ? 'tractor' : item.vehicle;
        targets = [{ veh, axle: null, location: null }];
      }

      const zoneEntry = {
        item: item.id, label: item.label, section: section.title, priority: item.priority,
        positions: [], vehicles: new Set(), checks: item.checks || [], zone: item.zone || '',
        value: item.kind === 'volt' ? ans.value : undefined, unit: item.unit, comment: ans.comment || '',
      };

      for (const t of targets) {
        if (!vehicles[t.veh]) {
          warnings.push(`Пункт «${item.label}»: ${t.veh === 'trailer' ? 'прицеп' : 'тягач'} не указан в дефектовке — работа не запланирована`);
          continue;
        }
        zoneEntry.vehicles.add(t.veh);
        if (t.location) zoneEntry.positions.push(t.location);

        let works;
        if (item.kind === 'mileage') {
          const st = maint[t.veh]?.[item.maint];
          const wt = st?.work_type_id ? byId.get(st.work_type_id) : null;
          if (!wt) { warnings.push(`Для «${item.label}» не задано правило ТО для этой марки — добавьте работу вручную`); continue; }
          works = [wt];
        } else {
          works = matchWorks(item, t.veh, vehicles[t.veh], t.axle).map((w) => resolveWt(w.wt, item.label)).filter(Boolean);
          if (!works.length) {
            warnings.push(`Пункт «${item.label}» (${t.location || t.veh}): нет подходящей работы в справочнике — добавьте вручную`);
          }
        }
        for (const wt of works) {
          addTask({ wt, veh: t.veh, location: t.location, reason, source: 'defect', seq: item.seq ?? 2, priority: item.priority });
        }
        // Дополнительные работы, отмеченные мастером в пункте
        for (const optKey of ans.options || []) {
          const wt = resolveWt(optKey, item.label);
          if (wt) addTask({ wt, veh: t.veh, location: t.location, reason: `${reason} (доп. работа)`, source: 'defect', seq: item.seq ?? 2, priority: item.priority });
        }
        for (const r of item.related || []) {
          if (r.veh && r.veh !== t.veh) continue;
          relatedQueue.push({ r, t, item });
        }
      }

      zoneEntry.vehicles = [...zoneEntry.vehicles];
      zoneEntry.zone_text = item.zone
        ? item.zone.replace('{pos}', zoneEntry.positions.length ? zoneEntry.positions.join('; ') : (zoneEntry.vehicles[0] === 'trailer' ? 'Прицеп' : 'Тягач'))
        : '';
      zoneEntry.related_labels = (item.relatedItems || []).map((id) => ITEMS[id]?.label).filter(Boolean);
      inspection.push(zoneEntry);

      // Рекомендация проверить связанные пункты, которые ещё не осмотрены
      for (const relId of item.relatedItems || []) {
        const rel = ITEMS[relId];
        const relAns = answers[relId];
        const checked = relAns && (relAns.state || (relAns.positions && relAns.positions.length) || (relAns.value != null && relAns.value !== ''));
        if (rel && !checked) {
          recommendations.push({ item: relId, label: rel.label, because: item.label, text: `Проверьте также «${rel.label}» — связано с дефектом «${item.label}»` });
        }
      }
    }
  }

  for (const { r, t, item } of relatedQueue) {
    const wt = resolveWt(r.wt, item.label);
    if (!wt) continue;
    const location = r.scope === 'axle' && t.axle ? axleLabel(t.veh, t.axle) : null;
    // если такая же работа уже назначена как ремонт (на ось или позицию этой оси) — не дублируем
    const dup = [...tasks.values()].some((x) => x.work_type_id === wt.id && x.vehicle_type === t.veh && x.source === 'defect'
      && (!location || !x.location || x.location.startsWith(location)));
    if (dup) continue;
    addTask({ wt, veh: t.veh, location, reason: `Связанная проверка: ${r.why}`, source: 'related', seq: r.seq ?? 1, priority: item.priority });
  }

  // ТО «на подходе», не отмеченное в ведомости — рекомендация
  for (const veh of ['tractor', 'trailer']) {
    for (const st of Object.values(maint[veh] || {})) {
      const item = Object.values(ITEMS).find((i) => i.kind === 'mileage' && i.maint === st.key);
      const already = [...tasks.values()].some((x) => x.work_type_id === st.work_type_id && x.vehicle_type === veh);
      if (already) continue;
      if (st.status === 'overdue' || st.status === 'soon') {
        const wt = byId.get(st.work_type_id);
        recommendations.push({
          item: item?.id || null, maint: st.key, vehicle_type: veh, work_type_id: st.work_type_id,
          label: st.name, text: `${veh === 'tractor' ? 'Тягач' : 'Прицеп'}: ${st.name} — ${st.status === 'overdue' ? 'просрочено' : 'скоро'}`
            + (st.remaining_km != null ? ` (осталось ${st.remaining_km.toLocaleString('ru-RU')} км)` : '')
            + (wt ? `. Рекомендуется добавить «${wt.name}»` : ''),
        });
      }
    }
  }

  // Работы, добавленные вручную из справочника
  for (const ex of defects.extra || []) {
    const wt = byId.get(Number(ex.work_type_id));
    if (!wt) continue;
    const veh = ex.vehicle_type === 'trailer' ? 'trailer' : 'tractor';
    const pr = Number(ex.priority) || 2;
    addTask({ wt, veh, location: ex.location || null, reason: `Добавлено вручную${ex.comment ? ': ' + ex.comment : ''}`, source: 'manual', seq: wt.name.toLowerCase().startsWith('диагност') ? 1 : 2, priority: pr });
  }

  const list = [...tasks.values()].map((t) => ({ ...t, reason: t.reasons.join('; ') }));
  list.forEach((t) => delete t.reasons);
  list.sort((a, b) => a.seq - b.seq || a.priority - b.priority || a.vehicle_type.localeCompare(b.vehicle_type));
  return { tasks: list, inspection, damages, recommendations, warnings: [...new Set(warnings)] };
}

const fmt = (iso) => fmtDateTime(iso, 180);

/**
 * Проверка плана: противоречия приоритетов/сроков, сроки в прошлом, позже даты выпуска,
 * нет допущенного исполнителя, расписание не укладывается в срок.
 */
export function validatePlan(order, tasks, { scheduleByTask = new Map(), unschedulable = new Map(), now = new Date(), fmtDate = fmt } = {}) {
  const errors = [];
  const active = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  const nowIso = now.toISOString();

  for (const t of active) {
    if (t.deadline && t.deadline < nowIso && t.status === 'planned') {
      errors.push({ code: 'deadline_past', task_id: t.id, message: `«${t.description}»: срок ${fmtDate(t.deadline)} уже прошёл` });
    }
    if (order.release_deadline && t.deadline && t.deadline > order.release_deadline) {
      errors.push({ code: 'after_release', task_id: t.id, message: `«${t.description}»: срок ${fmtDate(t.deadline)} позже даты выпуска ТС ${fmtDate(order.release_deadline)}` });
    }
  }

  // Противоречие приоритетности и сроков: более важная работа со сроком позже менее важной
  const conflicts = new Set();
  for (const a of active) {
    for (const b of active) {
      if (a.id === b.id || !a.deadline || !b.deadline) continue;
      if (a.priority < b.priority && a.deadline > b.deadline) {
        const k = `${a.id}-${b.id}`;
        if (conflicts.has(k)) continue;
        conflicts.add(k);
        errors.push({
          code: 'priority_conflict', task_id: a.id,
          message: `Противоречие приоритетов и сроков: «${a.description}» (приоритет ${a.priority}) имеет срок ${fmtDate(a.deadline)} — позже, чем менее важная «${b.description}» (приоритет ${b.priority}, срок ${fmtDate(b.deadline)})`,
        });
      }
    }
  }

  for (const t of active) {
    const why = unschedulable.get(t.id);
    if (why) { errors.push({ code: 'no_executor', task_id: t.id, message: `«${t.description}»: ${why}` }); continue; }
    const s = scheduleByTask.get(t.id);
    if (s && t.deadline && s.end_at > t.deadline) {
      errors.push({ code: 'late', task_id: t.id, message: `«${t.description}»: по загрузке сотрудников закончится ${fmtDate(s.end_at)}, а срок — ${fmtDate(t.deadline)}. Измените срок, приоритет или исполнителя` });
    }
  }

  // Порядок: ремонт не может начаться до окончания осмотра/мойки этого ТС (при ручной фиксации)
  for (const a of active) {
    const sa = scheduleByTask.get(a.id);
    if (!sa) continue;
    for (const b of active) {
      if (b.vehicle_type !== a.vehicle_type || b.vehicle_id !== a.vehicle_id || b.seq >= a.seq) continue;
      const sb = scheduleByTask.get(b.id);
      if (sb && sa.start_at < sb.end_at) {
        errors.push({ code: 'sequence', task_id: a.id, message: `«${a.description}» начинается раньше окончания «${b.description}» (сначала мойка/осмотр, потом ремонт)` });
        break;
      }
    }
  }
  return errors;
}
