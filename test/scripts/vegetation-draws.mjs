// draw submissions of one cruising frame by pass (main, mirror, shadow) and owner, then frame pacing.
// usage: node test/harness.mjs vegetation-draws --tag=veg-perf --size=1920x1080 --quiet
export default async function (g) {
  await g.delay(1200);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(400);
  await g.luma("L.press('interact')");
  await g.luma("L.hold('forward', true)");
  await g.delay(3000);
  const counts = await g.evalJs(`new Promise((resolve) => {
    const c = __luma.ctx, R = c.renderer, orig = R.renderObject.bind(R), r = c.render;
    const out = {};
    const owner = (o) => {
      let p = o, path = [];
      while (p && p.parent && p.parent !== c.scene) { path.push(p); p = p.parent; }
      const top = p?.name || p?.type || '?';
      if (top === 'vegetation') {
        const sub = path[path.length - 2] || o;
        return 'veg/' + String(sub.name || o.name || o.material?.name || '?').split(':')[0];
      }
      return top;
    };
    let on = false;
    R.renderObject = function (object, scene, camera, ...rest) {
      if (on) {
        const pass = camera.isOrthographicCamera ? 'shadow' : camera === c.camera ? 'main' : 'mirror';
        const k = pass + ' ' + owner(object);
        out[k] = (out[k] || 0) + 1;
        out['total ' + pass] = (out['total ' + pass] || 0) + 1;
      }
      return orig(object, scene, camera, ...rest);
    };
    c.render = () => { on = true; r(); on = false; c.render = r; R.renderObject = orig; resolve(out); };
  })`);
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  console.log('draws', rows.filter(([k]) => k.startsWith('total')).map(([k, v]) => `${k}=${v}`).join(' '));
  for (const [k, v] of rows.filter(([k]) => !k.startsWith('total')).slice(0, 40)) console.log(String(v).padStart(5), k);
  await g.evalJs(`(() => { const c = __luma.ctx; const r = c.render; window.__ft = []; let last = performance.now(); c.render = () => { r(); const t = performance.now(); window.__ft.push(t - last); last = t; }; })()`);
  await g.delay(8000);
  const ft = await g.evalJs('window.__ft.slice(5)');
  await g.luma('L.releaseAll()');
  const s = [...ft].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1);
  console.log(`pacing: ${ft.length} frames, p50 ${q(0.5)}, p90 ${q(0.9)}, p99 ${q(0.99)}, max ${s[s.length - 1].toFixed(1)}`);
  console.log('veg', JSON.stringify(await g.luma('(({ grass, flowers, shrubs, banks, forest, garden }) => ({ grass, flowers, shrubs, banks, forest, garden }))(L.ctx.services.vegetation.stats())')));
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 3).join('\n'));
}
