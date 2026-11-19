import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createApp } from '../app.js';

test('admin database and ZIP backup, restore and invalid upload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-test-'));
  const previous = process.env.FF_ADMIN_PASSWORD;
  process.env.FF_ADMIN_PASSWORD = 'test-password-123';
  const app = createApp({ dbFile: path.join(dir, 'live.db') });
  const db = app.locals.db;
  const server = app.listen(0);
  try {
    const base = 'http://127.0.0.1:' + server.address().port + '/api';
    const login = await fetch(base + '/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login:'admin',password:'test-password-123'})});
    assert.equal(login.status,200);
    const {token} = await login.json();
    const headers = {Authorization:'Bearer '+token};
    db.prepare("INSERT INTO settings(key,value) VALUES ('backup_test','original')").run();
    assert.equal((await fetch(base+'/admin/backup')).status,401);
    const response = await fetch(base+'/admin/backup',{headers});
    assert.equal(response.status,200);
    const bytes = Buffer.from(await response.arrayBuffer());
    const snapshot = path.join(dir,'snapshot.db');
    fs.writeFileSync(snapshot,bytes);
    const copy = new Database(snapshot,{readonly:true});
    try {
      assert.equal(copy.pragma('integrity_check',{simple:true}),'ok');
      assert.equal(copy.prepare("SELECT value FROM settings WHERE key='backup_test'").get().value,'original');
    } finally { copy.close(); }
    const zip = await fetch(base+'/admin/backup/full',{headers});
    assert.equal(zip.status,200);
    assert.equal(Buffer.from(await zip.arrayBuffer()).subarray(0,2).toString(),'PK');
    db.prepare("UPDATE settings SET value='changed' WHERE key='backup_test'").run();
    const restore = async (data) => {
      const body = new FormData();
      body.append('backup',new Blob([data]),'snapshot.db');
      body.append('confirm','RESTORE');
      return fetch(base+'/admin/backup/restore',{method:'POST',headers,body});
    };
    assert.equal((await restore('invalid')).status,400);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='backup_test'").get().value,'changed');
    const restored = await restore(bytes);
    assert.equal(restored.status,200);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='backup_test'").get().value,'original');
    assert.ok(fs.readdirSync(path.join(dir,'backups')).length);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    db.close();
    fs.rmSync(dir,{recursive:true,force:true});
    if(previous===undefined) delete process.env.FF_ADMIN_PASSWORD; else process.env.FF_ADMIN_PASSWORD=previous;
  }
});
