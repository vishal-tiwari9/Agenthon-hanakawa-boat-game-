// same pose, paused vs running, to isolate per-frame work that runs away while paused
export default async function (g) {
  await g.delay(1200);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(400);
  await g.luma("L.press('interact')");
  await g.luma("L.hold('forward', true)");
  await g.delay(7000);
  await g.luma('L.releaseAll()');
  const fps = async (label) => { await g.delay(1500); const a = await g.stats(); await g.delay(3000); const b = await g.stats(); const f = (b.frames - a.frames) / 3; console.log(label.padEnd(30), f.toFixed(1), 'fps', (1000 / f).toFixed(2), 'ms'); };
  await fps('running, follow camera');
  await g.luma("(L.look(L.ctx.camera.position.toArray(), L.ctx.camera.position.clone().add(L.ctx.camera.getWorldDirection(new L.ctx.camera.position.constructor()).multiplyScalar(40)).toArray()), true)");
  await fps('running, fixed camera');
  await g.luma('(L.ctx.paused = true, true)');
  await fps('paused, fixed camera');
  const t0 = await g.evalJs('performance.now()');
  const prof = await g.evalJs(`(() => { const L = __luma.ctx.services.loop; const out = []; for (const e of L.updates) { const t = performance.now(); for (let i = 0; i < 20; i++) e.fn(__luma.ctx); out.push([e.order, (e.fn.name || '?'), +((performance.now() - t) / 20).toFixed(3)]); } return out.sort((a, b) => b[2] - a[2]).slice(0, 8); })()`);
  console.log('slowest update callbacks (ms each):', JSON.stringify(prof));
  await g.luma('(L.ctx.paused = false, true)');
}
