import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Check, X, Plus, Trash2, AlertTriangle, MapPin, Lightbulb, ClipboardCheck, Wrench, RotateCcw } from 'lucide-react';
import * as api from '../api.js';
import { useApp } from '../App.jsx';
import { hours, inputToIso, isoToInput, km, money, plate, PRIORITY, VEH } from '../format.js';
import { Badge, Button, Card, cx, Empty, Field, SearchSelect, Spinner, useAction, useLoad, useToast } from '../ui/kit.jsx';
import { VehicleForm } from './Vehicles.jsx';

const DRAFT_KEY = 'ff_defect_draft';
const wtName = (key) => key.split('::')[1];

function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; }
}

export default function DefectSheet() {
  const { checklist } = useApp();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const tractors = useLoad(() => api.get('/vehicles/tractor'));
  const trailers = useLoad(() => api.get('/vehicles/trailer'));
  const works = useLoad(() => api.get('/work-types'));
  const employees = useLoad(() => api.get('/employees'));
  const { user } = useApp();

  const [draftAvailable, setDraftAvailable] = useState(() => !params.get('tractor') && !params.get('trailer') && !!loadDraft());
  const [head, setHead] = useState(() => ({
    tractor_id: params.get('tractor') ? Number(params.get('tractor')) : null,
    trailer_id: params.get('trailer') ? Number(params.get('trailer')) : null,
    inspected_at: isoToInput(new Date().toISOString()),
    release_deadline: '',
    tractor_mileage: '', trailer_mileage: '', reefer_hours: '', notes: '',
    inspector_id: null,
  }));
  const [items, setItems] = useState({});
  const [extra, setExtra] = useState([]);
  const [newVehicle, setNewVehicle] = useState(null);
  const [run, busy] = useAction();

  const tractor = (tractors.data || []).find((t) => t.id === head.tractor_id) || null;
  const trailer = (trailers.data || []).find((t) => t.id === head.trailer_id) || null;

  // ТО по выбранному тягачу/прицепу (для пунктов «по пробегу»)
  const tractorInfo = useLoad(() => (head.tractor_id ? api.get(`/vehicles/tractor/${head.tractor_id}`) : Promise.resolve(null)), [head.tractor_id]);
  const trailerInfo = useLoad(() => (head.trailer_id ? api.get(`/vehicles/trailer/${head.trailer_id}`) : Promise.resolve(null)), [head.trailer_id]);

  // выбор тягача подставляет сцепленный прицеп
  const chooseTractor = (id) => {
    const t = (tractors.data || []).find((x) => x.id === id);
    setHead((h) => ({ ...h, tractor_id: id, trailer_id: t?.trailer_id ?? h.trailer_id, tractor_mileage: '' }));
  };
  useEffect(() => {
    if (head.tractor_id && tractor && !head.trailer_id && tractor.trailer_id) setHead((h) => ({ ...h, trailer_id: tractor.trailer_id }));
  }, [tractor]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (user?.employee_id && !head.inspector_id) setHead((h) => ({ ...h, inspector_id: user.employee_id }));
  }, [user?.employee_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // автосохранение черновика
  useEffect(() => {
    if (draftAvailable) return;
    const has = head.tractor_id || head.trailer_id || Object.keys(items).length || extra.length;
    try { if (has) localStorage.setItem(DRAFT_KEY, JSON.stringify({ head, items, extra })); } catch { /* */ }
  }, [head, items, extra, draftAvailable]);

  const setItem = (id, patch) => setItems((s) => {
    const next = { ...(s[id] || {}), ...patch };
    const filled = (v) => v !== '' && v != null;
    const empty = !next.state && !(next.positions || []).length && !filled(next.value) && !(next.zones || []).length && !next.comment && !(next.options || []).length
      && !(next.values || []).some(filled) && !Object.values(next.measure || {}).some((m) => m && (filled(m.pad) || filled(m.disc))) && !(next.works || []).length && !(next.custom || []).length;
    const copy = { ...s };
    if (empty) delete copy[id]; else copy[id] = next;
    return copy;
  });

  // толщина колодок/дисков: одни и те же данные в пункте «Колодки»/«Диски» и в «Показаниях и замерах»
  const measureItem = checklist?.sections.flatMap((x) => x.items).find((i) => i.kind === 'measure');
  const setMeasure = (code, field, value) => setItems((s) => {
    const cur = s.br_measure?.measure || {};
    return { ...s, br_measure: { ...(s.br_measure || {}), measure: { ...cur, [code]: { ...(cur[code] || {}), [field]: value } } } };
  });

  const body = useMemo(() => ({
    tractor_id: head.tractor_id, trailer_id: head.trailer_id,
    inspected_at: inputToIso(head.inspected_at), release_deadline: inputToIso(head.release_deadline),
    tractor_mileage: head.tractor_mileage === '' ? null : Number(head.tractor_mileage),
    trailer_mileage: head.trailer_mileage === '' ? null : Number(head.trailer_mileage),
    reefer_hours: head.reefer_hours === '' ? null : Number(head.reefer_hours),
    notes: head.notes || null,
    inspector_id: head.inspector_id || null,
    defects: { items, extra: extra.filter((e) => e.work_type_id), custom: extra.filter((e) => !e.work_type_id && e.name) },
  }), [head, items, extra]);

  // живой предпросмотр плана
  const [preview, setPreview] = useState(null);
  const [previewErr, setPreviewErr] = useState(null);
  const timer = useRef(null);
  useEffect(() => {
    if (!head.tractor_id && !head.trailer_id) { setPreview(null); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const p = await api.post('/orders/preview', body, { offline: false });
        setPreview(p); setPreviewErr(null);
      } catch (e) { setPreviewErr(e.status === 0 ? 'Предпросмотр плана недоступен без сети — дефектовка будет сохранена и обработана после синхронизации' : e.message); }
    }, 350);
    return () => clearTimeout(timer.current);
  }, [body, head.tractor_id, head.trailer_id]);

  const submit = () => run(async () => {
    if (!head.tractor_id && !head.trailer_id) throw new Error('Выберите тягач и/или прицеп');
    if (head.tractor_id && head.tractor_mileage === '') throw new Error('Укажите пробег тягача');
    if (!head.inspector_id) throw new Error('Укажите, кто провёл дефектовку');
    if (tractor?.mileage && head.tractor_mileage !== '' && Number(head.tractor_mileage) < tractor.mileage) {
      if (!window.confirm(`Пробег ${head.tractor_mileage} км меньше последнего записанного (${tractor.mileage} км). Продолжить?`)) return null;
    }
    const r = await api.post('/orders', body, { label: `Дефектовка ${plate(tractor?.plate || trailer?.plate)}` });
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* */ }
    if (r?.queued) { nav('/orders'); return r; }
    toast(`Ремонт ${r.number} создан: ${r.tasks.length} работ`);
    nav(`/orders/${r.id}`);
    return null;
  });

  const reset = () => {
    setItems({}); setExtra([]);
    setHead((h) => ({ ...h, tractor_id: null, trailer_id: null, tractor_mileage: '', trailer_mileage: '', reefer_hours: '', release_deadline: '', notes: '' }));
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* */ }
  };

  if (!checklist || tractors.loading || trailers.loading) return <Spinner />;

  const maintByKey = {};
  for (const m of tractorInfo.data?.maintenance || []) maintByKey[`tractor:${m.key}`] = m;
  for (const m of trailerInfo.data?.maintenance || []) maintByKey[`trailer:${m.key}`] = m;

  // подсветка связанных пунктов
  const allItems = checklist.sections.flatMap((s) => s.items);
  const isMarked = (it, a) => a && (a.state === 'defect' || (a.positions || []).length || (it.kind === 'volt' && a.value !== '' && a.value != null && (Number(a.value) < it.min || Number(a.value) > it.max))
    || (it.kind === 'circuits' && circuitsBad(it, a)));
  const hints = {};
  for (const it of allItems) {
    if (!isMarked(it, items[it.id])) continue;
    for (const rel of it.relatedItems || []) {
      const ra = items[rel];
      const checked = ra && (ra.state || (ra.positions || []).length || (ra.value != null && ra.value !== '') || (ra.values || []).some((v) => v !== '' && v != null));
      if (!checked) (hints[rel] = hints[rel] || []).push(it.label);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Дефектная ведомость</h1>
        <div className="row gap-s">
          <Button variant="ghost" icon={RotateCcw} onClick={reset}>Очистить</Button>
        </div>
      </div>

      {draftAvailable && (
        <div className="alert alert-blue">
          <div>Есть несохранённый черновик дефектовки.</div>
          <div className="row gap-s">
            <Button size="sm" variant="primary" onClick={() => { const d = loadDraft(); if (d) { setHead(d.head); setItems(d.items || {}); setExtra(d.extra || []); } setDraftAvailable(false); }}>Восстановить</Button>
            <Button size="sm" onClick={() => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* */ } setDraftAvailable(false); }}>Начать заново</Button>
          </div>
        </div>
      )}

      <div className="defect-layout">
        <div className="defect-main">
          <Card title="Транспортное средство">
            <div className="form-grid">
              <VehiclePicker kind="tractor" list={tractors.data || []} value={head.tractor_id} onChange={chooseTractor} onNew={() => setNewVehicle('tractor')} />
              <VehiclePicker kind="trailer" list={trailers.data || []} value={head.trailer_id} onChange={(v) => setHead((h) => ({ ...h, trailer_id: v }))} onNew={() => setNewVehicle('trailer')} />
              {tractor && (
                <Field label="Пробег тягача, км *" hint={tractor.mileage ? `Последний: ${km(tractor.mileage)}` : 'Пробег ещё не записывался'}>
                  <input className="input" type="number" inputMode="numeric" value={head.tractor_mileage} onChange={(e) => setHead((h) => ({ ...h, tractor_mileage: e.target.value }))} />
                </Field>
              )}
              {trailer && (
                <Field label="Пробег прицепа, км" hint={trailer.mileage ? `Последний: ${km(trailer.mileage)}` : 'необязательно'}>
                  <input className="input" type="number" inputMode="numeric" value={head.trailer_mileage} onChange={(e) => setHead((h) => ({ ...h, trailer_mileage: e.target.value }))} />
                </Field>
              )}
              {trailer?.has_reefer ? (
                <Field label="Реф. установка, м/ч">
                  <input className="input" type="number" value={head.reefer_hours} onChange={(e) => setHead((h) => ({ ...h, reefer_hours: e.target.value }))} />
                </Field>
              ) : null}
              <Field label="Дефектовку провёл *">
                <SearchSelect value={head.inspector_id} onChange={(v) => setHead((h) => ({ ...h, inspector_id: v }))} placeholder="Выберите сотрудника"
                  options={(employees.data || []).filter((e) => e.active && !e.is_external).map((e) => ({ value: e.id, label: `${e.name}${e.position ? ` — ${e.position}` : ''}` }))} />
              </Field>
              <Field label="Дата составления">
                <input className="input" type="datetime-local" value={head.inspected_at} onChange={(e) => setHead((h) => ({ ...h, inspected_at: e.target.value }))} />
              </Field>
              <Field label="Дата/время выпуска с ремонта" hint="Если не указать — сроки по приоритетам">
                <input className="input" type="datetime-local" value={head.release_deadline} onChange={(e) => setHead((h) => ({ ...h, release_deadline: e.target.value }))} />
              </Field>
            </div>
          </Card>

          {!tractor && !trailer && (
            <div className="alert alert-blue">Сначала выберите тягач и/или прицеп в блоке «Транспортное средство» — по числу осей и типу тормозов появятся схемы колёс, замеры колодок и дисков, давление в контурах.</div>
          )}
          {(tractor || trailer) && checklist.sections.map((s) => {
            const visible = s.items.filter((it) => it.vehicle === 'any' || (it.vehicle === 'tractor' ? !!tractor : !!trailer));
            if (!visible.length) return null;
            const simple = visible.filter((it) => it.kind === 'pm' || it.kind === 'yesno');
            return (
              <Card key={s.id} title={s.title} className="defect-section" actions={simple.length > 1 && (
                <Button size="sm" variant="ghost" icon={Check} onClick={() => simple.forEach((it) => { if (!items[it.id]?.state) setItem(it.id, { state: 'ok' }); })}>Остальное в норме</Button>
              )}>
                {s.note && <p className="muted small">{s.note}</p>}
                <div className="items">
                  {visible.map((it) => (
                    <ItemRow key={it.id} item={it} ans={items[it.id] || {}} onChange={(p) => setItem(it.id, p)}
                      tractor={tractor} trailer={trailer} hint={hints[it.id]} damageZones={checklist.damageZones}
                      maint={it.maint ? maintByKey[`${it.vehicle === 'trailer' ? 'trailer' : 'tractor'}:${it.maint}`] : null}
                      mileageNow={it.vehicle === 'trailer' ? head.trailer_mileage : head.tractor_mileage} catalog={works.data || []}
                      measure={items.br_measure?.measure || {}} onMeasure={setMeasure} padMin={measureItem?.padMin} discMin={measureItem?.discMin} />
                  ))}
                </div>
              </Card>
            );
          })}

          <Card title="Повреждения или требуется ремонт — дополнительные работы">
            <ExtraWorks extra={extra} setExtra={setExtra} works={works.data || []} tractor={tractor} trailer={trailer} />
            <Field label="Примечание к дефектовке">
              <textarea className="input" rows={2} value={head.notes} onChange={(e) => setHead((h) => ({ ...h, notes: e.target.value }))} />
            </Field>
          </Card>
        </div>

        <aside className="defect-side">
          <PlanPreview preview={preview} error={previewErr} hasVehicle={!!(tractor || trailer)} />
          <Button variant="primary" size="lg" icon={ClipboardCheck} className="w-full" loading={busy} onClick={submit} disabled={!tractor && !trailer}>
            Сформировать план ремонта
          </Button>
        </aside>
      </div>

      {newVehicle && <VehicleForm type={newVehicle} onClose={() => setNewVehicle(null)} onSaved={async (id) => {
        const t = newVehicle;
        setNewVehicle(null);
        if (t === 'tractor') { await tractors.reload(true); if (id) chooseTractor(id); } else { await trailers.reload(true); if (id) setHead((h) => ({ ...h, trailer_id: id })); }
      }} />}
    </div>
  );
}

