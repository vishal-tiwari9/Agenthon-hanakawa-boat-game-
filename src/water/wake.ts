// boat waves: a fine (~0.1 m) dispersive height-field wave sim on a boat-following grid, texel-snapped
// and reprojected as the boat moves, 1-3 substeps a frame.
//  - the hull is a moving displacement source: its submerged depth (a smooth hull footprint) enters the
//    restoring term, so the water under it settles to -depth, the bow pushes water up as it arrives and
//    the stern draws it down as it leaves. the kelvin v, bow and stern waves, rings when turning,
//    accelerating or stopping all come out of that; throttle kicks churn the water behind the transom and
//    hard turns press the hull deeper; hull slaps ('boat:splash') drop soft rings
//  - the restoring kernel (radius 3) is fitted on the cpu to gravity-wave dispersion, so short ripples
//    lag the long ones and every disturbance spreads into a train of irregular rings, not one clean circle
//  - the state drifts with the baked river current (lax-wendroff advection, nearly no smearing), waves
//    slow in the shallows, soak into beaches and reflect off banks (1 m terrain) and rocks (instances)
//  - sparse random drops (petals landing, fish rises, drips) keep the whole window alive; rocks in the
//    current shed small standing ripples downstream
//  - rain (ctx.services.day): every step each ~0.9 m cell of a randomly offset grid may take a raindrop
//    (a hashed coin toss, fresh seed per step), so thousands of tiny overlapping rings a second in a storm
// state (ping-pong, nearest): r = height, g = previous height, b = turbulence, a = hull pressure depth.
// display (linear, no mips): r = height (m), g/b = slope, a = turbulence; low: quarter-res height for
// vertex displacement.
import {
  Color, DataUtils, HalfFloatType, LinearFilter, MeshBasicNodeMaterial, NearestFilter, NoBlending, QuadMesh, RenderTarget, Vector2,
  Vector4, type MagnificationTextureFilter, type Texture,
} from 'three/webgpu';
import {
  Fn, If, abs, clamp, dot, exp, float, floor, fract, max, min, mix, screenUV, select, sin, smoothstep, texture, uniform, uniformArray, vec2, vec3, vec4,
} from 'three/tsl';
import type { GameContext } from '../core/context';
import type { DayState } from '../core/daycycle';
import { ANCHORS, HULL } from '../boat/hullSpec';

type N = any;

const G = 9.81;
/** kernel radius in texels */
const KR = 3;
/** fraction of true gravity: keeps the rings calm and the kernel's short-wave speeds near real water */
const GRAV = 1.0;
const MAX_ROCKS = 12;
const MAX_DROPS = 4;
/** rain grid cell (m): one possible drop per cell per step, landing in the middle 40% so its kernel stays inside */
const RAIN_CELL = 0.9;

/** sine-free 2d hash (dave hoskins hash22): two values in [0, 1) */
function hash22(p: N): N {
  let p3: N = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.103, 0.0973)));
  p3 = p3.add(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.xx.add(p3.yz).mul(p3.zy));
}

const sq = (x: N) => x.mul(x);

/** radial kernel classes (a >= b >= 0, a > 0) with their symmetric tap offsets; class 0 is the 4 neighbours */
function kernelClasses() {
  const out: { taps: [number, number][] }[] = [];
  for (let a = 1; a <= KR; a++) {
    for (let b = 0; b <= a; b++) {
      if (a * a + b * b > KR * KR) continue;
      const seen = new Set<string>();
      const taps: [number, number][] = [];
      for (const [p, q] of [[a, b], [b, a]]) {
        for (const sp of [1, -1]) {
          for (const sq2 of [1, -1]) {
            const i = p * sp, j = q * sq2, k = `${i},${j}`;
            if (!seen.has(k)) { seen.add(k); taps.push([i, j]); }
          }
        }
      }
      out.push({ taps });
    }
  }
  return out;
}

const CLASSES = kernelClasses();

