// Пример данных для демо: пробеги парка и несколько ремонтов «в работе».
// Пробег — из сводки «АВТО» (где не указан — условный).
import fleet from '../../server/seed/fleet.json';

const plateKey = (p) => String(p || '').toUpperCase().replace(/\s+/g, '');

export async function fillDemoData(db, handle) {
  const realKm = new Map(fleet.filter((r) => r.tractor && r.tractor_mileage).map((r) => [plateKey(r.tractor), r.tractor_mileage]));
  const now = Date.now();
  const DAY = 86400000;
  const tractors = db.prepare('SELECT id, year, plate FROM tractors').all();
  const insLog = db.prepare('INSERT INTO mileage_log(vehicle_type, vehicle_id, mileage, recorded_at, source) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (const t of tractors) {
      const age = Math.max(1, 2026 - (t.year || 2015));
      const perDay = 300 + ((t.id * 97) % 280);
      const m = realKm.get(plateKey(t.plate)) || 90000 + Math.min(age, 9) * 68000 + ((t.id * 7919) % 41000);
      insLog.run('tractor', t.id, m - perDay * 60, new Date(now - 60 * DAY).toISOString(), 'import');
      insLog.run('tractor', t.id, m, new Date(now - DAY).toISOString(), 'import');
      db.prepare('UPDATE tractors SET mileage = ? WHERE id = ?').run(m, t.id);
    }
  })();

  const login = await handle('POST', '/api/auth/login', { body: { login: 'admin', password: 'admin' } });
  const token = JSON.parse(login.text).token;
  const call = async (method, url, body) => JSON.parse((await handle(method, '/api' + url, { headers: { authorization: `Bearer ${token}` }, body })).text || '{}');
  const list = await call('GET', '/vehicles/tractor');
  if (!Array.isArray(list)) throw new Error('Демо-данные: ' + JSON.stringify(list));
  const byPlate = (p) => list.find((t) => t.plate === p);

  const releaseIn = (days) => {
    const d = new Date(now + days * DAY);
    d.setUTCHours(14, 0, 0, 0); // 17:00 МСК
    return d.toISOString();
  };

  const t1 = byPlate('Т970ОН58');
  const t2 = byPlate('К531НК95');
  const t3 = byPlate('В178МЕ164');
  const orders = [];
  if (t1) {
    orders.push(await call('POST', '/orders', {
      tractor_id: t1.id, trailer_id: t1.trailer_id, tractor_mileage: t1.mileage + 120, release_deadline: releaseIn(5),
      defects: { items: {
        wash_tanks: { state: 'defect' },
        steer_cross: { state: 'defect', comment: 'люфт в левом шарнире' },
        br_calipers: { positions: ['tractor:1:L'], comment: 'подклинивает' },
        el_generator: { value: 26.4 },
        br_leak_trailer: { state: 'defect', comment: 'шипит у соединительной головки' },
        sus_shocks: { positions: ['trailer:2:L'] },
        dmg_body: { zones: ['Бампер'], comment: 'скол справа' },
      } },
    }));
  }
  if (t2) {
    orders.push(await call('POST', '/orders', {
      tractor_id: t2.id, trailer_id: t2.trailer_id, tractor_mileage: t2.mileage + 80, release_deadline: releaseIn(7),
      defects: { items: {
        br_pads: { positions: ['tractor:2:L', 'tractor:2:R'] },
        dl_crosses: { state: 'defect' },
        cool_leak: { state: 'defect', comment: 'потёк у нижнего патрубка' },
        tires: { positions: ['trailer:1:R'], comment: 'грыжа' },
        tr_tent: { state: 'defect' },
      } },
    }));
  }
  if (t3) {
    orders.push(await call('POST', '/orders', {
      tractor_id: t3.id, trailer_id: t3.trailer_id, tractor_mileage: t3.mileage + 50,
      defects: { items: { eng_to: { state: 'defect' }, el_lights: { state: 'defect', comment: 'не горит левый габарит прицепа' }, sus_cab: { state: 'defect' } } },
    }));
  }

  // Часть работ уже выполнена / в работе
  const o1 = orders[0];
  if (o1?.tasks?.length) {
    const first = o1.tasks[0];
    await call('POST', `/tasks/${first.id}/status`, { status: 'in_progress' });
    await call('POST', `/tasks/${first.id}/status`, { status: 'done', actual_hours: 0.4 });
    const second = o1.tasks.find((t) => t.id !== first.id && t.status === 'planned');
    if (second) await call('POST', `/tasks/${second.id}/status`, { status: 'in_progress' });
  }
  if (orders[1]?.id) await call('POST', `/orders/${orders[1].id}/approve`, {});
  if (o1?.tasks?.length) {
    await call('POST', `/orders/${o1.id}/parts`, { task_id: o1.tasks.find((t) => /суппорт/i.test(t.description))?.id, name: 'Суппорт тормозной передний левый', code: '00-004512', article: 'K003268', qty: 1, price: 38500 });
  }
  await call('POST', '/parts', { name: 'Колодки тормозные дисковые (комплект на ось)', code: '00-001120', article: '29087', unit: 'компл', price: 8900, source: '1c' });
  await call('POST', '/parts', { name: 'Крестовина карданного вала 57x152', code: '00-002208', article: 'GUM-92', price: 4200, source: '1c' });
}
