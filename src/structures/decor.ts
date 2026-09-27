// lived-in frontage for the first river reach. everything merges into the village sites' small
// buckets (main pass only: too small for the mirror or the shadow maps), so the whole reach adds only
// a few draws; the dyed banners are one mesh that stays in the mirror.
import { DoubleSide, Matrix4, Mesh, MeshStandardNodeMaterial, Vector3 } from 'three/webgpu';
import { attribute, float, mix, positionLocal, sin, smoothstep, uv, vec3 } from 'three/tsl';
import type { GameContext } from '../core/context';
import { uTime, uWindDir, uWindStrength } from '../core/uniforms';
import { LAYERS } from '../core/layers';
import { bankPoint, BRIDGES, DOCKS, riverFrame } from '../world/layout';
import { SITES, type Site as SiteDef } from '../world/sites';
import { smallOf, type Adder, type Site } from './builder';
import { Bucket, chamferBox, cylinder, lathe, poly, polyOut, rng, segment, torus, trs, type Part, type RGB } from './geom';
import type { Materials } from './materials';

const INK: RGB = [0.022, 0.052, 0.13];
const RED: RGB = [0.49, 0.064, 0.035];
const PAPER: RGB = [0.78, 0.68, 0.48];
const GREEN: RGB = [0.11, 0.22, 0.055];
// noren and banner dyes: indigo, madder red, ochre, moss green, pale indigo, plum
const NOREN: RGB[] = [INK, RED, [0.5, 0.3, 0.055], [0.07, 0.2, 0.09], [0.07, 0.16, 0.34], [0.3, 0.07, 0.16]];
// doorstep pot blooms: pink, crimson, white, yellow, violet
const BLOOMS: RGB[] = [[0.8, 0.3, 0.45], [0.62, 0.05, 0.08], [0.85, 0.83, 0.76], [0.8, 0.62, 0.06], [0.4, 0.2, 0.62]];
type At = (x: number, y: number, z: number, yaw?: number, pitch?: number, roll?: number) => Matrix4;
interface Leaf { add(part: Part, m: Matrix4, o?: { col?: RGB }): void }
interface Cluster { site: Adder; cloth: Bucket; leaf: Leaf }

export function clothMaterial() {
  const m = new MeshStandardNodeMaterial({ roughness: 0.94, side: DoubleSide });
  const a = attribute('aVar', 'vec4');
  const flutter = sin(positionLocal.x.mul(0.8).add(positionLocal.z.mul(0.47)).add(uTime.mul(1.6)).add(a.y.mul(6.28)))
    .mul(a.x).mul(uWindStrength).mul(0.1);
  m.positionNode = positionLocal.add(vec3(uWindDir.x.mul(flutter), flutter.mul(0.13), uWindDir.y.mul(flutter)));
  // a plain circular crest, not invented lettering
  const disc = float(1).sub(smoothstep(0.135, 0.155, uv().sub(vec3(0.5, 0.35, 0).xy).length())).mul(a.z);
  m.colorNode = mix(attribute('aCol', 'vec3'), vec3(0.78, 0.74, 0.61), disc);
  return m;
}

function blank(): Part { return { pos: [], nor: [], uv: [] }; }

export function cloth(bucket: Bucket, at: Matrix4, width: number, length: number, tint: RGB, seed: number, crest = true) {
  const rows = 5, cols = 4;
  const p = blank();
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const point = (x: number, y: number) => [width * (x / cols - 0.5), -length * y / rows, Math.sin(x / cols * Math.PI * 3 + seed) * 0.025 * y / rows];
    const ids = [[i, j], [i, j + 1], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i + 1, j]];
    for (const [x, y] of ids) {
      const q = point(x, y);
      p.pos.push(...q); p.nor.push(0, 0, 1); p.uv.push(x / cols, y / rows);
    }
  }
  const first = bucket.count;
  bucket.add(p, at, { col: tint, v: [0, seed, crest ? 1 : 0, 0] });
  for (let v = first; v < bucket.count; v++) bucket.vv[v * 4] = p.uv[(v - first) * 2 + 1] ** 2;
}

