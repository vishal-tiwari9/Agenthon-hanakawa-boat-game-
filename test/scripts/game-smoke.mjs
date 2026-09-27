// gameplay/ui smoke: loading screen styling, title card, start, hud over the harbor, event emission.
export default async function (g) {
  await g.delay(2200);
  const tag = `${g.args.backend || 'webgpu'}-${g.W}`;
  // bring the loading screen back briefly to check its styling against the title that replaces it
  await g.evalJs(`(() => { const l = document.getElementById('loading'); l.style.transition = 'none'; l.classList.remove('done'); document.querySelector('.loading-fill').style.width = '64%'; document.querySelector('.loading-label').textContent = 'Loading water'; })()`);
  await g.delay(300);
  await g.shot(`loading-${tag}`);
  await g.evalJs(`document.getElementById('loading').classList.add('done')`);
  await g.delay(400);
  await g.shot(`title-${tag}`);
  // count the contract events gameplay emits
  await g.evalJs(`window.__ev = {}; for (const n of ['boat:docked', 'boat:undocked', 'objective:started', 'objective:completed', 'discovery', 'unlock', 'pause', 'resume', 'ui:chart']) __luma.ctx.events.on(n, () => (__ev[n] = (__ev[n] || 0) + 1));`);
  await g.evalJs(`document.querySelector('.title-start')?.click()`);
  await g.delay(1200);
  await g.shot(`hud-start-${tag}`);
  const G = 'L.ctx.services.game';
  await g.luma(`L.press('interact')`);
  await g.delay(300);
  await g.luma(`${G}.debug.complete('cast-off')`);
  const d = (await g.luma('L.docks')).find((x) => x.id === 'harbor');
  await g.luma(`(L.ctx.boat.teleport(${d.moorX}, ${d.moorZ}, ${d.headingDeg}), true)`);
  await g.delay(400);
  await g.luma(`L.press('interact')`);
  await g.delay(300);
  const r = (await g.luma(`${G}.debug.reach()`)).find((p) => p.id === 'lighthouse');
  await g.luma(`L.press('interact')`);
  await g.luma(`(L.ctx.boat.teleport(${r.x}, ${r.z}, 0), true)`);
  await g.delay(500);
  await g.luma(`L.press('chart')`);
  await g.delay(300);
  await g.luma(`L.press('chart')`);
  await g.luma(`L.press('pause')`);
  await g.delay(400);
  await g.luma(`L.press('pause')`);
  await g.delay(300);
  const ev = await g.evalJs('JSON.stringify(window.__ev)');
  console.log('events', ev);
  const e = JSON.parse(ev);
  const ok = ['boat:docked', 'boat:undocked', 'objective:started', 'objective:completed', 'discovery', 'unlock', 'pause', 'resume', 'ui:chart'].every((n) => e[n] > 0);
  console.log(ok ? 'PASS all contract events emitted' : 'FAIL missing events');
  console.log('stats', JSON.stringify(await g.stats()));
  console.log('errors', g.errors.length, g.errors.slice(0, 5).join('\n'));
  return ok && g.errors.length === 0;
}
