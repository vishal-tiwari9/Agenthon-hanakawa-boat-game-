// reflection and post costs at the village view (runtime toggles without recompiles)
export default async function (g) {
  await g.luma("L.view('village')");
  await g.delay(2500);
  const fps = async (label) => { await g.delay(1500); const a = await g.stats(); await g.delay(3000); const b = await g.stats(); const f = (b.frames - a.frames) / 3; console.log(label.padEnd(24), f.toFixed(1), 'fps', (1000 / f).toFixed(2), 'ms'); };
  await fps('baseline');
  await g.luma('L.ctx.services.water.setReflectionEnabled(false)'); await fps('no planar reflection'); await g.luma('L.ctx.services.water.setReflectionEnabled(true)');
  await g.evalJs('__lumaRender.bypassPost(true)'); await fps('no post pipeline'); await g.evalJs('__lumaRender.bypassPost(false)');
  await g.evalJs('window.__su = __lumaRender.service.sun.update; __lumaRender.service.sun.update = () => {}'); await fps('shadow maps frozen'); await g.evalJs('__lumaRender.service.sun.update = window.__su');
}
