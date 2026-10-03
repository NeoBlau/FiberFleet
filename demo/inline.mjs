// Собирает один самодостаточный HTML-файл: весь JS и CSS встраиваются внутрь
import fs from 'node:fs';
import path from 'node:path';
const dist = path.resolve('dist');
let html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, href) =>
  `<style>${fs.readFileSync(path.join(dist, href), 'utf8')}</style>`);
html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_, src) =>
  `<script type="module">${fs.readFileSync(path.join(dist, src), 'utf8').replace(/<\/script/gi, '<\\/script').replace(/\uFFFD/g, '\\uFFFD')}</script>`);
const out = path.join(dist, 'fiberfleet-demo.html');
fs.writeFileSync(out, html);
fs.writeFileSync(path.join(dist, 'index.html'), html);
for (const f of fs.readdirSync(path.join(dist, 'assets'))) fs.rmSync(path.join(dist, 'assets', f));
fs.rmdirSync(path.join(dist, 'assets'));
console.log(`Готово: ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} МБ)`);
