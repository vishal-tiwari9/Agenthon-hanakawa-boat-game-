// consecutive frames while cruising. the page runs on a virtual 60 hz clock from cast-off, so every
// frame advances exactly 1/60 s whatever the capture costs, and runs with different settings follow
// the same path. options: --frames=8 --warm=300 (virtual frames after cast-off before capturing)
// --scale=0.5 (downscale the saved frames)
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export default async function (g) {
  const n = Number(g.args.frames || 8), warm = Number(g.args.warm || 300), scale = Number(g.args.scale || 1);
  await g.delay(1200);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(800);
  await g.evalJs(`(() => {
    let vt = performance.now();
    window.__vframe = 0;
    window.requestAnimationFrame = (f) => setTimeout(() => { vt += 1000 / 60; window.__vframe++; f(vt); }, 4);
    const c = __luma.ctx, r = c.render;
    window.__caps = []; window.__capFrom = Infinity; window.__capN = 0;
    c.render = () => {
      r();
      if (window.__vframe >= window.__capFrom && window.__caps.length < window.__capN) window.__caps.push(createImageBitmap(c.canvas));
    };
  })()`);
  await g.luma("L.press('interact')");
  await g.luma("L.hold('forward', true)");
  await g.evalJs(`window.__capFrom = window.__vframe + ${warm}; window.__capN = ${n};`);
  for (let i = 0; i < 400; i++) {
    if (await g.evalJs(`window.__caps.length >= ${n}`)) break;
    await g.delay(100);
  }
  console.log('boat', JSON.stringify((await g.stats()).boat));
  const dir = join(g.args.root || process.cwd(), 'shots', g.args.tag || '');
  for (let i = 0; i < n; i++) {
    const b64 = await g.evalJs(`(async () => {
      const bmp = await window.__caps[${i}];
      const w = Math.round(bmp.width * ${scale}), h = Math.round(bmp.height * ${scale});
      const oc = new OffscreenCanvas(w, h);
      oc.getContext('2d').drawImage(bmp, 0, 0, w, h);
      const blob = await oc.convertToBlob({ type: 'image/png' });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = ''; for (let k = 0; k < buf.length; k += 0x8000) s += String.fromCharCode(...buf.subarray(k, k + 0x8000));
      return btoa(s);
    })()`);
    await writeFile(join(dir, `f${i}.png`), Buffer.from(b64, 'base64'));
  }
  console.log(`saved ${n} frames to ${dir}`);
  await g.luma('L.releaseAll()');
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 5).join('\n'));
}
