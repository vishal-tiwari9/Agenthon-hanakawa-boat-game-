// japanese garden and canal trees on the town floor: weeping willows along the embankment lanes
// (kurashiki style, leaning over the water), cloud-pruned niwaki pines and ume plum in deep pink or
// white around the shrine, the temple and the landing. all procedural (no impostor atlases): each
// species is one near and one far instanced mesh sharing a single material and painted atlas.
// the far lod keeps the lowest-ranked strands and cards, larger; every card's size morphs with its
// distance to the player (uViewPos, so shadow passes agree) and the lod swap is invisible.
import {
  BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, Frustum, Group, InstancedBufferGeometry,
  InstancedInterleavedBuffer, InterleavedBufferAttribute, Matrix4, Mesh, Sphere, Vector3, type Texture,
} from 'three/webgpu';
import {
  Fn, attribute, cameraViewMatrix, clamp, cos, faceDirection, float, fract, length, mix, normalLocal, normalize,
  positionLocal, select, sin, smoothstep, uv, varyingProperty, vec2, vec3, vec4,
} from 'three/tsl';
import type { GameContext } from '../core/context';
import { uTime, uWindStrength } from '../core/uniforms';
import { BRIDGES, DOCKS, bankPoint, riverFrame } from '../world/layout';
import { SITES } from '../world/sites';
import { FoliageMaterial, leafAlbedo } from './foliage';
import { windAt } from './wind';
import { uViewPos } from './forest';
import { GARDEN_RECTS, gardenAtlas } from './atlas';
import { footprintDistance, type Footprint, type HeightFn } from './field';
import { hash1 } from './noise';
import { hidesFacade } from './townView';

type N = any;
type V = [number, number, number];
type Rect = [number, number, number, number];

/** near/far lod distance (m, from the tree root) and the morph band below it */
export const GARDEN_LOD = 42;
const BAND = 12;
/** far lod keeps cards with rank below KEEP, grown by GROW */
const KEEP = 0.34, GROW = 1.62;

const KIND = { bark: 0, card: 1, strand: 2, plum: 3 };

interface Prim { rank: number; v0: number; v1: number; i0: number; i1: number }

