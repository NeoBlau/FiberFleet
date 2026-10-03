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

  const [draftAvailable, setDraftAvailable] = useState(() => !params.get('tractor') && !params.get('trailer') && !!loadDraft());
  const [head, setHead] = useState(() => ({
    tractor_id: params.get('tractor') ? Number(params.get('tractor')) : null,
    trailer_id: params.get('trailer') ? Number(params.get('trailer')) : null,
    inspected_at: isoToInput(new Date().toISOString()),
    release_deadline: '',
    tractor_mileage: '', trailer_mileage: '', reefer_hours: '', notes: '',
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

  // автосохранение черновика
  useEffect(() => {
    if (draftAvailable) return;
    const has = head.tractor_id || head.trailer_id || Object.keys(items).length || extra.length;
    try { if (has) localStorage.setItem(DRAFT_KEY, JSON.stringify({ head, items, extra })); } catch { /* */ }
  }, [head, items, extra, draftAvailable]);

  const setItem = (id, patch) => setItems((s) => {
    const next = { ...(s[id] || {}), ...patch };
    const empty = !next.state && !(next.positions || []).length && (next.value == null || next.value === '') && !(next.zones || []).length && !next.comment && !(next.options || []).length;
    const copy = { ...s };
    if (empty) delete copy[id]; else copy[id] = next;
    return copy;
  });

  const body = useMemo(() => ({
    tractor_id: head.tractor_id, trailer_id: head.trailer_id,
    inspected_at: inputToIso(head.inspected_at), release_deadline: inputToIso(head.release_deadline),
    tractor_mileage: head.tractor_mileage === '' ? null : Number(head.tractor_mileage),
    trailer_mileage: head.trailer_mileage === '' ? null : Number(head.trailer_mileage),
    reefer_hours: head.reefer_hours === '' ? null : Number(head.reefer_hours),
    notes: head.notes || null,
    defects: { items, extra },
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
  const isMarked = (it, a) => a && (a.state === 'defect' || (a.positions || []).length || (it.kind === 'volt' && a.value !== '' && a.value != null && (Number(a.value) < it.min || Number(a.value) > it.max)));
  const hints = {};
  for (const it of allItems) {
    if (!isMarked(it, items[it.id])) continue;
    for (const rel of it.relatedItems || []) {
      const ra = items[rel];
      const checked = ra && (ra.state || (ra.positions || []).length || (ra.value != null && ra.value !== ''));
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
              <Field label="Тягач (госномер)">
                <div className="row gap-s">
                  <SearchSelect clearable value={head.tractor_id} onChange={chooseTractor} placeholder="Выберите тягач"
                    options={(tractors.data || []).map((t) => ({ value: t.id, label: `${plate(t.plate)} — ${t.brand} ${t.model || ''}`, search: t.plate }))} />
                  <Button icon={Plus} title="Новый тягач" onClick={() => setNewVehicle('tractor')} />
                </div>
              </Field>
              <Field label="Полуприцеп (п/п)">
                <div className="row gap-s">
                  <SearchSelect clearable value={head.trailer_id} onChange={(v) => setHead((h) => ({ ...h, trailer_id: v }))} placeholder="Без прицепа"
                    options={(trailers.data || []).map((t) => ({ value: t.id, label: `${plate(t.plate)} — ${t.brand || ''} ${t.model}`, search: t.plate }))} />
                  <Button icon={Plus} title="Новый прицеп" onClick={() => setNewVehicle('trailer')} />
                </div>
              </Field>
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
              <Field label="Дата составления">
                <input className="input" type="datetime-local" value={head.inspected_at} onChange={(e) => setHead((h) => ({ ...h, inspected_at: e.target.value }))} />
              </Field>
              <Field label="Дата/время выпуска с ремонта" hint="Если не указать — сроки по приоритетам">
                <input className="input" type="datetime-local" value={head.release_deadline} onChange={(e) => setHead((h) => ({ ...h, release_deadline: e.target.value }))} />
              </Field>
            </div>
          </Card>

          {checklist.sections.map((s) => {
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
                      mileageNow={it.vehicle === 'trailer' ? head.trailer_mileage : head.tractor_mileage} />
                  ))}
                </div>
              </Card>
            );
          })}

          <Card title="Повреждения или требуется ремонт — работы из справочника">
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

function AxleMap({ veh, axles, value, onChange, label }) {
  const toggle = (code) => onChange(value.includes(code) ? value.filter((x) => x !== code) : [...value, code]);
  return (
    <div className="axlemap">
      <div className="axlemap-title">{label}</div>
      <div className="axlemap-body">
        {Array.from({ length: axles }, (_, i) => i + 1).map((a) => (
          <div className="axle" key={a}>
            {['L', 'R'].map((side, idx) => {
              const code = `${veh}:${a}:${side}`;
              const on = value.includes(code);
              const btn = <button key={side} type="button" className={cx('wheel', on && 'on')} onClick={() => toggle(code)} title={`Ось ${a}, ${side === 'L' ? 'левая' : 'правая'} сторона`}>{side === 'L' ? 'Л' : 'П'}</button>;
              return idx === 0 ? [btn, <span key="bar" className="axle-bar">ось {a}</span>] : btn;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function ItemRow({ item, ans, onChange, tractor, trailer, hint, damageZones, maint, mileageNow }) {
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
        {tractor && <AxleMap veh="tractor" label={`Тягач ${plate(tractor.plate)}`} axles={tractor.axles || 2} value={value} onChange={(p) => onChange({ positions: p })} />}
        {trailer && <AxleMap veh="trailer" label={`Прицеп ${plate(trailer.plate)}`} axles={trailer.axles || 3} value={value} onChange={(p) => onChange({ positions: p })} />}
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

  const wide = item.kind === 'positions' || item.kind === 'damage';
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
      {defect && item.kind !== 'damage' && (
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
            const w = works.find((x) => x.id === e.work_type_id);
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
      <Button icon={Plus} onClick={add} disabled={!wt || !vehOk}>Добавить работу</Button>
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
