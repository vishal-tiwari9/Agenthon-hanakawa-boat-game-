// draw calls and triangles per frame in the follow view after cruising into the village, what the
// structures and bridges groups contribute (by toggling them), and their mesh counts per pass
export default async function (g) {
  await g.delay(1200);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(400);
  await g.luma("L.press('interact')");
  await g.luma("L.hold('forward', true)");
  await g.delay(+(g.args.cruise || 7000));
  await g.luma('L.releaseAll()');
  await g.luma("(L.look(L.ctx.camera.position.toArray(), L.ctx.camera.position.clone().add(L.ctx.camera.getWorldDirection(new L.ctx.camera.position.constructor()).multiplyScalar(40)).toArray()), L.ctx.paused = true, true)");
  const frame = async (label) => {
    await g.delay(1200);
    const a = await g.luma('({ f: L.stats().frames, t: performance.now() })');
    await g.delay(2500);
    const b = await g.luma('({ f: L.stats().frames, t: performance.now(), d: L.ctx.renderer.info.render.drawCalls, tri: L.ctx.renderer.info.render.triangles })');
    const ms = (b.t - a.t) / (b.f - a.f);
    console.log(label.padEnd(22), `draws ${String(b.d).padStart(5)}  tris ${(b.tri / 1e6).toFixed(2)}M  ${ms.toFixed(1)} ms`);
    return b;
  };
  const mine = "(o) => /^(structures|town|life|frontage|prop:|bridges)/.test(o.name)";
  const groups = await g.luma(`(() => {
    const cam = L.ctx.camera; cam.updateMatrixWorld();
    const out = {};
    const top = (o) => { let r = o; while (r.parent && r.parent !== L.ctx.scene) r = r.parent; return r; };
    L.ctx.scene.traverseVisible((o) => {
      if (!o.isMesh) return;
      const t = top(o);
      if (!(${mine})(t)) return;
      const k = t.name.split(':').slice(0, 2).join(':');
      const e = out[k] || (out[k] = { meshes: 0, refl: 0, cast: 0, tris: 0 });
      const n = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 * (o.count ?? 1);
      e.meshes++; e.tris += n;
      if (o.layers.isEnabled(0)) e.refl++;
      if (o.castShadow) e.cast++;
    });
    for (const e of Object.values(out)) e.tris = Math.round(e.tris / 1000) + 'k';
    return out;
  })()`);
  const tot = Object.values(groups).reduce((a, e) => ({ meshes: a.meshes + e.meshes, refl: a.refl + e.refl, cast: a.cast + e.cast }), { meshes: 0, refl: 0, cast: 0 });
  console.log('visible (whole scene, not frustum) meshes of mine:', JSON.stringify(tot));
  for (const [k, e] of Object.entries(groups).sort((a, b) => b[1].meshes - a[1].meshes)) console.log('  ', k.padEnd(28), JSON.stringify(e));
  const base = await frame('baseline');
  // detach rather than hide: per-frame culling code would turn hidden groups back on
  const hide = async (pred, on) => g.luma(on
    ? '(() => { const h = window.__hidden || []; h.forEach((o) => L.ctx.scene.add(o)); window.__hidden = []; return h.length; })()'
    : `(() => { const h = L.ctx.scene.children.filter((o) => ${pred}); h.forEach((o) => L.ctx.scene.remove(o)); window.__hidden = h; return h.length; })()`);
  const stru = "/^(structures|town|life|frontage|prop:)/.test(o.name)";
  await hide(stru, false);
  const s = await frame('no structures');
  await hide(stru, true);
  await hide("o.name === 'bridges'", false);
  const b = await frame('no bridges');
  await hide("o.name === 'bridges'", true);
  console.log(`structures: ${base.d - s.d} draws, ${((base.tri - s.tri) / 1e6).toFixed(2)}M tris; bridges: ${base.d - b.d} draws, ${((base.tri - b.tri) / 1e6).toFixed(2)}M tris`);
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 3).join('\n'));
}