class Builder {
  P: number[] = []; N: number[] = []; U: number[] = []; C: number[] = []; F: number[] = []; S: number[] = []; K: number[] = [];
  I: number[] = [];
  prims: Prim[] = [];
  private cur: Prim | null = null;
  begin(rank: number) { this.cur = { rank, v0: this.P.length / 3, v1: 0, i0: this.I.length, i1: 0 }; }
  end() { const c = this.cur!; c.v1 = this.P.length / 3; c.i1 = this.I.length; this.prims.push(c); this.cur = null; }
  vert(p: V, n: V, u: [number, number], c: V, rank: number, kind: number, hang: number, depth: number, sph: V, col: V) {
    this.P.push(...p); this.N.push(...n); this.U.push(...u); this.C.push(...c, rank); this.F.push(kind, hang, depth, 0);
    this.S.push(...sph); this.K.push(...col);
    return this.P.length / 3 - 1;
  }
  /** bark tube along a polyline */
  tube(pts: V[], radii: number[], sides: number, col: V) {
    this.begin(-1);
    const [x0, y0, x1, y1] = GARDEN_RECTS.bark;
    const base = this.P.length / 3;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
      const t = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
      const ref: V = Math.abs(t[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      const n1 = norm(cross(t, ref)), n2 = cross(t, n1);
      for (let j = 0; j < sides; j++) {
        const ang = (j / sides) * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
        const d: V = [n1[0] * ca + n2[0] * sa, n1[1] * ca + n2[1] * sa, n1[2] * ca + n2[2] * sa];
        const r = radii[k];
        const p: V = [pts[k][0] + d[0] * r, pts[k][1] + d[1] * r, pts[k][2] + d[2] * r];
        const shade = 0.82 + 0.18 * Math.sin(ang * 3 + k);
        this.vert(p, d, [x0 + (x1 - x0) * (j / sides), y0 + (y1 - y0) * (k / Math.max(1, pts.length - 1))], pts[k], -1, KIND.bark, 0, 1, d,
          [col[0] * shade, col[1] * shade, col[2] * shade]);
      }
    }
    for (let k = 0; k < pts.length - 1; k++) for (let j = 0; j < sides; j++) {
      const a = base + k * sides + j, b = base + k * sides + ((j + 1) % sides), c = a + sides, d = b + sides;
      this.I.push(a, c, b, b, c, d);
    }
    this.end();
  }
  /** a leaf card centred at c, facing n, `w` wide along `side`, `h` tall along `up` */
  card(c: V, n: V, up: V, w: number, h: number, rect: Rect, rank: number, kind: number, depth: number, sph: V, col: V, hang = 0) {
    this.begin(rank);
    const side = norm(cross(up, n));
    const u2 = norm(cross(n, side));
    const [x0, y0, x1, y1] = rect;
    const base = this.P.length / 3;
    for (const [a, b] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
      const p: V = [c[0] + side[0] * a * w + u2[0] * b * h, c[1] + side[1] * a * w + u2[1] * b * h, c[2] + side[2] * a * w + u2[2] * b * h];
      this.vert(p, n, [x0 + (x1 - x0) * (a + 0.5), y1 - (y1 - y0) * (b + 0.5)], c, rank, kind, hang, depth, sph, col);
    }
    this.I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.end();
  }
  /** a hanging willow strand: a ribbon from `top` straight down `len`, bowing out along `out` */
  strand(top: V, len: number, width: number, out: V, segs: number, rank: number, col: V) {
    this.begin(rank);
    const side = norm(cross([0, 1, 0], out));
    const [x0, y0, x1, y1] = GARDEN_RECTS.strand;
    const vLen = Math.min(1, len / 4.6);
    const base = this.P.length / 3;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const bow = Math.sin(Math.PI * Math.min(1, t * 1.4)) * 0.22 + t * 0.12;
      const c: V = [top[0] + out[0] * bow, top[1] - len * t, top[2] + out[2] * bow];
      const w = width * (0.75 + 0.35 * Math.sin(Math.PI * Math.min(1, t * 1.2 + 0.1)));
      for (const a of [-0.5, 0.5]) {
        const p: V = [c[0] + side[0] * a * w, c[1], c[2] + side[2] * a * w];
        this.vert(p, out, [x0 + (x1 - x0) * (a + 0.5), y0 + (y1 - y0) * t * vLen], c, rank, KIND.strand, t, 0.8 + 0.2 * t, out, col);
      }
      if (k < segs) { const a = base + k * 2; this.I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    this.end();
  }
  /** geometry of the bark plus every card/strand with rank below `keep` */
  geometry(keep: number) {
    const P: number[] = [], Nn: number[] = [], U: number[] = [], C: number[] = [], F: number[] = [], S: number[] = [], K: number[] = [], I: number[] = [];
    for (const pr of this.prims) {
      if (pr.rank >= keep) continue;
      const off = P.length / 3 - pr.v0;
      for (let v = pr.v0; v < pr.v1; v++) {
        P.push(this.P[v * 3], this.P[v * 3 + 1], this.P[v * 3 + 2]);
        Nn.push(this.N[v * 3], this.N[v * 3 + 1], this.N[v * 3 + 2]);
        U.push(this.U[v * 2], this.U[v * 2 + 1]);
        for (let q = 0; q < 4; q++) { C.push(this.C[v * 4 + q]); F.push(this.F[v * 4 + q]); }
        S.push(this.S[v * 3], this.S[v * 3 + 1], this.S[v * 3 + 2]);
        K.push(this.K[v * 3], this.K[v * 3 + 1], this.K[v * 3 + 2]);
      }
      for (let i = pr.i0; i < pr.i1; i++) I.push(this.I[i] + off);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(P), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(Nn), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(U), 2));
    g.setAttribute('aCard', new BufferAttribute(new Float32Array(C), 4));
    g.setAttribute('aInfo', new BufferAttribute(new Float32Array(F), 4));
    g.setAttribute('aSph', new BufferAttribute(new Float32Array(S), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(K), 3));
    g.setIndex(new BufferAttribute(new Uint32Array(I), 1));
    g.computeBoundingSphere();
    return g;
  }
}

const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V): V => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a: V, b: V, t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const bez = (a: V, b: V, c: V, t: number): V => lerp3(lerp3(a, b, t), lerp3(b, c, t), t);

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296;
}

