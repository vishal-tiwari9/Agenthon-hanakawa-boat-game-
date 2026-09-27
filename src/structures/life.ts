// festive, moving life for the opening reach (s ~40-460): lantern strings across the canal, koinobori
// carp streamers over the rooftops. everything animates in the vertex shader from the shared wind and
// time uniforms (the shadow pass uses the same position node, so shadows move with the geometry), and
// every visibility decision is made on the cpu from the camera's world position.
import {
  BufferGeometry, DoubleSide, Group, InstancedBufferAttribute, InstancedBufferGeometry, InstancedMesh, Matrix4, Mesh,
  MeshStandardNodeMaterial, PlaneGeometry, Quaternion, Sphere, Vector2, Vector3,
} from 'three/webgpu';
import {
  Fn, abs, attribute, cos, float, fract, fwidth, length, max, mix, mx_noise_float, normalLocal, positionGeometry, positionLocal, sin, smoothstep,
  step, uv, vec2, vec3,
} from 'three/tsl';
import { LAYERS } from '../core/layers';
import { waterHeight } from '../world/waves';
import { SITES } from '../world/sites';
import type { GameContext } from '../core/context';
import { uTime, uWindDir, uWindStrength } from '../core/uniforms';
import { bankPoint, riverFrame, type RiverFrame } from '../world/layout';
import { Site } from './builder';
import { Bucket, chamferBox, cylinder, lathe, poly, rng, segment, trs, type Part, type RGB } from './geom';
import { GLOW_GAIN, GLOW_TINT, type Materials } from './materials';
import { buildBoat, MooredBoat, type HullSpec } from './boats';
import { LAMP_GAIN, flicker, lampColor, lampLevel, lampLevelNow } from './night';

type N = any;

const RED: RGB = [0.5, 0.06, 0.03];
const PAPER: RGB = [0.8, 0.72, 0.55];
const INK: RGB = [0.03, 0.05, 0.12];
const GOLD: RGB = [0.62, 0.42, 0.08];
const GREEN: RGB = [0.06, 0.2, 0.08];
const WHITE: RGB = [0.82, 0.8, 0.74];

function blank(): Part { return { pos: [], nor: [], uv: [] }; }

// ---------------------------------------------------------------------------------------------
// materials

/**
 * hanging things (lanterns, pennants). geometry is in world space; aVar = [hang y, seed, paper, glow].
 * everything below the hang point shears downwind and swings, so the whole string sways as one.
 */
export function swayMaterial() {
  const m = new MeshStandardNodeMaterial({ side: DoubleSide });
  const a = attribute('aVar', 'vec4') as N;
  const col = attribute('aCol', 'vec3') as N;
  const drop = max(a.x.sub(positionLocal.y), 0);
  const ph = uTime.mul(1.25).add(a.y.mul(6.283));
  const gust = uWindStrength.add(0.25);
  // cloth (paper = 0) flutters harder than the stiff paper lanterns
  const k = mix(float(0.22), float(0.075), a.z);
  const along = sin(ph).mul(k).add(uWindStrength.mul(0.1)).mul(gust).mul(drop);
  const across = sin(ph.mul(0.73).add(1.9)).mul(k).mul(0.6).mul(gust).mul(drop);
  const w: N = uWindDir;
  m.positionNode = positionLocal.add(vec3(w.x.mul(along).sub(w.y.mul(across)), 0, w.y.mul(along).add(w.x.mul(across))));
  const ribFade = float(1).sub(smoothstep(0.15, 0.4, fwidth(uv().y.div(0.028))));
  const rib = mix(float(0.2), smoothstep(0.75, 0.95, abs(sin(uv().y.mul(Math.PI / 0.028)))), ribFade).mul(a.z);
  const c = col.mul(float(1).sub(rib.mul(0.35)));
  m.colorNode = c;
  m.roughnessNode = mix(float(0.9), float(0.82), a.z);
  m.metalnessNode = float(0);
  // lantern paper (paper = 1 with a day glow) burns brighter from dusk, each with its own flicker
  const night = lampColor(c).mul(a.z.mul(step(0.001, a.w)).mul(lampLevel).mul(flicker(a.y)).mul(LAMP_GAIN));
  m.emissiveNode = c.mul(vec3(...GLOW_TINT)).mul(a.w.mul(GLOW_GAIN)).add(night).mul(float(1).sub(rib.mul(0.6)));
  return m;
}

/**
 * koinobori carp and the five-colour streamer. geometry lives in a pole-local frame whose +x points
 * downwind (the cpu turns the group each frame); aVar = [u along the body 0..1, length, seed, kind]
 * with kind 0 = carp, 1 = streamer. uv = (u, angle around the body / 2pi).
 */
function carpMaterial() {
  const m = new MeshStandardNodeMaterial({ side: DoubleSide });
  const a = attribute('aVar', 'vec4') as N;
  const body = attribute('aCol', 'vec3') as N;
  const u = a.x, L = a.y, seed = a.z, kind = a.w;
  const t = uTime.add(seed.mul(17.0));
  const ws: N = uWindStrength.clamp(0.05, 1);
  // a slack sock droops at the tail; a steady breeze holds it out and ripples it
  const droop: N = u.mul(u).mul(L).mul(float(1).sub(ws).mul(0.32).add(0.05));
  const ripple: N = ws.add(0.35);
  const side: N = sin(t.mul(3.0).sub(u.mul(7.5))).mul(u).mul(L).mul(0.05).mul(ripple);
  const lift: N = sin(t.mul(2.2).sub(u.mul(5.0)).add(1.3)).mul(u).mul(L).mul(0.035).mul(ripple);
  // the body breathes as air fills it
  const theta: N = uv().y.mul(Math.PI * 2);
  const breathe: N = sin(t.mul(2.6).sub(u.mul(6.0))).mul(0.06).mul(u).mul(float(1).sub(kind));
  const radial = vec3(0, cos(theta), sin(theta)).mul(breathe.mul(0.25));
  m.positionNode = positionLocal.add(vec3(0, droop.negate().add(lift), side)).add(radial);

  // carp: scales, pale belly, a gold-ringed eye, a white mouth ring
  const ct = cos(theta);
  const belly = smoothstep(0.35, 0.95, ct.negate());
  const sx = u.mul(L).div(0.16), sy = uv().y.mul(22);
  const row = sx.floor();
  const cell = vec2(sx.fract(), sy.add(row.mul(0.5)).fract());
  const arc = smoothstep(0.34, 0.42, length(cell.sub(vec2(0, 0.5))));
  let c: N = mix(body, body.mul(1.9).add(0.02), arc.mul(0.3));
  c = mix(c, vec3(0.78, 0.74, 0.62), belly.mul(0.85));
  const eyeD = length(vec2(u.sub(0.1).mul(L).div(0.13), ct.div(0.28)));
  c = mix(c, vec3(0.8, 0.78, 0.7), smoothstep(1.0, 0.9, eyeD));
  c = mix(c, vec3(0.6, 0.4, 0.06), smoothstep(0.72, 0.64, eyeD));
  c = mix(c, vec3(0.02, 0.02, 0.025), smoothstep(0.45, 0.38, eyeD));
  c = mix(c, vec3(0.82, 0.8, 0.72), smoothstep(0.035, 0.02, u));
  // tail fin darkens toward its edge
  c = mix(c, c.mul(0.55), smoothstep(0.86, 1.0, u));
  // streamer: five colour bands around the sock
  const band = uv().y.mul(5).floor();
  const s0 = vec3(0.04, 0.12, 0.4), s1 = vec3(0.5, 0.06, 0.03), s2 = vec3(0.62, 0.45, 0.06), s3 = vec3(0.8, 0.78, 0.72), s4 = vec3(0.05, 0.22, 0.1);
  const sc = mix(mix(mix(mix(s0, s1, step(1, band)), s2, step(2, band)), s3, step(3, band)), s4, step(4, band));
  m.colorNode = mix(c, sc, kind);
  m.roughnessNode = float(0.62);
  m.metalnessNode = float(0);
  return m;
}

function plainMaterial(rough = 0.7, metal = 0) {
  const m = new MeshStandardNodeMaterial({ side: DoubleSide });
  m.colorNode = attribute('aCol', 'vec3');
  m.roughnessNode = float(rough);
  m.metalnessNode = float(metal);
  return m;
}

// ---------------------------------------------------------------------------------------------
// geometry

/** chochin lantern hanging with its top at (x, y, z); aVar marks the rope as the hang point */
export function hangLantern(b: Bucket, x: number, y: number, z: number, hangY: number, tint: RGB, seed: number, scale = 1) {
  const s = scale;
  const prof = [[0.09, -0.62], [0.16, -0.58], [0.23, -0.45], [0.25, -0.29], [0.225, -0.1], [0.15, 0.0], [0.085, 0.02]].map(([r, h]) => [r * s, h * s]);
  const m = trs(x, y, z);
  b.add(lathe(prof, 10), m, { col: tint, v: [hangY, seed, 1, 0.18] });
  for (const cy of [-0.64 * s, 0.0]) b.add(cylinder(0.095 * s, 0.095 * s, 0.05 * s, 8), m.clone().multiply(trs(0, cy, 0)), { col: [0.05, 0.035, 0.025], v: [hangY, seed, 0, 0] });
  b.add(cylinder(0.008, 0.008, hangY - y, 4), trs(x, y, z), { col: [0.12, 0.1, 0.07], v: [hangY, seed, 0, 0] });
  // a short tassel under the lantern
  b.add(cylinder(0.02 * s, 0.006, 0.22 * s, 5), m.clone().multiply(trs(0, -0.64 * s - 0.22 * s, 0)), { col: tint === RED ? [0.62, 0.45, 0.08] : RED, v: [hangY, seed, 0, 0] });
}

