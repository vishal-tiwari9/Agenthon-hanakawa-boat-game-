// breaks the render module's gpu cost down by rebuilding the pipeline with single effects removed.
// timing: the game loop is paused and frames are rendered back to back, each waited on with
// queue.onSubmittedWorkDone(), so the number is serialized cpu+gpu time per frame (no overlap),
// including every module's per-frame update. differences between variants are the gpu cost.
// node test/harness.mjs render-perf-post --tag=render [--view=open-water] [--quality=balanced]
export default async function (g) {
  const view = g.args.view || 'open-water';
  await g.luma(`L.view(${JSON.stringify(view)})`);
  await g.delay(2500);
  const timeFrames = (n = 40) => g.evalJs(`(async () => {
    const ctx = __luma.ctx, r = ctx.renderer, dev = r.backend.device;
    const wait = () => dev ? dev.queue.onSubmittedWorkDone() : new Promise((res) => { const gl = r.backend.gl; gl.finish(); res(); });
    r.setAnimationLoop(null);
    // advance the node frame like the renderer's animation loop does, then run a full game frame
    const step = () => { const nf = r._nodes.nodeFrame; nf.update(); r.info.frame = nf.frameId; ctx.services.loop.frame(ctx, performance.now()); };
    for (let i = 0; i < 5; i++) { step(); await wait(); }
    const ts = [];
    for (let i = 0; i < ${n}; i++) { const t0 = performance.now(); step(); await wait(); ts.push(performance.now() - t0); }
    r.setAnimationLoop((t) => ctx.services.loop.frame(ctx, t));
    ts.sort((a, b) => a - b);
    return ts[Math.floor(ts.length / 2)];
  })()`);
  const quality = (await g.stats()).quality;
  const variants = (g.args.variants ? JSON.parse(g.args.variants) : [
    ['preset', {}],
    ['no-ao', { ao: false }],
    ['no-bloom', { bloom: false }],
    ['aa-none', { aa: 'none' }],
    ['bare', { ao: false, bloom: false, aa: 'none', ssgi: false }],
  ]);
  const res = {};
  for (const [name, o] of variants) {
    await g.evalJs(`__lumaRender.postOptions(${JSON.stringify(o)})`);
    await g.delay(1500);
    res[name] = await timeFrames();
    console.log(`frame ${view} [${quality}] ${name}: ${res[name].toFixed(2)} ms`);
  }
  await g.evalJs('__lumaRender.postOptions({})');
  await g.evalJs('__lumaRender.bypassPost(true)');
  await g.delay(800);
  res.direct = await timeFrames();
  console.log(`frame ${view} direct (no pipeline): ${res.direct.toFixed(2)} ms`);
  await g.evalJs('__lumaRender.bypassPost(false)');
  await g.evalJs('__lumaRender.shadows(false)');
  await g.delay(2000);
  res.noShadow = await timeFrames();
  await g.evalJs('__lumaRender.shadows(true)');
  await g.delay(1500);
  res.preset2 = await timeFrames();
  console.log(`frame ${view} no shadows: ${res.noShadow.toFixed(2)} ms (preset again ${res.preset2.toFixed(2)})`);
  console.log(`SUMMARY ${view} [${quality}]: post ~${(res.preset - res.direct).toFixed(2)} ms, shadows ~${(res.preset2 - res.noShadow).toFixed(2)} ms, frame ${res.preset.toFixed(2)} ms`);
}
