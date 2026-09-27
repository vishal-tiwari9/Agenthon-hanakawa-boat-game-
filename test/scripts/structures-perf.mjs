// structures: frame time at a few views with structures shown vs hidden, so the module's own
// cost can be separated from everyone else's. rAF is timer pumped, so these are throughput numbers.
export default async function (g) {
  await g.delay(2500);
  await g.evalJs(`(() => { const u = document.getElementById('ui'); if (u) u.style.visibility = 'hidden'; })()`);
  const views = (g.args.views || 'harbor,harbor-wide').split(',');
  const setVis = (on) => g.luma(`(() => {
    const keep = (o) => o.name && (o.name.startsWith('structures') || o.name.startsWith('prop:'));
    let n = 0;
    L.ctx.scene.traverse((o) => { if (keep(o) && o.parent === L.ctx.scene) { o.visible = ${on}; n++; } });
    return n;
  })()`);
  const measure = async () => {
    await g.delay(1200);
    const a = await g.stats();
    await g.delay(3000);
    const b = await g.stats();
    const frames = b.frames - a.frames;
    return { ms: 3000 / frames, calls: b.calls, tris: b.triangles };
  };
  for (const v of views) {
    await g.luma(`L.view(${JSON.stringify(v)})`);
    await setVis(true);
    const on = await measure();
    const n = await setVis(false);
    const off = await measure();
    await setVis(true);
    console.log(`perf ${v}: with structures ${on.ms.toFixed(2)} ms (calls ${on.calls}, tris ${on.tris}) | without ${off.ms.toFixed(2)} ms (calls ${off.calls}, tris ${off.tris}) | structures ~${(on.ms - off.ms).toFixed(2)} ms, ${n} groups toggled`);
  }
}
