// render module cost per view: post pipeline and sun shadows, from serialized frame timing.
// the game loop is paused; frames run back to back and each waits on queue.onSubmittedWorkDone(),
// so a frame's number is cpu + gpu with no overlap. (webgpu timestamp queries on apple gpus report
// pass durations that include scheduling gaps, so they are not used.)
//   post    = frame with the pipeline - same frame rendered directly without it
//   shadows = frame with sun shadows - same frame with castShadow off
// node test/harness.mjs render-perf --tag=render [--views=harbor,open-water] [--quality=balanced]
export default async function (g) {
  const views = (g.args.views || 'harbor,open-water,cliffside,cove').split(',');
  const timeFrames = (n = 40) => g.evalJs(`(async () => {
    const ctx = __luma.ctx, r = ctx.renderer, dev = r.backend.device;
    const wait = () => dev ? dev.queue.onSubmittedWorkDone() : Promise.resolve(r.backend.gl.finish());
    r.setAnimationLoop(null);
    const step = () => { const nf = r._nodes.nodeFrame; nf.update(); r.info.frame = nf.frameId; ctx.services.loop.frame(ctx, performance.now()); };
    for (let i = 0; i < 5; i++) { step(); await wait(); }
    const ts = [];
    for (let i = 0; i < ${n}; i++) { const t0 = performance.now(); step(); await wait(); ts.push(performance.now() - t0); }
    r.setAnimationLoop((t) => ctx.services.loop.frame(ctx, t));
    ts.sort((a, b) => a - b);
    return ts[Math.floor(ts.length / 2)];
  })()`);
  const quality = (await g.stats()).quality;
  const f = (x) => x.toFixed(2);
  for (const v of views) {
    await g.luma(`L.view(${JSON.stringify(v)})`);
    await g.delay(2500);
    const full = await timeFrames();
    await g.evalJs('__lumaRender.bypassPost(true)');
    const direct = await timeFrames();
    await g.evalJs('__lumaRender.bypassPost(false)');
    await g.evalJs('__lumaRender.shadows(false)');
    await g.delay(2000);
    const noShadow = await timeFrames();
    await g.evalJs('__lumaRender.shadows(true)');
    await g.delay(2000);
    const full2 = await timeFrames();
    const s = await g.stats();
    console.log(`PERF ${v} [${quality}]: frame ${f(full2)} ms, post ~${f(full - direct)} ms, shadows ~${f(full2 - noShadow)} ms  (calls ${s.calls}, tris ${s.triangles})`);
  }
}
