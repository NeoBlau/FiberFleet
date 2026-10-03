// Минимальная совместимая с Express 4 маршрутизация для запуска серверных роутов в браузере
function compile(path, end) {
  if (path === '*') return { re: /^.*$/, keys: [] };
  const keys = [];
  let src = '^';
  for (const seg of path.split('/').filter(Boolean)) {
    const m = seg.match(/^:(\w+)(?:\((.+)\))?$/);
    if (m) { keys.push(m[1]); src += `/(${m[2] || '[^/]+'})`; } else src += '/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  src += end ? '/?$' : '(?=/|$)';
  return { re: new RegExp(src), keys };
}

function Router() {
  const stack = [];
  const router = (req, res, next) => router.handle(req, res, next);
  const add = (method) => (path, ...handlers) => { stack.push({ method, ...compile(path, true), handlers: handlers.flat() }); return router; };
  router.get = add('GET');
  router.post = add('POST');
  router.put = add('PUT');
  router.delete = add('DELETE');
  router.use = (...a) => {
    const path = typeof a[0] === 'string' ? a.shift() : null;
    stack.push({ method: null, prefix: path, ...(path ? compile(path, false) : { re: null, keys: [] }), handlers: a.flat() });
    return router;
  };
  router.handle = (req, res, out) => {
    let i = 0;
    const basePath = req.path;
    const next = (err) => {
      req.path = basePath;
      if (err) return out(err);
      while (i < stack.length) {
        const layer = stack[i++];
        if (layer.method && layer.method !== req.method) continue;
        let m = null;
        if (layer.re) { m = req.path.match(layer.re); if (!m) continue; }
        const params = {};
        layer.keys.forEach((k, j) => { params[k] = decodeURIComponent(m[j + 1]); });
        if (layer.method) req.params = params;
        if (layer.prefix) req.path = req.path.slice(m[0].length) || '/';
        const hs = layer.handlers;
        let h = 0;
        const step = (e) => {
          if (e) { req.path = basePath; return out(e); }
          if (h >= hs.length) { req.path = basePath; return next(); }
          const fn = hs[h++];
          try { fn(req, res, step); } catch (ex) { req.path = basePath; out(ex); }
        };
        return step();
      }
      out();
    };
    next();
  };
  return router;
}

const express = () => { throw new Error('express() недоступен в демо'); };
express.Router = Router;
express.json = () => (_q, _s, n) => n();
express.static = () => (_q, _s, n) => n();
export default express;
export { Router };