/** triangular pennant hanging from a rope point */
function pennant(b: Bucket, x: number, y: number, z: number, tx: number, tz: number, tint: RGB, seed: number) {
  const w = 0.17, h = 0.46;
  const p = blank();
  poly(p, [[x - tx * w, y, z - tz * w], [x + tx * w, y, z + tz * w], [x, y - h, z]], 'y', [tz, 0, -tx]);
  b.add(p, new Matrix4(), { col: tint, v: [y + 0.02, seed, 0, 0] });
}

function rope(site: Site, pts: number[][], r = 0.013) {
  for (let i = 0; i < pts.length - 1; i++) {
    const q = segment(pts[i], pts[i + 1]);
    site.add('rope', cylinder(r, r, q.len, 5, false), q.m, { col: [0.5, 0.43, 0.3] });
  }
}

function pole(site: Site, x: number, base: number, z: number, top: number, r = 0.09) {
  site.add('timber', cylinder(r, r * 0.82, top - base + 0.35, 8), trs(x, base - 0.35, z), { col: [0.9, 0.82, 0.7] });
  site.add('dressed', chamferBox(0.34, 0.2, 0.34, 0.03), trs(x, base + 0.05, z), { col: [0.6, 0.6, 0.55] });
  site.add('timber', lathe([[0, 0], [r * 1.3, 0.04], [r * 1.35, 0.1], [r * 0.9, 0.18], [0, 0.26]], 8), trs(x, top, z), { col: [0.25, 0.2, 0.15] });
}

/** a carp windsock tube from the mouth (x0) downwind along +x. pole-local frame, y = mouth height */
function carp(b: Bucket, x0: number, y0: number, L: number, r: number, body: RGB, seed: number, kind = 0) {
  const NU = 20, NT = 16;
  const rad = (u: number) => {
    if (u < 0.22) return r * (0.95 + 0.3 * Math.sin((u / 0.22) * Math.PI * 0.5));
    if (u < 0.86) return r * (1.25 - 0.78 * ((u - 0.22) / 0.64) ** 1.2);
    return r * 0.47;
  };
  // the tail flattens into a vertical two-lobed fin
  const squash = (u: number) => (u < 0.86 ? 0 : Math.min(1, (u - 0.86) / 0.14));
  const P = (u: number, th: number) => {
    const k = kind ? 0 : squash(u);
    const rr = kind ? r * (1 - 0.15 * u) : rad(u);
    const lobe = 1 + k * (1.1 + 0.5 * Math.abs(Math.cos(th)));
    return [x0 + u * L, y0 + rr * Math.cos(th) * lobe, rr * Math.sin(th) * (1 - 0.88 * k)];
  };
  const p = blank();
  for (let i = 0; i < NU; i++) {
    const u0 = i / NU, u1 = (i + 1) / NU;
    for (let j = 0; j < NT; j++) {
      const t0 = (j / NT) * Math.PI * 2, t1 = ((j + 1) / NT) * Math.PI * 2;
      const q = [[u0, t0], [u1, t0], [u1, t1], [u0, t1]];
      for (const k of [0, 1, 2, 0, 2, 3]) {
        const [uu, th] = q[k];
        p.pos.push(...P(uu, th));
        p.nor.push(0, Math.cos(th), Math.sin(th));
        p.uv.push(uu, th / (Math.PI * 2));
      }
    }
  }
  const first = b.count;
  b.add(p, new Matrix4(), { col: body, v: [0, L, seed, kind] });
  for (let v = first; v < b.count; v++) b.vv[v * 4] = p.uv[(v - first) * 2];
}

/** a small pinwheel (yaguruma) spinning about local +x, built at the origin */
function pinwheel(b: Bucket) {
  const spokes = 8, R = 0.42;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    const q = segment([0, 0, 0], [0, Math.cos(a) * R, Math.sin(a) * R]);
    b.add(cylinder(0.012, 0.012, q.len, 4), q.m, { col: GOLD });
    const f = blank(), a2 = a + 0.35;
    poly(f, [[0, Math.cos(a) * R * 0.3, Math.sin(a) * R * 0.3], [0, Math.cos(a) * R, Math.sin(a) * R], [0.05, Math.cos(a2) * R * 0.95, Math.sin(a2) * R * 0.95]], 'y', [1, 0, 0]);
    b.add(f, new Matrix4(), { col: i % 2 ? WHITE : RED });
  }
  b.add(lathe([[0, -0.07], [0.07, 0], [0, 0.07]], 8), trs(0, 0, 0, 0, 0, Math.PI / 2), { col: GOLD });
}


// ---------------------------------------------------------------------------------------------
// river traffic: small wooden boats poled along lanes near each bank, pivoting at the ends of their
// beat. the path is a pure function of time, so the render pose (render time) and the kinematic
// collider (sim time) always agree.

interface Lane { side: -1 | 1; s0: number; s1: number; speed: number; inset: number; phase: number }

const TURN = 9; // seconds to pivot 180 degrees at the end of a beat
const _rf: RiverFrame = { s: 0, x: 0, z: 0, tx: 0, tz: -1, nx: 1, nz: 0, width: 20 };

/** pose on a lane at time t: world x, z and a three.js yaw (bow = -z) */
function lanePose(l: Lane, t: number, out: { x: number; z: number; yaw: number; moving: number }) {
  const D = (l.s1 - l.s0) / l.speed;
  const P = 2 * D + 2 * TURN;
  let k = (t / 1 + l.phase * P) % P;
  if (k < 0) k += P;
  let s: number, up: number, moving: number;
  if (k < D) {
    const u = k / D;
    s = l.s0 + (l.s1 - l.s0) * (u - Math.sin(2 * Math.PI * u) / (2 * Math.PI));
    up = 1; moving = 1 - Math.cos(2 * Math.PI * u);
  } else if (k < D + TURN) {
    s = l.s1; up = 1 - 2 * smooth01((k - D) / TURN); moving = 0;
  } else if (k < 2 * D + TURN) {
    const u = (k - D - TURN) / D;
    s = l.s1 - (l.s1 - l.s0) * (u - Math.sin(2 * Math.PI * u) / (2 * Math.PI));
    up = -1; moving = 1 - Math.cos(2 * Math.PI * u);
  } else {
    s = l.s0; up = -1 + 2 * smooth01((k - 2 * D - TURN) / TURN); moving = 0;
  }
  const f = riverFrame(s, _rf);
  const lat = l.side * (f.width / 2 - l.inset) + Math.sin(t * 0.07 + l.phase * 20) * 0.35;
  out.x = f.x + f.nx * lat;
  out.z = f.z + f.nz * lat;
  // heading swings from upstream (up = 1) to downstream (up = -1) through the bank-side normal
  const a = Math.acos(Math.max(-1, Math.min(1, up)));
  const bx = f.tx * Math.cos(a) + f.nx * l.side * Math.sin(a) * -1;
  const bz = f.tz * Math.cos(a) + f.nz * l.side * Math.sin(a) * -1;
  out.yaw = Math.atan2(-bx, -bz);
  out.moving = moving;
  return out;
}

function smooth01(x: number) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

/** cargo and dressing inside a boat, in the hull's local frame (bow toward -z) */
function boatLoad(mats: Materials, kind: number, clothMat: MeshStandardNodeMaterial, seed: number) {
  const g = new Group();
  const site = new Site({} as GameContext, 'npc-load');
  const cloth = new Bucket();
  const R = rng(seed);
  if (kind === 0) {
    // tea chests and rice sacks for the market
    for (let i = 0; i < 4; i++) site.add('cedar', chamferBox(0.5, 0.42, 0.5, 0.02), trs((i % 2 - 0.5) * 0.55, 0.05, -0.6 + Math.floor(i / 2) * 0.58, R() * 0.2), { col: [0.9 + R() * 0.2, 0.8, 0.6] });
    site.add('cedar', chamferBox(0.5, 0.42, 0.5, 0.02), trs(0.02, 0.48, -0.32, 0.3), { col: [0.85, 0.72, 0.52] });
    for (let i = 0; i < 3; i++) site.add('bamboo', lathe([[0.2, 0], [0.3, 0.1], [0.32, 0.4], [0.24, 0.6], [0.08, 0.66], [0, 0.66]], 10), trs(-0.25 + i * 0.25, 0.02, 0.55, R()), { col: [1.25, 1.05, 0.7] });
  } else if (kind === 1) {
    // a leisure boat under a vermilion parasol
    site.add('bamboo', cylinder(0.025, 0.025, 2.1, 6), trs(0, -0.1, 0.1), { col: [0.9, 0.8, 0.55] });
    const n = 20, r = 1.1;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
      const p = blank();
      const P = (rr: number, t: number, y: number) => [rr * Math.cos(t), y, 0.1 + rr * Math.sin(t)];
      poly(p, [P(0.05, a, 2.02), P(r, b, 1.72), P(r, a, 1.72)], 'y', [0, 1, 0]);
      poly(p, [P(0.05, a, 2.02), P(0.05, b, 2.02), P(r, b, 1.72)], 'y', [0, 1, 0]);
      cloth.add(p, new Matrix4(), { col: i % 5 === 0 ? PAPER : RED });
    }
    site.add('linen', chamferBox(1.0, 0.1, 1.6, 0.03), trs(0, 0.02, 0.2), { col: [4, 3.2, 2.4] });
  } else {
    // a fisherman's baskets and a coiled net
    for (let i = 0; i < 3; i++) site.add('bamboo', lathe([[0.18, 0], [0.26, 0.06], [0.28, 0.3], [0.22, 0.34]], 10), trs(-0.3 + i * 0.3, 0.02, 0.9 - (i % 2) * 0.2, R()), { col: [1.2, 1.0, 0.65] });
    site.add('rope', lathe([[0.1, 0], [0.42, 0.05], [0.38, 0.14], [0.12, 0.16]], 12), trs(0.1, 0.02, -0.5), { col: [0.6, 0.55, 0.42] });
  }
  for (const [k, b] of site.buckets) {
    const geo = b.build();
    if (!geo) continue;
    const mesh = new Mesh(geo, (mats as any)[k.split('.')[0]]);
    // cargo sits inside the hull: no shadow worth casting, too small for the mirror
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.layers.set(LAYERS.NO_REFLECT);
    g.add(mesh);
  }
  const cg = cloth.build();
  if (cg) {
    const m = new Mesh(cg, clothMat);
    m.castShadow = true;
    g.add(m);
  }
  return g;
}

