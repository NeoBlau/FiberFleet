// Окружение Node.js, которого ждёт серверный код, — для запуска в браузере (демо-версия)
globalThis.process = globalThis.process || { env: {} };
globalThis.process.env = { FF_DEMO_USERS: '1', ...(globalThis.process.env || {}) };
if (!globalThis.Buffer) {
  globalThis.Buffer = { from: (s, enc) => ({ __hex: enc === 'hex' ? String(s) : null, toString: () => String(s) }) };
}
