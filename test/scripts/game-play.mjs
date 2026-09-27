// scripted playthrough of every objective on the river: the lesson (cast off with real throttle and
// steering, pass under the vermilion bridge, dock at temple steps), three chained deliveries with
// their cargo, the lantern run, all four bridges and every landmark. screenshots of the feedback.
//   node test/harness.mjs game-play --tag=game [--backend=webgl]
export default async function (g) {
  const tag = g.args.backend || 'webgpu';
  const G = 'L.ctx.services.game';
  const layout = (expr) => g.evalJs(`import('/src/world/layout.ts').then((m) => JSON.stringify(${expr}))`).then(JSON.parse);
  const state = () => g.luma(`(() => { const s = ${G}; const b = L.stats().boat; return {
    tracked: s.tracked && s.tracked.id, prompt: s.prompt && s.prompt.text, docked: s.dockedAt, cargo: s.cargo && s.cargo.label,
    items: (L.ctx.boat.object.getObjectByName('cargo') || { children: [] }).children.length,
    done: s.objectives.filter((o) => o.status === 'done').map((o) => o.id), found: s.pois.filter((p) => p.discovered).length,
    boat: b && [b.x, b.z, b.speed, b.docked] }; })()`);
  const tp = (x, z, h) => g.luma(`(L.ctx.boat.teleport(${x}, ${z}, ${h}), true)`);
  const press = async (a, wait = 500) => { await g.luma(`L.press('${a}')`); await g.delay(wait); };
  const fail = [];
  const expect = async (what, cond) => { const s = await state(); const ok = cond(s); console.log(ok ? 'PASS' : 'FAIL', what); if (!ok) { fail.push(what); console.log('   state', JSON.stringify(s)); } };
  // teleport across along-river position s (upstream), in the channel
  const across = async (s, d = 8) => {
    const [a, b] = await layout(`[m.riverFrame(${s - d}), m.riverFrame(${s + d}), m.riverHeading(${s})]`);
    const h = await layout(`m.riverHeading(${s})`);
    await tp(a.x, a.z, h);
    await g.delay(300);
    await tp(b.x, b.z, h);
    await g.delay(400);
  };
  const approach = async (id) => {
    const d = (await layout('m.DOCKS')).find((x) => x.id === id);
    const f = await layout(`m.riverFrame(${d.s - 7})`);
    // just downstream of the berth, on the same line off the bank
    const nx = f.nx * (d.side * (f.width / 2 - 4.2));
    await tp(f.x + nx, f.z + f.nz * (d.side * (f.width / 2 - 4.2)), d.headingDeg);
    await g.delay(800);
  };

  await g.delay(2000);
  await g.evalJs(`document.querySelector('.title-start')?.click()`);
  await g.delay(900);
  await expect('incense loaded at the village landing', (s) => s.cargo === 'Incense bundles' && s.docked === 'village' && s.tracked === 'cast-off');

  await press('interact', 700);
  await expect('cast off undocks', (s) => s.docked === null);
  const p0 = await g.luma('L.stats().boat');
  await g.luma(`L.hold('forward', true)`);
  await g.delay(3500);
  await g.shot(`play-hud-throttle-${tag}`);
  await g.luma(`L.hold('left', true)`);
  await g.delay(1000);
  await g.luma('L.releaseAll()');
  const p1 = await g.luma('L.stats().boat');
  console.log('drive', JSON.stringify({ moved: Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(1), speed: p1.speed }));

  await across(300);
  await g.delay(500);
  await g.shot(`play-toast-bridge-${tag}`);
  await expect('passed under the vermilion bridge: cast-off complete', (s) => s.done.includes('cast-off') && s.tracked === 'temple-steps');

  await approach('temple');
  await expect('dock prompt at temple steps', (s) => /^Dock at Temple Steps/.test(s.prompt || ''));
  await g.shot(`play-prompt-dock-${tag}`);
  await press('interact', 900);
  await expect('temple-steps + incense complete, tea loaded', (s) => ['temple-steps', 'incense'].every((x) => s.done.includes(x)) && s.cargo === 'Tea chests' && s.items === 2);
  await g.delay(300);
  await g.shot(`play-toast-lessons-${tag}`);

  await press('interact');
  await approach('teahouse');
  await press('interact', 900);
  await expect('tea delivered, rice loaded', (s) => s.done.includes('tea') && s.cargo === 'Rice bales' && s.items === 3);
  await press('interact');
  await approach('mill');
  await press('interact', 900);
  await expect('rice delivered', (s) => s.done.includes('rice') && s.cargo === null);

  await press('interact');
  const gates = await g.luma(`${G}.debug.lanterns()`);
  for (const gt of gates) {
    const h = ((Math.atan2(gt.dx, -gt.dz) * 180) / Math.PI + 360) % 360;
    await tp(gt.x - gt.dx * 6, gt.z - gt.dz * 6, h);
    await g.delay(250);
    await tp(gt.x + gt.dx * 6, gt.z + gt.dz * 6, h);
    await g.delay(300);
  }
  await expect('lantern run complete', (s) => s.done.includes('lanterns'));

  for (const b of await layout('m.BRIDGES')) await across(b.s);
  await expect('under every bridge', (s) => s.done.includes('bridges'));

  const reach = (await g.luma(`${G}.debug.reach()`)).filter((r) => r.id.startsWith('poi:'));
  for (const r of reach) {
    await tp(r.x, r.z, 0);
    await g.delay(450);
  }
  const total = await g.luma(`${G}.pois.length`);
  await expect('every landmark and bridge found, all objectives complete', (s) => s.done.length === 8 && s.found === total);
  await g.delay(2500);
  await g.shot(`play-final-${tag}`);
  const fin = await g.luma(`({ allDone: ${G}.allDone, paints: ${G}.paints.map((p) => p.id + (p.unlocked ? '' : '*')), save: localStorage.getItem('hanakawa/save/v1').length })`);
  console.log('final', JSON.stringify(fin));
  const mine = ownErrors(g.errors);
  console.log('errors', g.errors.length, 'total;', mine.length, 'from game/ui', mine.slice(0, 6).join('\n'));
  console.log(fail.length ? `FAILED: ${fail.join('; ')}` : 'ALL OBJECTIVES PASSED');
  return fail.length === 0 && mine.length === 0;
}

// errors raised by gameplay or the interface (other modules are mid-edit and log their own)
export function ownErrors(errors) {
  return errors.filter((e) => /\[game\]|\[ui\]|src\/game\/|src\/ui\/|assets\/game|assets\/ui|lantern|cargo/i.test(e) || !/\[(vegetation|terrain|structures|bridges|water|render|boat|camera|audio|luma)\]|WebGPU|GPUValidation|pipeline|BindGroup/i.test(e));
}
