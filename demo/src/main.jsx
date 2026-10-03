// Точка входа демо: поднимает серверную часть в браузере и запускает обычный интерфейс FiberFleet
import { createRoot } from 'react-dom/client';
import '../../client/src/styles.css';
import iconSvg from '../../client/public/icon.svg?raw';
import { bootDemoServer, installFetch, resetDemo } from './server.js';

const ICON = `data:image/svg+xml;utf8,${encodeURIComponent(iconSvg)}`;

// Иконка приложения: в демо нет отдельных файлов, подставляем встроенную
const fixIcons = (root) => root.querySelectorAll?.('img[src="/icon.svg"]').forEach((img) => { img.src = ICON; });
new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.nodeType === 1 && (n.matches?.('img[src="/icon.svg"]') ? (n.src = ICON) : fixIcons(n))))).observe(document.body, { childList: true, subtree: true });
const link = document.createElement('link');
link.rel = 'icon';
link.href = ICON;
document.head.appendChild(link);

function banner() {
  const el = document.createElement('div');
  el.className = 'demo-banner';
  el.innerHTML = `<b>Демо-версия.</b> Данные — пример по вашему парку, хранятся только в этом браузере.
    Входы: <code>admin / admin</code>, <code>operator / operator</code>, <code>master / master</code>, <code>slastunov / slastunov</code>.
    <button type="button" id="demo-reset">Сбросить данные</button>
    <button type="button" id="demo-hide" aria-label="Скрыть">×</button>`;
  document.body.appendChild(el);
  el.querySelector('#demo-hide').onclick = () => el.remove();
  const btn = el.querySelector('#demo-reset');
  btn.onclick = async () => {
    if (btn.dataset.sure !== '1') { btn.dataset.sure = '1'; btn.textContent = 'Точно сбросить?'; return; }
    await resetDemo();
    location.reload();
  };
}

const style = document.createElement('style');
style.textContent = `.demo-banner{position:fixed;left:12px;right:12px;bottom:12px;z-index:150;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;
background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:10px;padding:8px 12px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)}
.demo-banner code{background:#0f172a;color:#fde68a;padding:1px 6px;border-radius:4px}
.demo-banner button{border:1px solid #475569;background:#334155;color:#fff;border-radius:6px;padding:3px 9px;cursor:pointer;font:inherit}
.demo-banner #demo-hide{margin-left:auto;border:0;background:none;font-size:18px;line-height:1}
@media (max-width:640px){.demo-banner{font-size:12px}}`;
document.head.appendChild(style);

const rootEl = document.getElementById('root');
const root = createRoot(rootEl);
rootEl.innerHTML = '<div class="boot"><div class="spinner">Загрузка FiberFleet…</div></div>';

(async () => {
  try {
    await bootDemoServer();
    installFetch();
    const { default: App } = await import('../../client/src/App.jsx');
    root.render(<App />);
    banner();
  } catch (e) {
    console.error(e);
    rootEl.innerHTML = `<div class="boot"><div class="alert alert-red">Не удалось запустить демо: ${e.message}</div></div>`;
  }
})();