/**
 * least-squares fit of the class weights (1/s^2) so the operator sum_c w_c (n_c h - sum h_ij) has the
 * response w^2 = g k tanh(k d) on a grid of spacing dx, lifted so every mode oscillates and none grows
 */
function fitKernel(dx: number) {
  const n = CLASSES.length;
  const basis = (kx: number, ky: number) => CLASSES.map((c) => c.taps.reduce((s, [i, j]) => s + 1 - Math.cos(kx * i + ky * j), 0));
  const resp = (A: number[], w: ArrayLike<number>) => A.reduce((s, v, i) => s + v * w[i], 0);
  const target = (kg: number) => {
    const k = Math.min(kg, 2.1) / dx;
    return G * GRAV * k * Math.tanh(k * 1.25);
  };
  const M = Array.from({ length: n }, () => new Float64Array(n + 1));
  const tRef = target(0.2);
  const S = 32;
  for (let x = 1; x <= S; x++) {
    for (let y = 0; y <= x; y++) {
      const kx = (x / S) * Math.PI, ky = (y / S) * Math.PI;
      const kg = Math.hypot(kx, ky);
      const t = target(kg);
      const A = basis(kx, ky);
      const wt = ((kg <= 2.1 ? 1 : 0.2) / Math.max(t, tRef)) ** 2;
      for (let i = 0; i < n; i++) {
        M[i][n] += wt * A[i] * t;
        for (let j = 0; j < n; j++) M[i][j] += wt * A[i] * A[j];
      }
    }
  }
  for (let i = 0; i < n; i++) M[i][i] *= 1 + 1e-6;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(M[i][c]) > Math.abs(M[p][c])) p = i;
    [M[c], M[p]] = [M[p], M[c]];
    for (let i = c + 1; i < n; i++) {
      const f = M[i][c] / M[c][c];
      for (let j = c; j <= n; j++) M[i][j] -= f * M[c][j];
    }
  }
  const w = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * w[j];
    w[i] = s / M[i][i];
  }
  // where the fit dips below 30% of the target, add a plain laplacian (class 0)
  let lift = 0;
  for (let x = 1; x <= S; x++) {
    for (let y = 0; y <= x; y++) {
      const kx = (x / S) * Math.PI, ky = (y / S) * Math.PI;
      const A = basis(kx, ky);
      const floor = 0.3 * target(Math.hypot(kx, ky));
      const R = resp(A, w);
      if (R < floor) lift = Math.max(lift, (floor - R) / A[0]);
    }
  }
  w[0] += lift;
  let rMax = 0;
  for (let x = 0; x <= S; x++) for (let y = 0; y <= x; y++) rMax = Math.max(rMax, resp(basis((x / S) * Math.PI, (y / S) * Math.PI), w));
  const cLong = Math.sqrt(resp(basis(0.05, 0), w)) / (0.05 / dx);
  return { w: Array.from(w), rMax, cLong };
}

