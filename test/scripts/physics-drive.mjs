// river handling in the real game: cast off at the village, top speed / coast / reverse / full-lock
// turn on the lake, idle drift on the current, a cruise under the vermilion bridge with the follow
// camera (composition, bridge clearance, smoothness), then helm and photo views.
import { setup, fmt, screenJitter } from './physics-lib.mjs';

export default async function (g) {
  const { P, sim, hold, state } = await setup(g);
  await g.delay(800);
  const s0 = await state();
  console.log('spawn', fmt({ ...s0, depth: await P('ctx.world.depthAt(b.position.x, b.position.z)'), s: (await P('P.where()')).s }));
  await g.luma('L.press("interact")');
  await sim(1);
  console.log('cast off', fmt({ docked: (await state()).docked }));

  // --- lake: accelerate from rest
  await P(`(L.clearView(), ctx.cameraRig.setMode('follow'), P.place(1640), true)`);
  await sim(2);
  console.log('rest on the lake', fmt(await state()));
  const t0 = (await state()).t;
  await hold('forward');
  const accel = [];
  let t90 = null;
  for (let i = 0; i < 14; i++) {
    await sim(1);
    const s = await state();
    accel.push(+s.speed.toFixed(2));
    if (t90 === null && s.speed >= 4.95) t90 = s.t - t0;
  }
  const top = await state();
  console.log('accel per second', accel.join(' '));
  console.log('top speed', fmt({ speed: top.speed, t90, trimDeg: top.pitch, heelDeg: top.heel }));

  await hold('forward', false);
  const coast = [];
  for (let i = 0; i < 6; i++) {
    await sim(1);
    coast.push(+(await state()).speed.toFixed(2));
  }
  console.log('coast per second', coast.join(' '));

  // back to speed, then reverse
  await P('(P.place(1640), true)');
  await hold('forward');
  await sim(12);
  await hold('forward', false);
  await hold('reverse');
  const tr = (await state()).t;
  let tStop = null;
  const rev = [];
  for (let i = 0; i < 9; i++) {
    await sim(1);
    const s = await state();
    rev.push(+s.speed.toFixed(2));
    if (tStop === null && s.speed <= 0) tStop = s.t - tr;
  }
  await hold('reverse', false);
  console.log('reverse per second', rev.join(' '), 'stopped after', tStop?.toFixed(1), 's');

  // full lock turn at cruise, lake center
  await P('(P.place(1700), true)');
  await P('(P.rec = [], P.recOn = true)');
  await hold('forward');
  await sim(9);
  await hold('right');
  await sim(6);
  const ts = (await state()).t;
  await sim(14);
  await g.shot('drive-follow-turn');
  await hold('right', false);
  await hold('forward', false);
  await P('(P.recOn = false)');
  const rows = await P('P.rec');
  const turn = rows.filter((r) => r[1] >= ts);
  const xs = turn.map((r) => r[8]), zs = turn.map((r) => r[9]);
  const diameter = (Math.max(...xs) - Math.min(...xs) + Math.max(...zs) - Math.min(...zs)) / 2;
  const heel = turn.reduce((s, r) => s + r[6], 0) / turn.length;
  const speed = turn.reduce((s, r) => s + r[5], 0) / turn.length;
  console.log('turn', fmt({ diameterM: diameter, lengths: diameter / 7.5, heelDeg: heel, speed }));

  // --- idle on the current in the channel
  const cur = await P('(P.place(560), P.river(560))');
  await sim(4);
  const d0 = await P('P.where()');
  await sim(10);
  const d1 = await P('P.where()');
  const flow = await P(`Math.hypot(ctx.world.sample('flowX', ${cur.x}, ${cur.z}), ctx.world.sample('flowZ', ${cur.x}, ${cur.z}))`);
  console.log('idle drift', fmt({ downstreamMps: (d0.s - d1.s) / 10, channelFlow: flow, lateralM: d1.lateral }));

  // --- cruise upstream under the vermilion bridge: follow composition and bridge clearance
  const bridge = await P(`P.layout.BRIDGES.find((b) => b.id === 'red-bridge')`);
  await P(`(P.place(${bridge.s - 70}), true)`);
  await sim(1);
  await P(`(() => { P.cam = []; P.camOff = ctx.onUpdate(() => { const c = ctx.camera, p = b.position, f = new c.position.constructor(0, 0, -1).applyQuaternion(c.quaternion);
    const r = P.layout.nearestRiver(c.position.x, c.position.z);
    P.cam.push([ctx.time.real, c.position.y - p.y, Math.hypot(c.position.x - p.x, c.position.z - p.z), Math.asin(f.y) * 57.2958, r.s, c.position.y, p.x, p.y, p.z, c.position.x, c.position.z]); }, 56); return true; })()`);
  await hold('forward');
  await sim(10);
  await g.shot('drive-follow-cruise');
  await sim(8);
  await g.shot('drive-follow-bridge');
  await sim(6);
  await P('(P.camOff(), true)');
  const cam = await P('P.cam');
  const steady = cam.slice(Math.floor(cam.length * 0.15), Math.floor(cam.length * 0.4));
  const avg = (i) => steady.reduce((s, r) => s + r[i], 0) / steady.length;
  const under = cam.filter((r) => Math.abs(r[4] - bridge.s) < bridge.deckWidth / 2 + 0.5);
  console.log('follow composition', fmt({ aboveBoatM: avg(1), behindM: avg(2), viewPitchDeg: avg(3) }));
  console.log('under the bridge', fmt({ frames: under.length, maxCamY: under.length ? Math.max(...under.map((r) => r[5])) : null, clearance: bridge.clearance }));
  // world-space smoothness: deviation of each frame from the line through its neighbours (mm)
  const dev = (k) => {
    const out = [];
    for (let i = 1; i < cam.length - 1; i++) {
      const a = cam[i - 1], c = cam[i + 1], t = (cam[i][0] - a[0]) / (c[0] - a[0] || 1);
      out.push(Math.hypot(...k.map((j) => cam[i][j] - (a[j] + (c[j] - a[j]) * t))) * 1000);
    }
    out.sort((x, y) => x - y);
    return [+out[Math.floor(out.length * 0.95)].toFixed(2), +out[out.length - 1].toFixed(2)];
  };
  console.log('smoothness mm p95/max', JSON.stringify({ hull: dev([6, 7, 8]), camera: dev([9, 5, 10]) }));
  const jit = screenJitter(rows, g.W, g.H);
  console.log('follow screen jitter', fmt(jit));

  // helm and photo views while under way
  await g.luma('L.press("camera")');
  await sim(2);
  await g.shot('drive-helm');
  console.log('helm', fmt({ mode: (await state()).cam }));
  await g.luma('L.press("camera")');
  await sim(0.5);
  const inPhoto = await state();
  await sim(2);
  const after = await state();
  console.log('photo mode', fmt({ mode: inPhoto.cam, throttleAfter: after.throttle, speedAfter: after.speed }));
  await hold('forward', false);
  await g.luma('L.press("camera")');
  await sim(0.5);
  const ev = await P('P.events');
  console.log('events', JSON.stringify({ camera: ev.filter((e) => e.type === 'camera:mode').map((e) => e.p), splash: ev.filter((e) => e.type === 'boat:splash').length, impact: ev.filter((e) => e.type === 'boat:impact').length }));
  console.log('back to', (await state()).cam, 'errors', g.errors.length);
  return g.errors.length === 0;
}
