import { Fragment, useMemo, useState } from 'react';
import { Plus, Search, BookOpen } from 'lucide-react';
import * as api from '../api.js';
import { can, useApp } from '../App.jsx';
import { hours, money } from '../format.js';
import { Badge, Button, cx, Empty, ErrorBox, Field, Modal, Spinner, useAction, useLoad } from '../ui/kit.jsx';

const APPLIES = { tractor: 'Тягач', trailer: 'Прицеп', any: 'Любое ТС' };
const range = (a, b, fmt) => (b && b !== a ? `${fmt(a)} – ${fmt(b)}` : fmt(a));

export default function Catalog() {
  const { user } = useApp();
  const canWrite = can(user, 'catalog.write');
  const [showInactive, setShowInactive] = useState(false);
  const { data, loading, error, reload } = useLoad(() => api.get(`/work-types${showInactive ? '?all=1' : ''}`), [showInactive]);
  const emps = useLoad(() => api.get('/employees'));
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [edit, setEdit] = useState(null);
  const cats = useMemo(() => [...new Set((data || []).map((w) => w.category))], [data]);
  const empName = (id) => (emps.data || []).find((e) => e.id === id)?.name || `#${id}`;

  const rows = (data || []).filter((w) => (!cat || w.category === cat) && (!q || `${w.name} ${w.code}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <div className="page">
      <div className="page-head">
        <h1>Справочник работ</h1>
        {canWrite && <Button variant="primary" icon={Plus} onClick={() => setEdit({})}>Новая работа</Button>}
      </div>
      <p className="muted">База фиксированных работ (по прайс-листу): норма времени, цена с НДС, ЗП исполнителя и допуск. Работы выбираются из этого списка при дефектовке и в плане ремонта.</p>
      <div className="toolbar">
        <div className="search"><Search size={16} /><input className="input" placeholder="Название или код" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select className="input w-auto" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">Все категории ({(data || []).length})</option>
          {cats.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Показать отключённые</label>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : rows.length === 0 ? <Empty icon={BookOpen} title="Ничего не найдено" /> : (
        <div className="table-wrap card">
          <table className="table table-click">
            <thead><tr><th>Код</th><th>Работа</th><th>ТС</th><th>Норма</th><th>Цена с НДС</th><th>ЗП</th><th>Допуск</th></tr></thead>
            <tbody>
              {rows.map((w, i) => (
                <Fragment key={w.id}>
                  {(i === 0 || rows[i - 1].category !== w.category) && <tr className="cat-row"><td colSpan={7}>{w.category}</td></tr>}
                  <tr className={cx(!w.active && 'dim')} onClick={() => canWrite && setEdit(w)}>
                    <td className="muted small">{w.code}</td>
                    <td>{w.name}{w.note && <div className="small muted">{w.note}</div>}</td>
                    <td className="small">{APPLIES[w.applies_to]}</td>
                    <td className="nowrap">{range(w.hours, w.hours_max, hours)}</td>
                    <td className="nowrap">{w.price == null ? <span className="muted">к/д</span> : range(w.price, w.price_max, money)}</td>
                    <td className="nowrap">{w.salary == null ? '—' : range(w.salary, w.salary_max, money)}</td>
                    <td className="small">
                      {w.external ? <Badge tone="blue">сервис</Badge> : w.access_all ? 'Все' : w.access.map(empName).join(', ')}
                      {w.required_qualification && <Badge>{w.required_qualification}</Badge>}
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <WorkDialog w={edit} cats={cats} emps={emps.data || []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function WorkDialog({ w, cats, emps, onClose, onSaved }) {
  const [f, setF] = useState({
    code: w.code || '', category: w.category || '', name: w.name || '', applies_to: w.applies_to || 'tractor',
    hours: w.hours ?? '', hours_max: w.hours_max ?? '', price: w.price ?? '', price_max: w.price_max ?? '',
    salary: w.salary ?? '', salary_max: w.salary_max ?? '', access_all: w.id ? !!w.access_all : true, external: !!w.external,
    required_qualification: w.required_qualification || '', note: w.note || '', active: w.id ? !!w.active : true, access: w.access || [],
    apply_to_open: false,
  });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const [run, busy] = useAction();
  return (
    <Modal title={w.id ? w.name : 'Новая работа'} onClose={onClose} wide footer={<>
      {w.id && <Button variant="ghost" onClick={() => run(async () => { const r = await api.del(`/work-types/${w.id}`); onSaved(); return r; }, w.used ? 'Работа отключена (используется в истории)' : 'Удалено')}>{w.used ? 'Отключить' : 'Удалить'}</Button>}
      <span className="grow" />
      <Button onClick={onClose}>Отмена</Button>
      <Button variant="primary" loading={busy} onClick={() => run(async () => {
        const r = w.id ? await api.put(`/work-types/${w.id}`, f) : await api.post('/work-types', f);
        onSaved(); return r;
      }, 'Сохранено')}>Сохранить</Button>
    </>}>
      <div className="form-grid">
        <Field label="Категория">
          <input className="input" list="cats" value={f.category} onChange={set('category')} />
          <datalist id="cats">{cats.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Код"><input className="input" value={f.code} onChange={set('code')} placeholder="авто" /></Field>
        <Field label="Название" className="span-2"><input className="input" value={f.name} onChange={set('name')} /></Field>
        <Field label="Для ТС">
          <select className="input" value={f.applies_to} onChange={set('applies_to')}>{Object.entries(APPLIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </Field>
        <Field label="Особая квалификация" hint="напр. «токарь»"><input className="input" value={f.required_qualification} onChange={set('required_qualification')} /></Field>
        <Field label="Норма, ч"><input className="input" type="number" step="0.05" value={f.hours} onChange={set('hours')} /></Field>
        <Field label="Норма макс., ч"><input className="input" type="number" step="0.05" value={f.hours_max} onChange={set('hours_max')} /></Field>
        <Field label="Цена с НДС, ₽" hint="Пусто — по договорённости"><input className="input" type="number" value={f.price} onChange={set('price')} /></Field>
        <Field label="Цена макс., ₽"><input className="input" type="number" value={f.price_max} onChange={set('price_max')} /></Field>
        <Field label="ЗП, ₽"><input className="input" type="number" value={f.salary} onChange={set('salary')} /></Field>
        <Field label="ЗП макс., ₽"><input className="input" type="number" value={f.salary_max} onChange={set('salary_max')} /></Field>
        <Field label="Примечание" className="span-2"><input className="input" value={f.note} onChange={set('note')} /></Field>
        <label className="check"><input type="checkbox" checked={f.access_all} onChange={set('access_all')} /> Допуск: все сотрудники</label>
        <label className="check"><input type="checkbox" checked={f.external} onChange={set('external')} /> Выполняет сторонний сервис</label>
        <label className="check"><input type="checkbox" checked={f.active} onChange={set('active')} /> Активна</label>
        {w.id && <label className="check"><input type="checkbox" checked={f.apply_to_open} onChange={set('apply_to_open')} /> Применить норму и цену к незапущенным работам</label>}
      </div>
      {!f.access_all && (
        <>
          <div className="field-label">Допущенные сотрудники</div>
          <div className="chips">
            {emps.filter((e) => e.active).map((e) => (
              <button type="button" key={e.id} className={cx('chip', f.access.includes(e.id) && 'on')}
                onClick={() => setF((s) => ({ ...s, access: s.access.includes(e.id) ? s.access.filter((x) => x !== e.id) : [...s.access, e.id] }))}>{e.name}</button>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