function rod(site: Adder, a: number[], b: number[], r: number, mat: 'timber' | 'bamboo' | 'rope' = 'bamboo', col: RGB = [0.9, 0.82, 0.66]) {
  const q = segment(a, b);
  site.add(mat, cylinder(r, r * 0.93, q.len, 6), q.m, { col });
}

function localRod(site: Adder, at: At, a: number[], b: number[], r: number, mat: 'timber' | 'bamboo' | 'rope' = 'bamboo', col?: RGB) {
  const A = new Vector3(...a).applyMatrix4(at(0, 0, 0));
  const B = new Vector3(...b).applyMatrix4(at(0, 0, 0));
  rod(site, A.toArray(), B.toArray(), r, mat, col);
}

function box(site: Adder, at: At, x: number, y: number, z: number, w: number, h: number, d: number, col: RGB = [0.8, 0.75, 0.64], mat: 'timber' | 'cedar' | 'lacquer' | 'dressed' = 'timber') {
  site.add(mat, chamferBox(w, h, d, Math.min(0.025, h / 6)), at(x, y, z), { col });
}

function lantern(site: Adder, at: Matrix4, tint: RGB, scale = 1) {
  const profile = [[0.09, -0.33], [0.16, -0.29], [0.23, -0.16], [0.25, 0.02], [0.225, 0.2], [0.15, 0.31], [0.085, 0.34]];
  const m = at.clone().scale(new Vector3(scale, scale, scale));
  site.add('paper', lathe(profile, 16), m, { col: tint, v: [0, 0, 0, 0.16] });
  for (const y of [-0.34, 0.33]) site.add('timber', cylinder(0.095, 0.095, 0.055, 12), m.clone().multiply(trs(0, y, 0)), { col: [0.32, 0.25, 0.2] });
  site.add('rope', cylinder(0.012, 0.012, 0.3, 5), m.clone().multiply(trs(0, 0.37, 0)), { col: [0.5, 0.43, 0.3] });
}

function garland(site: Adder, at: At, span: number, seed: number) {
  const top = 3.35;
  for (const x of [-span / 2, span / 2]) {
    localRod(site, at, [x, 0, 0], [x, top + 0.16, 0], 0.053, 'timber');
    box(site, at, x, 0.06, 0, 0.28, 0.12, 0.28, [0.58, 0.6, 0.56], 'dressed');
  }
  const y = (u: number) => top - Math.sin(u * Math.PI) * 0.37;
  for (let k = 0; k < 12; k++) localRod(site, at, [-span / 2 + span * k / 12, y(k / 12), 0], [-span / 2 + span * (k + 1) / 12, y((k + 1) / 12), 0], 0.009, 'rope');
  for (let i = 0; i < 4; i++) {
    const u = (i + 0.65) / 4.3;
    lantern(site, at(span * (u - 0.5), y(u) - 0.5, 0), (i + seed) % 3 === 0 ? RED : PAPER, 0.88);
  }
}

function chest(site: Adder, at: At, x: number, y: number, z: number, tint: RGB, size = 0.68) {
  box(site, at, x, y + size * 0.4, z, size, size * 0.8, size * 0.72, tint, 'cedar');
  for (const dy of [0.12, size * 0.65]) box(site, at, x, y + dy, z, size + 0.045, 0.045, size * 0.72 + 0.045, [0.6, 0.52, 0.36]);
  for (const dx of [-0.2, 0.2]) box(site, at, x + dx * size, y + size * 0.82, z, 0.035, 0.035, size * 0.8, [0.35, 0.3, 0.21]);
}

function bench(site: Adder, at: At, x: number, z: number, red = false) {
  for (const dx of [-0.69, 0.69]) for (const dz of [-0.19, 0.19]) box(site, at, x + dx, 0.21, z + dz, 0.1, 0.42, 0.1);
  for (const dz of [-0.18, 0, 0.18]) box(site, at, x, 0.47, z + dz, 1.8, 0.08, 0.16, red ? RED : [0.9, 0.8, 0.64], red ? 'lacquer' : 'timber');
}

