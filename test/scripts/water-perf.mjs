// water: cost of the water system per frame. the harness rAF pump caps frames at ~4 ms and apple
// gpu pass timestamps overlap, so neither measures it. instead the animation loop is stopped and
// n frames (updates + full render pipeline) are pushed back to back, then we wait for the gpu to
// finish: ms/frame = max(cpu submit, gpu) under full load. the water cost is the difference with the
// water mesh hidden (which also skips its planar reflection pass) and the wake/spray disabled.
export default async function (g) {
  const views = (g.args.views || 'harbor,open-water').split(',');
  const n = Number(g.args.frames || 90);
  await g.delay(1500);
  await g.luma(`(() => {
    const r = L.ctx.renderer, loop = L.ctx.services.loop;
    r.setAnimationLoop(null);
    const sync = async () => {
      if (r.backend.isWebGPUBackend) await r.backend.device.queue.onSubmittedWorkDone();
      else { const gl = r.backend.gl; const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    };
    let t = performance.now();
    window.__waterBench = async (frames) => {
      for (let i = 0; i < 5; i++) { t += 16.67; r._nodes.nodeFrame.update(); loop.frame(L.ctx, t); }
      await sync();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) { t += 16.67; r._nodes.nodeFrame.update(); loop.frame(L.ctx, t); }
      await sync();
      return (performance.now() - t0) / frames;
    };
    return true;
  })()`);
  const bench = async () => {
    const a = await g.evalJs(`window.__waterBench(${n})`);
    const b = await g.evalJs(`window.__waterBench(${n})`);
    return Math.min(a, b);
  };
  const setWater = (on) => g.luma(`(() => { const w = L.ctx.services.water; w.mesh.visible = ${on}; w.debug.setWake(${on}); return true; })()`);
  for (const v of views) {
    await g.luma(`L.view(${JSON.stringify(v)})`);
    const on = await bench();
    await g.luma('L.ctx.services.water.setReflectionEnabled(false)');
    const noRefl = await bench();
    await g.luma('L.ctx.services.water.setReflectionEnabled(true)');
    await setWater(false);
    const off = await bench();
    await setWater(true);
    console.log(`perf ${v} [${g.args.backend || 'webgpu'} ${g.args.quality || 'balanced'} ${g.W}x${g.H}]: frame ${on.toFixed(2)} ms with water, ${off.toFixed(2)} ms without => water ${(on - off).toFixed(2)} ms (planar reflection ${(on - noRefl).toFixed(2)} ms, surface+wake+spray ${(noRefl - off).toFixed(2)} ms)`);
  }
  await g.luma(`(() => { const r = L.ctx.renderer, loop = L.ctx.services.loop; r.setAnimationLoop((t) => loop.frame(L.ctx, t)); return true; })()`);
  return true;
}
