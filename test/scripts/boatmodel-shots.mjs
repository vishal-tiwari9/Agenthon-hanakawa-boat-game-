// wasen close-ups on the player's boat at the village landing. poses are in the boat's local
// frame (bow -z, starboard +x); x flips so the camera stays on the river side of the moored boat.
// args: --poses=opening,bow34,profile,stern34,canopy,helm,top --paints=dark,vermilion+indigo --prefix=x
const POSES = {
  bow34: [[-4.4, 1.9, -6.4], [0, 0.6, -1.3]],
  profile: [[-8.2, 1.1, 0.2], [0, 0.5, 0.2]],
  stern34: [[-4.8, 1.7, 6.0], [0, 0.55, 0.8]],
  stern: [[-1.1, 2.3, 7.6], [0, 0.6, 1.2]],
  canopy: [[-1.9, 1.35, -2.4], [0, 0.55, 0.3]],
  bow: [[-1.8, 1.5, -4.9], [0, 0.75, -2.7]],
  aft: [[-1.6, 1.8, 5.1], [0, 0.55, 2.7]],
  top: [[-0.3, 9.0, 0.0], [0, 0.2, -0.1]],
  low: [[-4.0, 0.25, -3.2], [0, 0.1, 0.8]],
  helm: [[0, 2.06, 3.02], [0, 1.25, -4.0]],
  chase: [[1.4, 3.6, 12.5], [0, 0.9, -1.0]],
};

export default async function (g) {
  await g.delay(2500);
  const info = await g.luma(`(async () => {
    const ui = document.getElementById('ui'); if (ui) ui.style.display = 'none';
    const b = L.ctx.boat, m = b && b.model;
    const mod = await import('/src/boat/model/index.ts');
    let tris = 0, meshes = 0;
    if (m) m.root.traverse((o) => { if (o.isMesh) { meshes++; const gg = o.geometry; tris += (gg.index ? gg.index.count : gg.attributes.position.count) / 3; } });
    return { model: m && m.root ? m.root.name : null, paints: m ? m.paints.map((p) => p.id).join(',') : null, tris, meshes, pos: b ? b.position.toArray().map((v) => +v.toFixed(2)) : null };
  })()`);
  console.log('model', JSON.stringify(info));
  if (g.args.paint) await g.luma(`(L.ctx.boat.model.setPaint(${JSON.stringify(g.args.paint)}), true)`);
  // river side: toward the nearest centerline point, in the boat frame
  const side = await g.luma(`(async () => {
    const lay = await import('/src/world/layout.ts');
    const b = L.ctx.boat; const n = lay.nearestRiver(b.position.x, b.position.z);
    const f = lay.riverFrame(n.s);
    const d = new b.position.constructor(f.x - b.position.x, 0, f.z - b.position.z).applyQuaternion(b.quaternion.clone().invert());
    return d.x >= 0 ? 1 : -1;
  })()`);
  const shoot = async (name, label) => {
    if (name === 'opening') {
      await g.luma(`(L.view('opening'), true)`);
      await g.delay(1600);
      return g.shot(label);
    }
    const p = POSES[name];
    if (!p) return;
    const fx = name === 'helm' || name === 'chase' ? 1 : -side;
    const cam = [p[0][0] * fx, p[0][1], p[0][2]], tgt = [p[1][0] * fx, p[1][1], p[1][2]];
    for (let k = 0; k < 5; k++) {
      await g.luma(`(() => {
        const o = L.ctx.boat.object; o.updateMatrixWorld();
        const V = o.position.constructor;
        L.look(new V(${cam.join(',')}).applyMatrix4(o.matrixWorld).toArray(), new V(${tgt.join(',')}).applyMatrix4(o.matrixWorld).toArray());
        return true;
      })()`);
      await g.delay(260);
    }
    return g.shot(label);
  };
  const be = g.args.backend || 'webgpu';
  for (const name of (g.args.poses || 'opening,bow34,profile,stern34,canopy,helm').split(',')) await shoot(name, `${g.args.prefix || ''}${name}-${be}`);
  if (g.args.paints) {
    for (const pid of g.args.paints.split(',')) {
      await g.luma(`(L.ctx.boat.model.setPaint(${JSON.stringify(pid)}), true)`);
      await shoot(g.args.paintpose || 'bow34', `paint-${pid.replace(/\+/g, '_')}-${be}`);
    }
  }
  console.log('stats', JSON.stringify(await g.stats()));
  if (g.errors.length) console.log('errors', g.errors.slice(0, 6).join('\n'));
}