function parasol(c: Cluster, at: At, x: number, z: number, tint: RGB, seed: number) {
  localRod(c.site, at, [x, 0, z], [x, 2.7, z], 0.035);
  box(c.site, at, x, 0.07, z, 0.45, 0.14, 0.45, [0.45, 0.44, 0.39], 'dressed');
  const n = 24, radius = 1.28;
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2, b = (i + 1) / n * Math.PI * 2;
    const p = blank();
    const P = (r: number, t: number, y: number) => [x + r * Math.cos(t), y, z + r * Math.sin(t)];
    polyOut(p, [P(0.06, a, 2.68), P(0.06, b, 2.68), P(radius * 0.55, b, 2.52), P(radius * 0.55, a, 2.52)], [0, 1, 0]);
    polyOut(p, [P(radius * 0.55, a, 2.52), P(radius * 0.55, b, 2.52), P(radius, b, 2.19), P(radius, a, 2.19)], [0, 1, 0]);
    c.cloth.add(p, at(0, 0, 0), { col: i % 6 === 0 ? PAPER : tint, v: [0, seed, 0, 0] });
    localRod(c.site, at, P(0.03, a, 2.61), P(radius, a, 2.18), 0.012);
  }
}

function fence(site: Adder, at: At, x: number, z: number, len: number, h = 0.95) {
  for (let dx = -len / 2; dx <= len / 2; dx += 0.13) localRod(site, at, [x + dx, 0.02, z], [x + dx, h + 0.035 * Math.sin(dx * 14), z], 0.029);
  for (const y of [0.24, h - 0.13]) localRod(site, at, [x - len / 2 - 0.06, y, z - 0.035], [x + len / 2 + 0.06, y, z - 0.035], 0.04);
}

function planter(c: Cluster, at: At, x: number, z: number, seed: number) {
  const R = rng(seed);
  c.leaf.add(lathe([[0.27, 0], [0.34, 0.04], [0.39, 0.42], [0.43, 0.46], [0.43, 0.51], [0.34, 0.51], [0.33, 0.44], [0.2, 0.12]], 16), at(x, 0, z), { col: [0.24, 0.095, 0.053] });
  for (let k = 0; k < 6; k++) {
    const a = R() * Math.PI * 2;
    const xx = x + Math.cos(a) * 0.25, zz = z + Math.sin(a) * 0.25, y = 0.78 + R() * 0.6;
    localRod(c.site, at, [x, 0.42, z], [xx, y, zz], 0.012, 'timber');
    for (let j = 0; j < 8; j++) {
      const leaf = blank(), t = j * 2.4 + a, r = 0.15 + R() * 0.12;
      const p = [xx + Math.cos(t) * r, y + (R() - 0.5) * 0.28, zz + Math.sin(t) * r];
      const w = 0.1;
      poly(leaf, [[p[0] - w, p[1], p[2]], [p[0], p[1] + 0.045, p[2] + w * 0.8], [p[0] + w, p[1], p[2]], [p[0], p[1] - 0.025, p[2] - w * 0.8]], 'y', [0, 1, 0]);
      c.leaf.add(leaf, at(0, 0, 0), { col: j % 4 ? GREEN : [0.21, 0.32, 0.08] });
      if (j % 3 === 0) c.leaf.add(lathe([[0, -0.035], [0.055, 0], [0.025, 0.05], [0, 0.065]], 6), at(p[0], p[1] + 0.03, p[2]), { col: seed % 2 ? [0.74, 0.32, 0.42] : [0.82, 0.72, 0.55] });
    }
  }
}

