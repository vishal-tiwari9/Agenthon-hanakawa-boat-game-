// lod popping along the river, on the render module's virtual 60 hz clock (see render-frames.mjs).
// time is paused (wind, water and petals hold still) and every rendered frame moves the camera
// exactly `step` m along the river (0.125 m = 7.5 m/s), set from inside the render hook, so runs
// with different code see identical frames and the streaming budgets are spent per frame as in play.
// each frame is reduced in-page to 4x4 block luminance (thin blades average out; a tree or patch
// changing its look does not). a block that jumps in one frame while holding steady in the frames
// before and after is counted as a pop; smooth parallax is not.
// usage: node test/harness.mjs vegetation-pops --tag=vegetation2 --size=1280x720 --quiet [--frames=120] [--from=200] [--step=0.125] [--lat=0] [--aim=14] [--save] [--suffix=x]
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export default async function (g) {
  const n = Number(g.args.frames || 120), B = 4;
  const suffix = g.args.suffix ? `-${g.args.suffix}` : '';
  await g.delay(1200);
  await g.evalJs(`(() => { const s = document.createElement('style'); s.textContent = '#ui, #loading { display: none !important; }'; document.head.appendChild(s); })()`);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(800);
  const from = Number(g.args.from ?? 200), step = Number(g.args.step ?? 0.125), lat = Number(g.args.lat ?? 0), aim = Number(g.args.aim ?? 14), y = Number(g.args.y ?? 3.4);
  await g.evalJs(`(async () => {
    const Lay = await import('/src/world/layout.ts');
    const Vector3 = __luma.ctx.camera.position.constructor;
    const c = __luma.ctx, r = c.render;
    const pose = (k) => { const s = ${from} + k * ${step}; const f = Lay.riverFrame(s), t = Lay.riverFrame(s + 60);
      c.cameraRig.setOverride(new Vector3(f.x + f.nx * ${lat}, ${y}, f.z + f.nz * ${lat}), new Vector3(t.x + t.nx * ${aim}, 3, t.z + t.nz * ${aim})); };
    pose(0);
    if (${!!g.args.noveg}) { c.services.vegetation.root.visible = false; c.scene.getObjectByName('bank-details').visible = false; }
    let vt = performance.now();
    window.__vframe = 0;
    window.requestAnimationFrame = (f) => setTimeout(() => { vt += 1000 / 60; window.__vframe++; f(vt); }, 4);
    window.__caps = []; window.__capFrom = Infinity; window.__capN = 0; window.__k = 0;
    c.render = () => {
      r();
      if (window.__vframe >= window.__capFrom && window.__caps.length < window.__capN) {
        window.__caps.push(createImageBitmap(c.canvas));
        // the next frame renders the next pose (the rig applies overrides in its update)
        pose(++window.__k);
      }
    };
  })()`);
  // stream the start pose in with time running, then freeze time and walk the path
  await g.delay(3000);
  await g.luma('L.ctx.paused = true');
  await g.evalJs(`window.__capFrom = window.__vframe + 2; window.__capN = ${n};`);
  for (let i = 0; i < 600; i++) {
    if (await g.evalJs(`window.__caps.length >= ${n}`)) break;
    await g.delay(100);
  }
  await g.luma('L.ctx.paused = false');
  const lum = [];
  let w = 0, h = 0;
  for (let i = 0; i < n; i++) {
    const r = await g.evalJs(`(async () => {
      const bmp = await window.__caps[${i}];
      const w = Math.floor(bmp.width / ${B}), h = Math.floor(bmp.height / ${B});
      const oc = new OffscreenCanvas(w, h), cx = oc.getContext('2d');
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(bmp, 0, 0, w, h);
      const d = cx.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h);
      for (let k = 0; k < w * h; k++) out[k] = Math.round(0.3 * d[k * 4] + 0.59 * d[k * 4 + 1] + 0.11 * d[k * 4 + 2]);
      let s = ''; for (let k = 0; k < out.length; k += 0x8000) s += String.fromCharCode(...out.subarray(k, k + 0x8000));
      return { w, h, b64: btoa(s) };
    })()`);
    w = r.w; h = r.h;
    lum.push(Buffer.from(r.b64, 'base64'));
  }
  const T = 14, Q = 5;
  const diffs = [];
  for (let i = 1; i < n; i++) { const d = new Uint8Array(w * h); for (let k = 0; k < d.length; k++) d[k] = Math.abs(lum[i][k] - lum[i - 1][k]); diffs.push(d); }
  // clustered pops: a spike block whose neighbours spiked too (a tree or patch changing its look);
  // isolated spikes are texture shimmer and are reported separately
  const per = [], perRaw = [];
  let total = 0, totalRaw = 0;
  const spike = new Uint8Array(w * h);
  for (let k = 1; k < diffs.length - 1; k++) {
    const a = diffs[k - 1], d = diffs[k], b = diffs[k + 1];
    let raw = 0;
    for (let i = 0; i < d.length; i++) { spike[i] = d[i] > T && a[i] < Q && b[i] < Q ? 1 : 0; raw += spike[i]; }
    let c = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!spike[i]) continue;
      const nb = spike[i - 1] + spike[i + 1] + spike[i - w] + spike[i + w] + spike[i - w - 1] + spike[i - w + 1] + spike[i + w - 1] + spike[i + w + 1];
      if (nb >= 3) c++;
    }
    per.push(c); total += c; perRaw.push(raw); totalRaw += raw;
  }
  if (g.args.seq) console.log('per-frame mean diff', diffs.slice(0, 40).map((d) => (d.reduce((x, y) => x + y, 0) / d.length).toFixed(1)).join(' '));
  const mean = diffs.reduce((s, d) => s + d.reduce((x, y) => x + y, 0) / d.length, 0) / diffs.length;
  const sorted = [...per].sort((x, y) => y - x);
  const worst = per.indexOf(sorted[0]) + 1;
  console.log(`pops${suffix}: ${n} frames, clustered pop blocks total ${total}, per frame ${(total / per.length).toFixed(1)}, isolated spikes per frame ${(totalRaw / perRaw.length).toFixed(1)}, max ${sorted[0]} at frame ${worst}, top5 ${sorted.slice(0, 5).join(',')}, frames with >10 clustered: ${per.filter((x) => x > 10).length}, mean abs diff ${mean.toFixed(2)}`);
  if (g.args.save) {
    // the worst transition, full resolution, for a look
    const dir = join(process.cwd(), 'shots', g.args.tag || '');
    for (const i of [worst, worst + 1]) {
      const b64 = await g.evalJs(`(async () => { const bmp = await window.__caps[${i}]; const oc = new OffscreenCanvas(bmp.width, bmp.height);
        oc.getContext('2d').drawImage(bmp, 0, 0); const buf = new Uint8Array(await (await oc.convertToBlob({ type: 'image/png' })).arrayBuffer());
        let s = ''; for (let k = 0; k < buf.length; k += 0x8000) s += String.fromCharCode(...buf.subarray(k, k + 0x8000)); return btoa(s); })()`);
      await writeFile(join(dir, `pop${suffix}-${i}.png`), Buffer.from(b64, 'base64'));
    }
    // where the pops were: a mask of the pop blocks over all frames
    const heat = new Uint16Array(w * h);
    const sp = (k, i) => diffs[k][i] > T && diffs[k - 1][i] < Q && diffs[k + 1][i] < Q ? 1 : 0;
    for (let k = 1; k < diffs.length - 1; k++) for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (sp(k, i) && sp(k, i - 1) + sp(k, i + 1) + sp(k, i - w) + sp(k, i + w) + sp(k, i - w - 1) + sp(k, i - w + 1) + sp(k, i + w - 1) + sp(k, i + w + 1) >= 3) heat[i]++;
    }
    const rows = [];
    for (let y = 0; y < h; y += 6) { let row = ''; for (let x = 0; x < w; x += 4) { let m = 0; for (let yy = y; yy < Math.min(h, y + 6); yy++) for (let xx = x; xx < Math.min(w, x + 4); xx++) m += heat[yy * w + xx]; row += m === 0 ? '.' : m < 3 ? ':' : m < 10 ? 'o' : '#'; } rows.push(row); }
    console.log(rows.join('\n'));
  }
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 5).join('\n'));
}