export interface NpcBoat { boat: MooredBoat; lane: Lane; figure: Group | null; pole: Group | null; lamp?: Mesh }

/**
 * a chochin on a short bamboo pole at the bow, in the hull's local frame. it is lit only from dusk
 * (the mesh is hidden while lampLevel is ~0, so the authored day neither sees nor pays for it)
 */
function boatLamp(mats: Materials, h: HullSpec, seed: number) {
  const b = new Bucket();
  const R = rng(seed);
  const z = -h.L / 2 + 0.8, top = 1.85;
  const dark: RGB = [0.05, 0.035, 0.025];
  // lantern paper material: aVar = [flicker phase, night lamp, 0, day glow]; the pole never glows
  b.add(cylinder(0.022, 0.016, top, 6), trs(0, 0.05, z), { col: [0.3, 0.24, 0.12] });
  const arm = segment([0, top, z + 0.04], [0, top - 0.04, z - 0.42]);
  b.add(cylinder(0.012, 0.012, arm.len, 5), arm.m, { col: [0.3, 0.24, 0.12] });
  const s = 0.62, hy = top - 0.06, ly = hy - 0.12;
  const prof = [[0.09, -0.62], [0.16, -0.58], [0.23, -0.45], [0.25, -0.29], [0.225, -0.1], [0.15, 0.0], [0.085, 0.02]].map(([r, y]) => [r * s, y * s]);
  const lz = z - 0.4;
  b.add(cylinder(0.006, 0.006, hy - ly, 4), trs(0, ly, lz), { col: dark });
  b.add(lathe(prof, 10), trs(0, ly, lz), { col: R() < 0.5 ? RED : PAPER, v: [R(), 1, 0, 0] });
  for (const cy of [-0.64 * s, 0.0]) b.add(cylinder(0.095 * s, 0.095 * s, 0.05 * s, 8), trs(0, ly + cy, lz), { col: dark });
  const mesh = new Mesh(b.build()!, mats.paper);
  mesh.name = 'life:npc-lamp';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.visible = false;
  return mesh;
}

function riverTraffic(ctx: GameContext, mats: Materials, clothMat: MeshStandardNodeMaterial) {
  const lanes: Lane[] = [
    { side: 1, s0: 70, s1: 284, speed: 0.95, inset: 3.6, phase: 0.1 },
    { side: -1, s0: 206, s1: 284, speed: 0.8, inset: 3.7, phase: 0.55 },
    { side: -1, s0: 62, s1: 172, speed: 0.85, inset: 3.6, phase: 0.3 },
    { side: 1, s0: 314, s1: 424, speed: 0.9, inset: 3.8, phase: 0.8 },
    { side: 1, s0: 468, s1: 650, speed: 0.9, inset: 3.7, phase: 0.2 },
    { side: -1, s0: 330, s1: 560, speed: 0.85, inset: 3.6, phase: 0.65 },
  ];
  const specs: HullSpec[] = [
    { L: 6.2, B: 1.3, draft: 0.2, sheer: [0.8, 0.45, 0.5], transom: 0.7, topside: [1.05, 1, 0.95], inside: [0.95, 0.9, 0.85], gear: true },
    { L: 5.6, B: 1.3, draft: 0.18, sheer: [0.76, 0.43, 0.48], transom: 0.68, topside: [0.9, 0.85, 0.8], inside: [1, 0.95, 0.9] },
    { L: 5.8, B: 1.25, draft: 0.19, sheer: [0.78, 0.44, 0.5], transom: 0.7, topside: [1.1, 1.02, 0.95], inside: [0.9, 0.88, 0.85], gear: true },
    { L: 6.0, B: 1.3, draft: 0.2, sheer: [0.8, 0.45, 0.5], transom: 0.7, topside: [0.95, 0.9, 0.85], inside: [1, 0.96, 0.9] },
    { L: 5.9, B: 1.28, draft: 0.19, sheer: [0.78, 0.44, 0.5], transom: 0.7, topside: [1.0, 0.94, 0.88], inside: [0.95, 0.92, 0.86], gear: true },
    { L: 5.7, B: 1.3, draft: 0.19, sheer: [0.77, 0.44, 0.49], transom: 0.69, topside: [0.92, 0.88, 0.84], inside: [1, 0.95, 0.9] },
  ];
  const loads = [0, 1, 2, 1, 0, 1];
  const pose = { x: 0, z: 0, yaw: 0, moving: 0 };
  const boats: NpcBoat[] = lanes.map((lane, i) => {
    lanePose(lane, 0, pose);
    const build = buildBoat(mats, specs[i], 70 + i);
    const load = boatLoad(mats, loads[i], clothMat, 300 + i);
    load.position.y = -specs[i].draft + 0.12;
    build.group.add(load);
    const lamp = boatLamp(mats, specs[i], 500 + i);
    lamp.position.y = -specs[i].draft + 0.12;
    build.group.add(lamp);
    const boat = new MooredBoat(ctx, build, pose.x, pose.z, pose.yaw);
    boat.build.group.name = 'life:npc-boat';
    return { boat, lane, figure: null, pole: null, lamp };
  });
  return { boats, pose };
}


// ---------------------------------------------------------------------------------------------
// creatures: one draw per species. per-instance data (position, yaw, phase, scale, variant) lives in
// instanced attributes updated on the cpu; deformation (paddling, tails, wings) happens in local space
// before the instance transform, and the shadow pass shares the same position node.

const rotY = (v: N, c: N, s: N) => vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)));

export interface Crowd {
  mesh: Mesh;
  a: Float32Array;
  b: Float32Array;
  attrA: InstancedBufferAttribute;
  attrB: InstancedBufferAttribute;
  max: number;
  n: number;
}

/** deform(p, phase, variant) -> local position; colour(variant, phase) -> albedo */
export function crowd(base: BufferGeometry, max: number, deform: (p: N, ph: N, v: N, w: N) => N, colour: ((v: N, ph: N) => N) | null, rough = 0.75): Crowd {
  const g = new InstancedBufferGeometry();
  g.index = base.index;
  for (const k of Object.keys(base.attributes)) g.setAttribute(k, base.getAttribute(k));
  const a = new Float32Array(max * 4), b = new Float32Array(max * 4);
  const attrA = new InstancedBufferAttribute(a, 4), attrB = new InstancedBufferAttribute(b, 4);
  g.setAttribute('aInstA', attrA);
  g.setAttribute('aInstB', attrB);
  g.instanceCount = 0;
  g.boundingSphere = new Sphere(new Vector3(), 1e6);
  const m = new MeshStandardNodeMaterial({ side: DoubleSide });
  const A = attribute('aInstA', 'vec4') as N, B = attribute('aInstB', 'vec4') as N;
  m.positionNode = Fn(() => {
    const c = cos(A.w), sn = sin(A.w);
    const p = deform(positionGeometry as N, B.x, B.z, B.w).mul(B.y);
    normalLocal.assign(rotY(normalLocal, c, sn));
    return rotY(p, c, sn).add(A.xyz);
  })();
  m.colorNode = colour ? colour(B.z, B.x) : attribute('aCol', 'vec3');
  m.roughnessNode = float(rough);
  m.metalnessNode = float(0);
  const mesh = new Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  return { mesh, a, b, attrA, attrB, max, n: 0 };
}

export function crowdSet(c: Crowd, i: number, x: number, y: number, z: number, yaw: number, phase: number, scale: number, variant: number, extra = 0) {
  c.a[i * 4] = x; c.a[i * 4 + 1] = y; c.a[i * 4 + 2] = z; c.a[i * 4 + 3] = yaw;
  c.b[i * 4] = phase; c.b[i * 4 + 1] = scale; c.b[i * 4 + 2] = variant; c.b[i * 4 + 3] = extra;
}

export function crowdCommit(c: Crowd, n: number) {
  c.n = n;
  (c.mesh.geometry as InstancedBufferGeometry).instanceCount = n;
  c.attrA.needsUpdate = true;
  c.attrB.needsUpdate = true;
}

/** lathe around the local z axis: profile [radius, t] ascending from tail (t < 0) to nose (t > 0); nose ends up at -z */
export function body(profile: number[][], seg: number, sx = 1, sy = 1): Part {
  const p = lathe(profile, seg);
  // lathe runs along +y; rotating -90 deg about x sends +y to -z
  const m = new Matrix4().makeScale(sx, sy, 1).multiply(new Matrix4().makeRotationX(-Math.PI / 2));
  const nm = new Matrix4().copy(m).invert().transpose();
  const out = blank();
  const v = new Vector3(), n = new Vector3();
  for (let i = 0; i < p.pos.length; i += 3) {
    v.set(p.pos[i], p.pos[i + 1], p.pos[i + 2]).applyMatrix4(m);
    n.set(p.nor[i], p.nor[i + 1], p.nor[i + 2]).transformDirection(nm);
    out.pos.push(v.x, v.y, v.z);
    out.nor.push(n.x, n.y, n.z);
  }
  out.uv = p.uv.slice();
  return out;
}