export class Wake {
  /** display target the water material samples */
  rt: RenderTarget;
  /** quarter-res height for vertex displacement */
  low: RenderTarget;
  /** world meters covered by the grid */
  size = 64;
  res = 640;
  uCenter = uniform(new Vector2());
  uSize = uniform(64);
  uTexel = uniform(64 / 640);
  enabled = true;
  /** follow the day cycle's rain (perf probes turn it off) */
  weather = true;
  info = { cLong: 0, rMax: 0, steps: 0, rocks: 0, rainPerSec: 0 };
  private state: [RenderTarget, RenderTarget];
  private cur = 0;
  private stepQuad: [QuadMesh, QuadMesh];
  private showQuad: [QuadMesh, QuadMesh];
  private lowQuad: QuadMesh;
  private uK: N[] = CLASSES.map(() => uniform(0));
  private uKSum = uniform(0);
  private uUV = uniform(1 / 640);
  private uShift = uniform(new Vector2());
  private uDt = uniform(1 / 120);
  private uDtRatio = uniform(1);
  private uDamp = uniform(0.15);
  /** boat position (x, z) and bow direction (fx, fz) */
  private uBoat = uniform(new Vector4(0, 1e6, 0, -1));
  /** hull draft, prop churn, prop turbulence rate, side eddies */
  private uForce = uniform(new Vector4());
  /** one-step impulses: x, z, depth pushed down (m), radius (hull slaps, random drops) */
  private uDrops = uniformArray(Array.from({ length: MAX_DROPS + 1 }, () => new Vector4(0, 0, 0, 1)), 'vec4');
  /** rocks near the boat: x, z, radius, 0 */
  private uRocks = uniformArray(Array.from({ length: MAX_ROCKS }, () => new Vector4(0, 1e6, 0, 0)), 'vec4');
  /** rain: drop probability per cell this step (0 = no rain), depth (m), kernel radius (m) */
  private uRain = uniform(new Vector4());
  /** per-step rain seed: grid offset (m, x/z) and hash offset */
  private uRainSeed = uniform(new Vector4());
  private uT = uniform(0);
  private rocks: Float32Array | null = null;
  private rockScan = 0;
  private cleared = false;
  private needsClear = true;
  private ramp = 0;
  private prevDt = 1 / 120;
  private prevThr = 0;
  private splash: { x: number; z: number; s: number } | null = null;
  private clearCol = new Color();

  constructor(ctx: GameContext, worldPack: Texture) {
    const mk = (res: number, filter: MagnificationTextureFilter) => {
      const t = new RenderTarget(res, res, { type: HalfFloatType, depthBuffer: false });
      t.texture.minFilter = filter;
      t.texture.magFilter = filter;
      t.texture.generateMipmaps = false;
      return t;
    };
    this.rt = mk(this.res, LinearFilter);
    this.low = mk(this.res / 4, LinearFilter);
    this.state = [mk(this.res, NearestFilter), mk(this.res, NearestFilter)];
    const height = (xz: N) => ctx.world.channelNode('height', xz);
    const ws = ctx.world.size;
    this.stepQuad = [0, 1].map((i) => new QuadMesh(this.stepMaterial(this.state[i].texture, worldPack, ws, height))) as [QuadMesh, QuadMesh];
    this.showQuad = [0, 1].map((i) => new QuadMesh(this.showMaterial(this.state[i].texture))) as [QuadMesh, QuadMesh];
    this.lowQuad = new QuadMesh(this.lowMaterial());
    ctx.events.on('boat:splash', (e: { strength: number; x: number; z: number }) => {
      if (!this.splash || e.strength > this.splash.s) this.splash = { x: e.x, z: e.z, s: e.strength };
    });
    // rocks standing in the river are reflecting obstacles; instances: piece, x, y, z, qx, qy, qz, qw, scale, _
    ctx.assets.json<{ stride: number; instances: number[] }>('/world/rocks.json?v=' + ctx.world.meta.version).then((r) => {
      const out: number[] = [];
      for (let i = 0; i + r.stride <= r.instances.length; i += r.stride) {
        const x = r.instances[i + 1], y = r.instances[i + 2], z = r.instances[i + 3], sc = r.instances[i + 8];
        const rad = 0.75 * sc;
        if (y + rad > 0.02 && y - rad < 0) out.push(x, z, rad * Math.sqrt(Math.max(0, 1 - (y / rad) ** 2)) * 0.9);
      }
      this.rocks = new Float32Array(out);
    }).catch(() => { this.rocks = new Float32Array(0); });
    this.fit();
  }

  private fit() {
    const f = fitKernel(this.size / this.res);
    f.w.forEach((v, i) => { this.uK[i].value = v; });
    this.uKSum.value = f.w.reduce((s, v, i) => s + v * CLASSES[i].taps.length, 0);
    this.info.cLong = +f.cLong.toFixed(2);
    this.info.rMax = +f.rMax.toFixed(0);
  }

