// list structure meshes with shadow casting and mirror layer (for draw-count work)
export default async function (g) {
  await g.delay(1500);
  const r = await g.evalJs(`(() => {
    const out = [];
    __luma.ctx.scene.traverse((o) => {
      if (!o.isMesh) return;
      let p = o, mine = false;
      while (p) { if (p.name.startsWith('structures') || p.name.startsWith('prop:') || p.name.startsWith('life') || p.name.startsWith('town') || p.name.startsWith('frontage')) { mine = true; break; } p = p.parent; }
      if (!mine) return;
      const n = o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count;
      out.push([o.name, o.castShadow ? 'cast' : '-', o.layers.mask === 2 ? 'noref' : 'ref', Math.round(n / 3)]);
    });
    return out;
  })()`);
  const sum = { total: r.length, cast: r.filter((x) => x[1] === 'cast').length, ref: r.filter((x) => x[2] === 'ref').length };
  console.log(JSON.stringify(sum));
  for (const x of r.filter((x) => x[0].startsWith('village') || x[0].startsWith('town') || x[0].startsWith('temple'))) console.log(x.join(' '));
}
