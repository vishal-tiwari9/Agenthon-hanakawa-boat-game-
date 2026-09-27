// boat physics against real rapier in node: hydrostatics, stability, handling envelope, contacts.
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// src files import siblings without extensions (vite style); resolve them to .ts for node
registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (e) {
      if ((spec.startsWith('.') || spec.startsWith('/')) && !/\.[cm]?[jt]s$/.test(spec)) return next(spec + '.ts', ctx);
      throw e;
    }
  },
});

const R = (await import('@dimforge/rapier3d-compat')).default;
await R.init();
const { BoatSim } = await import('../../src/boat/physics/sim.ts');
const { buildHydro } = await import('../../src/boat/physics/hydro.ts');
const { findRiverSpot } = await import('../../src/boat/physics/safeSpot.ts');
const { HULL } = await import('../../src/boat/hullSpec.ts');
const waves = await import('../../src/world/waves.ts');
const { Euler } = await import('three/webgpu');

const DT = 1 / 60;
const e = new Euler();
function attitude(sim) {
  e.setFromQuaternion(sim.quat, 'YXZ');
  return { pitch: (e.x * 180) / Math.PI, heel: (e.z * 180) / Math.PI, yaw: (e.y * 180) / Math.PI };
}

function rig({ amp = 0, env = {}, setup, x = 0, z = 0, heading = 0 } = {}) {
  waves.waveGlobal.amplitude = amp;
  const world = new R.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  setup?.(world);
  const impacts = [], splashes = [];
  const sim = new BoatSim(R, world, { water: (px, pz, t, o) => waves.sampleWater(px, pz, t, o), ...env }, {
    x, z, headingDeg: heading, onImpact: (i) => impacts.push(i), onSplash: (s) => splashes.push(s),
  });
  const r = { sim, world, impacts, splashes, t: 0 };
  r.step = (n = 1, each) => {
    for (let i = 0; i < n; i++) {
      sim.preStep(r.t, DT);
      world.step();
      r.t += DT;
      sim.postStep(r.t, DT);
      each?.(i);
    }
  };
  r.seconds = (s, each) => r.step(Math.round(s / DT), each);
  return r;
}

test('hydro cells cover the hull and match its displacement', () => {
  const h = buildHydro();
  assert.equal(h.cells.length, 15);
  const w = h.cells.reduce((s, c) => s + c.w, 0), lat = h.cells.reduce((s, c) => s + c.lat, 0);
  assert.ok(Math.abs(w - 1) < 1e-9 && Math.abs(lat - 1) < 1e-9);
  // hullSpec volume below the waterline should already be close to mass / rho
  assert.ok(h.scale > 0.8 && h.scale < 1.25, `displacement calibration ${h.scale}`);
  assert.ok(h.colliderPoints.length >= 3 * 40);
});

test('floats at the design waterline in calm water, level, without drift or jitter', () => {
  const r = rig();
  r.seconds(12);
  const y0 = r.sim.pos.y;
  let lo = Infinity, hi = -Infinity;
  r.seconds(20, () => {
    lo = Math.min(lo, r.sim.pos.y);
    hi = Math.max(hi, r.sim.pos.y);
  });
  const a = attitude(r.sim);
  assert.ok(Math.abs(y0) < 0.05, `draft offset ${y0}`);
  assert.ok(hi - lo < 0.002, `heave jitter ${hi - lo}`);
  assert.ok(Math.abs(a.pitch) < 1 && Math.abs(a.heel) < 0.1, `trim ${a.pitch} heel ${a.heel}`);
  assert.ok(Math.hypot(r.sim.pos.x, r.sim.pos.z) < 0.01, 'drift');
  assert.equal(Math.round(r.sim.body.mass()), HULL.mass);
});