// Выбор ТС как в бумажной ведомости: сначала марка и модель, затем госномер
const modelKey = (v) => `${v.brand || ''} ${v.model || ''}`.replace(/\s+/g, ' ').trim() || 'Без марки';

function VehiclePicker({ kind, list, value, onChange, onNew }) {
  const selected = list.find((v) => v.id === value) || null;
  const [model, setModel] = useState(null);
  useEffect(() => { if (selected) setModel(modelKey(selected)); }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const models = useMemo(() => {
    const m = new Map();
    for (const v of list) m.set(modelKey(v), (m.get(modelKey(v)) || 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'));
  }, [list]);
  const filtered = model ? list.filter((v) => modelKey(v) === model) : list;
  const isTractor = kind === 'tractor';
  const chooseModel = (m) => {
    setModel(m);
    if (selected && modelKey(selected) !== m) onChange(null);
  };
  return (
    <>
      <Field label={isTractor ? 'Марка и модель тягача' : 'Марка и модель полуприцепа (п/п)'}>
        <SearchSelect clearable value={model} onChange={chooseModel} placeholder={isTractor ? 'Выберите марку и модель' : 'Без прицепа'}
          options={models.map(([k, n]) => ({ value: k, label: `${k} (${n})` }))} />
      </Field>
      <Field label={isTractor ? 'Госномер тягача' : 'Госномер полуприцепа'}>
        <div className="row gap-s">
          <SearchSelect clearable value={value} onChange={onChange}
            placeholder={model ? 'Выберите госномер' : isTractor ? 'Сначала марка и модель (или поиск по номеру)' : 'Без прицепа'}
            options={filtered.map((v) => ({ value: v.id, label: model ? plate(v.plate) : `${plate(v.plate)} — ${modelKey(v)}`, search: v.plate }))} />
          <Button icon={Plus} title={isTractor ? 'Новый тягач' : 'Новый прицеп'} onClick={onNew} />
        </div>
      </Field>
    </>
  );
}

function Seg({ value, onChange, options }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} type="button" className={cx('seg-btn', value === o.value && `on-${o.tone || 'blue'}`)}
          onClick={() => onChange(value === o.value ? null : o.value)}>
          {o.icon && <o.icon size={14} />} {o.label}
        </button>
      ))}
    </div>
  );
}