/** ranks are shuffled so the far lod keeps an even spread of the crown */
function ranks(n: number, rnd: () => number) {
  const r = Array.from({ length: n }, (_, i) => (i + rnd()) / n);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
  return r;
}

/** weeping willow, leaning toward local +x (the water): a short trunk, arching limbs and a curtain of strands */
function buildWillow(seed: number) {
  const b = new Builder(), rnd = rng(seed);
  const bark: V = [0.2, 0.17, 0.14];
  const H = 2.7 + rnd() * 0.7;
  const top: V = [0.55, H, 0.05];
  b.tube([[0, -0.3, 0], [0.12, H * 0.45, 0.02], [0.38, H * 0.8, 0.05], top], [0.3, 0.22, 0.18, 0.15], 9, bark);
  const cc: V = [1.0, H + 1.25, 0];
  const RX = 3.0 + rnd() * 0.5, RY = 1.5, RZ = 2.8 + rnd() * 0.4;
  const limbs = 5;
  for (let i = 0; i < limbs; i++) {
    const a = (i / limbs) * Math.PI * 2 + rnd() * 0.8;
    const L = 1.8 + rnd() * 0.9;
    const d: V = [Math.cos(a), 0, Math.sin(a)];
    const mid: V = [top[0] + d[0] * L * 0.45, top[1] + 0.9, top[2] + d[2] * L * 0.45];
    const end: V = [cc[0] + d[0] * RX * 0.72, cc[1] + 0.35, cc[2] + d[2] * RZ * 0.72];
    const pts: V[] = [];
    for (let k = 0; k <= 4; k++) pts.push(bez(top, mid, end, k / 4));
    b.tube(pts, [0.12, 0.1, 0.075, 0.055, 0.035], 6, bark);
  }
  // soft grey-green: the painted strands are a fresh lime, so they are muted here to about 0.10-0.16
  // linear green, a little bluer, in family with the cedars and the canal-side greens
  const leaf: V = [0.46, 0.44, 1.3];
  // strands hang from the dome's upper and outer shell; ground clearance about a meter
  const NS = 200, rs = ranks(NS, rnd);
  for (let i = 0; i < NS; i++) {
    const th = rnd() * Math.PI * 2, ph = Math.acos(1 - rnd() * 0.85) * 1.15;
    const dir: V = [Math.cos(th) * Math.sin(ph), Math.cos(ph), Math.sin(th) * Math.sin(ph)];
    const p: V = [cc[0] + dir[0] * RX, cc[1] + dir[1] * RY, cc[2] + dir[2] * RZ];
    const out = norm([dir[0], 0, dir[2]]);
    const len = Math.max(1.4, Math.min(p[1] - 0.9 - rnd() * 0.6, 2.4 + rnd() * 2.6));
    const tint = 0.9 + rnd() * 0.18;
    b.strand(p, len, 0.34 + rnd() * 0.12, out, 5, rs[i], [leaf[0] * tint, leaf[1] * tint, leaf[2] * (0.9 + rnd() * 0.2)]);
  }
  // leaf sprays over the top so the crown is closed from above
  const NC = 70, rc = ranks(NC, rnd);
  for (let i = 0; i < NC; i++) {
    const th = rnd() * Math.PI * 2, ph = Math.acos(1 - rnd() * 0.7);
    const dir: V = [Math.cos(th) * Math.sin(ph), Math.cos(ph), Math.sin(th) * Math.sin(ph)];
    const p: V = [cc[0] + dir[0] * RX * 0.92, cc[1] + dir[1] * RY * 0.95, cc[2] + dir[2] * RZ * 0.92];
    const n = norm([dir[0] + (rnd() - 0.5) * 0.8, dir[1] + 0.3, dir[2] + (rnd() - 0.5) * 0.8]);
    b.card(p, n, [0, 1, 0], 1.1, 1.1, GARDEN_RECTS.willowLeaf, rc[i], KIND.card, 0.7 + 0.3 * Math.sin(ph), dir, leaf, 0.2);
  }
  return b;
}

