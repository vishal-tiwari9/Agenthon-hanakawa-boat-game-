// what happens on spiky frames: shadow cascade refreshes, vegetation generation, new pipelines
export default async function (g) {
  await g.delay(1200);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(400);
  await g.luma("L.press('interact')");
  await g.luma("L.hold('forward', true)");
  await g.delay(2500);
  await g.evalJs(`(() => {
    const c = __luma.ctx; const r = c.render; window.__fr = []; let last = performance.now();
    const pipes = () => { try { return c.renderer._pipelines.caches.size; } catch { return -1; } };
    const sun = __lumaRender.service.sun;
    const veg = c.services.vegetation;
    c.render = () => {
      const lights = sun.csm && sun.csm.lights ? sun.csm.lights.map((l) => l.shadow.needsUpdate ? 1 : 0).join('') : '';
      const p0 = pipes();
      const t0 = performance.now();
      r();
      const t = performance.now();
      const gen = veg ? ['grass', 'flowers', 'shrubs'].map((k) => (veg[k]?.stats?.generatedMs || 0).toFixed(1)).join('/') : '';
      window.__fr.push({ dt: +(t - last).toFixed(1), render: +(t - t0).toFixed(1), cascades: lights, newPipes: pipes() - p0, gen });
      last = t;
    };
  })()`);
  await g.delay(10000);
  const fr = await g.evalJs('window.__fr.slice(5)');
  await g.luma('L.releaseAll()');
  const spikes = fr.filter((f) => f.dt > 25);
  console.log('spikes', spikes.length, 'of', fr.length);
  for (const f of spikes.slice(0, 16)) console.log(JSON.stringify(f));
  const refresh = fr.filter((f) => f.cascades && f.cascades !== '100' && f.cascades !== '000');
  const avg = (a) => (a.reduce((x, y) => x + y.render, 0) / Math.max(1, a.length)).toFixed(1);
  console.log('avg render ms: outer cascade refresh frames', avg(refresh), 'others', avg(fr.filter((f) => !refresh.includes(f))), 'refresh frames', refresh.length);
}