test('a heel disturbance rocks and settles (damped, not undamped)', () => {
  const r = rig();
  r.seconds(3);
  r.sim.body.applyTorqueImpulse({ x: 0, y: 0, z: 900 }, true);
  let peak = 0, overshoot = 0;
  r.seconds(10, () => {
    const h = attitude(r.sim).heel;
    peak = Math.max(peak, h);
    overshoot = Math.min(overshoot, h);
  });
  assert.ok(peak > 8, `peak heel ${peak}`);
  assert.ok(overshoot < -0.5, 'should rock back past level at least once');
  assert.ok(Math.abs(attitude(r.sim).heel) < 0.3, 'settles within 10 s');
});

test('rides the river chop: follows the surface, stays level, no drift without current', () => {
  const r = rig({ amp: 1 });
  r.seconds(5);
  const p0 = r.sim.pos.clone();
  let maxRel = 0, maxRoll = 0, maxPitch = 0;
  r.seconds(30, () => {
    const s = r.sim.pos, a = attitude(r.sim);
    maxRel = Math.max(maxRel, Math.abs(s.y - waves.waterHeight(s.x, s.z, r.t)));
    maxRoll = Math.max(maxRoll, Math.abs(a.heel));
    maxPitch = Math.max(maxPitch, Math.abs(a.pitch));
  });
  assert.ok(maxRel < 0.05, `hull vs surface ${maxRel}`);
  assert.ok(maxRoll < 3 && maxPitch < 3, `roll ${maxRoll} pitch ${maxPitch}`);
  assert.ok(r.sim.pos.clone().sub(p0).setY(0).length() < 1, 'drift');
});

test('drifts downstream with the current when idle; the current also acts on the hull under way', () => {
  // uniform current of 0.5 m/s toward +z (downstream is south); the boat faces upstream (north)
  const flow = (x, z, o) => { o.x = 0; o.z = 0.5; };
  const r = rig({ env: { flow } });
  r.seconds(40);
  assert.ok(r.sim.vel.z > 0.4 && r.sim.vel.z < 0.55, `idle drift ${r.sim.vel.z}`);
  assert.ok(Math.abs(r.sim.waterSpeed) < 0.1, 'moves with the water');
  r.sim.setControls(1, 0);
  r.seconds(25);
  const still = rig();
  still.sim.setControls(1, 0);
  still.seconds(25);
  // through the water it makes the same speed; over the ground the current is subtracted
  assert.ok(Math.abs(r.sim.waterSpeed - still.sim.speed) < 0.25, `water speed ${r.sim.waterSpeed} vs ${still.sim.speed}`);
  assert.ok(Math.abs(r.sim.speed - (still.sim.speed - 0.5)) < 0.3, `ground speed ${r.sim.speed}`);
});

test('handling envelope: top speed, coast, progressive reverse, turning circle and heel', () => {
  const r = rig();
  r.seconds(2);
  r.sim.setControls(1, 0);
  let t90 = null;
  const t0 = r.t;
  r.seconds(25, () => {
    if (t90 === null && r.sim.speed > 6.8) t90 = r.t - t0;
  });
  const top = r.sim.speed;
  assert.ok(top > 7 && top < 8.2, `top speed ${top}`);
  assert.ok(t90 > 2.5 && t90 < 9, `responsive acceleration: time to 90% ${t90}`);
  const trim = attitude(r.sim).pitch;
  assert.ok(trim > 0.5 && trim < 3, `bow rise at speed ${trim}`);

  r.sim.setControls(0, 0);
  r.seconds(6);
  assert.ok(r.sim.speed > 1.2 && r.sim.speed < 3.5, `coasting after 6 s ${r.sim.speed}`);

  r.sim.setControls(1, 0);
  r.seconds(15);
  r.sim.setControls(-1, 0);
  let tStop = null;
  const tr = r.t;
  r.seconds(15, () => {
    if (tStop === null && r.sim.speed <= 0) tStop = r.t - tr;
  });
  assert.ok(tStop > 3 && tStop < 10, `reverse stop time ${tStop}`);
  assert.ok(r.sim.speed < -1.8 && r.sim.speed > -3.5, `astern speed ${r.sim.speed}`);

  r.sim.setControls(1, 0);
  r.seconds(15);
  r.sim.setControls(1, 1);
  const xs = [], zs = [];
  let heel = 0, n = 0;
  r.seconds(25, (i) => {
    if (i < 600) return;
    xs.push(r.sim.pos.x);
    zs.push(r.sim.pos.z);
    heel += attitude(r.sim).heel;
    n++;
  });
  const d = (Math.max(...xs) - Math.min(...xs) + Math.max(...zs) - Math.min(...zs)) / 2;
  assert.ok(d / HULL.length > 2.3 && d / HULL.length < 3.6, `turning circle ${d / HULL.length} L`);
  assert.ok(r.sim.ang.y < 0, 'right rudder turns to starboard');
  heel /= n;
  assert.ok(Math.abs(heel) < 3, `flat bottom keeps it nearly level in the turn: ${heel}`);
});