  setResolution(res: number, size: number) {
    this.res = res;
    this.size = size;
    this.rt.setSize(res, res);
    this.low.setSize(res / 4, res / 4);
    this.state[0].setSize(res, res);
    this.state[1].setSize(res, res);
    this.uSize.value = size;
    this.uTexel.value = size / res;
    this.uUV.value = 1 / res;
    this.fit();
    this.needsClear = true;
  }

  private base(m: MeshBasicNodeMaterial) {
    m.depthTest = false;
    m.depthWrite = false;
    m.fog = false;
    m.transparent = false;
    m.blending = NoBlending;
    return m;
  }

  private stepMaterial(src: Texture, worldPack: Texture, worldSize: number, height: (xz: N) => N) {
    const m = this.base(new MeshBasicNodeMaterial());
    const uv0 = screenUV;
    const uvS = uv0.add(this.uShift.mul(this.uUV));
    const tap = (i: number, j: number): N => texture(src, uvS.add(vec2(i, j).mul(this.uUV)));
    const c = tap(0, 0);
    const e = (t: N) => t.r.add(t.a);
    // dispersive restoring term on height + hull depth: sum_c w_c (n_c e0 - sum e_ij)
    let conv: N = e(c).mul(this.uKSum);
    const n4: N[] = [];
    CLASSES.forEach((cl, ci) => {
      let s: N = float(0);
      for (const [i, j] of cl.taps) {
        const t = tap(i, j);
        if (ci === 0) n4.push(t);
        s = s.add(e(t));
      }
      conv = conv.sub(s.mul(this.uK[ci]));
    });
    const [tE, tW, tS, tN] = n4;

    // world position, water depth (1 m terrain) and the river current (baked flow)
    const w = this.uCenter.add(uv0.sub(0.5).mul(this.uSize)).toVar();
    const depth = height(w).negate().toVar();
    const flow = texture(worldPack, w.div(worldSize).add(0.5)).gb.toVar();
    const dt = this.uDt;
    // lax-wendroff advection by the current (courant ~0.05): rings drift downstream with almost no blur
    const C = flow.mul(dt).div(this.uSize.mul(this.uUV)).toVar();
    const adv = (f: (t: N) => N) => {
      const f0 = f(c), fe = f(tE), fw = f(tW), fs = f(tS), fn = f(tN);
      return f0
        .sub(C.x.mul(fe.sub(fw)).mul(0.5)).add(sq(C.x).mul(0.5).mul(fe.add(fw).sub(f0.mul(2))))
        .sub(C.y.mul(fs.sub(fn)).mul(0.5)).add(sq(C.y).mul(0.5).mul(fs.add(fn).sub(f0.mul(2))));
    };
    const h = adv((t) => t.r), hp = adv((t) => t.g);

    // rocks: solid inside, a pressure collar outside that sheds standing ripples into the current
    let rockD: N = float(99);
    for (let i = 0; i < MAX_ROCKS; i++) {
      const r: N = this.uRocks.element(i);
      rockD = min(rockD, w.sub(r.xy).length().sub(r.z));
    }
    const rockDV = rockD.toVar();
    const wall = depth.lessThan(0.02).or(rockDV.lessThan(0));
    const speed = flow.length();
    const rockP = exp(sq(rockDV.div(0.3)).negate()).mul(smoothstep(0.08, 0.6, speed)).mul(0.012);

    // shallows slow the waves and beaches soak them up; walls, banks and rocks reflect them
    const deep = clamp(depth.div(0.5), 0.15, 1);
    const damp = this.uDamp.add(float(2.5).mul(float(1).sub(smoothstep(0.03, 0.3, depth))));
    const vel0 = h.sub(hp).mul(this.uDtRatio);
    // light viscosity on the velocity keeps grid-scale noise from ringing
    const avgVel = tE.r.sub(tE.g).add(tW.r.sub(tW.g)).add(tS.r.sub(tS.g)).add(tN.r.sub(tN.g)).mul(0.25).mul(this.uDtRatio);
    const vel = mix(vel0, avgVel, 0.02).mul(max(float(1).sub(damp.mul(dt)), 0));

    // boat frame: lz along the keel (bow -z), lx athwartships
    const rel = w.sub(this.uBoat.xy);
    const fwd = this.uBoat.zw;
    const lz = dot(rel, fwd).negate();
    const lx = dot(rel, vec2(fwd.y.negate(), fwd.x));
    const L2 = (HULL.sternZ - HULL.bowZ) * 0.47;
    const taper = mix(0.25, 1, smoothstep(HULL.bowZ + 0.1, HULL.bowZ + 2.6, lz)).mul(mix(1, 0.7, smoothstep(HULL.sternZ - 1.6, HULL.sternZ, lz)));
    // sharp-edged footprint: a smooth one only radiates long swells that tilt the mirror; hard edges shed
    // the short ripple trains that actually break it up
    const eta = abs(lx).div(taper.mul(HULL.beam * 0.47));
    const hullF = smoothstep(1, 0.8, eta).mul(smoothstep(1, 0.9, abs(lz).div(L2)));
    // turbulent boundary layer along the sides: a restless pressure band that sheds random ripples
    const sideBand = exp(sq(eta.sub(1.05).div(0.18)).negate()).mul(smoothstep(1.05, 0.85, abs(lz).div(L2)));
    const t0 = this.uT;
    const eddy = sin(w.x.mul(9.7).add(t0.mul(11.3)).add(sin(w.y.mul(8.3).sub(t0.mul(7.1))).mul(2.2)))
      .mul(sin(w.y.mul(10.9).sub(t0.mul(9.7)).add(sin(w.x.mul(7.7).add(t0.mul(6.1))).mul(2.2))));
    // prop churn: a restless pressure field just aft of the transom
    const propF = exp(sq(lz.sub(ANCHORS.propeller.z + 0.8).div(0.9)).negate()).mul(exp(sq(lx.div(0.45)).negate()));
    const t = this.uT;
    const churn = sin(w.x.mul(6.3).add(t.mul(9.1)).add(sin(w.y.mul(5.1).sub(t.mul(5.3))).mul(2)))
      .mul(sin(w.y.mul(7.1).sub(t.mul(8.3)).add(sin(w.x.mul(4.4).add(t.mul(4.7))).mul(2))));
    const f = this.uForce;
    const press = hullF.mul(f.x).add(propF.mul(churn).mul(f.y)).add(sideBand.mul(eddy).mul(f.w)).add(rockP);

    // one-step impulses: soft rings from hull slaps and random drops
    let kick: N = float(0);
    for (let i = 0; i <= MAX_DROPS; i++) {
      const d: N = this.uDrops.element(i);
      kick = kick.add(exp(sq(w.sub(d.xy).length().div(max(d.w, 0.01))).negate()).mul(d.z));
    }

    // rain: a fresh coin toss per cell each step; nothing is evaluated while it is dry
    const rainKick = Fn(() => {
      const k = float(0).toVar();
      If(this.uRain.x.greaterThan(0), () => {
        const q = uv0.mul(this.uSize).add(this.uRainSeed.xy).div(RAIN_CELL);
        const id = floor(q);
        const h0 = hash22(id.add(this.uRainSeed.zw));
        const h1 = hash22(id.add(this.uRainSeed.wz).add(vec2(37.2, 91.7)));
        const d = fract(q).sub(h0.mul(0.4).add(0.3)).mul(RAIN_CELL).length().div(this.uRain.z);
        const drop = exp(d.mul(d).negate()).mul(this.uRain.y).mul(h1.y.add(0.5)).mul(float(1).sub(hullF));
        k.assign(select(h1.x.lessThan(this.uRain.x), drop, float(0)));
      });
      return k;
    })();
    kick = kick.add(rainKick);

    let hn: N = h.add(vel).sub(conv.mul(deep).mul(dt.mul(dt))).sub(kick);
    // sponge along the grid border so nothing reflects off the domain edge
    const edge = min(min(uv0.x, float(1).sub(uv0.x)), min(uv0.y, float(1).sub(uv0.y)));
    const sponge = mix(0.92, 1, smoothstep(0, 0.06, edge));
    hn = select(wall, float(0), clamp(hn.mul(sponge), -0.5, 0.5));
    const hOut = select(wall, float(0), h.mul(sponge));
    // turbulence: the prop wash drifts with the current and lingers as a smooth slick
    const tb = clamp(adv((t2) => t2.b).mul(exp(dt.div(-20))).add(propF.mul(f.z).mul(dt)), 0, 1);
    m.fragmentNode = vec4(hn, hOut, tb.mul(sponge), press);
    return m;
  }