function stoneLantern(c: Cluster, at: At) {
  const col: RGB = [0.5, 0.52, 0.46];
  c.site.add('dressed', lathe([[0.38, 0], [0.4, 0.14], [0.22, 0.2], [0.12, 0.3], [0.12, 0.95], [0.26, 1.02], [0.27, 1.12]], 8), at(0, 0, 0), { col });
  for (const x of [-0.19, 0.19]) for (const z of [-0.19, 0.19]) box(c.site, at, x, 1.32, z, 0.09, 0.4, 0.09, col, 'dressed');
  c.site.add('paper', chamferBox(0.21, 0.3, 0.21), at(0, 1.32, 0), { col: PAPER, v: [0, 0, 0, 0.12] });
  c.site.add('dressed', lathe([[0.42, 1.5], [0.45, 1.56], [0.34, 1.61], [0.17, 1.8], [0.07, 1.84], [0.07, 1.96], [0, 2.02]], 8), at(0, 0, 0), { col });
}

/** a row of glazed pots with flowering plants along a facade base (the kyoto doorstep garden) */
function doorPots(c: Cluster, at: At, x0: number, x1: number, z: number, seed: number) {
  const R = rng(seed);
  const pot: RGB[] = [[0.2, 0.12, 0.08], [0.1, 0.16, 0.2], [0.26, 0.1, 0.05]];
  for (let x = x0; x <= x1; x += 0.46 + R() * 0.12) {
    const h = 0.22 + R() * 0.16, r = 0.13 + R() * 0.05;
    c.leaf.add(lathe([[r * 0.7, 0], [r, h * 0.2], [r * 1.08, h * 0.9], [r * 1.12, h], [r * 0.9, h]], 10), at(x, 0, z), { col: pot[Math.floor(R() * 3)] });
    const bloom = BLOOMS[Math.floor(R() * BLOOMS.length)];
    for (let k = 0; k < 5; k++) {
      const a = R() * Math.PI * 2, rr = R() * r * 0.9;
      const p = [x + Math.cos(a) * rr, h + 0.1 + R() * 0.22, z + Math.sin(a) * rr];
      const leaf = blank();
      const w = 0.07;
      poly(leaf, [[p[0] - w, p[1] - 0.05, p[2]], [p[0], p[1] - 0.02, p[2] + w], [p[0] + w, p[1] - 0.05, p[2]], [p[0], p[1] - 0.08, p[2] - w]], 'y', [0, 1, 0]);
      c.leaf.add(leaf, at(0, 0, 0), { col: GREEN });
      c.leaf.add(lathe([[0, -0.03], [0.05, 0], [0.03, 0.04], [0, 0.05]], 6), at(p[0], p[1], p[2]), { col: bloom });
    }
  }
}

/** a free-standing painted signboard: lacquered frame, a pale panel and a coloured mark (no lettering) */
function kanban(site: Adder, at: At, x: number, z: number, frame: RGB, mark: RGB) {
  box(site, at, x, 0.85, z, 0.5, 1.7, 0.1, frame, 'lacquer');
  box(site, at, x, 0.95, z + 0.055, 0.36, 1.3, 0.02, [0.86, 0.78, 0.58], 'lacquer');
  site.add('lacquer', chamferBox(0.2, 0.2, 0.03, 0.01), at(x, 1.35, z + 0.07, 0, 0, Math.PI / 4), { col: mark });
  box(site, at, x, 0.05, z, 0.62, 0.1, 0.3, [0.4, 0.3, 0.22]);
}

/** decorations remain on land and outside the usable dock and bridge approaches */
function clearApproach(s: number, side: -1 | 1) {
  return !DOCKS.some(d => d.side === side && Math.abs(d.s - s) < 13)
    && !BRIDGES.some(b => Math.abs(b.s - s) < b.deckWidth / 2 + 7);
}