function AxleMap({ veh, axles, value, onChange, label, measureField, measure = {}, onMeasure, min }) {
  const toggle = (code) => onChange(value.includes(code) ? value.filter((x) => x !== code) : [...value, code]);
  const mm = (code) => measure[code]?.[measureField];
  return (
    <div className="axlemap">
      <div className="axlemap-title">{label}</div>
      <div className="axlemap-body">
        {Array.from({ length: axles }, (_, i) => i + 1).map((a) => (
          <div className="axle" key={a}>
            {['L', 'R'].map((side, idx) => {
              const code = `${veh}:${a}:${side}`;
              const on = value.includes(code);
              const v = measureField ? mm(code) : null;
              const btn = (
                <button key={side} type="button" className={cx('wheel', on && 'on', measureField && v !== '' && v != null && 'has-mm')} onClick={() => toggle(code)} title={`Ось ${a}, ${side === 'L' ? 'левая' : 'правая'} сторона`}>
                  {side === 'L' ? 'Л' : 'П'}{measureField && v !== '' && v != null ? <small>{String(v).replace('.', ',')}</small> : null}
                </button>
              );
              return idx === 0 ? [btn, <span key="bar" className="axle-bar">ось {a}</span>] : btn;
            })}
          </div>
        ))}
      </div>
      {measureField && value.filter((c) => c.startsWith(`${veh}:`)).length > 0 && (
        <div className="wheel-mm">
          {value.filter((c) => c.startsWith(`${veh}:`)).map((code) => {
            const [, a, side] = code.split(':');
            const n = mm(code);
            const bad = n !== '' && n != null && min != null && Number(n) < min;
            return (
              <label key={code} className="wheel-mm-row">
                <span>Ось {a}, {side === 'L' ? 'лев.' : 'прав.'} — {measureField === 'pad' ? 'толщина колодки' : 'толщина диска'}</span>
                <span className="volt">
                  <input className={cx('input input-sm mm', bad && 'input-bad')} type="number" step="0.5" inputMode="decimal" value={n ?? ''} placeholder="мм"
                    onChange={(e) => onMeasure(code, measureField, e.target.value)} />
                  <span>мм</span>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

const numOrNull = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
function circuitsBad(item, ans) {
  const vals = (ans.values || []).map(numOrNull).filter((v) => v != null);
  if (!vals.length) return false;
  return vals.some((v) => v < item.min || v > item.max) || (item.maxDelta != null && vals.length > 1 && Math.max(...vals) - Math.min(...vals) > item.maxDelta);
}

// Замеры колодок и дисков по осям: колодка / диск, мм
function MeasureTable({ veh, vehicle, value, onChange, item }) {
  const axles = vehicle.axles || (veh === 'tractor' ? 2 : 3);
  const drum = vehicle.brake_type === 'drum';
  const cell = (code, field, min) => {
    const v = value[code]?.[field] ?? '';
    const n = numOrNull(v);
    return (
      <input className={cx('input input-sm mm', n != null && n < min && 'input-bad', n != null && n >= min && 'input-good')} type="number" step="0.5" inputMode="decimal"
        value={v} placeholder="мм" aria-label={`${field === 'pad' ? 'Колодка' : 'Диск'} ${code}`}
        onChange={(e) => onChange({ ...value, [code]: { ...(value[code] || {}), [field]: e.target.value } })} />
    );
  };
  return (
    <div className="measure">
      <div className="axlemap-title">{veh === 'tractor' ? 'Тягач' : 'Прицеп'} {plate(vehicle.plate)}{drum ? ' (барабанные — только колодки)' : ''}</div>
      <table className="measure-table">
        <thead><tr><th /><th colSpan={drum ? 1 : 2}>Левая сторона</th><th colSpan={drum ? 1 : 2}>Правая сторона</th></tr>
          <tr><th /><th>колодка</th>{!drum && <th>диск</th>}<th>колодка</th>{!drum && <th>диск</th>}</tr></thead>
        <tbody>
          {Array.from({ length: axles }, (_, i) => i + 1).map((a) => (
            <tr key={a}>
              <th>Ось {a}</th>
              {['L', 'R'].map((side) => {
                const code = `${veh}:${a}:${side}`;
                return [<td key={`${side}p`}>{cell(code, 'pad', item.padMin)}</td>, !drum && <td key={`${side}d`}>{cell(code, 'disc', item.discMin)}</td>];
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ItemRow({ item, ans, onChange, tractor, trailer, hint, damageZones, maint, mileageNow, catalog = [], measure, onMeasure, padMin, discMin }) {
  let defect = false;
  let control;
  if (item.kind === 'pm') {
    defect = ans.state === 'defect';
    control = <Seg value={ans.state} onChange={(v) => onChange({ state: v })} options={[{ value: 'ok', label: 'Норма', icon: Check, tone: 'green' }, { value: 'defect', label: 'Дефект', icon: X, tone: 'red' }]} />;
  } else if (item.kind === 'yesno') {
    defect = ans.state === 'defect';
    control = <Seg value={ans.state} onChange={(v) => onChange({ state: v })} options={[{ value: 'ok', label: 'Нет', tone: 'green' }, { value: 'defect', label: 'Есть', tone: 'red' }]} />;
  } else if (item.kind === 'volt') {
    const v = ans.value === '' || ans.value == null ? null : Number(ans.value);
    defect = v != null && (v < item.min || v > item.max);
    control = (
      <div className="volt">
        <input className={cx('input', defect && 'input-bad', v != null && !defect && 'input-good')} type="number" step="0.1" inputMode="decimal"
          value={ans.value ?? ''} onChange={(e) => onChange({ value: e.target.value })} placeholder={`${item.min}–${item.max}`} />
        <span>{item.unit}</span>
      </div>
    );
  } else if (item.kind === 'mileage') {
    const overdue = maint?.status === 'overdue';
    const state = ans.state ?? (overdue ? 'defect' : null);
    defect = state === 'defect';
    let remaining = maint?.remaining_km;
    if (maint?.next_km != null && mileageNow !== '' && mileageNow != null) remaining = maint.next_km - Number(mileageNow);
    control = (
      <div className="row gap-s wrap">
        <Seg value={state} onChange={(v) => onChange({ state: v })} options={[{ value: 'ok', label: 'Не требуется', tone: 'green' }, { value: 'defect', label: 'Выполнить', tone: 'red' }]} />
        {maint ? (
          <span className={cx('small', remaining != null && remaining <= 0 ? 'text-red' : 'muted')}>
            {maint.next_km != null ? `след. на ${km(maint.next_km)}` : ''}{remaining != null ? ` · ${remaining <= 0 ? 'просрочено на ' + km(-remaining) : 'осталось ' + km(remaining)}` : ''}{maint.estimated ? ' (оценка)' : ''}
          </span>
        ) : <span className="muted small">нет правила ТО</span>}
      </div>
    );
  } else if (item.kind === 'positions') {
    const value = ans.positions || [];
    defect = value.length > 0;
    control = (
      <div className="axlemaps">
        {tractor && <AxleMap veh="tractor" label={`Тягач ${plate(tractor.plate)}`} axles={tractor.axles || 2} value={value} onChange={(p) => onChange({ positions: p })}
          measureField={item.measureField === 'disc' && tractor.brake_type === 'drum' ? null : item.measureField} measure={measure} onMeasure={onMeasure} min={item.measureField === 'disc' ? discMin : padMin} />}
        {trailer && <AxleMap veh="trailer" label={`Прицеп ${plate(trailer.plate)}`} axles={trailer.axles || 3} value={value} onChange={(p) => onChange({ positions: p })}
          measureField={item.measureField === 'disc' && trailer.brake_type === 'drum' ? null : item.measureField} measure={measure} onMeasure={onMeasure} min={item.measureField === 'disc' ? discMin : padMin} />}
      </div>
    );
  } else if (item.kind === 'circuits') {
    const vals = ans.values || [];
    defect = circuitsBad(item, ans);
    control = (
      <div className="circuits">
        {item.circuits.map((c, i) => {
          const n = numOrNull(vals[i]);
          const bad = n != null && (n < item.min || n > item.max);
          return (
            <label key={c} className="circuit">
              <span className="small muted">{c}</span>
              <span className="volt">
                <input className={cx('input', bad && 'input-bad', n != null && !bad && 'input-good')} type="number" step="0.1" inputMode="decimal"
                  value={vals[i] ?? ''} placeholder={`${item.min}–${item.max}`}
                  onChange={(e) => { const next = [...vals]; next[i] = e.target.value; onChange({ values: next }); }} />
                <span>{item.unit}</span>
              </span>
            </label>
          );
        })}
      </div>
    );
  } else if (item.kind === 'measure') {
    const value = ans.measure || {};
    const low = Object.entries(value).filter(([code, v]) => {
      const veh = code.split(':')[0];
      const vrec = veh === 'tractor' ? tractor : trailer;
      const pad = numOrNull(v?.pad), disc = numOrNull(v?.disc);
      return vrec && ((pad != null && pad < item.padMin) || (disc != null && vrec.brake_type !== 'drum' && disc < item.discMin));
    });
    defect = low.length > 0;
    control = (
      <div className="axlemaps">
        {tractor && <MeasureTable veh="tractor" vehicle={tractor} value={value} item={item} onChange={(m) => onChange({ measure: m })} />}
        {trailer && <MeasureTable veh="trailer" vehicle={trailer} value={value} item={item} onChange={(m) => onChange({ measure: m })} />}
        {defect && <div className="text-red small w-100">Ниже нормы: {low.length} поз. — замена будет добавлена в план автоматически (пункты «Колодки» / «Тормозные диски»)</div>}
      </div>
    );
  } else if (item.kind === 'damage') {
    const zones = ans.zones || [];
    defect = zones.length > 0;
    control = (
      <div className="chips">
        {damageZones.map((z) => (
          <button key={z} type="button" className={cx('chip', zones.includes(z) && 'on')}
            onClick={() => onChange({ zones: zones.includes(z) ? zones.filter((x) => x !== z) : [...zones, z] })}>{z}</button>
        ))}
      </div>
    );
  }

  const wide = ['positions', 'damage', 'measure', 'circuits'].includes(item.kind);
  const pickedWorks = (ans.works || []).map((id) => catalog.find((w) => w.id === id)).filter(Boolean);
  return (
    <div className={cx('item', defect && 'item-defect', hint && !defect && 'item-hint', wide && 'item-wide')}>
      <div className="item-head">
        <div className="item-label">
          {item.label}
          {item.priority === 1 && <Badge tone="red" title="Критично для безопасности">!</Badge>}
          {item.hint && <div className="muted small">{item.hint}</div>}
          {hint && !defect && <div className="text-amber small"><Lightbulb size={13} /> Проверьте: связано с «{hint.join('», «')}»</div>}
        </div>
        <div className="item-control">{control}</div>
      </div>
      {item.kind === 'mileage' && (
        <div className="item-extra">
          <div className="small muted">Отдельные работы (можно добавить, даже если полное ТО не требуется): выберите из списка или впишите вручную</div>
          {pickedWorks.length > 0 && (
            <div className="chips">
              {pickedWorks.map((w) => (
                <button key={w.id} type="button" className="chip on" title="Убрать" onClick={() => onChange({ works: ans.works.filter((x) => x !== w.id) })}>{w.name} ×</button>
              ))}
            </div>
          )}
          {(ans.custom || []).length > 0 && (
            <div className="chips">
              {ans.custom.map((c, i) => (
                <button key={i} type="button" className="chip on" title="Убрать" onClick={() => onChange({ custom: ans.custom.filter((_, j) => j !== i) })}>{c.name} · {c.hours} ч ×</button>
              ))}
            </div>
          )}
          <ManualWork onAdd={(c) => onChange({ custom: [...(ans.custom || []), c] })} />
          <div className="pick-work">
            <SearchSelect value={null} onChange={(id) => id && !(ans.works || []).includes(id) && onChange({ works: [...(ans.works || []), id] })}
              groupBy="category" placeholder="+ Добавить работу из списка…"
              options={catalog.filter((w) => w.applies_to !== (item.vehicle === 'trailer' ? 'tractor' : 'trailer')).map((w) => ({ value: w.id, label: w.name, category: w.category, search: w.code }))} />
          </div>
        </div>
      )}
      {defect && item.kind !== 'damage' && item.kind !== 'measure' && (
        <div className="item-extra">
          {item.zone && <div className="zone"><MapPin size={14} /> {item.zone.replace('{pos}', (ans.positions || []).length ? 'отмеченные позиции' : 'узел')}</div>}
          {item.checks?.length > 0 && <div className="muted small">Проверить также: {item.checks.join('; ')}</div>}
          {item.options?.length > 0 && (
            <div className="opts">
              <span className="small muted">Добавить работы:</span>
              {item.options.map((o) => {
                const on = (ans.options || []).includes(o);
                return (
                  <label key={o} className={cx('chip', on && 'on')}>
                    <input type="checkbox" checked={on} onChange={() => onChange({ options: on ? ans.options.filter((x) => x !== o) : [...(ans.options || []), o] })} />
                    {wtName(o)}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}
      {(defect || ans.comment) && (
        <input className="input input-sm comment" placeholder="Комментарий (что именно обнаружено)" value={ans.comment || ''} onChange={(e) => onChange({ comment: e.target.value })} />
      )}
    </div>
  );
}

// Работа, которой нет в справочнике: название и норма времени
function ManualWork({ onAdd }) {
  const [name, setName] = useState('');
  const [hours, setHours] = useState('1');
  const add = () => {
    if (!name.trim()) return;
    onAdd({ name: name.trim(), hours: Number(String(hours).replace(',', '.')) || 1 });
    setName(''); setHours('1');
  };
  return (
    <div className="manual-work">
      <input className="input input-sm" placeholder="Вписать работу вручную…" value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
      <input className="input input-sm mm" type="number" step="0.1" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Норма, ч" />
      <span className="small muted">ч</span>
      <Button size="sm" icon={Plus} onClick={add} disabled={!name.trim()}>Добавить</Button>
    </div>
  );
}

function ExtraWorks({ extra, setExtra, works, tractor, trailer }) {
  const [wt, setWt] = useState(null);
  const [veh, setVeh] = useState('tractor');
  const [prio, setPrio] = useState(2);
  const [comment, setComment] = useState('');
  const vehOk = veh === 'tractor' ? tractor : trailer;
  const options = works.filter((w) => w.applies_to === 'any' || w.applies_to === veh)
    .map((w) => ({ value: w.id, label: w.name, category: w.category, search: w.code }));
  const add = () => {
    if (!wt || !vehOk) return;
    setExtra((x) => [...x, { work_type_id: wt, vehicle_type: veh, priority: prio, comment }]);
    setWt(null); setComment('');
  };
  return (
    <div className="extra">
      {extra.length > 0 && (
        <ul className="list">
          {extra.map((e, i) => {
            const w = e.work_type_id ? works.find((x) => x.id === e.work_type_id) : { name: `${e.name} (вручную, ${e.hours} ч)` };
            return (
              <li key={i} className="row between">
                <span><Badge tone={PRIORITY[e.priority].tone}>{PRIORITY[e.priority].short}</Badge> {VEH[e.vehicle_type]}: <b>{w?.name}</b>{e.comment ? ` — ${e.comment}` : ''}</span>
                <button className="icon-btn" onClick={() => setExtra((x) => x.filter((_, j) => j !== i))} aria-label="Убрать"><Trash2 size={15} /></button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="form-grid extra-form">
        <Field label="ТС">
          <select className="input" value={veh} onChange={(e) => setVeh(e.target.value)}>
            <option value="tractor" disabled={!tractor}>Тягач</option>
            <option value="trailer" disabled={!trailer}>Прицеп</option>
          </select>
        </Field>
        <Field label="Приоритет">
          <select className="input" value={prio} onChange={(e) => setPrio(Number(e.target.value))}>
            {[1, 2, 3, 4].map((p) => <option key={p} value={p}>{PRIORITY[p].label}</option>)}
          </select>
        </Field>
        <Field label="Работа (выбор из справочника)" className="span-2">
          <SearchSelect value={wt} onChange={setWt} options={options} groupBy="category" placeholder="Начните вводить название работы…" />
        </Field>
        <Field label="Комментарий" className="span-2"><input className="input" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </div>
      <Button icon={Plus} onClick={add} disabled={!wt || !vehOk}>Добавить работу из справочника</Button>
      <div className="field-label" style={{ marginTop: 12 }}>Нет в справочнике? Впишите вручную (ТС и приоритет — как выбрано выше):</div>
      <ManualWork onAdd={(c) => vehOk && setExtra((x) => [...x, { ...c, vehicle_type: veh, priority: prio, comment }])} />
    </div>
  );
}

function PlanPreview({ preview, error, hasVehicle }) {
  if (!hasVehicle) return <Card title="План ремонта"><Empty icon={Wrench} title="Выберите ТС">План формируется автоматически по мере заполнения ведомости</Empty></Card>;
  if (error) return <Card title="План ремонта"><div className="alert alert-amber">{error}</div></Card>;
  if (!preview) return <Card title="План ремонта"><Spinner label="Расчёт…" /></Card>;
  const { tasks, inspection, recommendations, warnings, damages } = preview;
  const totalH = tasks.reduce((a, t) => a + (t.hours || 0), 0);
  const totalP = tasks.reduce((a, t) => a + (t.price || 0), 0);
  return (
    <Card title="План ремонта (предпросмотр)" className="preview">
      {tasks.length === 0 ? <p className="muted">Отметьте неисправности — работы появятся здесь.</p> : (
        <>
          <div className="preview-sum">
            <div><b>{tasks.length}</b> работ</div>
            <div><b>{hours(totalH)}</b> по норме</div>
            <div><b>{money(totalP)}</b></div>
          </div>
          <ul className="preview-list">
            {tasks.map((t) => (
              <li key={t.key}>
                <Badge tone={PRIORITY[t.priority].tone}>{PRIORITY[t.priority].short}</Badge>
                <div>
                  <div>{t.description}</div>
                  <div className="muted small">{VEH[t.vehicle_type]}{t.location ? ` · ${t.location}` : ''}{t.source === 'related' ? ' · связанная проверка' : ''}</div>
                </div>
                <span className="muted small nowrap">{hours(t.hours)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {inspection.length > 0 && (
        <details className="preview-block" open>
          <summary><MapPin size={14} /> Зоны осмотра ({inspection.length})</summary>
          <ul className="zones">
            {inspection.map((z) => (
              <li key={z.item}><b>{z.label}:</b> {z.zone_text}{z.checks?.length ? <div className="muted small">Также: {z.checks.join('; ')}</div> : null}</li>
            ))}
          </ul>
        </details>
      )}
      {recommendations.length > 0 && (
        <div className="preview-block">
          {recommendations.map((r, i) => <div key={i} className="text-amber small"><Lightbulb size={13} /> {r.text}</div>)}
        </div>
      )}
      {damages.length > 0 && <div className="preview-block small">Зафиксированы повреждения: {damages.map((d) => d.zones.join(', ')).join('; ')}</div>}
      {warnings.length > 0 && (
        <div className="preview-block">
          {warnings.map((w, i) => <div key={i} className="text-red small"><AlertTriangle size={13} /> {w}</div>)}
        </div>
      )}
    </Card>
  );
}
