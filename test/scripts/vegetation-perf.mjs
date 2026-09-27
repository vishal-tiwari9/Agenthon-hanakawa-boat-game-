// vegetation cost: frame time per view with vegetation visible vs hidden (same run, same views).
// rAF is pumped by a 4 ms timer, so these are throughput numbers, not vsync-limited.
// usage: node test/harness.mjs vegetation-perf --tag=vegetation --views=harbor,harbor-wide,close
export default async function (g) {
  await g.evalJs(`(() => { const s = document.createElement('style'); s.textContent = '#ui, #loading { display: none !important; }'; document.head.appendChild(s); })()`);
  const views = (g.args.views || 'harbor,harbor-wide').split(',');
  const measure = async (ms = 3000) => {
    const a = await g.stats();
    await g.delay(ms);
    const b = await g.stats();
    const frames = b.frames - a.frames;
    return { ms: ms / Math.max(1, frames), calls: b.calls, tris: b.triangles };
  };
  for (const v of views) {
    if (v === 'close') await g.luma(`(() => { const w = L.ctx.world, ex = -139.5, ez = 146.6; L.look([ex, w.heightAt(ex, ez) + 1.7, ez], [-120, w.heightAt(-127.5, 158.6) - 1, 170]); })()`);
    else await g.luma(`L.view(${JSON.stringify(v)})`);
    await g.luma(`L.ctx.services.vegetation.root.visible = true`);
    await g.delay(2500);
    const on = await measure();
    const vs = await g.luma(`L.ctx.services.vegetation.stats()`);
    await g.luma(`L.ctx.services.vegetation.root.visible = false`);
    await g.delay(800);
    const off = await measure();
    await g.luma(`L.ctx.services.vegetation.root.visible = true`);
    console.log(`perf ${v}: on ${on.ms.toFixed(2)} ms (${on.calls} calls, ${(on.tris / 1e6).toFixed(2)}M tris) | off ${off.ms.toFixed(2)} ms (${off.calls} calls, ${(off.tris / 1e6).toFixed(2)}M tris) | vegetation ~${(on.ms - off.ms).toFixed(2)} ms`);
    console.log(`  grass ${vs.grass.visible} tiles ${vs.grass.instances} tufts | flowers ${vs.flowers.instances} | shrubs ${vs.shrubs?.instances ?? 0} | trees ${vs.trees}`);
  }
}
