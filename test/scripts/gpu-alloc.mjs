// every gpu texture and buffer the page creates (hooks GPUDevice at document start), largest first.
//   node test/harness.mjs gpu-alloc --quiet   (dev server for readable source names)
import { readFile } from 'node:fs/promises';
export default async function (g) {
  const source = await readFile(new URL('./gpu-hook.js', import.meta.url), 'utf8');
  await g.send('Page.addScriptToEvaluateOnNewDocument', { source });
  await g.evalJs('window.__oldPage = true');
  await g.send('Page.reload', {});
  for (let i = 0; i < 200 && (await g.evalJs('!!window.__oldPage').catch(() => true)); i++) await g.delay(20);
  while (!(await g.evalJs('!!window.__lumaReady').catch(() => false))) await g.delay(250);
  await g.delay(3000);
  const r = await g.evalJs(`(() => {
    const l = window.__gpuAlloc;
    const tex = l.tex.sort((a, b) => b[0] - a[0]);
    const src = Object.entries(l.bySrc).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => [Math.round(v / 104857.6) / 10, k]);
    return { texMB: Math.round(tex.reduce((a, t) => a + t[0], 0)), n: tex.length, bufMB: Math.round(l.buf / 1048576), bufs: l.bufs, top: tex.slice(0, 15), src };
  })()`);
  console.log('textures MB', r.texMB, 'count', r.n, '| buffers MB', r.bufMB, 'count', r.bufs);
  for (const t of r.top) console.log('TEX', t.join('\t'));
  for (const s of r.src) console.log('BUF', s.join('\t'));
}