function duckGeometry(male: boolean) {
  const b = new Bucket();
  const bodyCol: RGB = male ? [0.3, 0.28, 0.25] : [0.26, 0.17, 0.1];
  const breast: RGB = male ? [0.2, 0.09, 0.04] : [0.24, 0.15, 0.08];
  const head: RGB = male ? [0.02, 0.16, 0.07] : [0.22, 0.14, 0.08];
  b.add(body([[0, -0.2], [0.05, -0.19], [0.09, -0.12], [0.105, 0.0], [0.1, 0.1], [0.07, 0.17], [0, 0.2]], 12, 1, 0.78), trs(0, 0.04, 0), { col: bodyCol });
  b.add(body([[0, 0.02], [0.07, 0.06], [0.08, 0.13], [0.04, 0.2], [0, 0.21]], 10, 0.95, 0.9), trs(0, 0.035, 0), { col: breast });
  const neck = segment([0, 0.08, -0.13], [0, 0.18, -0.16]);
  b.add(cylinder(0.035, 0.03, neck.len, 8), neck.m, { col: head });
  b.add(lathe([[0, -0.052], [0.04, -0.035], [0.052, 0], [0.04, 0.035], [0, 0.05]], 10), trs(0, 0.2, -0.17), { col: head });
  if (male) b.add(cylinder(0.037, 0.037, 0.012, 10), neck.m.clone().multiply(trs(0, 0.02, 0)), { col: [0.8, 0.8, 0.76] });
  b.add(chamferBox(0.036, 0.016, 0.07, 0.005), trs(0, 0.19, -0.235, 0, 0.15), { col: male ? [0.6, 0.5, 0.08] : [0.45, 0.25, 0.08] });
  b.add(chamferBox(0.08, 0.02, 0.08, 0.005), trs(0, 0.09, 0.19, 0, -0.5), { col: male ? [0.03, 0.03, 0.03] : [0.2, 0.13, 0.07] });
  return b.build()!;
}

function koiGeometry() {
  const b = new Bucket();
  b.add(body([[0, -0.3], [0.025, -0.27], [0.03, -0.2], [0.055, -0.06], [0.07, 0.08], [0.058, 0.2], [0.035, 0.27], [0, 0.3]], 12, 0.72, 1), new Matrix4(), { col: [1, 1, 1] });
  const fin = blank();
  poly(fin, [[0, 0, 0.27], [0, 0.1, 0.44], [0, 0.02, 0.4]], 'z', [1, 0, 0]);
  poly(fin, [[0, 0, 0.27], [0, -0.02, 0.4], [0, -0.1, 0.44]], 'z', [1, 0, 0]);
  poly(fin, [[0, 0.06, -0.05], [0, 0.1, 0.08], [0, 0.05, 0.14]], 'z', [1, 0, 0]);
  for (const sx of [-1, 1]) poly(fin, [[sx * 0.04, -0.03, -0.14], [sx * 0.12, -0.05, -0.08], [sx * 0.05, -0.04, -0.04]], 'z', [0, 1, 0]);
  b.add(fin, new Matrix4(), { col: [1, 1, 1] });
  return b.build()!;
}

function egretGeometry() {
  const b = new Bucket();
  const white: RGB = [0.8, 0.8, 0.77];
  b.add(body([[0, -0.26], [0.05, -0.22], [0.09, -0.08], [0.1, 0.04], [0.07, 0.14], [0, 0.18]], 12, 0.85, 1), trs(0, 0.62, 0, 0, 0.35), { col: white });
  const neckPts = [[0, 0.7, -0.14], [0, 0.82, -0.1], [0, 0.93, -0.16], [0, 1.02, -0.2]];
  for (let i = 0; i < neckPts.length - 1; i++) {
    const q = segment(neckPts[i], neckPts[i + 1]);
    b.add(cylinder(0.028, 0.022, q.len, 8), q.m, { col: white });
  }
  b.add(lathe([[0, -0.035], [0.03, -0.02], [0.034, 0.01], [0.02, 0.035], [0, 0.04]], 10), trs(0, 1.03, -0.21), { col: white });
  const bill = segment([0, 1.03, -0.24], [0, 1.0, -0.37]);
  b.add(cylinder(0.012, 0.003, bill.len, 6), bill.m, { col: [0.6, 0.48, 0.08] });
  for (const sx of [-0.035, 0.035]) {
    const leg = segment([sx, 0.58, 0.02], [sx, 0, 0.01]);
    b.add(cylinder(0.009, 0.008, leg.len, 5), leg.m, { col: [0.03, 0.03, 0.03] });
  }
  return b.build()!;
}

function butterflyGeometry() {
  const b = new Bucket();
  const w = blank();
  for (const sx of [-1, 1]) {
    poly(w, [[0, 0, -0.01], [sx * 0.06, 0, -0.045], [sx * 0.065, 0, -0.005], [sx * 0.02, 0, 0.01]], 'z', [0, 1, 0]);
    poly(w, [[0, 0, 0.0], [sx * 0.045, 0, 0.012], [sx * 0.035, 0, 0.045], [0, 0, 0.03]], 'z', [0, 1, 0]);
  }
  b.add(w, new Matrix4(), { col: [1, 1, 1] });
  b.add(cylinder(0.004, 0.003, 0.04, 4), trs(0, 0, 0.02, 0, -Math.PI / 2), { col: [0.05, 0.04, 0.03] });
  return b.build()!;
}

function birdGeometry() {
  const b = new Bucket();
  const w = blank();
  poly(w, [[0, 0, -0.12], [-0.46, 0.02, 0.05], [0, 0, 0.16]], 'z', [0, 1, 0]);
  poly(w, [[0, 0, -0.12], [0, 0, 0.16], [0.46, 0.02, 0.05]], 'z', [0, 1, 0]);
  b.add(w, new Matrix4(), { col: [0.1, 0.1, 0.11] });
  b.add(body([[0, -0.2], [0.03, -0.1], [0.04, 0.05], [0.02, 0.18], [0, 0.22]], 6), new Matrix4(), { col: [0.12, 0.12, 0.13] });
  return b.build()!;
}

function smokeMaterial() {
  const m = new MeshStandardNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
  const puff = attribute('aPuff', 'vec2') as N;
  const d = length(uv().sub(0.5));
  const n = mx_noise_float(vec3(uv().mul(3.2), puff.y.mul(7))).mul(0.5).add(0.5);
  m.colorNode = vec3(0.46, 0.45, 0.43);
  m.opacityNode = smoothstep(0.5, 0.08, d).mul(n.mul(0.7).add(0.3)).mul(puff.x);
  m.roughnessNode = float(1);
  m.metalnessNode = float(0);
  return m;
}

interface Paddler { crowd: Crowd; i: number; ax: number; az: number; tx: number; tz: number; nx: number; nz: number; range: number; drift: number; phase: number; speed: number }

