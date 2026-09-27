// vegetation look for the opening stretch (s 0-700): close-up lawn, a flowery bank, the wooded
// hills, the canal banks and the opening view. poses are searched at runtime from the vegetation
// field so they follow the layout.
// usage: node test/harness.mjs vegetation-look --tag=vegetation2 --size=1600x900 --quiet [--views=grass,flowers] [--suffix=x]
export default async function (g) {
  await g.delay(1000);
  await g.evalJs(`(() => { const s = document.createElement('style'); s.textContent = '#ui, #loading { display: none !important; }'; document.head.appendChild(s); })()`);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(400);
  const views = (g.args.views || 'grass,flowers,hills,canal,opening').split(',');
  const suffix = g.args.suffix ? `-${g.args.suffix}` : '';
  const layout = `await import('/src/world/layout.ts')`;
  // best field spot along the opening stretch: highest mean of a field array in a small disc
  const spot = (arr, lo, hi, r) => `(() => { const f = L.ctx.services.vegetation.field; let best = null, bv = -1;
    for (let s = 40; s < 680; s += 6) for (const side of [-1, 1]) for (let off = ${lo}; off < ${hi}; off += 3) {
      const p = Lay.bankPoint(s, side, off); let v = 0, n = 0;
      for (let a = 0; a < 6; a++) { const x = p.x + Math.cos(a) * ${r}, z = p.z + Math.sin(a) * ${r}; v += f.sample(f.${arr}, x, z); n++; }
      v /= n; if (v > bv) { bv = v; best = { s, side, off, x: p.x, z: p.z, v }; } }
    return best; })()`;
  for (const v of views) {
    let info = null;
    if (v === 'grass') {
      info = await g.luma(`(async () => { const Lay = ${layout}; const w = L.ctx.world; const b = ${spot('density', 3, 30, 4)};
        const f = Lay.riverFrame(b.s); const e = [b.x - f.tx * 6, 0, b.z - f.tz * 6];
        e[1] = w.heightAt(e[0], e[2]) + 0.9;
        L.look(e, [b.x + f.tx * 4, w.heightAt(b.x, b.z) + 0.1, b.z + f.tz * 4]); return b; })()`);
    } else if (v === 'flowers') {
      info = await g.luma(`(async () => { const Lay = ${layout}; const w = L.ctx.world; const b = ${spot('flower', 1, 24, 3)};
        const f = Lay.riverFrame(b.s); const e = [b.x - f.tx * 8 - f.nx * b.side * 2, 0, b.z - f.tz * 8 - f.nz * b.side * 2];
        e[1] = Math.max(0.5, w.heightAt(e[0], e[2])) + 1.4;
        L.look(e, [b.x + f.tx * 3, w.heightAt(b.x, b.z), b.z + f.tz * 3]); return b; })()`);
    } else if (v === 'hills') {
      await g.luma(`(async () => { const Lay = ${layout}; const w = L.ctx.world;
        const e = Lay.riverFrame(160), t = Lay.bankPoint(260, 1, 170);
        L.look([e.x, 3.2, e.z], [t.x, w.heightAt(t.x, t.z) * 0.7, t.z]); })()`);
    } else if (v === 'hillsL') {
      await g.luma(`(async () => { const Lay = ${layout}; const w = L.ctx.world;
        const e = Lay.riverFrame(430), t = Lay.bankPoint(540, -1, 160);
        L.look([e.x, 3.2, e.z], [t.x, w.heightAt(t.x, t.z) * 0.7, t.z]); })()`);
    } else if (v === 'canal') {
      await g.luma(`(async () => { const Lay = ${layout};
        const e = Lay.bankPoint(96, -1, -7), t = Lay.bankPoint(175, -1, 2);
        L.look([e.x, 2.6, e.z], [t.x, 2.4, t.z]); })()`);
    } else if (v === 'canalR') {
      await g.luma(`(async () => { const Lay = ${layout};
        const e = Lay.bankPoint(470, 1, -8), t = Lay.bankPoint(560, 1, 2);
        L.look([e.x, 2.6, e.z], [t.x, 2.4, t.z]); })()`);
    } else if (v === 'temple') {
      await g.luma(`(async () => { const Lay = ${layout};
        const e = Lay.bankPoint(360, -1, -10), t = Lay.bankPoint(420, 1, 20);
        L.look([e.x, 3, e.z], [t.x, 6, t.z]); })()`);
    } else {
      const ok = await g.luma(`L.view(${JSON.stringify(v)})`);
      if (!ok) console.log('view not available:', v);
    }
    await g.delay(Number(g.args.settle) || 2600);
    if (info) console.log(v, JSON.stringify(info));
    await g.shot(v + suffix);
  }
  console.log('veg', JSON.stringify(await g.luma('L.ctx.services.vegetation && L.ctx.services.vegetation.stats()')));
  console.log('stats', JSON.stringify(await g.stats()));
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 5).join('\n'));
}
