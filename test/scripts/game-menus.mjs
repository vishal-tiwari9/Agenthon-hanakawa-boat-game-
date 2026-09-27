// chart and pause menu: finish the lessons, find two places, then screenshot the chart, each menu
// panel and the new-game confirmation; change settings through the ui and check they apply.
export default async function (g) {
  const tag = `${g.args.backend || 'webgpu'}-${g.W}`;
  const G = 'L.ctx.services.game';
  const tp = (x, z, h) => g.luma(`(L.ctx.boat.teleport(${x}, ${z}, ${h}), true)`);
  const hdg = (dx, dz) => ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  const fail = [];
  const check = (what, ok) => { console.log(ok ? 'PASS' : 'FAIL', what); if (!ok) fail.push(what); };
  await g.delay(1800);
  await g.evalJs(`document.querySelector('.title-start')?.click()`);
  await g.delay(600);
  await g.luma(`L.press('interact')`);
  await g.delay(400);
  const routes = await g.luma(`${G}.debug.routes()`);
  for (const gt of routes.find((r) => r.id === 'harbor').gates) {
    await tp(gt.x - gt.dx * 7, gt.z - gt.dz * 7, hdg(gt.dx, gt.dz));
    await g.delay(200);
    await tp(gt.x + gt.dx * 7, gt.z + gt.dz * 7, hdg(gt.dx, gt.dz));
    await g.delay(250);
  }
  // dock at the berth to finish the lessons (unlocks seaglass, loads the lamp oil)
  const d = (await g.luma('L.docks')).find((x) => x.id === 'harbor');
  await tp(d.moorX, d.moorZ, d.headingDeg);
  await g.delay(400);
  await g.luma(`L.press('interact')`);
  await g.delay(400);
  await g.luma(`L.press('interact')`);
  const reach = await g.luma(`${G}.debug.reach()`);
  for (const id of ['lighthouse', 'white-cliffs']) {
    const p = reach.find((r) => r.id === id);
    await tp(p.x, p.z, 200);
    await g.delay(400);
  }
  // sail toward faro so the chart shows a course line and the next objective
  await tp(40, -60, 60);
  await g.delay(4000);

  await g.luma(`L.press('chart')`);
  await g.delay(3500);
  check('chart open, gameplay input off', await g.evalJs(`__lumaUi.mode === 'chart' && !__luma.ctx.input.gameplayEnabled`));
  await g.shot(`chart-${tag}`);
  await g.luma(`L.press('chart')`);
  await g.delay(500);
  check('chart closed, gameplay input back', await g.evalJs(`__lumaUi.mode === 'play' && __luma.ctx.input.gameplayEnabled`));

  await g.luma(`L.press('pause')`);
  await g.delay(700);
  check('paused: ctx.paused and input off', await g.evalJs(`__lumaUi.mode === 'pause' && __luma.ctx.paused && !__luma.ctx.input.gameplayEnabled`));
  const sim0 = await g.luma('L.ctx.time.sim');
  await g.delay(500);
  check('sim frozen while paused', (await g.luma('L.ctx.time.sim')) === sim0);
  await g.shot(`pause-settings-${tag}`);
  // change units and the marker through the real controls
  await g.evalJs(`[...document.querySelectorAll('.seg input')].find((i) => i.value === 'kmh').click()`);
  await g.evalJs(`[...document.querySelectorAll('.switch')][1].click()`);
  await g.delay(200);
  const st = await g.evalJs(`JSON.stringify({ units: __luma.ctx.settings.units, marker: __luma.ctx.settings.showMarker, saved: JSON.parse(localStorage.getItem('luma-coast/settings/v1') || '{}').units })`);
  console.log('settings', st);
  check('settings applied and persisted', /"units":"kmh","marker":false,"saved":"kmh"/.test(st));
  await g.evalJs(`document.getElementById('tab-paint').click()`);
  await g.delay(400);
  await g.shot(`pause-paint-${tag}`);
  const picked = await g.evalJs(`(() => { const i = [...document.querySelectorAll('.paint input')].find((x) => x.value === 'seaglass'); if (!i || i.disabled) return false; i.click(); return __luma.ctx.services.game.paint; })()`);
  check('seaglass selectable after the lessons', picked === 'seaglass');
  await g.evalJs(`document.getElementById('tab-controls').click()`);
  await g.delay(300);
  await g.shot(`pause-controls-${tag}`);
  await g.evalJs(`document.getElementById('tab-voyage').click()`);
  await g.delay(200);
  await g.evalJs(`document.querySelector('#panel-voyage .btn').click()`);
  await g.delay(300);
  await g.shot(`pause-newgame-${tag}`);
  await g.evalJs(`document.querySelector('#panel-voyage .btn-quiet').click()`);
  await g.evalJs(`document.querySelector('.menu-resume').click()`);
  await g.delay(500);
  check('resumed', await g.evalJs(`__lumaUi.mode === 'play' && !__luma.ctx.paused && __luma.ctx.input.gameplayEnabled`));
  // live resize: the hud, compass and chart must re-layout without a reload
  await g.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await g.delay(800);
  await g.shot(`resize-hud-1920-from-${g.W}`);
  await g.luma(`L.press('chart')`);
  await g.delay(1200);
  const size = await g.evalJs(`JSON.stringify({ w: innerWidth, canvas: document.querySelector('.chart-canvas').style.width, compass: document.querySelector('.compass canvas').width })`);
  console.log('after resize', size);
  check('chart re-laid out for 1080p', /"w":1920,"canvas":"980px"/.test(size));
  await g.shot(`resize-chart-1920-from-${g.W}`);
  await g.luma(`L.press('chart')`);
  await g.delay(300);
  // restore settings so other runs are unaffected (fresh profiles anyway)
  await g.luma(`(L.ctx.events.emit('settings:change', { units: 'knots', showMarker: true }), true)`);
  console.log('errors', g.errors.length, g.errors.slice(0, 5).join('\n'));
  console.log(fail.length ? `FAILED: ${fail.join('; ')}` : 'MENUS PASSED');
  return fail.length === 0 && g.errors.length === 0;
}
