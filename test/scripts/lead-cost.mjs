// frame cost breakdown at the opening view: toggle one system at a time
export default async function (g) {
  await g.luma("L.view('opening')");
  await g.delay(2500);
  const fps = async (label) => {
    await g.delay(1200);
    const a = await g.stats(); await g.delay(3000); const b = await g.stats();
    console.log(label.padEnd(22), ((b.frames - a.frames) / 3).toFixed(1), 'fps');
  };
  const find = (name) => `(() => { let o = null; L.ctx.scene.traverse((x) => { if (!o && x.name === ${JSON.stringify(name)}) o = x; }); return o; })()`;
  await fps('baseline');
  await g.evalJs('__lumaRender.shadows(false)'); await fps('no sun shadows'); await g.evalJs('__lumaRender.shadows(true)');
  for (const n of ['forest', 'vegetation', 'bank-details', 'frontage', 'bridges', 'terrain', 'water']) {
    const ok = await g.luma(`(() => { const o = ${find(n)}; if (!o) return false; o.visible = false; return true; })()`);
    if (!ok) { console.log(n, 'not found'); continue; }
    await fps('no ' + n);
    await g.luma(`(() => { const o = ${find(n)}; o.visible = true; return true; })()`);
  }
}
