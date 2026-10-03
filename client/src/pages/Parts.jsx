import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Upload, Download, Plus, Search, Package, Pencil } from 'lucide-react';
import * as api from '../api.js';
import { dateToIso, fmtDate, fmtDateTime, isoToDateInput, money, plate } from '../format.js';
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, Spinner, Tabs, useAction, useLoad, useToast } from '../ui/kit.jsx';

export default function Parts() {
  const [tab, setTab] = useState('installed');
  return (
    <div className="page">
      <div className="page-head"><h1>Запчасти и обмен с 1С</h1></div>
      <Tabs value={tab} onChange={setTab} items={[
        { value: 'installed', label: 'Установленные запчасти' },
        { value: 'catalog', label: 'Номенклатура' },
        { value: 'exchange', label: 'Обмен с 1С' },
      ]} />
      {tab === 'installed' && <Installed />}
      {tab === 'catalog' && <Nomenclature />}
      {tab === 'exchange' && <Exchange />}
    </div>
  );
}

const monthStart = () => { const d = new Date(); return isoToDateInput(new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1, 12)).toISOString()); };
const today = () => isoToDateInput(new Date().toISOString());
const nextDay = (v) => (v ? new Date(new Date(dateToIso(v)).getTime() + 86400000).toISOString() : undefined);

function Installed() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [onlyNew, setOnlyNew] = useState(false);
  const { data, loading, error, reload } = useLoad(() => api.get(`/installed-parts${api.qs({ from: dateToIso(from), to: nextDay(to), only_new: onlyNew ? 1 : '' })}`), [from, to, onlyNew]);
  const total = (data || []).reduce((a, p) => a + (p.price || 0) * p.qty, 0);
  return (
    <>
      <div className="toolbar">
        <Field label="С"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="По"><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <label className="check"><input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} /> Только не выгруженные в 1С</label>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : !data?.length ? <Empty icon={Package} title="За период запчасти не устанавливались">Запчасти добавляются в карточке ремонта</Empty> : (
        <div className="table-wrap card">
          <table className="table">
            <thead><tr><th>Дата</th><th>Ремонт</th><th>ТС</th><th>Код 1С</th><th>Артикул</th><th>Наименование</th><th>Кол-во</th><th>Цена</th><th>Сумма</th><th>Источник</th><th>1С</th></tr></thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td className="nowrap">{fmtDateTime(p.installed_at)}</td>
                  <td>{p.order_id ? <Link to={`/orders/${p.order_id}`}>{p.order_number}</Link> : '—'}</td>
                  <td>{plate(p.plate)}</td><td>{p.code || '—'}</td><td>{p.article || '—'}</td><td>{p.name}<div className="small muted">{p.work}</div></td>
                  <td>{p.qty} {p.unit}</td><td>{money(p.price)}</td><td>{money((p.price || 0) * p.qty)}</td>
                  <td>{p.source === '1c' ? <Badge tone="blue">1С</Badge> : <Badge>вручную</Badge>}</td>
                  <td>{p.exported_at ? <Badge tone="green">{fmtDate(p.exported_at)}</Badge> : <Badge>нет</Badge>}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={8}><b>Итого</b></td><td><b>{money(total)}</b></td><td colSpan={2} /></tr></tfoot>
          </table>
        </div>
      )}
    </>
  );
}