/** niwaki black pine: an s-curved leaning trunk, near-horizontal branches ending in flat cloud pads */
function buildPine(seed: number) {
  const b = new Builder(), rnd = rng(seed);
  const bark: V = [0.18, 0.15, 0.13];
  const H = 3.4 + rnd() * 0.9;
  const trunk: V[] = [[0, -0.3, 0], [0.35, H * 0.25, 0.1], [-0.05, H * 0.5, 0.2], [0.3, H * 0.75, 0.0], [0.1, H, 0.1]];
  b.tube(trunk, [0.24, 0.19, 0.15, 0.12, 0.09], 8, bark);
  const pads: { c: V; rx: number; ry: number; rz: number }[] = [{ c: [0.1, H + 0.25, 0.1], rx: 0.95, ry: 0.42, rz: 0.9 }];
  const nb = 5 + Math.floor(rnd() * 2);
  for (let i = 0; i < nb; i++) {
    const t = 0.38 + (i / nb) * 0.55;
    const k = Math.min(3, Math.floor(t * 4));
    const at = lerp3(trunk[k], trunk[k + 1], t * 4 - k);
    const a = i * 2.4 + rnd() * 0.6;
    const L = (1.7 - t) * (0.9 + rnd() * 0.5);
    const end: V = [at[0] + Math.cos(a) * L, at[1] + 0.25 + rnd() * 0.2, at[2] + Math.sin(a) * L];
    b.tube([at, lerp3(at, end, 0.5), end], [0.07, 0.05, 0.035], 5, bark);
    const s = 0.75 + (1 - t) * 0.7;
    pads.push({ c: [end[0], end[1] + 0.12, end[2]], rx: 0.85 * s, ry: 0.36 * s, rz: 0.8 * s });
  }
  let total = 0;
  for (const p of pads) total += Math.round(24 * (p.rx * p.rz) / 0.72 + 8);
  const rr = ranks(total, rnd);
  let r = 0;
  const needle: V = [0.9, 1.0, 0.95];
  for (const p of pads) {
    const n = Math.round(24 * (p.rx * p.rz) / 0.72 + 8);
    for (let i = 0; i < n; i++) {
      const th = rnd() * Math.PI * 2, ph = Math.acos(1 - rnd() * 1.4);
      const dir: V = [Math.cos(th) * Math.sin(ph), Math.cos(ph), Math.sin(th) * Math.sin(ph)];
      const pos: V = [p.c[0] + dir[0] * p.rx * 0.85, p.c[1] + dir[1] * p.ry * 0.85, p.c[2] + dir[2] * p.rz * 0.85];
      const sph = norm([dir[0] / p.rx, dir[1] / p.ry, dir[2] / p.rz]);
      const nn = norm([sph[0] + (rnd() - 0.5) * 0.7, sph[1] + 0.4, sph[2] + (rnd() - 0.5) * 0.7]);
      const sz = 0.55 + rnd() * 0.25;
      b.card(pos, nn, [rnd() - 0.5, 0.2, rnd() - 0.5], sz, sz, GARDEN_RECTS.needles, rr[r++], KIND.card, 0.6 + 0.4 * Math.max(0, dir[1]), sph, needle, 0.15);
    }
  }
  return b;
}

