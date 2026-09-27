// which casters dominate the shadow pass: toggle castShadow on groups while comparing frozen vs live shadows
export default async function (g) {
  await g.luma("L.view('opening')");
  await g.delay(2500);
  const fps = async () => { await g.delay(1500); const a = await g.stats(); await g.delay(2500); const b = await g.stats(); return (b.frames - a.frames) / 2.5; };
  const freeze = (on) => g.evalJs(on ? 'window.__su ??= __lumaRender.service.sun.update, __lumaRender.service.sun.update = () => {}' : '__lumaRender.service.sun.update = window.__su');
  const cast = (name, on) => g.luma(`(() => { let n = 0; L.ctx.scene.traverse((o) => { if (o.name === ${JSON.stringify(name)}) o.traverse((m) => { if (m.isMesh) { m.userData.cs ??= m.castShadow; m.castShadow = ${on} ? m.userData.cs : false; n++; } }); }); return n; })()`);
  for (const grp of ['none', 'forest', 'terrain', 'bridges', 'structures:frontage', 'vegetation']) {
    if (grp !== 'none') await cast(grp, false);
    const live = await fps(); await freeze(true); const frozen = await fps(); await freeze(false);
    console.log(`${grp.padEnd(22)} shadow cost ${(1000 / live - 1000 / frozen).toFixed(2)} ms  (live ${live.toFixed(1)} fps)`);
    if (grp !== 'none') await cast(grp, true);
  }
}