function Nomenclature() {
  const [q, setQ] = useState('');
  const { data, loading, error, reload } = useLoad(() => api.get(`/parts${api.qs({ q, limit: 500 })}`), [q]);
  const [edit, setEdit] = useState(null);
  return (
    <>
      <div className="toolbar">
        <div className="search"><Search size={16} /><input className="input" placeholder="Наименование, код, артикул" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Button icon={Plus} onClick={() => setEdit({})}>Добавить</Button>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : !data?.length ? <Empty icon={Package} title="Номенклатура пуста">Загрузите её из 1С на вкладке «Обмен с 1С»</Empty> : (
        <div className="table-wrap card">
          <table className="table">
            <thead><tr><th>Код 1С</th><th>Артикул</th><th>Наименование</th><th>Ед.</th><th>Цена</th><th>Источник</th><th>Установлено</th><th /></tr></thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td>{p.code || '—'}</td><td>{p.article || '—'}</td><td>{p.name}</td><td>{p.unit}</td><td>{money(p.price)}</td>
                  <td>{p.source === '1c' ? <Badge tone="blue">1С</Badge> : <Badge>вручную</Badge>}</td>
                  <td>{p.installed_qty || 0}</td>
                  <td><button className="icon-btn" onClick={() => setEdit(p)} aria-label="Изменить"><Pencil size={15} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <PartDialog part={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}

function PartDialog({ part, onClose, onSaved }) {
  const [f, setF] = useState({ code: part.code || '', article: part.article || '', name: part.name || '', unit: part.unit || 'шт', price: part.price ?? '' });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const [run, busy] = useAction();
  return (
    <Modal title={part.id ? 'Запчасть' : 'Новая запчасть'} onClose={onClose} footer={<>
      {part.id && <Button variant="ghost" onClick={() => run(async () => { const r = await api.del(`/parts/${part.id}`); onSaved(); return r; }, 'Удалено')}>Удалить</Button>}
      <span className="grow" />
      <Button onClick={onClose}>Отмена</Button>
      <Button variant="primary" loading={busy} onClick={() => run(async () => { const r = part.id ? await api.put(`/parts/${part.id}`, f) : await api.post('/parts', f); onSaved(); return r; }, 'Сохранено')}>Сохранить</Button>
    </>}>
      <div className="form-grid">
        <Field label="Наименование" className="span-2"><input className="input" value={f.name} onChange={set('name')} /></Field>
        <Field label="Код 1С"><input className="input" value={f.code} onChange={set('code')} /></Field>
        <Field label="Артикул"><input className="input" value={f.article} onChange={set('article')} /></Field>
        <Field label="Ед. изм."><input className="input" value={f.unit} onChange={set('unit')} /></Field>
        <Field label="Цена, ₽"><input className="input" type="number" value={f.price} onChange={set('price')} /></Field>
      </div>
    </Modal>
  );
}

function Exchange() {
  const file = useRef(null);
  const toast = useToast();
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [onlyNew, setOnlyNew] = useState(true);
  const [mark, setMark] = useState(true);

  const upload = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    setBusy(true);
    try {
      const r = await api.post('/parts/import', fd, { offline: false });
      setResult(r);
      toast(`Загружено: новых ${r.added}, обновлено ${r.updated}`);
    } catch (err) { toast(err.message, 'red'); } finally { setBusy(false); e.target.value = ''; }
  };

  const exp = (format) => api.download(`/onec/export${api.qs({ format, from: dateToIso(from), to: nextDay(to), only_new: onlyNew ? 1 : '', mark: mark ? 1 : '' })}`, `fiberfleet-1c.${format}`)
    .then(() => toast(mark ? 'Файл сформирован, строки отмечены как выгруженные' : 'Файл сформирован'))
    .catch((e) => toast(e.message, 'red'));

  return (
    <div className="grid-2">
      <Card title="Загрузка номенклатуры из 1С">
        <p>Поддерживаемые файлы:</p>
        <ul className="list small">
          <li><b>Excel (.xlsx) или CSV</b> — выгрузка списка номенклатуры из 1С; нужны колонки «Наименование» и, по возможности, «Код», «Артикул», «Ед. изм.», «Цена».</li>
          <li><b>CommerceML (import.xml, offers.xml)</b> — стандартный обмен 1С «Выгрузка на сайт».</li>
        </ul>
        <p className="small muted">Позиции сопоставляются по коду 1С: существующие обновляются, новые добавляются.</p>
        <input ref={file} type="file" accept=".xlsx,.csv,.txt,.xml" hidden onChange={upload} />
        <Button variant="primary" icon={Upload} loading={busy} onClick={() => file.current?.click()}>Выбрать файл</Button>
        {result && <div className="alert alert-green">Всего строк: {result.total}. Добавлено: {result.added}. Обновлено: {result.updated}.</div>}
      </Card>
      <Card title="Выгрузка установленных запчастей в 1С">
        <div className="form-grid">
          <Field label="С"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="По"><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} /> Только ещё не выгруженные</label>
        <label className="check"><input type="checkbox" checked={mark} onChange={(e) => setMark(e.target.checked)} /> Отметить строки как выгруженные</label>
        <div className="row gap-s wrap" style={{ marginTop: 12 }}>
          <Button variant="primary" icon={Download} onClick={() => exp('xml')}>XML для 1С</Button>
          <Button icon={Download} onClick={() => exp('xlsx')}>Excel</Button>
          <Button icon={Download} onClick={() => exp('csv')}>CSV</Button>
        </div>
        <p className="small muted" style={{ marginTop: 12 }}>
          XML группирует строки по ремонтам («Документ» = заказ-наряд с госномером и пробегом) — его загружает обработка на стороне 1С (документ «Требование-накладная» / «Списание»).
          Для автоматического обмена 1С может обращаться к API напрямую: <code>GET /api/onec/export?format=json&amp;only_new=1&amp;mark=1</code> и <code>POST /api/onec/parts</code> (номенклатура JSON), с заголовком <code>Authorization: Bearer &lt;токен&gt;</code>.
        </p>
      </Card>
    </div>
  );
}
