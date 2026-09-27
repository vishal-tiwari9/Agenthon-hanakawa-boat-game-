// gpu geometry memory by scene branch and by mesh (sizes of the uploaded attribute buffers)
export default async function (g) {
  const r = await g.evalJs(`(() => {
    const be = __luma.ctx.renderer.backend, seen = new Set(), byRoot = {}, byMesh = {};
    __luma.ctx.scene.traverse((o) => {
      if (!o.geometry) return;
      let root = o; while (root.parent && root.parent !== __luma.ctx.scene) root = root.parent;
      const rk = (root.name || root.type) , mk = rk + ' / ' + (o.name || o.type) + (o.isInstancedMesh ? ' [x' + o.count + ']' : '');
      const g = o.geometry, attrs = [...Object.values(g.attributes), g.index].filter(Boolean);
      if (o.isInstancedMesh && o.instanceMatrix) attrs.push(o.instanceMatrix);
      let b = 0;
      for (const a of attrs) { const d = a.isInterleavedBufferAttribute ? a.data : a; if (seen.has(d)) continue; seen.add(d); b += be.get(d)?.buffer?.size || 0; }
      byRoot[rk] = (byRoot[rk] || 0) + b; byMesh[mk] = (byMesh[mk] || 0) + b;
    });
    const f = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => (v / 1048576).toFixed(1) + '\\t' + k);
    return { roots: f(byRoot), meshes: f(byMesh) };
  })()`);
  for (const l of r.roots) console.log('ROOT', l);
  for (const l of r.meshes) console.log('MESH', l);
}
