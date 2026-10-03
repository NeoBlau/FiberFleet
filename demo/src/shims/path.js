const join = (...p) => p.filter(Boolean).join('/').replace(/\/+/g, '/');
const path = { join, resolve: join, dirname: (p) => String(p).split('/').slice(0, -1).join('/') || '/', sep: '/' };
export default path;
export { join };
export const { resolve, dirname, sep } = path;
