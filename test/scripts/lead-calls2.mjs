// visible meshes in the reflection (layer 0) and shadow-casting sets, by group
export default async function (g) {
  await g.luma("L.view('village')");
  await g.delay(2500);
  const r = await g.luma(`(() => { const refl = {}, cast = {}; L.ctx.scene.traverseVisible((o) => { if (!o.isMesh) return; let r = o; while (r.parent && r.parent !== L.ctx.scene) r = r.parent; const k = (r.name || r.type).split(':').slice(0, 2).join(':'); if (o.layers.isEnabled(0)) refl[k] = (refl[k] || 0) + 1; if (o.castShadow) cast[k] = (cast[k] || 0) + 1; }); const tot = (m) => Object.values(m).reduce((a, b) => a + b, 0); return { reflTotal: tot(refl), castTotal: tot(cast), refl: Object.entries(refl).sort((a, b) => b[1] - a[1]).slice(0, 10), cast: Object.entries(cast).sort((a, b) => b[1] - a[1]).slice(0, 10) }; })()`);
  console.log(JSON.stringify(r));
}
