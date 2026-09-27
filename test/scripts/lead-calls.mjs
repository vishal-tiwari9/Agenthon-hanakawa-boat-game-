// draw calls per frame at the slow village pose, and which object groups contribute the most meshes
export default async function (g) {
  await g.delay(1200);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(400);
  await g.luma("L.press('interact')");
  await g.luma("L.hold('forward', true)");
  await g.delay(7000);
  await g.luma('L.releaseAll()');
  await g.luma("(L.look(L.ctx.camera.position.toArray(), L.ctx.camera.position.clone().add(L.ctx.camera.getWorldDirection(new L.ctx.camera.position.constructor()).multiplyScalar(40)).toArray()), L.ctx.paused = true, true)");
  await g.delay(1500);
  const a = await g.luma('({ c: L.ctx.renderer.info.render.calls, f: L.stats().frames })');
  await g.delay(2000);
  const b = await g.luma('({ c: L.ctx.renderer.info.render.calls, f: L.stats().frames })');
  console.log('draw calls per frame', ((b.c - a.c) / (b.f - a.f)).toFixed(0));
  const groups = await g.luma(`(() => { const m = {}; L.ctx.scene.traverseVisible((o) => { if (!o.isMesh && !o.isSprite && !o.isPoints) return; let r = o; while (r.parent && r.parent !== L.ctx.scene) r = r.parent; const k = (r.name || r.type).split(':').slice(0, 2).join(':'); m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, 14); })()`);
  console.log('visible meshes by group', JSON.stringify(groups));
}
