import fleet from '../../../server/seed/fleet.json';
import catalog from '../../../server/seed/catalog.json';
const FILES = { 'fleet.json': fleet, 'catalog.json': catalog };
const fs = {
  readFileSync(p) {
    const name = String(p).split('/').pop();
    if (FILES[name]) return JSON.stringify(FILES[name]);
    throw new Error(`Файл ${name} недоступен в демо`);
  },
  existsSync: () => false,
  mkdirSync: () => {},
  rm: (_p, _o, cb) => cb && cb(),
};
export default fs;
export const { readFileSync, existsSync, mkdirSync } = fs;