/** ume: a short gnarled trunk, zigzag limbs and blossom sprays along them (no leaves yet) */
function buildPlum(seed: number) {
  const b = new Builder(), rnd = rng(seed);
  const bark: V = [0.14, 0.11, 0.1];
  const H = 1.3 + rnd() * 0.4;
  const top: V = [0.15, H, 0.05];
  b.tube([[0, -0.2, 0], [0.12, H * 0.5, -0.05], top], [0.16, 0.13, 0.1], 7, bark);
  const twigs: [V, V][] = [];
  const limbs = 3 + Math.floor(rnd() * 2);
  for (let i = 0; i < limbs; i++) {
    const a = (i / limbs) * Math.PI * 2 + rnd();
    let p = top;
    const pts: V[] = [p];
    for (let k = 0; k < 4; k++) {
      const z = (k % 2 ? 1 : -1) * 0.35;
      p = [p[0] + Math.cos(a + z) * 0.45, p[1] + 0.42 + rnd() * 0.2, p[2] + Math.sin(a + z) * 0.45];
      pts.push(p);
      if (k > 0) twigs.push([pts[k], p]);
    }
    b.tube(pts, [0.08, 0.06, 0.045, 0.032, 0.02], 5, bark);
    // side twigs
    for (let k = 1; k < 4; k++) {
      const s = pts[k], e: V = [s[0] + Math.cos(a + 1.3) * 0.6, s[1] + 0.35, s[2] + Math.sin(a + 1.3) * 0.6];
      b.tube([s, e], [0.025, 0.012], 4, bark);
      twigs.push([s, e]);
    }
  }
  const NC = 150, rc = ranks(NC, rnd);
  for (let i = 0; i < NC; i++) {
    const [s, e] = twigs[Math.floor(rnd() * twigs.length)];
    const p = lerp3(s, e, rnd());
    const n = norm([rnd() - 0.5, rnd() * 0.8, rnd() - 0.5]);
    const sz = 0.38 + rnd() * 0.2;
    const sph = norm([p[0] - top[0], p[1] - (H + 0.8), p[2] - top[2]]);
    b.card([p[0], p[1] + 0.05, p[2]], n, [rnd() - 0.5, 1, rnd() - 0.5], sz, sz, GARDEN_RECTS.plumPink, rc[i], KIND.plum, 0.8, sph, [1, 1, 1], 0.1);
  }
  return b;
}

function gardenMaterial(atlas: Texture) {
  const aA = attribute('aTreeA', 'vec4') as N;
  const aB = attribute('aTreeB', 'vec4') as N;
  const aCard = attribute('aCard', 'vec4') as N;
  const aInfo = attribute('aInfo', 'vec4') as N;
  const aSph = attribute('aSph', 'vec3') as N;
  const aCol = attribute('color', 'vec3') as N;
  const vN = varyingProperty('vec3', 'vGdN') as N;
  const vSph = varyingProperty('vec3', 'vGdSph') as N;
  const vInfo = varyingProperty('vec4', 'vGdInfo') as N; // kind, depth, seed, hang
  const vCol = varyingProperty('vec3', 'vGdCol') as N;
  const rotY = (v: N, c: N, s: N) => vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)));

  const m = new FoliageMaterial({ side: DoubleSide, alphaTest: 0.5 });
  m.name = 'garden-trees';
  m.positionNode = Fn(() => {
    const root = aA.xyz, yaw = aA.w, scale = aB.x, seed = aB.y;
    const kind = aInfo.x, hang = aInfo.y;
    const leafy = kind.greaterThan(0.5);
    // far lod morph: kept cards grow, the rest shrink away (uViewPos: the same in shadow passes)
    const dist = length((uViewPos as N).sub(root));
    const mm = smoothstep(GARDEN_LOD - BAND, GARDEN_LOD, dist);
    const keep = aCard.w.lessThan(KEEP);
    const sz = select(leafy, mix(float(1), select(keep, float(GROW), float(0)), mm), float(1));
    let p = aCard.xyz.add((positionLocal as N).sub(aCard.xyz).mul(sz)) as N;
    const c = cos(yaw), s = sin(yaw);
    // wind: crowns lean and rock; strands swing from their tops like pendulums
    const w = windAt(root.xz) as N;
    const phase = root.x.mul(0.13).add(root.z.mul(0.09)).add(seed.mul(6.28));
    const h01 = clamp(p.y.div(5), 0, 1.4);
    const sway = w.z.mul(0.45).add(w.w.mul(sin(uTime.mul(0.9).add(phase))).mul(0.55));
    const isStrand = kind.greaterThan(1.5).and(kind.lessThan(2.5));
    const swing = select(isStrand, hang.mul(hang).mul(sway.mul(0.9).add(0.12)).mul(1.3), float(0));
    const fl = sin(uTime.mul(2.6).add(phase).add(aCard.y.mul(1.7)).add(aCard.x)).mul(w.w.mul(0.06).add(0.02)).mul(uWindStrength.add(0.3));
    const flutter = select(isStrand, hang.mul(fl).mul(2.2), select(leafy, fl.mul(0.4).mul(h01), float(0))) as N;
    let wp = root.add(rotY(p.mul(scale), c, s)) as N;
    const wd = vec3(w.x, 0, w.y);
    wp = wp.add(wd.mul(sway.mul(h01.mul(h01)).mul(0.08).mul(scale).add(swing)))
      .add((vec3(w.y.negate(), 0, w.x) as N).mul(flutter));
    const n = rotY(normalLocal, c, s);
    normalLocal.assign(n);
    vN.assign(n);
    vSph.assign(rotY(aSph, c, s));
    vInfo.assign(vec4(kind, aInfo.z, seed, hang));
    vCol.assign(aCol);
    return wp;
  })();
  const kind = vInfo.x, depth = vInfo.y, seed = vInfo.z;
  const isBark = kind.lessThan(0.5), isPlum = kind.greaterThan(2.5);
  // haku-ume: some plums bloom white (the white sprays sit just below the pink ones in the atlas)
  const white = isPlum.and(fract(seed.mul(3.7)).lessThan(0.4));
  const uvn = (uv() as N).add(vec2(0, select(white, float(GARDEN_RECTS.plumWhite[1] - GARDEN_RECTS.plumPink[1]), float(0))));
  const tint = mix(vec3(0.92, 0.97, 0.9), vec3(1.08, 1.04, 0.94), fract(seed.mul(11.3)));
  const alb = leafAlbedo(atlas, uvn, vCol.mul(select(isBark, vec3(1), tint))) as N;
  const shade = select(isBark, float(1), depth.mul(0.45).add(0.55));
  m.colorNode = vec4(alb.rgb.mul(shade), alb.a);
  const nW: N = normalize(select(isBark, vN.mul(faceDirection), mix(vN.mul(faceDirection), vSph, 0.55)) as N);
  m.normalNode = normalize((cameraViewMatrix as N).mul(vec4(nW, float(0))).xyz);
  m.roughnessNode = select(isBark, float(0.9), float(0.62));
  m.aoNode = select(isBark, float(0.85), depth.mul(0.4).add(0.6));
  // willow strands glow only softly against the sun (they read neon at 0.62)
  m.translucencyNode = select(isBark, float(0), select(kind.greaterThan(1.5).and(kind.lessThan(2.5)), float(0.28), float(0.42)));
  m.translucencyTint = vec3(1.05, 1.1, 0.62);
  return m;
}