export function createFrontageDecor(ctx: GameContext, mats: Materials, siteFor: (s: number) => Site) {
  const cloths = new Bucket();
  const clusters = new Map<Site, Cluster>();
  const placements: { kind: string; s: number; side: number }[] = [];
  const take = (s: number, _x: number, _y: number, _z: number) => {
    const target = siteFor(s);
    let c = clusters.get(target);
    if (!c) {
      const site = smallOf(target);
      c = { site, cloth: cloths, leaf: { add: (part, m, o) => site.add('plain', part, m, o) } };
      clusters.set(target, c);
    }
    return c;
  };
  const frame = (s: number, side: -1 | 1, offset: number, y?: number) => {
    const p = bankPoint(s, side, offset), f = p.frame;
    const ground = y ?? ctx.world.heightAt(p.x, p.z);
    const base = trs(p.x, Math.max(0.7, ground), p.z, Math.atan2(-side * f.nx, -side * f.nz));
    const at: At = (x, y, z, yaw = 0, pitch = 0, roll = 0) => base.clone().multiply(trs(x, y, z, yaw, pitch, roll));
    return { p, y: Math.max(0.7, ground), at };
  };

  // shop displays face the water; every third frontage becomes a little tea stall.
  for (const sd of SITES) {
    if (sd.s === undefined || !sd.side || sd.s > 700 || !sd.w || !sd.front || sd.front > 10 || !clearApproach(sd.s, sd.side)) continue;
    if (!['shop', 'machiya', 'machiya-low', 'kura'].includes(sd.kind || '')) continue;
    const { p, at, y } = frame(sd.s, sd.side, Math.max(1.7, sd.front - 1.25), sd.y);
    const c = take(sd.s, p.x, y, p.z);
    const seed = Math.round(sd.s * 17 + (sd.side + 1) * 23), R = rng(seed);
    const kind = sd.kind === 'shop' ? 0 : seed % 3;
    const width = Math.min(5.5, sd.w - 0.7);
    garland(c.site, at, width, seed);
    const signX = width / 2 + 0.25;
    localRod(c.site, at, [signX, 0, 0.55], [signX, 3.1, 0.55], 0.033);
    localRod(c.site, at, [signX - 0.53, 3.02, 0.55], [signX + 0.04, 3.02, 0.55], 0.025);
    const dye = NOREN[seed % NOREN.length];
    cloth(c.cloth, at(signX - 0.23, 2.98, 0.55), 0.47, 1.9, dye, R());
    // flowering pots along the facade base
    doorPots(c, at, -width / 2 + 0.3, -width / 2 + 0.3 + Math.min(1.6, width * 0.3), -0.95, seed + 5);
    if (kind === 0) {
      // open tea counter, slatted trays and bound chests
      box(c.site, at, -0.6, 0.81, 0.4, 2.25, 0.11, 0.78);
      for (const x of [-1.45, 0.25]) box(c.site, at, x, 0.4, 0.4, 0.1, 0.8, 0.65);
      for (let i = 0; i < 3; i++) {
        chest(c.site, at, -1.3 + i * 0.74, 0.88, 0.43, [0.75 + i * 0.1, 0.75, 0.58], 0.55);
        cloth(c.cloth, at(-1.33 + i * 0.73, 2.55, 0.12), 0.7, 0.74, NOREN[(seed + i * 2) % NOREN.length], R(), i === 1);
      }
      kanban(c.site, at, -width / 2 - 0.35, 1.0, seed % 2 ? [0.05, 0.04, 0.035] : RED, NOREN[(seed + 1) % NOREN.length]);
      chest(c.site, at, 1.05, 0, 0.5, [0.8, 0.72, 0.5]);
      chest(c.site, at, 1.08, 0.57, 0.5, [0.68, 0.67, 0.54], 0.56);
      parasol(c, at, -1.9, 1.45, RED, R());
      bench(c.site, at, -0.35, 1.65, true);
    } else if (kind === 1) {
      // a basket maker's low display and bamboo screen
      bench(c.site, at, -0.5, 0.7);
      for (let i = 0; i < 3; i++) {
        const m = at(-1.15 + i * 0.58, 0.51, 0.73, i * 0.2);
        c.site.add('bamboo', lathe([[0.15, 0], [0.24, 0.08], [0.28, 0.32], [0.29, 0.38], [0.24, 0.38], [0.2, 0.12]], 12), m, { col: [0.95, 0.78, 0.45] });
        c.site.add('rope', torus(0.22, 0.018, Math.PI, 10, 5), m.clone().multiply(trs(0, 0.36, 0, 0, Math.PI / 2)), { col: [0.7, 0.56, 0.31] });
      }
      fence(c.site, at, 1.65, 0.15, 1.4, 1.2);
      planter(c, at, -width / 2 - 0.3, 0.5, seed);
      kanban(c.site, at, width / 2 + 0.5, 0.9, [0.05, 0.04, 0.035], NOREN[(seed + 2) % NOREN.length]);
    } else {
      // domestic frontage: indigo drying cloth, a bench and paired potted shrubs
      localRod(c.site, at, [-1.1, 2.0, 0.2], [1.1, 2.0, 0.2], 0.028);
      for (const x of [-0.76, 0, 0.76]) cloth(c.cloth, at(x, 1.96, 0.2), 0.6, 0.9, x === 0 ? PAPER : NOREN[(seed + (x > 0 ? 3 : 0)) % NOREN.length], R(), false);
      bench(c.site, at, 0, 1.15);
      planter(c, at, -1.9, 0.75, seed);
      planter(c, at, 1.85, 0.75, seed + 1);
    }
    placements.push({ kind: ['tea-shop', 'basket-display', 'domestic-frontage'][kind], s: sd.s, side: sd.side });
  }

  // small authored pauses fill the stretches between buildings, without decorating the whole world.
  const gardens: [number, -1 | 1, number][] = [
    [42, -1, 0], [61, 1, 1], [108, 1, 2], [174, 1, 0], [211, 1, 1], [252, -1, 2],
    [278, 1, 0], [322, 1, 2], [350, -1, 0], [365, 1, 1], [386, -1, 2],
    [417, -1, 0], [483, 1, 0], [518, -1, 2], [555, 1, 1], [596, -1, 0], [634, 1, 2], [658, -1, 1],
  ];
  for (const [s, side, kind] of gardens) {
    if (!clearApproach(s, side) || placements.some(p => p.side === side && Math.abs(p.s - s) < 5.5)) continue;
    const { p, y, at } = frame(s, side, 2.8);
    if (y > 8 || ctx.world.heightAt(p.x, p.z) < 0.25) continue;
    const c = take(s, p.x, y, p.z);
    if (kind === 0) {
      parasol(c, at, -0.8, 0, s % 2 ? INK : RED, s / 1000);
      bench(c.site, at, 0.55, 0.1, true);
      planter(c, at, 2, 0.1, s);
      fence(c.site, at, 0, -1.25, 4.7, 0.9);
    } else if (kind === 1) {
      stoneLantern(c, (x, yy, z, a, b, d) => at(x - 1.4, yy, z, a, b, d));
      fence(c.site, at, 0.8, -0.65, 2.7, 1.05);
      planter(c, at, 1.15, 0.3, s);
      // garden threshold stones
      for (let j = 0; j < 4; j++) box(c.site, at, -0.3 + Math.sin(j) * 0.15, 0.03, 0.8 - j * 0.5, 0.56, 0.1, 0.38, [0.66, 0.67, 0.59], 'dressed');
    } else {
      garland(c.site, at, 3.3, s);
      for (const x of [-1.4, 1.4]) planter(c, at, x, -0.2, s + x * 10);
      bench(c.site, at, 0, 0.45);
    }
    placements.push({ kind: ['tea-garden', 'lantern-garden', 'lantern-rest'][kind], s, side });
  }

  // the banners flutter in the vertex shader: one mesh for the reach, reflected, no shadow
  let mesh: Mesh | null = null;
  if (!cloths.finite()) console.error('[structures] non-finite frontage cloth');
  else {
    const geo = cloths.build();
    if (geo) {
      geo.boundingSphere!.radius += 0.5;
      mesh = new Mesh(geo, clothMaterial());
      mesh.name = 'structures:frontage-cloth';
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      ctx.scene.add(mesh);
    }
    cloths.clear();
  }
  void mats;
  const triangles = mesh ? mesh.geometry.attributes.position.count / 3 : 0;
  return { mesh, placements, stats: () => ({ sites: clusters.size, placements: placements.length, clothTriangles: triangles }) };
}