function wildlife(ctx: GameContext, site: Site) {
  const root = new Group();
  root.name = 'life:wildlife';
  const t0 = new Vector3();
  const add = (c: Crowd, reflect = false, cast = false) => {
    c.mesh.castShadow = cast;
    c.mesh.receiveShadow = true;
    if (!reflect) c.mesh.layers.set(LAYERS.NO_REFLECT);
    root.add(c.mesh);
    return c;
  };

  // ducks paddle slow loops near the banks, heads bobbing as they go
  const duckDeform = (p: N, ph: N) => {
    const headK = smoothstep(0.08, 0.16, p.y);
    return p.add(vec3(0, 0, sin(uTime.mul(2.2).add(ph.mul(6.28))).mul(0.018).mul(headK)));
  };
  const ducksM = add(crowd(duckGeometry(true), 16, duckDeform, null, 0.8));
  const ducksF = add(crowd(duckGeometry(false), 20, duckDeform, null, 0.85));
  const paddlers: Paddler[] = [];
  const duckSpots: [number, -1 | 1][] = [[96, 1], [134, -1], [236, 1], [262, -1], [352, -1], [404, -1], [498, 1], [540, -1], [622, 1]];
  duckSpots.forEach(([s, side], gi) => {
    for (let k = 0; k < 3; k++) {
      const p = bankPoint(s + k * 1.1, side, -1.6 - (k % 2) * 0.5);
      const f = p.frame;
      const crowdOf = k === 0 ? ducksM : ducksF;
      paddlers.push({ crowd: crowdOf, i: paddlers.filter((q) => q.crowd === crowdOf).length, ax: p.x, az: p.z, tx: f.tx, tz: f.tz, nx: f.nx * side, nz: f.nz * side, range: 5 + gi % 3, drift: 0.5, phase: gi * 1.7 + k * 0.45, speed: 0.045 + (gi % 2) * 0.01 });
    }
  });

  // koi circle in the clear shallows by the village landing and the water torii
  const ponds = (ctx.services.town as TownPeople | undefined)?.ponds ?? [];
  const koi = add(crowd(koiGeometry(), 16 + ponds.length * 7, (p: N, ph: N) => {
    const tail = smoothstep(-0.1, 0.44, p.z);
    return p.add(vec3(sin(uTime.mul(4.2).add(ph.mul(6.28)).sub(p.z.mul(9))).mul(0.045).mul(tail), 0, 0));
  }, (v: N, ph: N) => {
    const pn = mx_noise_float(positionGeometry.mul(9).add(vec3(ph.mul(13), 0, 0))) as N;
    const patch = smoothstep(0.0, 0.12, pn);
    const white = vec3(0.78, 0.76, 0.7), red = vec3(0.6, 0.1, 0.02), gold = vec3(0.7, 0.4, 0.05);
    const kohaku = mix(white, red, patch);
    return mix(kohaku, mix(gold, red.mul(1.1), patch.mul(0.4)), step(0.5, v));
  }, 0.45));
  const koiSpots: { x: number; z: number; tx: number; tz: number; nx: number; nz: number; y: number }[] = [];
  for (const [s, side] of [[212, -1], [431, 1]] as [number, -1 | 1][]) {
    const p = bankPoint(s, side, -2.4);
    const bed = ctx.world.heightAt(p.x, p.z);
    koiSpots.push({ x: p.x, z: p.z, tx: p.frame.tx, tz: p.frame.tz, nx: p.frame.nx * side, nz: p.frame.nz * side, y: Math.max(bed + 0.18, -0.42) });
  }
  // garden ponds in town: a few koi just under the surface on smaller loops
  const pondKoi = ponds.map((q) => {
    const l = Math.hypot(q.ax, q.az) || 1;
    return { x: q.x, z: q.z, tx: q.ax / l, tz: q.az / l, nx: -q.az / l, nz: q.ax / l, y: q.y - 0.07, rx: q.rx, rz: q.rz };
  });

  // egrets stand still in the shallows and on the embankment, turning their heads now and then
  const egretGeo = egretGeometry();
  const egrets: Mesh[] = [];
  const egretMat = plainMaterial(0.8);
  for (const [s, side, off] of [[262, -1, 0.7], [342, 1, -1.1], [118, 1, -0.9], [520, -1, 0.7], [610, 1, -0.9]] as [number, -1 | 1, number][]) {
    const p = bankPoint(s, side, off);
    const gy = ctx.world.heightAt(p.x, p.z);
    const m = new Mesh(egretGeo, egretMat);
    m.position.set(p.x, Math.max(gy, -0.32), p.z);
    m.rotation.y = Math.atan2(p.frame.tx, p.frame.tz) + (s % 3) * 0.8;
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.baseYaw = m.rotation.y;
    root.add(m);
    egrets.push(m);
  }

  // butterflies over the flower beds along the banks
  const flies = add(crowd(butterflyGeometry(), 40, (p: N, ph: N) => {
    const a = sin(uTime.mul(17).add(ph.mul(40))).mul(0.5).add(0.5).mul(1.15);
    return vec3(p.x.mul(cos(a)), p.y.add(abs(p.x).mul(sin(a))), p.z);
  }, (v: N) => {
    const white = vec3(0.82, 0.82, 0.76), yellow = vec3(0.78, 0.66, 0.1), orange = vec3(0.72, 0.3, 0.04);
    const base = mix(mix(white, yellow, step(0.34, v)), orange, step(0.67, v));
    return mix(base, vec3(0.04, 0.03, 0.03), smoothstep(0.052, 0.062, abs(positionGeometry.x)));
  }, 0.8));
  const flySpots: { x: number; z: number; tx: number; tz: number; nx: number; nz: number }[] = [];
  for (const [s, side] of [[88, 1], [140, -1], [232, 1], [266, -1], [346, 1], [400, -1], [492, 1], [584, -1]] as [number, -1 | 1][]) {
    const p = bankPoint(s, side, 4.5);
    flySpots.push({ x: p.x, z: p.z, tx: p.frame.tx, tz: p.frame.tz, nx: p.frame.nx * side, nz: p.frame.nz * side });
  }

  // a small flock of birds crosses the valley now and then
  const flock = add(crowd(birdGeometry(), 7, (p: N, ph: N) => {
    const a = sin(uTime.mul(7).add(ph.mul(6.28))).mul(0.45);
    return vec3(p.x.mul(cos(a)), p.y.add(abs(p.x).mul(sin(a))), p.z);
  }, null, 0.9));
  const fa = bankPoint(150, -1, 160), fb = bankPoint(275, 1, 160);

  // a faint wisp from two kitchen vents and the charcoal stall
  const sources: Vector3[] = [];
  for (const id of ['v-207r', 't1-402']) {
    const sd = SITES.find((q) => q.id === id);
    if (!sd) continue;
    const ridge = sd.kind === 'machiya-low' ? 8.0 : 8.6;
    sources.push(new Vector3(sd.x, sd.y + ridge + 0.2, sd.z));
  }
  {
    const p = bankPoint(157, -1, 2.3);
    const g = Math.max(0.6, ctx.world.heightAt(p.x, p.z));
    site.add('dark', lathe([[0.26, 0], [0.3, 0.1], [0.31, 0.62], [0.27, 0.7]], 12), trs(p.x, g, p.z), { col: [0.05, 0.04, 0.035] });
    for (let k = -3; k <= 3; k++) site.add('bronze', chamferBox(0.6, 0.012, 0.012), trs(p.x, g + 0.7, p.z + k * 0.07), { col: [0.5, 0.45, 0.4] });
    sources.push(new Vector3(p.x, g + 0.75, p.z));
  }
  const PUFFS = 8;
  const smokeGeo = new PlaneGeometry(1, 1);
  const puffAttr = new InstancedBufferAttribute(new Float32Array(sources.length * PUFFS * 2), 2);
  smokeGeo.setAttribute('aPuff', puffAttr);
  const smoke = new InstancedMesh(smokeGeo, smokeMaterial(), sources.length * PUFFS);
  smoke.name = 'life:smoke';
  smoke.frustumCulled = false;
  smoke.castShadow = false;
  smoke.layers.set(LAYERS.NO_REFLECT);
  smoke.renderOrder = 5;
  root.add(smoke);

  const counts = { ducks: paddlers.length, koi: 12, egrets: egrets.length, butterflies: flySpots.length * 4, flock: 7, smokeSources: sources.length };
  const center = new Vector3();
  {
    const f0 = riverFrame(60), f1 = riverFrame(660);
    center.set((f0.x + f1.x) / 2, 0, (f0.z + f1.z) / 2);
  }
  const reach = new Vector3(riverFrame(60).x, 0, riverFrame(60).z).distanceTo(center) + 60;
  const m4 = new Matrix4(), q = new Quaternion(), sc = new Vector3(), pos = new Vector3();

  function update(c: GameContext, cam: Vector3) {
    const t = c.time.render;
    // nothing here matters beyond ~350 m of the reach
    const near = cam.distanceTo(center) - reach < 350;
    root.visible = near;
    if (!near) return;
    // ducks
    const nD = { m: 0, f: 0 };
    for (const d of paddlers) {
      const u = Math.sin(t * d.speed + d.phase) * d.range;
      const v = Math.sin(t * d.speed * 2.3 + d.phase * 1.7) * d.drift;
      const du = Math.cos(t * d.speed + d.phase) * d.range * d.speed;
      const dv = Math.cos(t * d.speed * 2.3 + d.phase * 1.7) * d.drift * d.speed * 2.3;
      const x = d.ax + d.tx * u - d.nx * v, z = d.az + d.tz * u - d.nz * v;
      const vx = d.tx * du - d.nx * dv, vz = d.tz * du - d.nz * dv;
      const yaw = Math.atan2(-vx, -vz);
      const y = waterHeight(x, z, t) - 0.03 + Math.sin(t * 1.7 + d.phase) * 0.008;
      crowdSet(d.crowd, d.i, x, y, z, yaw, d.phase, 1.05, 0);
      if (d.crowd === ducksM) nD.m++;
      else nD.f++;
    }
    crowdCommit(ducksM, nD.m);
    crowdCommit(ducksF, nD.f);
    // koi: six per spot on slow overlapping ellipses
    let ki = 0;
    koiSpots.forEach((k, si) => {
      for (let j = 0; j < 6; j++) {
        const ph = si * 3.1 + j * 1.05, w = 0.11 + (j % 3) * 0.02;
        const a = t * w + ph;
        const ru = 2.6 + (j % 2) * 0.8, rv = 1.0 + (j % 3) * 0.25;
        const u = Math.cos(a) * ru, v = Math.sin(a) * rv;
        const x = k.x + k.tx * u - k.nx * v, z = k.z + k.tz * u - k.nz * v;
        const vx = -k.tx * Math.sin(a) * ru - k.nx * Math.cos(a) * rv, vz = -k.tz * Math.sin(a) * ru - k.nz * Math.cos(a) * rv;
        crowdSet(koi, ki++, x, k.y + Math.sin(t * 0.5 + ph) * 0.05, z, Math.atan2(-vx, -vz), ph, 0.9 + (j % 3) * 0.15, j % 4 === 3 ? 1 : 0);
      }
    });
    pondKoi.forEach((k, si) => {
      for (let j = 0; j < 7; j++) {
        const ph = si * 2.3 + j * 0.9, w = 0.16 + (j % 3) * 0.03;
        const a = t * w + ph;
        const ru = k.rx * (0.55 + (j % 2) * 0.35), rv = k.rz * (0.5 + (j % 3) * 0.2);
        const u = Math.cos(a) * ru, v = Math.sin(a) * rv;
        const x = k.x + k.tx * u + k.nx * v, z = k.z + k.tz * u + k.nz * v;
        const vx = -k.tx * Math.sin(a) * ru + k.nx * Math.cos(a) * rv, vz = -k.tz * Math.sin(a) * ru + k.nz * Math.cos(a) * rv;
        crowdSet(koi, ki++, x, k.y, z, Math.atan2(-vx, -vz), ph, 0.75 + (j % 3) * 0.12, j % 3 === 2 ? 1 : 0);
      }
    });
    crowdCommit(koi, ki);
    // egrets
    for (const [i, e] of egrets.entries()) {
      const k = Math.sin(t * 0.21 + i * 2.3);
      e.rotation.y = e.userData.baseYaw + (k > 0.6 ? 0.6 : k < -0.6 ? -0.5 : 0) * smooth01(Math.abs(k) * 2 - 1.2);
    }
    // butterflies
    let bi = 0;
    for (const [si, f] of flySpots.entries()) {
      for (let j = 0; j < 4; j++) {
        const ph = si * 2.7 + j * 1.3;
        const u = Math.sin(t * 0.37 + ph) * 3.2 + Math.sin(t * 1.1 + ph * 2) * 0.6;
        const v = Math.cos(t * 0.29 + ph * 1.7) * 2.2;
        const x = f.x + f.tx * u + f.nx * v, z = f.z + f.tz * u + f.nz * v;
        const du = Math.cos(t * 0.37 + ph) * 3.2 * 0.37, dv = -Math.sin(t * 0.29 + ph * 1.7) * 2.2 * 0.29;
        const vx = f.tx * du + f.nx * dv, vz = f.tz * du + f.nz * dv;
        const y = Math.max(0.7, c.world.heightAt(x, z)) + 0.7 + Math.sin(t * 1.9 + ph) * 0.35;
        crowdSet(flies, bi++, x, y, z, Math.atan2(-vx, -vz), ph, 1.3, ((si * 4 + j) * 0.37) % 1);
      }
    }
    crowdCommit(flies, bi);
    // the flock: a 26 s crossing every 55 s, alternating direction
    {
      const P = 55, D = 26;
      const cyc = Math.floor(t / P), k = (t % P) / D;
      if (k <= 1) {
        const dir = cyc % 2 ? -1 : 1;
        const from = dir > 0 ? fa : fb, to = dir > 0 ? fb : fa;
        const dx = to.x - from.x, dz = to.z - from.z, len = Math.hypot(dx, dz) || 1;
        const fx = dx / len, fz = dz / len;
        const yaw = Math.atan2(-fx, -fz);
        for (let i = 0; i < 7; i++) {
          const rank = Math.ceil(i / 2), sgn = i % 2 ? -1 : 1;
          const back = rank * 1.6, across = rank * 1.1 * sgn;
          const x = from.x + dx * k - fx * back - fz * across, z = from.z + dz * k - fz * back + fx * across;
          const y = 30 + Math.sin(k * Math.PI) * 6 + Math.sin(t * 0.8 + i) * 0.3;
          crowdSet(flock, i, x, y, z, yaw, i * 0.13, 1.2, 0);
        }
        crowdCommit(flock, 7);
      } else crowdCommit(flock, 0);
    }
    // smoke puffs, turned to face the camera
    q.copy(c.camera.quaternion);
    const w = uWindDir.value as Vector2;
    const life = 9;
    let pi = 0;
    for (const [si, src] of sources.entries()) {
      for (let j = 0; j < PUFFS; j++) {
        const age = ((t / life) + j / PUFFS + si * 0.31) % 1;
        const rise = age * 4.2, drift = Math.pow(age, 1.4) * 3.5;
        const wob = Math.sin(t * 0.6 + j * 2.1 + si) * 0.25 * age;
        pos.set(src.x + w.x * drift + wob, src.y + rise, src.z + w.y * drift - wob * 0.5);
        const size = 0.3 + age * 1.3;
        sc.set(size, size, size);
        m4.compose(pos, q, sc);
        smoke.setMatrixAt(pi, m4);
        const alpha = smooth01(age / 0.15) * Math.pow(1 - age, 2) * 0.11;
        puffAttr.setXY(pi, alpha, (si * PUFFS + j) * 0.173);
        pi++;
      }
    }
    smoke.instanceMatrix.needsUpdate = true;
    puffAttr.needsUpdate = true;
  }
  void t0;
  return { root, update, counts };
}


