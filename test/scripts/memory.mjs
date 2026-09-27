// gpu and js memory over time after load (renderer.info.memory byte sizes, js heap). run on the preview:
//   LUMA_PORT=5191 node test/harness.mjs memory --query=timelapse:1 --quiet
export default async function (g) {
  await g.evalJs("document.querySelector('.title-start')?.click()");
  const sample = () => g.evalJs(`(() => {
    const r = __luma.ctx.renderer, m = r.info.memory, mb = (v) => +((v || 0) / 1048576).toFixed(1);
    return { t: Math.round(performance.now() / 1000), jsMB: mb(performance.memory?.usedJSHeapSize), gpuMB: mb(m.total), texMB: mb(m.texturesSize), attrMB: mb(m.attributesSize + (m.indexAttributesSize || 0) + (m.storageAttributesSize || 0)),
      textures: m.textures, geometries: m.geometries, px: [r.domElement.width, r.domElement.height] };
  })()`);
  for (let i = 0; i < 7; i++) {
    await g.send('HeapProfiler.collectGarbage').catch(() => {});
    console.log(JSON.stringify(await sample()));
    await g.delay(5000);
  }
  const big = await g.evalJs(`(() => {
    const r = __luma.ctx.renderer, out = [];
    const seen = new Set();
    for (const t of r._textures?.datas ? [] : []) {}
    __luma.ctx.scene.traverse((o) => {
      for (const m of [].concat(o.material || [])) for (const k in m) { const t = m[k]; if (t && t.isTexture && !seen.has(t)) { seen.add(t); const im = t.image || {}; const w = im.width || 0, h = im.height || 0, d = im.depth || 1; out.push([Math.round(w * h * d * 4 / 1048576), w + 'x' + h + 'x' + d, t.name || k]); } }
    });
    return out.sort((a, b) => b[0] - a[0]).slice(0, 15);
  })()`);
  for (const b of big) console.log(b.join('\t'));
}
