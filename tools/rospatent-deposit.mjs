// Формирует депонируемые материалы для Роспатента: титульный лист + исходный текст программы.
// Если листинг длиннее лимита, берутся первые и последние страницы (всего не более MAX_PAGES вместе с титулом).
//
// Запуск: node tools/rospatent-deposit.mjs [выходной.pdf]
// Данные титульного листа — в tools/rospatent.config.json (создаётся при первом запуске).
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import PDFDocument from 'pdfkit';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs/rospatent/02_Депонируемые_материалы.pdf'));
const CFG = path.join(ROOT, 'tools/rospatent.config.json');
const MAX_PAGES = 70;       // всего страниц в документе, включая титульный лист
const LINES = 50;           // строк на странице
const COLS = 96;            // символов в строке (перенос длинных строк)
const MONO = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const SANS = path.join(ROOT, 'server/fonts/DejaVuSans.ttf');
const SANS_B = path.join(ROOT, 'server/fonts/DejaVuSans-Bold.ttf');
const monoFont = fs.existsSync(MONO) ? MONO : SANS;

if (!fs.existsSync(CFG)) {
  fs.writeFileSync(CFG, JSON.stringify({
    title: 'FiberFleet — система планирования, учёта и контроля сервисного обслуживания тягачей и прицепов',
    version: '1.0',
    rightholder: '[ПРАВООБЛАДАТЕЛЬ: ФИО полностью или наименование организации]',
    authors: ['[АВТОР 1: Фамилия Имя Отчество]'],
    city: '[Город]',
    year: new Date().getFullYear(),
  }, null, 2));
}
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));

// Порядок файлов: ядро сервера → API → интерфейс
const ORDER = [
  'server/domain/checklist.js', 'server/domain/planner.js', 'server/domain/scheduler.js', 'server/domain/calendar.js',
  'server/domain/maintenance.js', 'server/services/orders.js', 'server/services/reports.js', 'server/db.js',
  'server/seed.js', 'server/settings.js', 'server/auth.js', 'server/util.js', 'server/app.js', 'server/index.js',
];
const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n')
  .filter((f) => /^(server\/(routes\/)?[\w/-]+\.js|client\/src\/.+\.(jsx?|css)|client\/public\/sw\.js)$/.test(f) && !f.includes('/test/'));
const files = [...ORDER.filter((f) => tracked.includes(f)), ...tracked.filter((f) => !ORDER.includes(f)).sort()];

// Листинг: строки с переносом
const lines = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\t/g, '  ').replace(/\r/g, '');
  lines.push(`// ===== Файл: ${f} =====`);
  for (const raw of src.split('\n')) {
    let s = raw;
    if (!s.length) { lines.push(''); continue; }
    while (s.length > COLS) { lines.push(s.slice(0, COLS)); s = '  ' + s.slice(COLS); }
    lines.push(s);
  }
  lines.push('');
}
const pages = [];
for (let i = 0; i < lines.length; i += LINES) pages.push(lines.slice(i, i + LINES));
const total = pages.length;
const room = MAX_PAGES - 1; // минус титульный лист
let selected, note;
if (total <= room) {
  selected = pages.map((p, i) => ({ p, n: i + 1 }));
  note = `Исходный текст представлен полностью: ${total} стр.`;
} else {
  const head = Math.floor(room / 2), tail = room - head;
  selected = [...pages.slice(0, head).map((p, i) => ({ p, n: i + 1 })), ...pages.slice(total - tail).map((p, i) => ({ p, n: total - tail + i + 1 }))];
  note = `Исходный текст представлен фрагментами: страницы 1–${head} и ${total - tail + 1}–${total} листинга из ${total} (первые ${head} и последние ${tail} страниц).`;
}

const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 10, left: 56, right: 40 }, info: { Title: `${cfg.title}. Депонируемые материалы`, Author: cfg.authors.join(', ') } });
doc.registerFont('mono', monoFont);
doc.registerFont('r', SANS);
doc.registerFont('b', SANS_B);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
doc.pipe(fs.createWriteStream(OUT));

// Титульный лист
const W = doc.page.width - 96;
doc.font('r').fontSize(11).text(`Правообладатель: ${cfg.rightholder}`, 56, 70, { width: W, align: 'right' });
doc.moveDown(9);
doc.font('b').fontSize(16).text(cfg.title, { width: W, align: 'center' });
doc.moveDown(0.6);
doc.font('r').fontSize(12).text(`Версия ${cfg.version}`, { width: W, align: 'center' });
doc.moveDown(2);
doc.font('b').fontSize(14).text('ДЕПОНИРУЕМЫЕ МАТЕРИАЛЫ', { width: W, align: 'center' });
doc.font('r').fontSize(12).text('(исходный текст программы для ЭВМ)', { width: W, align: 'center' });
doc.moveDown(3);
doc.fontSize(11).text(`Автор${cfg.authors.length > 1 ? 'ы' : ''}: ${cfg.authors.join('; ')}`, { width: W });
doc.moveDown(0.5);
doc.text('Язык программирования: JavaScript (ECMAScript 2022, Node.js, React/JSX), SQL (SQLite)', { width: W });
doc.moveDown(0.5);
doc.text(note, { width: W });
doc.moveDown(0.5);
doc.text(`Всего листов в документе: ${selected.length + 1}.`, { width: W });
doc.font('r').fontSize(11).text(`${cfg.city}, ${cfg.year}`, 56, doc.page.height - 110, { width: W, align: 'center' });

// Листинг
let sheet = 2;
for (const { p, n } of selected) {
  doc.addPage();
  doc.font('r').fontSize(7.5).fillColor('#444')
    .text(`${cfg.title.split(' — ')[0]} v${cfg.version}. Исходный текст`, 56, 26, { width: W / 2, lineBreak: false });
  doc.text(`Лист ${sheet} · стр. листинга ${n} из ${total}`, 56 + W / 2, 26, { width: W / 2, align: 'right', lineBreak: false });
  doc.moveTo(56, 38).lineTo(56 + W, 38).lineWidth(0.4).strokeColor('#999').stroke();
  doc.font('mono').fontSize(8).fillColor('#000');
  let y = 48;
  for (const line of p) {
    doc.text(line || ' ', 56, y, { lineBreak: false, width: W + 4 });
    y += 14.6;
  }
  doc.font('r').fontSize(8).fillColor('#444').text(String(sheet), 56, doc.page.height - 34, { width: W, align: 'center', lineBreak: false });
  sheet++;
}
doc.end();
console.log(`Готово: ${OUT}\nФайлов исходного текста: ${files.length}, строк: ${lines.length}, страниц листинга: ${total}, в документе: ${selected.length + 1}\n${note}`);
