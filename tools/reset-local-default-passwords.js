// Reset local/demo account passwords in this checkout's database only.
import { openDb } from '../server/db.js';
import { seedIfEmpty } from '../server/seed.js';
import { INITIAL_CREDENTIAL_HASHES } from '../server/initial-credential-hashes.js';

const db = openDb();
try {
  seedIfEmpty(db);
  const accounts = [
    ['admin', 'Администратор', INITIAL_CREDENTIAL_HASHES.admin, 'admin', null],
    ['operator', 'Оператор', INITIAL_CREDENTIAL_HASHES.operator, 'operator', null],
    ['master', 'Мастер-приёмщик', INITIAL_CREDENTIAL_HASHES.master, 'master', null],
  ];
  const employee = db.prepare("SELECT id FROM employees WHERE name = 'Сластунов' LIMIT 1").get();
  if (employee) accounts.push(['slastunov', 'Сластунов', INITIAL_CREDENTIAL_HASHES.slastunov, 'mechanic', employee.id]);
  const update = db.prepare('UPDATE users SET pass_hash = ? WHERE login = ?');
  const insert = db.prepare('INSERT INTO users(login, name, pass_hash, role, employee_id) VALUES (?, ?, ?, ?, ?)');
  const tx = db.transaction(() => {
    for (const [login, name, passHash, role, employeeId] of accounts) {
      if (db.prepare('SELECT id FROM users WHERE login = ?').get(login)) update.run(passHash, login);
      else insert.run(login, name, passHash, role, employeeId);
    }
  });
  tx();
  console.log('Восстановлены стандартные пароли локальных учётных записей: admin, operator, master, slastunov.');
} finally {
  db.close();
}
