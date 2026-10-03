import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, ChevronDown, Search, Check } from 'lucide-react';

export const cx = (...a) => a.filter(Boolean).join(' ');

export function Badge({ tone = 'gray', children, title }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

export function Button({ variant = 'default', size, icon: Icon, loading, children, className, ...p }) {
  return (
    <button className={cx('btn', `btn-${variant}`, size && `btn-${size}`, className)} disabled={loading || p.disabled} {...p}>
      {loading ? <Loader2 className="spin" size={16} /> : Icon ? <Icon size={16} /> : null}
      {children && <span>{children}</span>}
    </button>
  );
}

export function Spinner({ label = 'Загрузка…' }) {
  return <div className="spinner"><Loader2 className="spin" size={20} /> {label}</div>;
}

export function Empty({ icon: Icon, title, children }) {
  return (
    <div className="empty">
      {Icon && <Icon size={32} strokeWidth={1.5} />}
      <div className="empty-title">{title}</div>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="alert alert-red">
      <div>{error.message || String(error)}</div>
      {onRetry && <Button size="sm" onClick={onRetry}>Повторить</Button>}
    </div>
  );
}

export function Card({ title, actions, children, className, pad = true }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="card-head">
          <h3>{title}</h3>
          {actions && <div className="row gap-s">{actions}</div>}
        </header>
      )}
      <div className={pad ? 'card-body' : ''}>{children}</div>
    </section>
  );
}

export function Field({ label, hint, error, children, className }) {
  return (
    <label className={cx('field', className)}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => { window.removeEventListener('keydown', onKey); document.body.classList.remove('modal-open'); };
  }, [onClose]);
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={cx('modal', wide && 'modal-wide')} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть"><X size={18} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function Tabs({ value, onChange, items }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <button key={it.value} role="tab" aria-selected={value === it.value} className={cx('tab', value === it.value && 'active')} onClick={() => onChange(it.value)}>
          {it.label}{it.count != null && <span className="tab-count">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------- Уведомления ----------
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((text, tone = 'green') => {
    const id = Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), tone === 'red' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast toast-${t.tone}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- Загрузка данных ----------
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async (silent = false) => {
    if (!silent) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fnRef.current();
      setState({ data, loading: false, error: null });
      return data;
    } catch (error) {
      setState((s) => ({ ...s, loading: false, error }));
      return null;
    }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, deps);
  const setData = useCallback((data) => setState((s) => ({ ...s, data: typeof data === 'function' ? data(s.data) : data })), []);
  return { ...state, reload, setData };
}

// Выполнение действия с уведомлением об ошибке/офлайн-очереди
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, okText) => {
    setBusy(true);
    try {
      const res = await fn();
      if (res && res.queued) toast('Нет связи: изменение сохранено и будет отправлено автоматически', 'amber');
      else if (okText) toast(okText);
      return res;
    } catch (e) {
      toast(e.message || 'Ошибка', 'red');
      return null;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return [run, busy];
}

// ---------- Выбор из списка с поиском ----------
export function SearchSelect({ options, value, onChange, placeholder = 'Выберите…', groupBy, render, disabled, clearable, autoFocus }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const ref = useRef(null);
  const inputRef = useRef(null);
  const selected = options.find((o) => o.value === value);
  const filtered = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return options.filter((o) => {
      const hay = `${o.label} ${o.search || ''} ${groupBy ? o[groupBy] || '' : ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    }).slice(0, 300);
  }, [options, q, groupBy]);

  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  useEffect(() => { if (open) { setHi(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  useEffect(() => { if (autoFocus) setOpen(true); }, [autoFocus]);

  const choose = (o) => { onChange(o ? o.value : null, o); setOpen(false); setQ(''); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, filtered.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    if (e.key === 'Enter') { e.preventDefault(); if (filtered[hi]) choose(filtered[hi]); }
    if (e.key === 'Escape') setOpen(false);
  };

  let lastGroup = null;
  return (
    <div className={cx('ss', disabled && 'disabled')} ref={ref}>
      <button type="button" className="ss-trigger input" onClick={() => !disabled && setOpen((o) => !o)} disabled={disabled}>
        <span className={selected ? '' : 'muted'}>{selected ? (render ? render(selected) : selected.label) : placeholder}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="ss-pop">
          <div className="ss-search">
            <Search size={15} />
            <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setHi(0); }} onKeyDown={onKey} placeholder="Поиск…" />
          </div>
          <div className="ss-list">
            {clearable && value != null && <button type="button" className="ss-opt muted" onClick={() => choose(null)}>— не выбрано —</button>}
            {filtered.length === 0 && <div className="ss-empty">Ничего не найдено</div>}
            {filtered.map((o, i) => {
              const g = groupBy ? o[groupBy] : null;
              const head = g && g !== lastGroup ? <div className="ss-group" key={`g-${g}`}>{g}</div> : null;
              lastGroup = g;
              return [head, (
                <button type="button" key={o.value} className={cx('ss-opt', i === hi && 'hi', o.value === value && 'sel')}
                  onMouseEnter={() => setHi(i)} onClick={() => choose(o)}>
                  <span>{render ? render(o) : o.label}</span>
                  {o.value === value && <Check size={14} />}
                </button>
              )];
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function Confirm({ title, text, onConfirm, onClose, danger, confirmText = 'Подтвердить' }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <Button onClick={onClose}>Отмена</Button>
      <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } onClose(); }}>{confirmText}</Button>
    </>}>
      <p>{text}</p>
    </Modal>
  );
}

export function Stat({ label, value, hint, tone }) {
  return (
    <div className={cx('stat', tone && `stat-${tone}`)}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}