  private showMaterial(src: Texture) {
    const m = this.base(new MeshBasicNodeMaterial());
    const d = this.uUV;
    const s = texture(src, screenUV);
    const hx = texture(src, screenUV.add(vec2(d, 0))).r.sub(texture(src, screenUV.sub(vec2(d, 0))).r);
    const hz = texture(src, screenUV.add(vec2(0, d))).r.sub(texture(src, screenUV.sub(vec2(0, d))).r);
    const k = float(1).div(this.uTexel.mul(2));
    m.fragmentNode = vec4(s.r, hx.mul(k), hz.mul(k), s.b);
    return m;
  }

  private lowMaterial() {
    const m = this.base(new MeshBasicNodeMaterial());
    // 4 bilinear taps of the display = a 4x4 box over the quarter-res texel
    const d = this.uUV;
    const tp = (i: number, j: number) => texture(this.rt.texture, screenUV.add(vec2(i, j).mul(d))).r;
    m.fragmentNode = vec4(tp(-1, -1).add(tp(1, -1)).add(tp(-1, 1)).add(tp(1, 1)).mul(0.25), 0, 0, 0);
    return m;
  }

  /** forget the waves (teleport/reset) */
  reset() {
    this.needsClear = true;
  }

  /** debug: min/max of each channel of the display target */
  async probe(ctx: GameContext) {
    const r = ctx.renderer as any;
    const px = await r.readRenderTargetPixelsAsync(this.rt, 0, 0, this.res, this.res);
    const get = px instanceof Uint16Array ? (i: number) => DataUtils.fromHalfFloat(px[i]) : (i: number) => px[i];
    const st = [0, 1, 2, 3].map(() => [Infinity, -Infinity]);
    for (let i = 0; i < this.res * this.res; i++) {
      for (let c = 0; c < 4; c++) {
        const v = get(i * 4 + c);
        st[c][0] = Math.min(st[c][0], v);
        st[c][1] = Math.max(st[c][1], v);
      }
    }
    // slope and height outside the hull: an annulus 2-8 m around the boat
    const c = this.uCenter.value as Vector2;
    const bp = ctx.boat?.position;
    let ring = { n: 0, maxH: 0, maxS: 0, meanS: 0 };
    if (bp) {
      for (let j = 0; j < this.res; j++) {
        for (let i = 0; i < this.res; i++) {
          const x = c.x + ((i + 0.5) / this.res - 0.5) * this.size, z = c.y + ((j + 0.5) / this.res - 0.5) * this.size;
          const d = Math.hypot(x - bp.x, z - bp.z);
          if (d < 2 || d > 8) continue;
          const k = (j * this.res + i) * 4;
          const sl = Math.hypot(get(k + 1), get(k + 2));
          ring.n++;
          ring.maxH = Math.max(ring.maxH, Math.abs(get(k)));
          ring.maxS = Math.max(ring.maxS, sl);
          ring.meanS += sl;
        }
      }
      ring.meanS /= Math.max(1, ring.n);
      ring = { n: ring.n, maxH: +ring.maxH.toFixed(3), maxS: +ring.maxS.toFixed(3), meanS: +ring.meanS.toFixed(4) };
    }
    return { channels: st.map(([a, b]) => `${a.toFixed(4)}..${b.toFixed(4)}`).join(' | '), center: c.toArray(), boat: bp?.toArray().map((v) => +v.toFixed(2)), ring, ...this.info };
  }

