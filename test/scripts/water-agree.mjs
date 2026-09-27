// water: cpu/gpu wave agreement.
// 1) numeric: pause the sim, read back the tsl gerstner displacement (same function the ocean vertex
//    shader uses, incl. the waveScale channel at the rest point) and compare with displacement() and
//    waterHeight() from src/world/waves.ts at the same time.
// 2) visual: spheres at cpu waterHeight() positions near the camera, close-up at the surface.
export default async function (g) {
  await g.delay(1500);
  const res = await g.luma(`(async () => {
    const w = L.ctx.services.water;
    const waves = await import('/src/world/waves.ts');
    L.ctx.paused = true;
    await new Promise((r) => setTimeout(r, 300));
    const t = L.ctx.time.render;
    const pts = [];
    // harbor, open sea, cove and a spread around the boat; includes sheltered (waveScale < 1) spots
    const centers = [[-170, 30], [-120, -20], [0, 0], [260, 480], [380, -120], [-60, 120]];
    for (const [cx, cz] of centers) for (let i = 0; i < 10; i++) pts.push([cx + Math.sin(i * 2.4) * (3 + i * 2.7), cz + Math.cos(i * 2.4) * (3 + i * 2.7)]);
    const gpu = await w.debug.sampleDisplacement(pts.slice(0, 60));
    let md = [0, 0, 0], mh = 0, mxz = 0, amp = 0, n = 0;
    const o = [0, 0, 0], rest = [0, 0];
    for (let i = 0; i < gpu.length; i++) {
      const [x, z] = pts[i];
      waves.displacement(x, z, t, o);
      for (let k = 0; k < 3; k++) md[k] = Math.max(md[k], Math.abs(o[k] - gpu[i][k]));
      amp = Math.max(amp, Math.abs(o[1]));
      n++;
    }
    // surface height at world (x, z): invert the horizontal displacement on the cpu, then compare the
    // gpu displaced point (rest + disp) with the query point and waterHeight()
    const gpuRest = [];
    for (let i = 0; i < 60; i++) { waves.invertRest(pts[i][0], pts[i][1], t, rest, 6); gpuRest.push([rest[0], rest[1]]); }
    const g2 = await w.debug.sampleDisplacement(gpuRest);
    for (let i = 0; i < g2.length; i++) {
      const [x, z] = pts[i];
      const h = waves.waterHeight(x, z, t);
      mh = Math.max(mh, Math.abs(h - g2[i][1]));
      mxz = Math.max(mxz, Math.hypot(gpuRest[i][0] + g2[i][0] - x, gpuRest[i][1] + g2[i][2] - z));
    }
    return { t, n, maxAbsDisp: md, maxAbsHeight: mh, maxXZ: mxz, maxCpuAmplitude: amp, sample: { p: pts[0], cpu: (waves.displacement(pts[0][0], pts[0][1], t, o), [...o]), gpu: gpu[0] } };
  })()`);
  console.log('agreement', JSON.stringify(res));
  const ok = res.maxAbsDisp.every((d) => d < 2e-3) && res.maxAbsHeight < 3e-3 && res.maxXZ < 3e-3;
  console.log(ok ? 'AGREEMENT OK' : 'AGREEMENT FAILED');

  // visual: markers around a point on open water, camera 1.2 m above the sea, looking along the surface
  const cx = Number(g.args.cx ?? -60), cz = Number(g.args.cz ?? 120);
  await g.luma(`(() => { const pts = []; for (let i = 0; i < 7; i++) for (let j = 0; j < 3; j++) pts.push([${cx} + (i - 3) * 1.6, ${cz} - 5 - j * 2.2]); L.ctx.services.water.debug.markers(pts, 0.14); L.ctx.paused = false; return pts.length; })()`);
  await g.luma(`L.look([${cx}, 1.1, ${cz} + 2], [${cx}, -0.2, ${cz} - 8])`);
  await g.delay(1500);
  await g.shot('agree-markers-a');
  await g.delay(1300);
  await g.shot('agree-markers-b');
  await g.luma('L.ctx.services.water.debug.markers(null)');
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 5).join('\n').slice(0, 2000));
  return ok;
}