// ---------------------------------------------------------------------------------------------
// villagers: simple kimono figures read from 10-60 m by silhouette and colour (hats, hair, obi,
// sleeves), never by faces. parts are tagged in aCol and coloured per instance in the shader.

const TAG = {
  kimono: [1, 0, 0] as RGB, obi: [0, 1, 0] as RGB, skin: [0, 0, 1] as RGB,
  straw: [1, 1, 0] as RGB, hair: [0, 0, 0] as RGB, wood: [0, 1, 1] as RGB,
};

function flat(p: Part, sz: number) {
  for (let i = 2; i < p.pos.length; i += 3) p.pos[i] *= sz;
  return p;
}

type Top = 'hat' | 'hair' | 'parasol';

function headTop(b: Bucket, y: number, z: number, top: Top) {
  b.add(flat(lathe([[0, -0.095], [0.06, -0.08], [0.09, -0.03], [0.092, 0.02], [0.07, 0.07], [0, 0.098]], 10), 0.92), trs(0, y, z), { col: TAG.skin });
  if (top === 'hat') {
    b.add(lathe([[0.33, 0], [0.31, 0.025], [0.05, 0.17], [0, 0.18]], 16), trs(0, y + 0.02, z), { col: TAG.straw });
  } else {
    b.add(flat(lathe([[0.075, -0.05], [0.098, 0], [0.098, 0.04], [0.07, 0.085], [0, 0.108]], 10), 0.95), trs(0, y + 0.005, z + 0.008), { col: TAG.hair });
    b.add(lathe([[0, -0.055], [0.05, -0.03], [0.058, 0.01], [0.04, 0.045], [0, 0.058]], 8), trs(0, y + 0.08, z + 0.075), { col: TAG.hair });
  }
}

/** standing figure (1.55-1.65 m), facing -z, feet at the origin */
function standingFigure(top: Top) {
  const b = new Bucket();
  for (const sx of [-0.06, 0.06]) b.add(chamferBox(0.08, 0.05, 0.2, 0.01), trs(sx, 0.025, -0.02), { col: TAG.wood });
  b.add(flat(lathe([[0.13, 0.05], [0.17, 0.09], [0.18, 0.5], [0.17, 0.85], [0.165, 1.0], [0.19, 1.2], [0.215, 1.3], [0.2, 1.36], [0.12, 1.42], [0.05, 1.45]], 14), 0.72), new Matrix4(), { col: TAG.kimono });
  b.add(flat(cylinder(0.178, 0.178, 0.16, 14), 0.74), trs(0, 0.86, 0), { col: TAG.obi });
  b.add(chamferBox(0.2, 0.12, 0.08, 0.02), trs(0, 0.95, 0.14), { col: TAG.obi });
  const raised = top === 'parasol';
  for (const sx of [-1, 1]) {
    const up = raised && sx > 0;
    b.add(chamferBox(0.12, up ? 0.3 : 0.4, 0.28, 0.03), trs(sx * 0.225, up ? 1.18 : 1.1, 0.0, 0, up ? 0.5 : 0, sx * 0.07), { col: TAG.kimono });
  }
  b.add(lathe([[0, -0.03], [0.035, 0], [0, 0.03]], 6), trs(-0.1, 0.93, -0.13), { col: TAG.skin });
  b.add(lathe([[0, -0.03], [0.035, 0], [0, 0.03]], 6), trs(raised ? 0.13 : 0.1, raised ? 1.24 : 0.93, raised ? -0.14 : -0.13), { col: TAG.skin });
  b.add(cylinder(0.045, 0.045, 0.1, 8), trs(0, 1.42, 0.01), { col: TAG.skin });
  headTop(b, 1.585, 0.01, top === 'hat' ? 'hat' : 'hair');
  if (raised) {
    b.add(cylinder(0.012, 0.012, 0.95, 5), trs(0.13, 1.2, -0.14), { col: TAG.wood });
    b.add(lathe([[0.58, 0], [0.5, 0.06], [0.2, 0.14], [0.02, 0.17], [0, 0.18]], 20), trs(0.13, 1.93, -0.14), { col: TAG.obi });
  }
  return b.build()!;
}

/** seated on a ledge: hips at the origin, knees forward (-z), shins hanging down */
function seatedFigure(top: Top) {
  const b = new Bucket();
  b.add(flat(lathe([[0.17, 0], [0.18, 0.2], [0.165, 0.35], [0.19, 0.55], [0.215, 0.64], [0.2, 0.7], [0.12, 0.76], [0.05, 0.79]], 14), 0.72), new Matrix4(), { col: TAG.kimono });
  b.add(flat(cylinder(0.172, 0.172, 0.15, 14), 0.74), trs(0, 0.2, 0), { col: TAG.obi });
  b.add(chamferBox(0.34, 0.16, 0.44, 0.04), trs(0, 0.06, -0.2), { col: TAG.kimono });
  b.add(chamferBox(0.3, 0.44, 0.15, 0.04), trs(0, -0.16, -0.38), { col: TAG.kimono });
  for (const sx of [-0.06, 0.06]) b.add(chamferBox(0.08, 0.05, 0.2, 0.01), trs(sx, -0.4, -0.42), { col: TAG.wood });
  for (const sx of [-1, 1]) b.add(chamferBox(0.12, 0.34, 0.26, 0.03), trs(sx * 0.225, 0.45, -0.04, 0, 0.35, sx * 0.07), { col: TAG.kimono });
  for (const sx of [-0.09, 0.09]) b.add(lathe([[0, -0.03], [0.035, 0], [0, 0.03]], 6), trs(sx, 0.22, -0.28), { col: TAG.skin });
  b.add(cylinder(0.045, 0.045, 0.1, 8), trs(0, 0.77, 0.01), { col: TAG.skin });
  headTop(b, 0.935, 0.01, top === 'hat' ? 'hat' : 'hair');
  return b.build()!;
}

function figureColour(v: N): N {
  const pick = (x: N, cols: number[][]) => {
    let c: N = vec3(...(cols[0] as [number, number, number]));
    for (let i = 1; i < cols.length; i++) c = mix(c, vec3(...(cols[i] as [number, number, number])), step(i / cols.length, x));
    return c;
  };
  const kim = pick(v, [[0.035, 0.05, 0.12], [0.13, 0.16, 0.12], [0.3, 0.2, 0.08], [0.3, 0.11, 0.11], [0.16, 0.1, 0.06], [0.14, 0.15, 0.18]]);
  const obi = pick(fract(v.mul(3.7).add(0.13)), [[0.62, 0.56, 0.44], [0.46, 0.06, 0.03], [0.55, 0.38, 0.08], [0.05, 0.07, 0.16], [0.7, 0.68, 0.62], [0.36, 0.14, 0.05]]);
  const tag = attribute('aCol', 'vec3') as N;
  const r = tag.x, g = tag.y, bl = tag.z;
  const isStraw = r.mul(g), isWood = g.mul(bl);
  const isKim = r.mul(float(1).sub(g)), isObi = g.mul(float(1).sub(r)).mul(float(1).sub(bl)), isSkin = bl.mul(float(1).sub(g));
  const hair = float(1).sub(isStraw).sub(isWood).sub(isKim).sub(isObi).sub(isSkin).max(0);
  return kim.mul(isKim).add(obi.mul(isObi)).add(vec3(0.42, 0.29, 0.2).mul(isSkin)).add(vec3(0.42, 0.32, 0.15).mul(isStraw))
    .add(vec3(0.07, 0.045, 0.03).mul(isWood)).add(vec3(0.018, 0.016, 0.015).mul(hair));
}

