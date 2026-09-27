// river contacts and helpers in the real game: running into a bank, a bridge pier, docking at the
// village landing through gameplay (E), reset/unstuck from the shallows, 30 s at rest on the lake.
import { setup, fmt } from './physics-lib.mjs';

export default async function (g) {
  const { P, sim, hold, state } = await setup(g);
  await g.delay(800);
  const impacts = async (since) => (await P('P.events')).filter((e) => e.type === 'boat:impact' && e.t >= since).map((e) => +e.p.strength.toFixed(2));
  console.log('terrain collider', await P('b.sim.env.terrainCollider()'));

  // drive from a pose for a while, cut the throttle, and watch the contact
  const ram = async (label, place, throttleSec, coastSec) => {
    await P(`(${place}, true)`);
    await sim(1);
    const t0 = (await state()).t;
    await hold('forward');
    await sim(throttleSec);
    const pre = await state();
    await hold('forward', false);
    await P('(P.rec = [], P.recOn = true)');
    await sim(coastSec);
    await P('(P.recOn = false)');
    const rows = await P('P.rec');
    const end = await state();
    let maxTilt = 0;
    for (const r of rows) maxTilt = Math.max(maxTilt, Math.abs(r[6]), Math.abs(r[7]));
    const where = await P('P.where()');
    console.log(label, fmt({ speedAtCut: pre.speed, impacts: (await impacts(t0)).join('/') || 'none', maxTiltDeg: maxTilt, endSpeed: end.speed, lateralM: where.lateral, halfWidth: where.width / 2, depthUnderHull: await P('ctx.world.depthAt(b.position.x, b.position.z)') }));
    return end;
  };

  // --- banks: square at the left bank from mid-channel, slow then moderate
  await ram('left bank slow', 'P.place(600, -9, -90)', 1.6, 12);
  await ram('left bank moderate', 'P.place(600, 0, -90)', 4, 10);
  await g.shot('contact-bank');
  await ram('right bank glancing', 'P.place(640, -4, 35)', 6, 8);

  // --- bridge piers: static colliders standing in the channel near a bridge
  const piers = await P(`(() => {
    const out = [];
    for (const br of P.layout.BRIDGES) {
      const f = P.layout.riverFrame(br.s);
      ctx.physics.world.forEachCollider((c) => {
        if (((c.collisionGroups() >>> 16) & 0x2) === 0) return;
        const t = c.translation(), r = P.layout.nearestRiver(t.x, t.z);
        if (Math.abs(r.s - br.s) < 8 && Math.abs(r.lateral) < r.width / 2 - 2 && t.y < 1.5) out.push({ bridge: br.id, s: r.s, lateral: r.lateral, y: t.y });
      });
    }
    return out;
  })()`);
  console.log('piers in the channel', piers.length, JSON.stringify(piers.slice(0, 3).map((p) => fmt(p))));
  if (piers.length) {
    const p = piers[0];
    await ram(`pier (${p.bridge})`, `P.place(${p.s - 16}, ${p.lateral})`, 4, 8);
    await g.shot('contact-pier');
  }

  // --- docking through gameplay at the village landing
  const berth = await P(`P.layout.DOCKS[0]`);
  await P(`(P.place(${berth.s - 10}, ${await P(`P.layout.nearestRiver(${berth.moorX}, ${berth.moorZ}).lateral`)}), true)`);
  await sim(1.5);
  await g.luma('L.press("interact")');
  await sim(0.5);
  let via = 'E';
  if (!(await state()).docked) {
    // gameplay not running (title card or a module down): exercise the boat api directly
    via = 'api';
    await P(`(b.dockTo({ x: ${berth.moorX}, z: ${berth.moorZ}, headingDeg: ${berth.headingDeg} }), true)`);
  }
  const d0 = await state();
  await sim(12);
  const d1 = await state();
  const herr = Math.abs(((((-d1.yaw - berth.headingDeg) % 360) + 540) % 360) - 180);
  console.log('dock', fmt({ via, docked: d0.docked, berthErrorM: Math.hypot(d1.x - berth.moorX, d1.z - berth.moorZ), headingErrDeg: herr, heel: d1.heel, pitch: d1.pitch }));
  await g.shot('contact-docked');
  if (via === 'E') await g.luma('L.press("interact")');
  else await P('(b.undock(), true)');
  await sim(1);
  const d2 = await state();
  const dockEvents = (await P('P.events')).filter((e) => e.type === 'boat:docked' || e.type === 'boat:undocked').map((e) => e.type + ':' + e.p?.dockId);
  console.log('undock', fmt({ docked: d2.docked, events: dockEvents.join(' ') }));

  // --- reset from the shallows by the right bank, pointing across the river
  const shallow = await P(`(() => { const f = P.layout.riverFrame(820); for (let u = 0.5; u > 0.3; u -= 0.01) { const x = f.x + f.nx * f.width * u, z = f.z + f.nz * f.width * u, d = ctx.world.depthAt(x, z); if (d > 0.05 && d < 0.35) return { x, z, d, s: 820 }; } return null; })()`);
  if (shallow) {
    await P(`(b.teleport(${shallow.x}, ${shallow.z}, 90), true)`);
    await sim(1);
    await g.luma('L.press("reset")');
    await sim(1.5);
    const after = await state();
    const w = await P('P.where()');
    const up = await P(`P.layout.riverHeading(${w.s})`);
    const heading = (360 - after.yaw) % 360;
    console.log('reset', fmt({ fromDepth: shallow.d, sBefore: shallow.s, sAfter: w.s, lateralM: w.lateral, depth: await P('ctx.world.depthAt(b.position.x, b.position.z)'), headingErrDeg: Math.abs((((heading - up) % 360) + 540) % 360 - 180), speed: after.speed }));
  } else console.log('no shallow spot found near s 820');

  // --- 30 s at rest on the lake (no current): attitude amplitude, heave, drift
  await P('(P.place(1760), true)');
  await sim(3);
  const r0 = await state();
  await P('(P.rec = [], P.recOn = true)');
  await sim(30);
  await P('(P.recOn = false)');
  const rows = await P('P.rec');
  const r1 = await state();
  const col = (i) => rows.map((r) => r[i]);
  const range = (a) => Math.max(...a) - Math.min(...a);
  console.log('rest 30s (lake)', fmt({ rollMin: Math.min(...col(6)), rollMax: Math.max(...col(6)), pitchMin: Math.min(...col(7)), pitchMax: Math.max(...col(7)), heaveRange: range(col(10)), driftM: Math.hypot(r1.x - r0.x, r1.z - r0.z) }));
  await g.shot('contact-rest');
  console.log('errors', g.errors.length);
  return g.errors.length === 0;
}
