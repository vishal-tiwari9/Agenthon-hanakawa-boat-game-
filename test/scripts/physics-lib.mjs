// shared helpers for the physics-* harness scripts. installs window.__phys in the page: attitude,
// state, a per-frame recorder that runs after the camera, and an event log.
export const INSTALL = `(async () => {
  if (window.__phys) return true;
  const layout = await import('/src/world/layout.ts');
  const L = window.__luma, ctx = L.ctx;
  const E = ctx.camera.rotation.constructor;
  const e = new E(0, 0, 0, 'YXZ');
  const D = 180 / Math.PI;
  const api = {
    rec: [], recOn: false, events: [],
    att() { e.setFromQuaternion(ctx.boat.quaternion, 'YXZ'); return { pitch: e.x * D, heel: e.z * D, yaw: e.y * D }; },
    state() {
      const b = ctx.boat, a = api.att();
      return { t: +ctx.time.sim.toFixed(3), x: b.position.x, y: b.position.y, z: b.position.z, speed: b.speed, throttle: b.throttle, rudder: b.rudder,
        docked: b.docked, sub: b.submersion, pitch: a.pitch, heel: a.heel, yaw: a.yaw, cam: ctx.cameraRig && ctx.cameraRig.mode };
    },
    layout,
    /** centerline pose at along-river s; lateral + toward the right bank; heading upstream unless flipped */
    river(s, lateral = 0, headingOffset = 0) {
      const f = layout.riverFrame(s);
      const x = f.x + f.nx * lateral, z = f.z + f.nz * lateral;
      const h = (layout.riverHeading(s) + headingOffset + 360) % 360;
      return { x, z, h, width: f.width, depth: ctx.world.depthAt(x, z), tx: f.tx, tz: f.tz, nx: f.nx, nz: f.nz };
    },
    place(s, lateral = 0, headingOffset = 0) {
      const p = api.river(s, lateral, headingOffset);
      ctx.boat.teleport(p.x, p.z, p.h);
      return p;
    },
    where() { const b = ctx.boat.position; return layout.nearestRiver(b.x, b.z); },
  };
  ctx.onUpdate(() => {
    if (!api.recOn || !ctx.boat) return;
    const b = ctx.boat, cam = ctx.camera, a = api.att();
    const v = b.position.clone().project(cam);
    api.rec.push([ctx.time.real, ctx.time.sim, v.x, v.y, cam.position.distanceTo(b.position), b.speed, a.heel, a.pitch, b.position.x, b.position.z, b.position.y, a.yaw]);
  }, 55);
  for (const n of ['boat:impact', 'boat:splash', 'camera:mode', 'boat:docked', 'boat:undocked'])
    ctx.events.on(n, (p) => api.events.push({ type: n, t: +ctx.time.sim.toFixed(2), p }));
  window.__phys = api;
  return true;
})()`;

export async function setup(g) {
  await g.evalJs(INSTALL);
  // leave the title card so gameplay input is live
  for (let i = 0; i < 40; i++) {
    const mode = await g.evalJs('window.__lumaUi ? window.__lumaUi.mode : "none"');
    if (mode === 'play' || mode === 'none') break;
    if (mode === 'title') await g.evalJs('window.__lumaUi.start()');
    await g.delay(250);
  }
  const P = (expr) => g.luma(`(() => { const P = window.__phys, ctx = L.ctx, b = L.ctx.boat; return (${expr}); })()`);
  /** wait for a span of simulation time (the loop may run slower than real time headless) */
  const sim = async (seconds) => {
    const t0 = await P('ctx.time.sim');
    const deadline = Date.now() + seconds * 4000 + 5000;
    for (;;) {
      await g.delay(100);
      const t = await P('ctx.time.sim');
      if (t - t0 >= seconds || Date.now() > deadline) return t - t0;
    }
  };
  const hold = (a, on = true) => g.luma(`L.hold(${JSON.stringify(a)}, ${on})`);
  return { P, sim, hold, state: () => P('P.state()') };
}

const f = (v, n = 2) => (typeof v === 'number' ? +v.toFixed(n) : v);
export const fmt = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)])));

/** high-frequency residual of the boat's screen position (px): jitter the eye would see */
export function screenJitter(rows, W, H) {
  const px = rows.map((r) => [(r[2] * 0.5 + 0.5) * W, (-r[3] * 0.5 + 0.5) * H]);
  const res = [];
  for (let i = 2; i < px.length - 2; i++) {
    let mx = 0, my = 0;
    for (let k = -2; k <= 2; k++) {
      mx += px[i + k][0];
      my += px[i + k][1];
    }
    res.push(Math.hypot(px[i][0] - mx / 5, px[i][1] - my / 5));
  }
  res.sort((a, b) => a - b);
  const rms = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / Math.max(1, res.length));
  return { frames: rows.length, rmsPx: rms, p95Px: res[Math.floor(res.length * 0.95)] ?? 0, maxPx: res[res.length - 1] ?? 0 };
}

export default async function (g) {
  console.log('physics-lib is a helper module; run physics-drive or physics-contact');
}
