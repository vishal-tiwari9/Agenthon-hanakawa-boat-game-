// frame pacing while cruising: per-frame times, percentiles and spike count
export default async function (g) {
  await g.delay(1200);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(400);
  await g.luma("L.press('interact')");
  await g.luma("L.hold('forward', true)");
  await g.delay(2500);
  await g.evalJs(`(() => { const c = __luma.ctx; const r = c.render; window.__ft = []; let last = performance.now(); c.render = () => { r(); const t = performance.now(); window.__ft.push(t - last); last = t; }; })()`);
  await g.delay(10000);
  const ft = await g.evalJs('window.__ft.slice(5)');
  await g.luma('L.releaseAll()');
  const s = [...ft].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1);
  const spikes = ft.filter((x) => x > 25).length;
  console.log(`pacing: ${ft.length} frames, mean ${(ft.reduce((a, b) => a + b, 0) / ft.length).toFixed(1)} ms, p50 ${q(0.5)}, p90 ${q(0.9)}, p99 ${q(0.99)}, max ${s[s.length - 1].toFixed(1)}, frames >25ms: ${spikes}`);
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 3).join('\n'));
}
