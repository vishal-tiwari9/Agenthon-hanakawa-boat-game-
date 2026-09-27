// saves: make progress, reload the page, check it is restored; then new game from the pause menu.
export default async function (g) {
  const G = 'L.ctx.services.game';
  const tp = (x, z, h) => g.luma(`(L.ctx.boat.teleport(${x}, ${z}, ${h}), true)`);
  const hdg = (dx, dz) => ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  const fail = [];
  const check = (what, ok) => { console.log(ok ? 'PASS' : 'FAIL', what); if (!ok) fail.push(what); };
  const waitReady = async () => { for (let i = 0; i < 120; i++) { await g.delay(500); try { if (await g.evalJs('!!window.__lumaReady')) return true; } catch {} } return false; };
  await g.delay(1500);
  await g.evalJs(`document.querySelector('.title-start')?.click()`);
  await g.delay(500);
  await g.luma(`L.press('interact')`);
  await g.delay(400);
  const routes = await g.luma(`${G}.debug.routes()`);
  for (const gt of routes.find((r) => r.id === 'harbor').gates) {
    await tp(gt.x - gt.dx * 7, gt.z - gt.dz * 7, hdg(gt.dx, gt.dz));
    await g.delay(200);
    await tp(gt.x + gt.dx * 7, gt.z + gt.dz * 7, hdg(gt.dx, gt.dz));
    await g.delay(250);
  }
  const d = (await g.luma('L.docks')).find((x) => x.id === 'harbor');
  await tp(d.moorX, d.moorZ, d.headingDeg);
  await g.delay(500);
  await g.luma(`L.press('interact')`);
  await g.delay(500);
  // carry the lamp oil to faro and dock there, then pick the seaglass paint
  await g.luma(`L.press('interact')`);
  const f = (await g.luma('L.docks')).find((x) => x.id === 'faro');
  await tp(f.moorX, f.moorZ, f.headingDeg);
  await g.delay(500);
  await g.luma(`L.press('interact')`);
  await g.delay(500);
  await g.luma(`${G}.selectPaint('seaglass')`);
  const before = await g.luma(`${G}.debug.save()`);
  console.log('save before', JSON.stringify(before));

  await g.send('Page.reload', {});
  check('reloaded', await waitReady());
  await g.delay(1500);
  // no title gate: the saved voyage resumes straight into play and a toast says where
  const resumed = await g.luma(`(() => { const s = ${G}; const d = L.docks.find((x) => x.id === s.dockedAt); return { mode: __lumaUi.mode, hasSave: s.hasSave, dock: d && d.name, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ') }; })()`);
  console.log('resumed', JSON.stringify(resumed));
  check('save resumes straight into play', resumed.mode === 'play' && resumed.hasSave && /Welcome back/.test(resumed.toast) && !!resumed.dock && resumed.toast.includes(resumed.dock));
  await g.shot('save-continue');
  const after = await g.luma(`(() => { const s = ${G}; return { done: s.objectives.filter((o) => o.status === 'done').map((o) => o.id), docked: s.dockedAt, cargo: s.cargo && s.cargo.label, crates: (L.ctx.boat.object.getObjectByName('cargo') || { children: [] }).children.length, paint: s.paint, boat: L.stats().boat, tracked: s.tracked && s.tracked.id }; })()`);
  console.log('restored', JSON.stringify(after));
  check('progress restored', ['cast-off', 'come-alongside', 'lamp-oil'].every((id) => after.done.includes(id)));
  check('moored at the last berth', after.docked === 'faro' && Math.hypot(after.boat.x - f.moorX, after.boat.z - f.moorZ) < 4);
  check('cargo restored aboard', after.cargo === 'Coiled rope');
  check('paint restored', after.paint === 'seaglass');
  await g.delay(1500);
  check('crates rebuilt on the boat', (await g.luma(`(L.ctx.boat.object.getObjectByName('cargo') || { children: [] }).children.length`)) === 1);

  // new game with confirmation
  await g.luma(`L.press('pause')`);
  await g.delay(500);
  await g.evalJs(`document.getElementById('tab-voyage').click()`);
  await g.evalJs(`document.querySelector('#panel-voyage .btn').click()`);
  await g.delay(200);
  await g.evalJs(`document.querySelector('#panel-voyage .btn-primary').click()`);
  await g.delay(800);
  const fresh = await g.luma(`(() => { const s = ${G}; return { mode: __lumaUi.mode, done: s.objectives.filter((o) => o.status === 'done').length, docked: s.dockedAt, cargo: s.cargo, tracked: s.tracked && s.tracked.id, paint: s.paint, save: JSON.parse(localStorage.getItem('luma-coast/save/v1')) }; })()`);
  console.log('new game', JSON.stringify(fresh));
  check('new game resets progress', fresh.mode === 'play' && fresh.done === 0 && fresh.docked === 'harbor' && !fresh.cargo && fresh.tracked === 'cast-off' && fresh.paint === 'ivory' && Object.keys(fresh.save.objectives).length === 0);
  console.log('errors', g.errors.length, g.errors.slice(0, 5).join('\n'));
  console.log(fail.length ? `FAILED: ${fail.join('; ')}` : 'SAVE PASSED');
  return fail.length === 0 && g.errors.length === 0;
}
