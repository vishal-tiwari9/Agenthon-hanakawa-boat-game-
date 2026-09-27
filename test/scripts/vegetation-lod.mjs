// targeted tree lod check. time is paused and every rendered frame moves the camera one step
// (virtual 60 hz clock, as render-frames.mjs), always looking at one tree, and only a crop around
// that tree is compared frame to frame. smooth approach changes the crop smoothly; a lod swap or an
// impostor frame snap shows as a spike far above the local median.
//   --mode=approach  the canal-side cherry nearest the landing, from ~95 m to ~15 m along the river
//                    (crosses the mesh/impostor band and the lod0/lod1 band)
//   --mode=pass      a hillside cedar 150-250 m off the river, passed at 0.5 m per frame from 22 m up
//                    (above the lantern strings; the impostor turns through its atlas frames)
//   --mode=match     no motion: the same tree at the same pose drawn as mesh vs impostor (~60 m) and
//                    lod0 vs lod1 (~24 m). the difference is what a hard swap would pop by; mean rgb
//                    of both shows how well the representations match
// usage: node test/harness.mjs vegetation-lod --tag=vegetation2 --size=1280x720 --quiet [--mode=approach] [--suffix=x]
export default async function (g) {
  const mode = g.args.mode || 'approach';
  const suffix = g.args.suffix ? `-${g.args.suffix}` : '';
  await g.delay(1200);
  await g.evalJs(`(() => { const s = document.createElement('style'); s.textContent = '#ui, #loading { display: none !important; }'; document.head.appendChild(s); })()`);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(800);
  const setup = await g.evalJs(`(async () => {
    const Lay = await import('/src/world/layout.ts');
    const V3 = __luma.ctx.camera.position.constructor;
    const c = __luma.ctx, f = c.services.vegetation.forest;
    const mode = ${JSON.stringify(mode)};
    // pick the tree
    let best = null, bd = 1e9;
    for (const v of f.variants) {
      const near = mode !== 'pass';
      if (v.species.id !== (${JSON.stringify(g.args.species || '')} || (near ? 'cherry' : 'cedar'))) continue;
      for (let i = 0; i < v.count; i++) {
        const o = i * 8, x = v.all[o], z = v.all[o + 2];
        const r = Lay.nearestRiver(x, z);
        let d;
        if (near) { if (r.s < 120 || r.s > 600 || Math.abs(r.lateral) - r.width / 2 > 40) continue; d = Math.abs(r.s - 250) + Math.abs(Math.abs(r.lateral) - r.width / 2 - 12) * 3; }
        else { const off = Math.abs(r.lateral) - r.width / 2; if (r.s < 380 || r.s > 560 || off < 150 || off > 250) continue; d = Math.abs(off - 190) + Math.abs(r.s - 470); }
        if (d < bd) { bd = d; const sc = v.all[o + 4]; best = { x, y: v.all[o + 1] + v.center.y * sc, z, s: r.s, lat: r.lateral, h: v.height * sc }; }
      }
    }
    if (!best) return null;
    const T = new V3(best.x, best.y, best.z);
    if (mode === 'match') return { tree: best, n: 0, R: 0 };
    const n = mode === 'approach' ? 600 : 160;
    const poses = [];
    for (let k = 0; k < n; k++) {
      let p;
      if (mode === 'approach') {
        // start downstream, far away, and come up the river toward the tree
        const fr = Lay.riverFrame(best.s - 95 + k * 0.125);
        p = new V3(fr.x, 3.2, fr.z);
      } else {
        const fr = Lay.riverFrame(best.s - 40 + k * 0.5);
        p = new V3(fr.x, 22, fr.z);
      }
      poses.push(p);
    }
    window.__poses = poses; window.__T = T;
    c.cameraRig.setOverride(poses[0], T);
    const r = c.render;
    let vt = performance.now();
    window.__vframe = 0;
    window.requestAnimationFrame = (fn) => setTimeout(() => { vt += 1000 / 60; window.__vframe++; fn(vt); }, 4);
    window.__rois = []; window.__dist = []; window.__on = false; window.__k = 0;
    const R = ${Number(g.args.roi || 0)} || (mode === 'approach' ? 360 : 96);
    c.render = () => {
      r();
      if (window.__on && window.__k < poses.length) {
        const W = c.canvas.width, H = c.canvas.height;
        window.__rois.push(createImageBitmap(c.canvas, Math.round(W / 2 - R / 2), Math.round(H / 2 - R / 2), R, R));
        window.__dist.push(poses[window.__k].distanceTo(T));
        window.__k++;
        if (window.__k < poses.length) c.cameraRig.setOverride(poses[window.__k], T);
      }
    };
    return { tree: best, n, R };
  })()`);
  if (!setup) { console.log('no tree found for', mode); return false; }
  console.log('tree', JSON.stringify(setup));
  if (mode === 'match') return match(g, setup.tree);
  await g.delay(3000);
  await g.luma('L.ctx.paused = true');
  await g.delay(100);
  await g.evalJs('window.__on = true');
  for (let i = 0; i < 600; i++) { if (await g.evalJs(`window.__rois.length >= ${setup.n}`)) break; await g.delay(100); }
  await g.luma('L.ctx.paused = false');
  const res = await g.evalJs(`(async () => {
    const out = [];
    let prev = null;
    for (const p of window.__rois) {
      const b = await p, oc = new OffscreenCanvas(b.width, b.height), cx = oc.getContext('2d');
      cx.drawImage(b, 0, 0);
      const d = cx.getImageData(0, 0, b.width, b.height).data;
      // 8x8 block means: a swap changes local coverage and colour, leaf shimmer is finer than a block
      const bw = Math.floor(b.width / 8), bh = Math.floor(b.height / 8), L = new Float32Array(bw * bh);
      for (let y = 0; y < bh * 8; y++) for (let x = 0; x < bw * 8; x++) { const k = y * b.width + x; L[(y >> 3) * bw + (x >> 3)] += (0.3 * d[k * 4] + 0.59 * d[k * 4 + 1] + 0.11 * d[k * 4 + 2]) / 64; }
      if (prev) { let s = 0; for (let k = 0; k < L.length; k++) s += Math.abs(L[k] - prev[k]); out.push(s / L.length); }
      prev = L;
    }
    return { diffs: out, dist: window.__dist };
  })()`);
  const { diffs, dist } = res;
  const spikes = [];
  for (let k = 0; k < diffs.length; k++) {
    const nb = [];
    for (let j = k - 4; j <= k + 4; j++) if (j !== k && j >= 0 && j < diffs.length) nb.push(diffs[j]);
    nb.sort((a, b) => a - b);
    const med = nb[nb.length >> 1];
    if (diffs[k] > med * 2 && diffs[k] - med > 0.35) spikes.push({ frame: k + 1, dist: +dist[k + 1].toFixed(1), diff: +diffs[k].toFixed(2), median: +med.toFixed(2) });
  }
  const sorted = [...diffs].sort((a, b) => a - b);
  console.log(`lod ${mode}${suffix}: ${diffs.length} steps, median diff ${sorted[sorted.length >> 1].toFixed(2)}, max ${sorted[sorted.length - 1].toFixed(2)}, spikes ${spikes.length}`);
  for (const s of spikes.slice(0, 20)) console.log('  spike', JSON.stringify(s));
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 5).join('\n'));
}