/** walking: bob, hem swing and a slight body roll scaled by w (1 walking, 0 standing) */
function figureDeform(p: N, ph: N, _v: N, w: N) {
  const step2 = uTime.mul(Math.PI * 1.8).add(ph.mul(6.283));
  const bob = abs(sin(step2)).mul(0.03).mul(w);
  const hem = smoothstep(0.75, 0.05, p.y);
  const swing = sin(step2).mul(0.035).mul(w).mul(hem);
  const roll = sin(step2.mul(0.5)).mul(0.018).mul(w).mul(p.y);
  const breathe = sin(uTime.mul(1.3).add(ph.mul(9))).mul(0.004).mul(smoothstep(0.8, 1.4, p.y));
  return vec3(p.x.add(roll), p.y.add(bob).add(breathe), p.z.add(swing));
}

interface Walker { crowd: Crowd; side: -1 | 1; s0: number; s1: number; offset: number; speed: number; phase: number; variant: number; lift?: number }
interface TownSpot { x: number; y: number; z: number; yaw: number }
interface TownPeople { walks: { side: -1 | 1; s0: number; s1: number; offset: number }[]; standing: TownSpot[]; seated: TownSpot[]; ponds: { x: number; y: number; z: number; ax: number; az: number; rx: number; rz: number }[] }

function villagers(ctx: GameContext, site: Site, boats: NpcBoat[]) {
  const root = new Group();
  root.name = 'life:villagers';
  const mk = (geo: BufferGeometry, n: number) => {
    const c = crowd(geo, n, figureDeform, figureColour, 0.85);
    c.mesh.castShadow = true;
    c.mesh.receiveShadow = true;
    c.mesh.layers.set(LAYERS.NO_REFLECT);
    root.add(c.mesh);
    return c;
  };
  const town = ctx.services.town as TownPeople | undefined;
  const hat = mk(standingFigure('hat'), 44);
  const hair = mk(standingFigure('hair'), 40);
  const parasol = mk(standingFigure('parasol'), 24);
  const seated = mk(seatedFigure('hair'), 40);
  const walkers: Walker[] = [
    { crowd: hat, side: -1, s0: 72, s1: 178, offset: 1.75, speed: 1.0, phase: 0.1, variant: 0.05 },
    { crowd: parasol, side: -1, s0: 208, s1: 288, offset: 1.8, speed: 0.8, phase: 0.6, variant: 0.55 },
    { crowd: hair, side: 1, s0: 66, s1: 190, offset: 1.75, speed: 0.9, phase: 0.35, variant: 0.72 },
    { crowd: parasol, side: 1, s0: 198, s1: 288, offset: 1.8, speed: 0.85, phase: 0.85, variant: 0.21 },
    { crowd: hat, side: -1, s0: 332, s1: 460, offset: 1.8, speed: 1.0, phase: 0.45, variant: 0.9 },
    { crowd: hat, side: 1, s0: 304, s1: 368, offset: 1.8, speed: 0.9, phase: 0.15, variant: 0.62 },
    { crowd: hair, side: -1, s0: 480, s1: 650, offset: 1.8, speed: 0.95, phase: 0.7, variant: 0.33 },
    { crowd: parasol, side: 1, s0: 470, s1: 655, offset: 1.8, speed: 0.8, phase: 0.4, variant: 0.8 },
  ];
  // strollers on the inland streets: four to a route, spread along it, a mix of hats, hair and parasols
  if (town) {
    const kinds = [hat, hair, parasol, hair, hat];
    town.walks.forEach((w, i) => {
      for (let k = 0; k < 4; k++) {
        const j = i * 4 + k;
        walkers.push({ crowd: kinds[j % kinds.length], side: w.side, s0: w.s0, s1: w.s1, offset: w.offset, speed: 0.75 + ((j * 0.37) % 1) * 0.35, phase: (k / 4 + i * 0.13) % 1, variant: (j * 0.618) % 1, lift: 0.06 });
      }
    });
  }
  const standers = town?.standing ?? [];
  const seatedTown = town?.seated ?? [];
  // a fisherman on the right bank embankment with his rod out over the water
  const fisher = bankPoint(244, 1, 0.6);
  const fyaw = Math.atan2(fisher.frame.nx, fisher.frame.nz);
  const fy = Math.max(0.7, ctx.world.heightAt(fisher.x, fisher.z));
  {
    const hand = new Vector3(0.1, 1.05, -0.2).applyAxisAngle(new Vector3(0, 1, 0), fyaw).add(new Vector3(fisher.x, fy, fisher.z));
    const f = fisher.frame;
    const tip = new Vector3(fisher.x - f.nx * 2.5, fy + 2.3, fisher.z - f.nz * 2.5);
    const rod = segment(hand.toArray(), tip.toArray());
    site.add('bamboo', cylinder(0.018, 0.006, rod.len, 5), rod.m, { col: [1.1, 0.95, 0.6] });
    const line = segment(tip.toArray(), [tip.x, 0.02, tip.z]);
    site.add('rope', cylinder(0.003, 0.003, line.len, 3), line.m, { col: [0.7, 0.7, 0.65] });
  }
  // two people sitting on the embankment edge, feet over the water
  const sitters = ([[132, 1, 0.33], [268, -1, 0.8], [520, -1, 0.5], [606, 1, 0.2]] as [number, -1 | 1, number][]).map(([s, side, v]) => {
    const p = bankPoint(s, side, 0.28);
    const q = bankPoint(s, side, 0.7);
    const y = Math.max(0.7, ctx.world.heightAt(q.x, q.z)) + 0.1;
    return { x: p.x, z: p.z, y, yaw: Math.atan2(side * p.frame.nx, side * p.frame.nz), v };
  });
  // boatmen stand at the stern of each traffic boat, poling; passengers sit under the parasols
  for (const nb of boats) {
    const h = nb.boat.build.spec;
    const pole = new Group();
    pole.position.set(0.22, -h.draft + 1.25, h.L / 2 - 0.85);
    const pb = new Bucket();
    pb.add(cylinder(0.022, 0.018, 4.4, 6), trs(0, -3.4, 0), { col: [1.05, 0.9, 0.58] });
    const pm = new Mesh(pb.build()!, plainMaterial(0.7));
    pm.castShadow = false;
    pm.layers.set(LAYERS.NO_REFLECT);
    pole.add(pm);
    nb.boat.build.group.add(pole);
    nb.pole = pole;
  }
  const wpos = { x: 0, z: 0, yaw: 0, moving: 0 };
  const v3 = new Vector3();
  const counts = { walkers: walkers.length, seated: sitters.length, fishermen: 1, boatmen: boats.length, passengers: 0 };
  boats.forEach((_, i) => { if (i % 2 === 1) counts.passengers += 2; });

  function walkerPose(w: Walker, t: number) {
    const D = (w.s1 - w.s0) / w.speed, PAUSE = 4;
    const P = 2 * (D + PAUSE);
    let k = (t + w.phase * P) % P;
    if (k < 0) k += P;
    let s: number, dir: number, moving = 1;
    if (k < D) { s = w.s0 + (k / D) * (w.s1 - w.s0); dir = 1; }
    else if (k < D + PAUSE) { s = w.s1; dir = 1; moving = 0; }
    else if (k < 2 * D + PAUSE) { s = w.s1 - ((k - D - PAUSE) / D) * (w.s1 - w.s0); dir = -1; }
    else { s = w.s0; dir = -1; moving = 0; }
    const p = bankPoint(s, w.side, w.offset);
    wpos.x = p.x; wpos.z = p.z;
    const fx = p.frame.tx * dir, fz = p.frame.tz * dir;
    wpos.yaw = Math.atan2(-fx, -fz);
    // at the ends they turn to look at the water for a moment
    if (!moving) wpos.yaw = Math.atan2(w.side * p.frame.nx, w.side * p.frame.nz);
    wpos.moving = moving;
    return wpos;
  }

  function update(c: GameContext) {
    const t = c.time.render;
    const n = new Map<Crowd, number>([[hat, 0], [hair, 0], [parasol, 0], [seated, 0]]);
    const put = (cr: Crowd, x: number, y: number, z: number, yaw: number, ph: number, v: number, walk: number) => {
      const i = n.get(cr)!;
      if (i >= cr.max) return;
      crowdSet(cr, i, x, y, z, yaw, ph, 1, v, walk);
      n.set(cr, i + 1);
    };
    for (const w of walkers) {
      const p = walkerPose(w, t);
      const y = Math.max(0.7, c.world.heightAt(p.x, p.z)) + (w.lift ?? 0);
      put(w.crowd, p.x, y, p.z, p.yaw, w.phase, w.variant, p.moving);
    }
    standers.forEach((s, i) => put(i % 3 === 0 ? hat : hair, s.x, s.y + 0.04, s.z, s.yaw, (i * 0.29) % 1, (i * 0.618 + 0.1) % 1, 0));
    seatedTown.forEach((s, i) => put(seated, s.x, s.y, s.z, s.yaw, (i * 0.41) % 1, (i * 0.382 + 0.2) % 1, 0));
    put(hat, fisher.x, fy, fisher.z, fyaw, 0.3, 0.38, 0);
    for (const s of sitters) put(seated, s.x, s.y, s.z, s.yaw, s.v, s.v, 0);
    boats.forEach((nb, i) => {
      const g = nb.boat.build.group;
      if (!g.visible) return;
      const h = nb.boat.build.spec;
      g.updateMatrixWorld();
      const yaw = g.rotation.y;
      v3.set(0, -h.draft + 0.1, h.L / 2 - 0.75).applyMatrix4(g.matrixWorld);
      put(hat, v3.x, v3.y, v3.z, yaw, 0.2 + i * 0.3, 0.15 + i * 0.23, 0);
      if (i % 2 === 1) {
        for (const sx of [-0.28, 0.28]) {
          v3.set(sx, -h.draft + 0.52, 0.45).applyMatrix4(g.matrixWorld);
          put(seated, v3.x, v3.y, v3.z, yaw, i + sx, 0.4 + i * 0.17 + sx, 0);
        }
      }
    });
    for (const [cr, k] of n) crowdCommit(cr, k);
  }
  return { root, update, counts };
}

