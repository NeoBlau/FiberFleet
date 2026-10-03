// Упрощённые замены node:crypto для демо (данные живут только в браузере пользователя)
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
function randomBytes(n) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return { toString: (enc) => (enc === 'base64url' ? btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : hex(a)) };
}
function scryptSync(pass, salt) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const s = `${salt}:${pass}`;
  for (let r = 0; r < 64; r++) {
    for (let i = 0; i < s.length; i++) {
      h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
      h2 = Math.imul(h2 ^ (h1 + r), 2246822519) >>> 0;
    }
  }
  const out = (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(8);
  return { __hex: out, toString: () => out };
}
const timingSafeEqual = (a, b) => (a.__hex || String(a)) === (b.__hex || String(b));
export default { randomBytes, scryptSync, timingSafeEqual };
export { randomBytes, scryptSync, timingSafeEqual };