async function match(g, t) {
  await g.delay(2500);
  const grab = (near, lod0, dist) => g.evalJs(`(async () => {
    const c = __luma.ctx, F = await import('/src/vegetation/forest.ts'), Lay = await import('/src/world/layout.ts');
    const V3 = c.camera.position.constructor;
    const T = new V3(${t.x}, ${t.y}, ${t.z});
    // camera on the water, ${dist} m from the tree, looking at it
    let best = null, bd = 1e9;
    for (let s = ${t.s} - 120; s < ${t.s} + 120; s += 0.5) { const f = Lay.riverFrame(s); const d = Math.abs(Math.hypot(f.x - T.x, 3.2 - T.y, f.z - T.z) - ${dist}); if (d < bd) { bd = d; best = new V3(f.x, 3.2, f.z); } }
    c.cameraRig.setOverride(best, T);
    F.forestDist.near.value = ${near}; F.forestDist.lod0.value = ${lod0};
    c.paused = true;
    await new Promise((r) => setTimeout(r, 900));
    const bmp = await createImageBitmap(c.canvas, Math.round(c.canvas.width / 2 - 100), Math.round(c.canvas.height / 2 - 100), 200, 200);
    const oc = new OffscreenCanvas(200, 200), cx = oc.getContext('2d'); cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, 200, 200).data;
    const L = new Float32Array(25 * 25 * 3);
    for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) { const k = (y * 200 + x) * 4, b = ((y >> 3) * 25 + (x >> 3)) * 3; L[b] += d[k] / 64; L[b + 1] += d[k + 1] / 64; L[b + 2] += d[k + 2] / 64; }
    c.paused = false;
    return Array.from(L);
  })()`);
  const cmp = (a, b) => { let s = 0; const m = [0, 0, 0, 0, 0, 0]; for (let i = 0; i < a.length; i++) { s += Math.abs(a[i] - b[i]); m[i % 3] += a[i]; m[3 + (i % 3)] += b[i]; } const n = a.length / 3; return { meanAbs: +(s / a.length).toFixed(2), rgbA: m.slice(0, 3).map((v) => Math.round(v / n)), rgbB: m.slice(3).map((v) => Math.round(v / n)) }; };
  const mesh60 = await grab(1000, 0, 60), imp60 = await grab(1, 0, 60);
  console.log('mesh vs impostor at 60 m', JSON.stringify(cmp(mesh60, imp60)));
  const l0 = await grab(1000, 1000, 24), l1 = await grab(1000, 0, 24);
  console.log('lod0 vs lod1 at 24 m', JSON.stringify(cmp(l0, l1)));
  const again = await grab(1000, 1000, 24);
  console.log('lod0 vs lod0 (noise floor)', JSON.stringify(cmp(l0, again)));
  await g.evalJs(`(async () => { const F = await import('/src/vegetation/forest.ts'); F.forestDist.near.value = 68; F.forestDist.lod0.value = 26; })()`);
}