// ---------------------------------------------------------------------------------------------

interface Culled { obj: Group | Mesh; sphere: Sphere; far: number }

/** static parts (poles, ropes, the brazier) merge into `site`, a village site finished by the caller */
export function createRiverLife(ctx: GameContext, mats: Materials, site: Site) {
  const root = new Group();
  root.name = 'structures:life';
  ctx.scene.add(root);
  const swayB = new Bucket();
  const culled: Culled[] = [];
  const counts: Record<string, number> = { lanternStrings: 0, lanterns: 0, pennants: 0, koinobori: 0, carp: 0, boats: 0 };
  const ground = (x: number, z: number) => Math.max(0.6, ctx.world.heightAt(x, z));

  // ---- festival lantern strings across the canal ----
  const crossings = [118, 198, 252, 372, 560];
  for (const [ci, s] of crossings.entries()) {
    const R = rng(900 + ci);
    const ends: { lan: number[]; pen: number[] }[] = [];
    for (const side of [-1, 1] as const) {
      const a = bankPoint(s, side, 1.3), b = bankPoint(s + 1.9, side, 1.3);
      const ga = ground(a.x, a.z), gb = ground(b.x, b.z);
      const top = 8.6;
      pole(site, a.x, ga, a.z, top);
      pole(site, b.x, gb, b.z, top - 0.5);
      ends.push({ lan: [a.x, top - 0.12, a.z], pen: [b.x, top - 0.62, b.z] });
    }
    const f = bankPoint(s, 1, 0).frame;
    for (const [key, sag] of [['lan', 1.35], ['pen', 1.2]] as const) {
      const A = ends[0][key], B = ends[1][key];
      const P = (t: number) => [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t - sag * 4 * t * (1 - t), A[2] + (B[2] - A[2]) * t];
      const pts: number[][] = [];
      for (let i = 0; i <= 24; i++) pts.push(P(i / 24));
      rope(site, pts);
      const span = Math.hypot(B[0] - A[0], B[2] - A[2]);
      if (key === 'lan') {
        const n = Math.floor((span - 3) / 1.7);
        for (let i = 0; i < n; i++) {
          const t = (1.5 + (i + 0.5) * ((span - 3) / n)) / span;
          const q = P(t);
          const tint = i % 3 === 1 ? PAPER : RED;
          hangLantern(swayB, q[0], q[1] - 0.14, q[2], q[1], tint, R(), 0.9 + R() * 0.12);
          counts.lanterns++;
        }
      } else {
        const n = Math.floor(span / 0.55);
        const cols: RGB[] = [RED, WHITE, INK, GOLD, GREEN];
        for (let i = 1; i < n; i++) {
          const q = P(i / n);
          pennant(swayB, q[0], q[1] - 0.02, q[2], f.nx, f.nz, cols[i % cols.length], R());
          counts.pennants++;
        }
      }
    }
    counts.lanternStrings++;
  }

  // ---- koinobori: tall poles in the yards behind the waterfront, carp streaming over the roofs ----
  const carpMat = carpMaterial(), plainMat = plainMaterial(0.55, 0.3);
  const koi: { group: Group; wheel: Group; seed: number }[] = [];
  const poles: [number, -1 | 1][] = [[105, -1], [146, 1], [216, 1], [238, -1], [420, -1], [548, 1]];
  for (const [pi, [s, side]] of poles.entries()) {
    const p = bankPoint(s, side, 17);
    const g = ground(p.x, p.z);
    const H = 13.5;
    pole(site, p.x, g, p.z, g + H, 0.1);
    const group = new Group();
    group.name = 'life:koinobori';
    group.position.set(p.x, g, p.z);
    const bucket = new Bucket();
    const seed = 0.13 + pi * 0.29;
    // fukinagashi on top, then father (black), mother (red), child (blue)
    carp(bucket, 0.14, H - 0.75, 3.3, 0.3, [0, 0, 0], seed, 1);
    carp(bucket, 0.14, H - 1.95, 3.0, 0.4, [0.02, 0.02, 0.028], seed + 0.1);
    carp(bucket, 0.14, H - 3.05, 2.45, 0.33, [0.46, 0.04, 0.025], seed + 0.2);
    carp(bucket, 0.14, H - 3.95, 1.9, 0.26, [0.05, 0.14, 0.42], seed + 0.3);
    counts.carp += 3;
    for (const y of [H - 0.75, H - 1.95, H - 3.05, H - 3.95]) {
      const q = segment([0, y + 0.05, 0], [0.14, y, 0]);
      // u = 0.5 with zero length: no droop or sway, and the body shading instead of the mouth ring
      bucket.add(cylinder(0.01, 0.01, q.len, 4), q.m, { col: [0.2, 0.18, 0.15], v: [0.5, 0, 0, 0] });
    }
    const geo = bucket.build()!;
    const mesh = new Mesh(geo, carpMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    // the pinwheel spins at the masthead, facing the wind with the carp
    const wb = new Bucket();
    pinwheel(wb);
    const wheel = new Group();
    const wm = new Mesh(wb.build()!, plainMat);
    // too small for the shadow maps or the mirror
    wm.castShadow = false;
    wm.layers.set(LAYERS.NO_REFLECT);
    wheel.add(wm);
    wheel.position.set(0.05, H + 0.2, 0);
    group.add(wheel);
    root.add(group);
    koi.push({ group, wheel, seed });
    culled.push({ obj: group, sphere: new Sphere(new Vector3(p.x, g + H - 2, p.z), 6), far: 700 });
    counts.koinobori++;
  }

  // ---- wildlife and smoke ----
  const wild = wildlife(ctx, site);
  root.add(wild.root);
  Object.assign(counts, wild.counts);

  // ---- river traffic ----
  const clothMat = plainMaterial(0.85);
  const traffic = riverTraffic(ctx, mats, clothMat);
  counts.boats = traffic.boats.length;

  // ---- villagers, boatmen and passengers ----
  const folk = villagers(ctx, site, traffic.boats);
  root.add(folk.root);
  Object.assign(counts, folk.counts);

  // ---- emit ----
  // lantern strings over the inland streets share this mesh
  const townSway = (ctx.services.town as { sway?: Bucket } | undefined)?.sway;
  if (townSway) swayB.append(townSway);
  if (!swayB.finite()) throw new Error('non-finite river life geometry');
  const swayGeo = swayB.build();
  if (swayGeo) {
    const m = new Mesh(swayGeo, swayMaterial());
    m.name = 'life:hanging';
    m.castShadow = true;
    m.receiveShadow = true;
    // displaced in the shader; the cpu bounds must include the swing
    m.frustumCulled = false;
    root.add(m);
    culled.push({ obj: m, sphere: new Sphere(swayGeo.boundingSphere!.center.clone(), swayGeo.boundingSphere!.radius + 1), far: 900 });
  }

  const cam = new Vector3();
  const wind = new Vector2();
  // kinematic colliders follow the lane at sim time; hulls are drawn at render time
  const tpose = { x: 0, z: 0, yaw: 0, moving: 0 };
  ctx.onFixed((c, dt) => {
    for (const nb of traffic.boats) {
      lanePose(nb.lane, c.time.sim + dt, tpose);
      nb.boat.x = tpose.x; nb.boat.z = tpose.z; nb.boat.yaw = tpose.yaw;
      nb.boat.fixed(c.time.sim + dt);
    }
  }, 30);

  ctx.onUpdate((c) => {
    c.camera.getWorldPosition(cam);
    const tr = c.time.render;
    wild.update(c, cam);
    const lampsLit = lampLevelNow() > 0.02;
    for (const nb of traffic.boats) {
      if (nb.lamp) nb.lamp.visible = lampsLit;
      lanePose(nb.lane, tr, tpose);
      nb.boat.x = tpose.x; nb.boat.z = tpose.z; nb.boat.yaw = tpose.yaw;
      const g = nb.boat.build.group;
      g.visible = cam.distanceTo(g.position) < 650;
      if (!g.visible) continue;
      nb.boat.update(tr, Math.min(0.1, c.time.frameDt));
      if (nb.pole) nb.pole.rotation.x = -0.35 + Math.sin(tr * 0.9 + nb.lane.phase * 7) * 0.22 * (0.3 + tpose.moving * 0.5);
    }
    // after the boats, so boatmen and passengers ride this frame's hull pose
    folk.root.visible = wild.root.visible;
    if (folk.root.visible) folk.update(c);
    for (const e of culled) e.obj.visible = cam.distanceTo(e.sphere.center) - e.sphere.radius < e.far;
    wind.copy(uWindDir.value as Vector2);
    const yaw = Math.atan2(-wind.y, wind.x);
    const ws = uWindStrength.value as number;
    const dt = Math.min(0.1, c.time.frameDt);
    for (const k of koi) {
      if (!k.group.visible) continue;
      k.group.rotation.y = yaw + Math.sin(c.time.render * 0.3 + k.seed * 9) * 0.12;
      if (!c.paused) k.wheel.rotateX(dt * (1.5 + ws * 6));
    }
  }, 22);

  const triangles = () => {
    let t = 0;
    root.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) t += (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3;
    });
    return Math.round(t);
  };
  const meshes = () => {
    let n = 0;
    root.traverse((o) => { if ((o as Mesh).isMesh) n++; });
    return n;
  };
  return { root, counts, stats: () => ({ ...counts, meshes: meshes(), triangles: triangles() }) };
}
