// shadow render cost without recompiling: freeze shadow map updates for a moment
export default async function (g) {
  await g.luma("L.view('opening')");
  await g.delay(2500);
  const fps = async (label) => {
    await g.delay(1200);
    const a = await g.stats(); await g.delay(3000); const b = await g.stats();
    console.log(label.padEnd(22), ((b.frames - a.frames) / 3).toFixed(1), 'fps');
  };
  await fps('baseline');
  await g.evalJs('window.__sunUpd = __lumaRender.service.sun.update; __lumaRender.service.sun.update = () => {}');
  await fps('shadow maps frozen');
  await g.evalJs('__lumaRender.service.sun.update = window.__sunUpd');
}