export interface GardenTree { species: 'willow' | 'pine' | 'plum'; x: number; y: number; z: number; yaw: number; scale: number; seed: number }

const STRIDE = 8;

interface Species {
  id: GardenTree['species'];
  height: number;
  radius: number;
  all: Float32Array;
  count: number;
  lods: { geo: BufferGeometry; inst: InstancedBufferGeometry; buf: InstancedInterleavedBuffer; data: Float32Array; mesh: Mesh; n: number }[];
}

/** where the garden trees stand: a few willows on the embankment lanes, pines and plums at the shrine, temple and weir */
export function planGarden(ctx: GameContext, heightAt: HeightFn): GardenTree[] {
  const out: GardenTree[] = [];
  const free = (x: number, z: number, r: number) => {
    for (const s of SITES) if (footprintDistance({ ...s, margin: r }, x, z) < 0) return false;
    if (ctx.world.has('path') && ctx.world.sample('path', x, z) > 0.35) return false;
    return true;
  };
  const clearOfCrossings = (s: number, side: -1 | 1) =>
    !DOCKS.some((d) => d.side === side && Math.abs(d.s - s) < 15) && !BRIDGES.some((b) => Math.abs(b.s - s) < b.deckWidth * 0.5 + 9);
  // the spawn landing (DOCKS[0]) opens the game: no willow curtains the view from the berth or just upstream
  const spawnView = (s: number, side: -1 | 1) => side === DOCKS[0].side && s > DOCKS[0].s - 35 && s < DOCKS[0].s + 60;
  const verandaNear = (s: number, side: -1 | 1) => SITES.some((q) => q.veranda && q.side === side && Math.abs((q.s ?? -1e9) - s) < (q.w ?? 8) / 2 + 3);
  const add = (species: GardenTree['species'], x: number, z: number, yaw: number, scale: number, seed: number) => {
    const y = heightAt(x, z);
    if (!Number.isFinite(y) || y < 0.5) return false;
    out.push({ species, x, y: y - 0.05, z, yaw, scale, seed });
    return true;
  };
  // accent willows lean over the water from the lane behind the embankment, one every 60-80 m per bank,
  // only where no house front stands behind them (gaps, precinct edges, bridge approaches)
  for (const side of [-1, 1] as const) {
    let next = 30;
    for (let s = 30; s < 668; s++) {
      if (s < next || !clearOfCrossings(s, side) || spawnView(s, side) || verandaNear(s, side)) continue;
      const h = hash1(Math.floor(s * 13), side + 11);
      const p = bankPoint(s, side, 1.7 + hash1(Math.floor(s), side + 7) * 0.6);
      if (!free(p.x, p.z, 0.8) || hidesFacade(p.x, p.z, 3, 6)) continue;
      const f = riverFrame(s);
      const yaw = Math.atan2(side * f.nz, -side * f.nx) + (h - 0.4) * 0.5;
      if (add('willow', p.x, p.z, yaw, 0.9 + h * 0.3, hash1(Math.floor(s * 3), side + 19))) next = s + 60 + hash1(s, side + 5) * 20;
    }
  }
  // garden groves: a token pine and plum beside the shrine (left, s 272) and the temple precinct (right,
  // s 372-470), off every facade line; the weir end, below the town, keeps its groves
  const groves: { s0: number; s1: number; side: -1 | 1; o0: number; o1: number; pines: number; plums: number }[] = [
    { s0: 252, s1: 300, side: -1, o0: 4, o1: 30, pines: 1, plums: 1 },
    { s0: 372, s1: 470, side: 1, o0: 4, o1: 38, pines: 2, plums: 1 },
    { s0: 10, s1: 56, side: -1, o0: 4, o1: 20, pines: 2, plums: 1 },
    { s0: 10, s1: 56, side: 1, o0: 4, o1: 20, pines: 2, plums: 1 },
  ];
  let seed = 1;
  for (const g of groves) {
    for (const [species, n] of [['pine', g.pines], ['plum', g.plums]] as const) {
      let placed = 0;
      for (let tries = 0; tries < n * 14 && placed < n; tries++) {
        seed++;
        const s = g.s0 + hash1(seed, 1) * (g.s1 - g.s0), off = g.o0 + hash1(seed, 2) * (g.o1 - g.o0);
        if (!clearOfCrossings(s, g.side)) continue;
        const p = bankPoint(s, g.side, off);
        if (!free(p.x, p.z, species === 'pine' ? 1.6 : 1.3)) continue;
        if (hidesFacade(p.x, p.z, 2, 6)) continue;
        if (out.some((t) => Math.hypot(t.x - p.x, t.z - p.z) < (t.species === 'willow' ? 3.5 : 4.5))) continue;
        if (ctx.world.normalAt(p.x, p.z).y < 0.85) continue;
        if (add(species, p.x, p.z, hash1(seed, 3) * 6.283, species === 'pine' ? 0.85 + hash1(seed, 4) * 0.35 : 0.9 + hash1(seed, 4) * 0.3, hash1(seed, 5))) placed++;
      }
    }
  }
  return out;
}