test('crossing its own wake pitches the hull gently', () => {
  const r = rig();
  r.sim.setControls(1, 0);
  r.seconds(12);
  r.sim.setControls(1, 1);
  let turned = 0, last = attitude(r.sim).yaw;
  while (turned < 180) {
    r.step();
    const y = attitude(r.sim).yaw;
    let d = last - y;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    turned += d;
    last = y;
  }
  r.sim.setControls(1, 0);
  let lo = Infinity, hi = -Infinity, wake = 0;
  r.seconds(8, (i) => {
    wake = Math.max(wake, Math.abs(r.sim.wakeHeight));
    if (i < 90) return;
    const p = attitude(r.sim).pitch;
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  });
  assert.ok(wake > 0.008, `wake under hull ${wake}`);
  assert.ok(hi - lo > 0.1 && hi - lo < 4, `pitch through wake ${hi - lo}`);
});

test('hitting a jetty face: no tunneling, impact reported, comes to rest stably', () => {
  for (const speed of [1.5, 4]) {
    const r = rig({ setup: (w) => w.createCollider(R.ColliderDesc.cuboid(10, 2, 1).setTranslation(0, 0.5, -26).setFriction(0.4).setRestitution(0.1)) });
    r.sim.setControls(1, 0);
    while (r.sim.speed < speed && r.t < 20) r.step();
    r.sim.setControls(0.2, 0);
    let bow = Infinity, maxAng = 0;
    r.seconds(12, () => {
      bow = Math.min(bow, r.sim.pos.z - HULL.length / 2);
      maxAng = Math.max(maxAng, r.sim.ang.length());
    });
    assert.ok(bow > -25.1, `bow passed the face: ${bow}`);
    assert.ok(r.impacts.length >= 1 && r.impacts[0].strength > speed * 0.6, `impact ${JSON.stringify(r.impacts[0])}`);
    assert.ok(maxAng < 1, `spun up ${maxAng}`);
    assert.ok(Math.abs(r.sim.speed) < 0.3, 'resting against the jetty');
  }
});

test('terrain fallback stops the hull at a cliff and on a beach without bouncing', () => {
  const fdn = (hf) => (x, z, o) => {
    const hx = hf(x + 1, z) - hf(x - 1, z), hz = hf(x, z + 1) - hf(x, z - 1), l = Math.hypot(hx, 2, hz);
    o.x = -hx / l; o.y = 2 / l; o.z = -hz / l;
    return o;
  };
  const cliffH = (x, z) => -8 + 18 * Math.min(1, Math.max(0, (-25 - z) / 2));
  const beachH = (x, z) => Math.min(2, Math.max(-8, -8 + (-5 - z) * 0.2));
  const cases = [
    { ground: cliffH, shore: (x, z) => -(z + 25) - 0.9, groundNormal: fdn(cliffH), coast: -25.9 },
    { ground: beachH, shore: (x, z) => -5 - z - 40, groundNormal: fdn(beachH), coast: -45 },
  ];
  // the raked bow overhangs the water: measure at the stem where the hull meets the waterline
  const stem = buildHydro().probes.find((p) => !p.bottom).z;
  for (const env of cases) {
    const r = rig({ env });
    r.sim.setControls(1, 0);
    while (r.sim.speed < 5 && r.t < 25) r.step();
    r.sim.setControls(0.25, 0);
    let bow = Infinity;
    r.seconds(20, () => (bow = Math.min(bow, r.sim.pos.z + stem)));
    assert.ok(bow > env.coast - 0.6, `past the coast ${bow}`);
    assert.ok(Math.abs(r.sim.speed) < 0.3, `still moving ${r.sim.speed}`);
    assert.ok(r.impacts.length >= 1 && r.impacts.length <= 3, `impacts ${r.impacts.length}`);
  }
});