  private clearTargets(ctx: GameContext, list: RenderTarget[]) {
    const r = ctx.renderer;
    for (const t of list) {
      r.setRenderTarget(t);
      r.clear();
    }
  }

  /** the (up to MAX_ROCKS) nearest rocks inside the window */
  private pickRocks(cx: number, cz: number) {
    const arr = this.uRocks.array as Vector4[];
    for (const v of arr) v.set(0, 1e6, 0, 0);
    const R = this.rocks;
    if (!R) return;
    const half = this.size / 2 + 2;
    const found: [number, number][] = [];
    for (let i = 0; i < R.length; i += 3) {
      const dx = R[i] - cx, dz = R[i + 1] - cz;
      if (Math.abs(dx) < half && Math.abs(dz) < half) found.push([dx * dx + dz * dz, i]);
    }
    found.sort((a, b) => a[0] - b[0]);
    found.slice(0, MAX_ROCKS).forEach(([, i], k) => arr[k].set(R[i], R[i + 1], R[i + 2], 0));
    this.info.rocks = Math.min(found.length, MAX_ROCKS);
  }

  update(ctx: GameContext) {
    const r = ctx.renderer;
    const b = ctx.boat;
    const prevTarget = r.getRenderTarget();
    const prevAlpha = r.getClearAlpha();
    const prevAuto = r.autoClear;
    r.getClearColor(this.clearCol);
    const restore = () => {
      r.setRenderTarget(prevTarget);
      r.setClearColor(this.clearCol, prevAlpha);
      r.autoClear = prevAuto;
    };
    r.setClearColor(0x000000, 0);
    r.autoClear = false;

    if (!this.enabled || !b) {
      if (!this.cleared) {
        this.clearTargets(ctx, [this.rt, this.low, this.state[0], this.state[1]]);
        this.cleared = true;
        this.needsClear = true;
      }
      restore();
      return;
    }
    this.cleared = false;

    // texel-snapped centre a little behind the boat so more of the wake fits
    const tex = this.size / this.res;
    const q = b.quaternion;
    let fx = -2 * (q.x * q.z + q.w * q.y), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl;
    fz /= fl;
    const back = this.size * 0.22;
    const cx = Math.round((b.position.x - fx * back) / tex) * tex;
    const cz = Math.round((b.position.z - fz * back) / tex) * tex;
    const c = this.uCenter.value as Vector2;
    if (this.needsClear || Math.hypot(cx - c.x, cz - c.y) > this.size * 0.2) {
      this.clearTargets(ctx, [this.state[0], this.state[1]]);
      this.needsClear = false;
      this.ramp = 0;
      c.set(cx, cz);
      this.rockScan = 0;
    }
    const shiftX = Math.round((cx - c.x) / tex), shiftZ = Math.round((cz - c.y) / tex);
    c.set(cx, cz);
    if (this.rockScan-- <= 0) {
      this.rockScan = 20;
      this.pickRocks(cx, cz);
    }

    const frameDt = ctx.paused ? 0 : Math.min(ctx.time.frameDt, 0.1);
    const steps = frameDt > 0 ? Math.min(3, Math.ceil(frameDt / 0.0095)) : shiftX || shiftZ ? 1 : 0;
    const dt = steps ? Math.max(frameDt / steps, 1e-4) : 0;
    this.info.steps = steps;

    // forcing: the hull's submerged depth (deeper when carving a turn), prop churn with throttle kicks
    const v = Math.max(0, b.speed);
    const thr = Math.abs(b.throttle);
    const kickT = frameDt > 0 ? Math.max(0, (thr - this.prevThr) / frameDt) : 0;
    this.prevThr = thr;
    this.ramp = Math.min(1, this.ramp + frameDt / 1.5);
    const yaw = Math.abs(b.angularVelocity.y);
    // the hull bobbing in the chop changes its displacement too: soft rings even at rest
    const bob = Math.max(-0.5, Math.min(0.5, -b.velocity.y * 3));
    const draft = Math.min(0.3, 1.2 * (HULL.draft + 0.012 * Math.min(v, 8)) * (1 + Math.min(0.8, yaw * 0.9)) * (1 + bob)) * this.ramp;
    const eddies = 0.6 * (0.004 + 0.0025 * Math.min(v, 7) + 0.01 * Math.min(1, yaw)) * this.ramp;
    const prop = (thr * (0.004 + 0.0015 * Math.min(v, 7)) + Math.min(kickT, 3) * 0.012) * this.ramp;
    (this.uBoat.value as Vector4).set(b.position.x, b.position.z, fx, fz);
    (this.uForce.value as Vector4).set(draft, prop, thr * 2.2 * Math.min(1, (v + thr * 1.5) / 2.2), eddies);
    this.uT.value = ctx.time.render;

    // random drops across the window (petals, fish rises, drips), never under the hull
    const drops = this.uDrops.array as Vector4[];
    for (const d of drops) d.set(0, 1e6, 0, 1);
    let nd = 0;
    const want = frameDt * 12;
    for (let k = 0; k < MAX_DROPS && Math.random() < want - k; k++) {
      const x = cx + (Math.random() - 0.5) * this.size * 0.85, z = cz + (Math.random() - 0.5) * this.size * 0.85;
      if (Math.hypot(x - b.position.x, z - b.position.z) < 4.5) continue;
      const big = Math.random() < 0.15;
      drops[nd++].set(x, z, big ? 0.018 : 0.005 + Math.random() * 0.006, big ? 0.16 : 0.07 + Math.random() * 0.05);
    }
    const sp = this.splash;
    if (sp) drops[MAX_DROPS].set(sp.x, sp.z, Math.min(0.04, 0.008 + sp.s * 0.006), 0.4 + Math.min(sp.s, 4) * 0.1);
    this.splash = null;

    // rain: drops per m^2 per second (~1000 a second over the 64 m window in rain, ~2500 in a storm, so
    // the rings overlap); size and depth grow with the downpour. kernel ~1 texel so each drop rings
    // instead of exciting grid noise
    const day = this.weather ? (ctx.services.day as DayState | undefined) : undefined;
    const rain = day?.rain ?? 0, storm = day?.storm ?? 0;
    const rainU = this.uRain.value as Vector4;
    const density = rain * (0.25 + 0.35 * storm);
    rainU.set(
      steps ? density * RAIN_CELL * RAIN_CELL * dt : 0,
      0.0035 + 0.0025 * rain + 0.002 * storm,
      tex * (0.85 + 0.35 * rain),
      0,
    );
    this.info.rainPerSec = Math.round(density * this.size * this.size);

    for (let i = 0; i < steps; i++) {
      (this.uShift.value as Vector2).set(i === 0 ? shiftX : 0, i === 0 ? shiftZ : 0);
      this.uDt.value = dt;
      this.uDtRatio.value = Math.min(2, dt / this.prevDt);
      if (i === 1) for (const d of drops) d.z = 0;
      if (rainU.x > 0) (this.uRainSeed.value as Vector4).set(Math.random() * RAIN_CELL, Math.random() * RAIN_CELL, Math.random() * 500, Math.random() * 500);
      r.setRenderTarget(this.state[1 - this.cur]);
      this.stepQuad[this.cur].render(r);
      this.cur = 1 - this.cur;
      this.prevDt = dt;
    }
    r.setRenderTarget(this.rt);
    this.showQuad[this.cur].render(r);
    r.setRenderTarget(this.low);
    this.lowQuad.render(r);
    restore();
  }
}