export class GardenTrees {
  root = new Group();
  species: Species[] = [];
  private frustum = new Frustum();
  private m4 = new Matrix4();
  private sphere = new Sphere();
  private shift = new Vector3();
  private trees: GardenTree[] = [];
  stats = { trees: 0, near: 0, far: 0 };
  ctx: GameContext;

  constructor(ctx: GameContext, trees: GardenTree[], atlas: Texture = gardenAtlas()) {
    this.ctx = ctx;
    this.root.name = 'garden-trees';
    this.root.matrixAutoUpdate = false;
    const material = gardenMaterial(atlas);
    const defs: { id: GardenTree['species']; build: (seed: number) => Builder; height: number; radius: number }[] = [
      { id: 'willow', build: buildWillow, height: 6, radius: 4.6 },
      { id: 'pine', build: buildPine, height: 5, radius: 2.6 },
      { id: 'plum', build: buildPlum, height: 4, radius: 2.4 },
    ];
    for (const d of defs) {
      const b = d.build(d.id === 'willow' ? 71 : d.id === 'pine' ? 23 : 47);
      const sp: Species = { id: d.id, height: d.height, radius: d.radius, all: new Float32Array(0), count: 0, lods: [] };
      for (const keep of [1.01, KEEP]) {
        const geo = b.geometry(keep);
        const data = new Float32Array(256 * STRIDE);
        const buf = new InstancedInterleavedBuffer(data, STRIDE, 1);
        buf.setUsage(DynamicDrawUsage);
        const inst = new InstancedBufferGeometry();
        inst.index = geo.index;
        for (const name of Object.keys(geo.attributes)) inst.setAttribute(name, geo.getAttribute(name));
        inst.setAttribute('aTreeA', new InterleavedBufferAttribute(buf, 4, 0));
        inst.setAttribute('aTreeB', new InterleavedBufferAttribute(buf, 4, 4));
        inst.instanceCount = 0;
        inst.boundingSphere = new Sphere(new Vector3(), 1e6);
        const mesh = new Mesh(inst, material);
        mesh.name = `garden-${d.id}-${keep > 1 ? 'near' : 'far'}`;
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.visible = false;
        this.root.add(mesh);
        sp.lods.push({ geo, inst, buf, data, mesh, n: 0 });
      }
      this.species.push(sp);
    }
    this.setTrees(trees);
  }