test('dockTo pulls into the berth and holds it against the current while still bobbing; undock releases', () => {
  // berths lie bow upstream: this one faces east, so the river runs west along the keel
  const r = rig({ amp: 1, env: { flow: (x, z, o) => { o.x = -0.45; o.z = 0.05; } } });
  r.seconds(2);
  r.sim.dockTo(12, -6, 90);
  r.seconds(15);
  const a = attitude(r.sim);
  assert.ok(Math.hypot(r.sim.pos.x - 12, r.sim.pos.z + 6) < 0.5, `berth error ${r.sim.pos.x}, ${r.sim.pos.z}`);
  assert.ok(Math.abs(((a.yaw + 90 + 540) % 360) - 180) < 5, `heading ${a.yaw}`);
  let lo = Infinity, hi = -Infinity;
  r.seconds(8, () => {
    lo = Math.min(lo, r.sim.pos.y);
    hi = Math.max(hi, r.sim.pos.y);
  });
  assert.ok(hi - lo > 0.004, `bobs on the chop while docked ${hi - lo}`);
  assert.ok(Math.hypot(r.sim.pos.x - 12, r.sim.pos.z + 6) < 0.5, 'holds against the current');
  r.sim.setControls(1, 0);
  r.seconds(2);
  assert.ok(Math.abs(r.sim.speed) < 0.2, 'throttle ignored while docked');
  r.sim.undock();
  r.seconds(5);
  assert.ok(r.sim.speed > 1.5, 'drives away after undock');
});

test('river reset finds the nearest deep centerline spot, clear of bridges, facing upstream', () => {
  // straight river heading north (upstream = -z), 30 m wide, 2.5 m deep, a shallow bar at s 100-130
  const frame = (s) => ({ x: 0, z: -s, tx: 0, tz: -1, nx: 1, nz: 0, width: 30 });
  const depth = (x, z) => (-z > 100 && -z < 130 ? 0.3 : 2.5 - (Math.abs(x) / 15) * 3);
  const a = findRiverSpot(110, frame, depth, { sMin: 30, sMax: 500 });
  assert.ok(a && (a.s < 100 || a.s > 130), `spot ${a?.s}`);
  assert.ok(Math.abs(a.s - 110) <= 24, 'nearest either way');
  assert.ok(a.headingDeg < 1 || a.headingDeg > 359, `faces upstream ${a.headingDeg}`);
  const b = findRiverSpot(200, frame, depth, { sMin: 30, sMax: 500, avoid: [[200, 12]] });
  assert.ok(b && Math.abs(b.s - 200) >= 12, `kept off the bridge ${b?.s}`);
  assert.equal(findRiverSpot(50, frame, () => 0.2, { maxSearch: 60 }), null);
});

test('the river ends ease the boat back instead of stopping it dead', () => {
  // past z = -100 (the falls) the channel pushes back south
  const boundary = (x, z) => (z < -100 ? { dx: 0, dz: 1, depth: -100 - z } : null);
  const r = rig({ env: { boundary } });
  r.sim.setControls(1, 0);
  let far = 0;
  r.seconds(60, () => (far = Math.max(far, -100 - r.sim.pos.z)));
  assert.ok(far > 1 && far < 40, `overshoot past the end ${far}`);
  assert.ok(r.sim.pos.z > -100, 'turned back into the river');
  assert.ok(Math.abs(r.sim.speed) > 2, 'still under way (not a wall)');
});
