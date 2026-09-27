// render smoke check: one view on the current preset, then each quality preset in turn.
// node test/harness.mjs render-check --tag=render [--backend=webgl] [--view=harbor] [--presets=low,high]
export default async function (g) {
  const view = g.args.view || 'harbor';
  const backend = g.args.backend || 'webgpu';
  const presets = (g.args.presets || 'low,high,balanced').split(',').filter(Boolean);
  await g.delay(1500);
  await g.luma(`L.view(${JSON.stringify(view)})`);
  await g.delay(1500);
  const s0 = await g.stats();
  await g.shot(`check-${backend}-${s0.quality}`);
  for (const p of presets) {
    const before = g.errors.length;
    await g.luma(`L.setQuality(${JSON.stringify(p)})`);
    await g.delay(2500);
    const s = await g.stats();
    await g.shot(`check-${backend}-${p}`);
    console.log(`preset ${p}: fps ${s.fps}, new errors ${g.errors.length - before}`);
  }
  const post = await g.evalJs('(() => { const p = window.__lumaRender?.service.post(); return p ? p.options : null; })()');
  console.log('post options', JSON.stringify(post));
  return g.errors.length === 0;
}