  setTrees(trees: GardenTree[]) {
    this.trees = trees;
    for (const sp of this.species) {
      const list = trees.filter((t) => t.species === sp.id);
      sp.count = list.length;
      sp.all = new Float32Array(Math.max(1, list.length) * STRIDE);
      list.forEach((t, i) => sp.all.set([t.x, t.y, t.z, t.yaw, t.scale, t.seed, 0, 0], i * STRIDE));
    }
    this.stats.trees = trees.length;
  }

  /** drop trees that a structure footprint published at runtime now covers */
  exclude(footprints: Footprint[]) {
    if (!footprints.length) return;
    this.setTrees(this.trees.filter((t) => !footprints.some((f) => footprintDistance(f, t.x, t.z) < 0.6)));
  }

  update(cam: Vector3) {
    const c = this.ctx.camera;
    this.m4.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m4);
    const sd = this.ctx.sun.direction;
    let near = 0, far = 0;
    for (const sp of this.species) {
      for (const l of sp.lods) l.n = 0;
      for (let i = 0; i < sp.count; i++) {
        const o = i * STRIDE, s = sp.all[o + 4];
        const x = sp.all[o], y = sp.all[o + 1], z = sp.all[o + 2];
        this.sphere.center.set(x, y + sp.height * 0.5 * s, z);
        this.sphere.radius = sp.radius * s;
        if (!this.frustum.intersectsSphere(this.sphere)) {
          // keep trees whose shadow can fall into view
          const len = (sp.height * s) / Math.max(0.25, sd.y);
          this.shift.set(x - sd.x * len * 0.6, y - sd.y * len * 0.6, z - sd.z * len * 0.6);
          this.sphere.center.copy(this.shift);
          this.sphere.radius = sp.radius * s + len * 0.5;
          if (!this.frustum.intersectsSphere(this.sphere)) continue;
        }
        // same point and threshold as the shader's morph: nearer than GARDEN_LOD is the near lod
        const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
        const l = sp.lods[d < GARDEN_LOD ? 0 : 1];
        if (l.n * STRIDE >= l.data.length) continue;
        l.data.set(sp.all.subarray(o, o + STRIDE), l.n * STRIDE);
        l.n++;
      }
      sp.lods.forEach((l, k) => {
        l.inst.instanceCount = l.n;
        l.mesh.visible = l.n > 0;
        if (l.n) {
          l.buf.needsUpdate = true;
          l.buf.clearUpdateRanges();
          l.buf.addUpdateRange(0, l.n * STRIDE);
        }
        if (k === 0) near += l.n; else far += l.n;
      });
    }
    this.stats.near = near;
    this.stats.far = far;
  }
}
