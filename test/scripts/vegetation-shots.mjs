// vegetation screenshots along the river. named debug views (opening, village, pagoda, gorge, lake,
// aerial...) plus vegetation close-ups derived from the river layout at runtime:
//   bank      eye height on the village-side bank looking across tall grass to the water
//   cherry    a few meters from the nearest cherry tree to the village landing
//   forest    at the forest edge looking up the valley wall (near meshes into impostors)
//   slope     mid-river looking at a forested wall 150-300 m away (impostors only)
//   look:x_y_z_tx_ty_tz  any pose
// usage: node test/harness.mjs vegetation-shots --tag=vegetation --views=opening,bank,cherry [--ground=0.9] [--suffix=x]
export default async function (g) {
  await g.delay(1200);
  if (!g.args.ui) await g.evalJs(`(() => { const s = document.createElement('style'); s.textContent = '#ui, #loading { display: none !important; }'; document.head.appendChild(s); })()`);
  const views = (g.args.views || 'opening,bank').split(',');
  const suffix = (g.args.backend ? `-${g.args.backend}` : '') + (g.args.ground ? '-ground' : '') + (g.args.suffix ? `-${g.args.suffix}` : '');
  if (g.args.ground) console.log('ground preview meshes:', await g.luma(`L.ctx.services.vegetation.previewGround(${Number(g.args.ground) || 0.9})`));
  const layout = `await import('/src/world/layout.ts')`;
  for (const v of views) {
    let name = v + suffix;
    if (v === 'bank') {
      await g.luma(`(async () => { const Lay = ${layout}; const w = L.ctx.world;
        const e = Lay.bankPoint(236, -1, 7), t = Lay.bankPoint(262, 1, -6);
        L.look([e.x, w.heightAt(e.x, e.z) + 1.6, e.z], [t.x, 0.5, t.z]); })()`);
    } else if (v === 'cherry' || v === 'maple' || v === 'cedar') {
      const ok = await g.luma(`(async () => { const Lay = ${layout}; const w = L.ctx.world; const f = L.ctx.services.vegetation.forest;
        const vs = f.variants.filter((x) => x.species.id === ${JSON.stringify(v)} && x.count);
        const spawn = Lay.SPAWN; let best = null, bd = 1e9;
        for (const x of vs) for (let i = 0; i < x.count; i++) { const o = i * 8; const d = Math.hypot(x.all[o] - spawn.x, x.all[o + 2] - spawn.z); if (d < bd) { bd = d; best = [x.all[o], x.all[o + 1], x.all[o + 2], x.all[o + 4] * x.height]; } }
        if (!best) return false;
        const [tx, ty, tz, h] = best; const r = Lay.nearestRiver(tx, tz); const f2 = Lay.riverFrame(r.s);
        const side = Math.sign(r.lateral) || 1; const ex = tx - f2.nx * side * (h * 1.5 + 4), ez = tz - f2.nz * side * (h * 1.5 + 4);
        L.look([ex, Math.max(w.heightAt(ex, ez), 0) + 1.8, ez], [tx, ty + h * 0.45, tz]); return true; })()`);
      if (!ok) { console.log('no', v); continue; }
    } else if (v === 'forest') {
      await g.luma(`(async () => { const Lay = ${layout}; const w = L.ctx.world;
        let s = 560, best = null; for (let off = 10; off < 120; off += 4) { const p = Lay.bankPoint(s, 1, off); if (w.sample('trees', p.x, p.z) > 0.5) { best = off; break; } }
        const e = Lay.bankPoint(s, 1, Math.max(4, (best ?? 30) - 18)), t = Lay.bankPoint(s + 30, 1, (best ?? 30) + 60);
        L.look([e.x, w.heightAt(e.x, e.z) + 1.7, e.z], [t.x, w.heightAt(t.x, t.z) + 6, t.z]); })()`);
    } else if (v === 'slope') {
      await g.luma(`(async () => { const Lay = ${layout}; const w = L.ctx.world;
        const e = Lay.riverFrame(600), t = Lay.bankPoint(640, -1, 180);
        L.look([e.x, 3, e.z], [t.x, w.heightAt(t.x, t.z) * 0.8, t.z]); })()`);
    } else if (v.startsWith('look:')) {
      const [px, py, pz, tx, ty, tz] = v.slice(5).split('_').map(Number);
      await g.luma(`L.look([${px}, ${py}, ${pz}], [${tx}, ${ty}, ${tz}])`);
      name = 'look' + suffix + '-' + views.indexOf(v);
    } else {
      const ok = await g.luma(`L.view(${JSON.stringify(v)})`);
      if (!ok) console.log('view not available:', v);
    }
    await g.delay(Number(g.args.settle) || 2400);
    await g.shot(name);
  }
  console.log('veg', JSON.stringify(await g.luma('L.ctx.services.vegetation && L.ctx.services.vegetation.stats()')));
  console.log('stats', JSON.stringify(await g.stats()));
}
