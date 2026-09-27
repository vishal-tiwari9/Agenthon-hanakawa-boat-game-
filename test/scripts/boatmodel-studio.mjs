// boat model close-ups on a separate instance in open water near the harbor (clear of the jetty).
// poses are in the boat's local frame (bow -z, starboard +x); the camera sits on the sunlit side.
// args: --poses=... --paint=ivory --detail=full|simple --prefix=x --spot=x,z --heading=deg
const POSES = {
  bow34: [[-4.2, 1.9, -6.2], [0, 0.55, -1.2]],
  profile: [[-7.6, 1.0, 0.1], [0, 0.45, 0.1]],
  stern: [[-1.2, 2.2, 7.0], [0, 0.6, 1.5]],
  stern34: [[-4.6, 1.5, 5.6], [0, 0.5, 0.8]],
  cockpit: [[-0.4, 7.4, 0.2], [0, 0.2, 0.0]],
  helm: [[0, 2.06, 3.02], [0, 1.2, -4.0]],
  deck: [[-1.7, 1.6, -4.6], [0, 0.7, -2.2]],
  canopy: [[-1.3, 1.2, -2.2], [0, 0.6, 0.2]],
  low: [[-3.4, 0.3, -2.4], [0, 0.05, 0.6]],
  chase: [[1.2, 3.4, 11.5], [0, 0.9, -1.0]],
  aft: [[-1.4, 1.7, 4.9], [0, 0.5, 2.6]],
};

export default async function (g) {
  await g.delay(2000);
  const detail = g.args.detail || 'full';
  const res = await g.luma(`(async () => {
    const ui = document.getElementById('ui'); if (ui) ui.style.display = 'none';
    const m = await import('/src/boat/model/index.ts');
    const w = L.ctx.world;
    let spot = ${g.args.spot ? `[${g.args.spot}]` : 'null'};
    if (!spot) {
      // deep water, well offshore, near the harbor
      let best = null;
      for (let r = 40; r < 260 && !best; r += 20) for (let a = 0; a < 24 && !best; a++) {
        const x = -170 + Math.cos(a / 24 * 6.283) * r, z = 30 + Math.sin(a / 24 * 6.283) * r;
        const d = w.depthAt(x, z), sh = w.sample('shore', x, z);
        if (d > 5 && sh < -30) best = [x, z];
      }
      spot = best || [-60, 60];
    }
    const t0 = performance.now();
    const b = await m.createBoatModel(L.ctx, { detail: ${JSON.stringify(detail)}, paint: ${JSON.stringify(g.args.paint || 'ivory')} });
    const ms = performance.now() - t0;
    const sun = L.ctx.sun.direction;
    const sunAz = Math.atan2(sun.x, -sun.z) * 180 / Math.PI;
    const heading = ${g.args.heading ?? 'sunAz + 70'};
    b.root.position.set(spot[0], 0.1, spot[1]);
    b.root.rotation.y = -heading * Math.PI / 180;
    L.ctx.scene.add(b.root);
    b.root.updateMatrixWorld(true);
    window.__bm = b;
    if (L.ctx.boat) L.ctx.boat.object.visible = false;
    let tris = 0, meshes = 0;
    b.root.traverse((o) => { if (o.isMesh) { meshes++; const gg = o.geometry; tris += (gg.index ? gg.index.count : gg.attributes.position.count) / 3; } });
    return { spot, heading, ms: Math.round(ms), tris, meshes, stats: m.boatStats(${JSON.stringify(detail)}) };
  })()`);
  console.log('studio', JSON.stringify(res));
  const side = await g.luma(`(() => { const o = window.__bm.root; const q = o.quaternion.clone().invert(); const s = L.ctx.sun.direction.clone().applyQuaternion(q); return s.x >= 0 ? 1 : -1; })()`);
  const poses = (g.args.poses || 'bow34,profile,stern,cockpit,helm').split(',');
  for (const name of poses) {
    const p = POSES[name];
    if (!p) continue;
    const fx = name === 'helm' || name === 'wheel' || name === 'chase' ? 1 : -side;
    const cam = [p[0][0] * fx, p[0][1], p[0][2]], tgt = [p[1][0] * fx, p[1][1], p[1][2]];
    await g.luma(`(() => {
      const o = window.__bm.root; const V = o.position.constructor;
      const a = new V(${cam.join(',')}).applyMatrix4(o.matrixWorld), t = new V(${tgt.join(',')}).applyMatrix4(o.matrixWorld);
      L.look(a.toArray(), t.toArray());
      return true;
    })()`);
    await g.delay(1400);
    await g.shot(`${g.args.prefix || ''}${name}${g.args.paint ? '-' + g.args.paint : ''}-${g.args.backend || 'webgpu'}`);
  }
  if (g.args.paints) {
    for (const pid of g.args.paints.split(',')) {
      await g.luma(`(window.__bm.setPaint(${JSON.stringify(pid)}), true)`);
      const p = POSES[g.args.paintpose || 'bow34'];
      const cam = [p[0][0] * -side, p[0][1], p[0][2]], tgt = [p[1][0] * -side, p[1][1], p[1][2]];
      await g.luma(`(() => { const o = window.__bm.root; const V = o.position.constructor; L.look(new V(${cam.join(',')}).applyMatrix4(o.matrixWorld).toArray(), new V(${tgt.join(',')}).applyMatrix4(o.matrixWorld).toArray()); return true; })()`);
      await g.delay(1100);
      await g.shot(`paint-${pid}-${g.args.backend || 'webgpu'}`);
    }
  }
  console.log('stats', JSON.stringify(await g.stats()));
  if (g.errors.length) console.log('errors', g.errors.slice(0, 5).join('\n'));
}
