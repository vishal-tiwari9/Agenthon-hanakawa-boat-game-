// the town behind the waterfront (s 55-670): paved inland streets and cross lanes hung with lanterns,
// street houses and shops facing them from both sides, a temple and a shrine precinct, a sake
// brewery, a festival lane of yatai stalls, koi gardens, flooded paddies, tea rows, fire towers and
// the small lived-in things (jizo, laundry, drying persimmons, umbrellas drying in a yard).
// static geometry merges into the village sites' material buckets, so shared materials cost no extra
// draws; fluttering cloth, swaying lanterns and pond water are one mesh each and skip the mirror.
import { DoubleSide, Group, Matrix4, Mesh, MeshStandardNodeMaterial, Vector3 } from 'three/webgpu';
import { abs, attribute, cos, float, mix, mx_noise_float, positionGeometry, positionWorld, sin, smoothstep, step, vec3 } from 'three/tsl';
import { uTime } from '../core/uniforms';
import type { GameContext } from '../core/context';
import { LAYERS } from '../core/layers';
import { nearestRiver, riverFrame } from '../world/layout';
import { LANES, STREET_HALF, STREET_Q, TOWN, type Lane, type Site as SiteDef } from '../world/sites';
import type { MatKey, Site } from './builder';
import { Bucket, chamferBox, cylinder, lathe, poly, polyOut, rng, segment, trs, type Part, type RGB } from './geom';
import type { Materials } from './materials';
import { gableTri, roof } from './roofs';
import { inuyarai, koshi, slatCol, taru } from './machiya';
import { toro, torii } from './shrine';
import { buildHall } from './temple';
import { cloth, clothMaterial } from './decor';
import { body, crowd, crowdCommit, crowdSet, hangLantern } from './life';

type At = (x: number, y: number, z: number, yaw?: number, pitch?: number, roll?: number) => Matrix4;

export interface Spot { x: number; y: number; z: number; yaw: number }
export interface Pond { x: number; z: number; y: number; ax: number; az: number; rx: number; rz: number }
export interface TownService {
  /** crowd spots (yaw in the crowd convention: the creature faces -z rotated by yaw) */
  cats: Spot[];
  birds: Spot[];
  standing: Spot[];
  seated: Spot[];
  /** strolling routes along the inland streets */
  walks: { side: -1 | 1; s0: number; s1: number; offset: number }[];
  ponds: Pond[];
  /** lantern geometry for the swaying mesh built by the river life */
  sway?: Bucket;
  stats: Record<string, number>;
}

const INK: RGB = [0.022, 0.052, 0.13];
const RED: RGB = [0.49, 0.064, 0.035];
const PAPER: RGB = [0.78, 0.68, 0.48];
const VER: RGB = [0.5, 0.058, 0.026];
const WHITE: RGB = [1.02, 1.0, 0.97];
const NOREN: RGB[] = [INK, RED, [0.5, 0.3, 0.055], [0.07, 0.2, 0.09], [0.07, 0.16, 0.34], [0.3, 0.07, 0.16], [0.74, 0.7, 0.6]];
// plaster finishes, as on the waterfront: warm cream, earthen ochre, pale apricot, crisp white
const TONES: RGB[] = [[1.0, 0.95, 0.84], [0.98, 0.8, 0.56], [1.02, 0.88, 0.74], [1.0, 0.99, 0.96], [1.0, 0.95, 0.84]];
const LEAF: RGB = [0.055, 0.115, 0.036];
const MOSS: RGB = [0.05, 0.095, 0.03];
const TEA: RGB = [0.085, 0.175, 0.038];
const HEDGE: RGB = [0.045, 0.1, 0.032];
const LEVEE: RGB = [0.085, 0.13, 0.042];
// clipped satsuki azaleas in flower: magenta, pink, pale, and plain green
const AZALEA: RGB[] = [[0.55, 0.08, 0.25], [0.78, 0.28, 0.42], [0.8, 0.6, 0.66], LEAF, LEAF];
const WAGASA: RGB[] = [[0.5, 0.06, 0.03], [0.05, 0.1, 0.32], [0.6, 0.4, 0.06], [0.36, 0.08, 0.22], [0.76, 0.7, 0.58], [0.05, 0.22, 0.2]];
const STONE: RGB = [0.9, 0.9, 0.88];
const BRONZE: RGB = [0.16, 0.11, 0.06];
const SHOP_DYE: Record<string, RGB> = {
  chaya: RED, sweets: [0.78, 0.5, 0.52], soba: INK, pottery: [0.5, 0.3, 0.055], umbrella: [0.3, 0.07, 0.16],
  rice: [0.74, 0.7, 0.6], fans: [0.07, 0.16, 0.34],
};

interface T {
  ctx: GameContext;
  cloth: Bucket;
  sway: Bucket;
  pond: Bucket;
  svc: TownService;
  seed: number;
  n: Record<string, number>;
}

function count(t: T, k: string, n = 1) { t.n[k] = (t.n[k] ?? 0) + n; }

/** three.js yaw so local +z faces the river from a bank at s */
function yawFacing(s: number, side: -1 | 1) {
  const f = riverFrame(s);
  return Math.atan2(-side * f.nx, -side * f.nz);
}

function frame(x: number, y: number, z: number, yaw: number): At {
  const base = trs(x, y, z, yaw);
  return (lx, ly, lz, a = 0, b = 0, c = 0) => base.clone().multiply(trs(lx, ly, lz, a, b, c));
}

const wp = (m: Matrix4): [number, number, number] => [m.elements[12], m.elements[13], m.elements[14]];

/** crowd yaw for a creature at site yaw Y facing local direction a (0 = local +z) */
const faceYaw = (Y: number, a = 0) => Y + a + Math.PI;

function spot(list: Spot[], at: At, Y: number, x: number, y: number, z: number, a = 0) {
  const [px, py, pz] = wp(at(x, y, z));
  list.push({ x: px, y: py, z: pz, yaw: faceYaw(Y, a) });
}

function bx(site: Site, mat: MatKey, at: At, sx: number, sy: number, sz: number, x: number, y: number, z: number, col?: RGB, small = false, yaw = 0, v?: [number, number, number, number]) {
  site.add(mat, chamferBox(sx, sy, sz, 0), at(x, y, z, yaw), { col, v }, small);
}

function rod(site: Site, mat: MatKey, a: number[], b: number[], r: number, col?: RGB, small = false, seg = 6) {
  const q = segment(a, b);
  site.add(mat, cylinder(r, r * 0.92, q.len, seg, false), q.m, { col }, small);
}

// cached small parts (built once, placed many times)
const cache = new Map<string, Part>();
function part(key: string, make: () => Part): Part {
  let p = cache.get(key);
  if (!p) cache.set(key, (p = make()));
  return p;
}
const ball = (r: number, seg = 8) => part(`ball${r}:${seg}`, () => {
  const prof: number[][] = [];
  for (let i = 0; i <= 5; i++) { const a = -Math.PI / 2 + (i / 5) * Math.PI; prof.push([Math.max(0.001, Math.cos(a) * r), Math.sin(a) * r]); }
  return lathe(prof, seg);
});
/** a clipped shrub mound (azalea, box) of radius r and height h */
const mound = (r: number, h: number) => part(`mound${r}:${h}`, () => {
  const prof: number[][] = [[r * 0.9, 0], [r, h * 0.3], [r * 0.9, h * 0.65], [r * 0.6, h * 0.9], [0.001, h]];
  return lathe(prof, 10);
});
const rock = (r: number, h: number, k: number) => part(`rock${r}:${h}:${k}`, () => {
  const R = rng(k * 31 + 7);
  const prof: number[][] = [[r * 0.95, -0.15], [r, h * 0.2], [r * (0.8 + R() * 0.15), h * 0.65], [r * 0.4, h * 0.95], [0.001, h]];
  return lathe(prof, 7, false);
});

function lantern(t: T, m: Matrix4, hang: number, tint: RGB, scale = 1) {
  const [x, y, z] = wp(m);
  hangLantern(t.sway, x, y, z, y + hang, tint, (t.seed++ * 0.618) % 1, scale);
  count(t, 'lanterns');
}

/** noren: `strips` dyed cloth strips hanging from a rod at m (top edge), width across */
function noren(t: T, site: Site, m: Matrix4, width: number, len: number, strips: number, tint: RGB, crest = true) {
  const sw = width / strips - 0.03;
  for (let i = 0; i < strips; i++) {
    const x = -width / 2 + (width * (i + 0.5)) / strips;
    cloth(t.cloth, m.clone().multiply(trs(x, 0, 0)), sw, len, tint, (t.seed++ * 0.37) % 1, crest && i === Math.floor(strips / 2));
  }
  site.add('dark', cylinder(0.015, 0.015, width + 0.2, 6, false), m.clone().multiply(trs(-width / 2 - 0.1, 0.02, 0, 0, 0, -Math.PI / 2)), { col: [0.1, 0.08, 0.05] }, true);
}

/** a jizo in a red bib and cap on a small plinth, facing local +z */
function jizo(site: Site, at: At, x: number, z: number, yaw = 0, s = 1) {
  const m = at(x, 0, z, yaw).multiply(trs(0, 0, 0, 0, 0, 0, s, s, s));
  site.add('dressed', chamferBox(0.42, 0.2, 0.36, 0), m.clone().multiply(trs(0, 0.1, 0)), { col: [0.85, 0.85, 0.82] }, true);
  site.add('dressed', part('jizo-body', () => lathe([[0.001, 0.2], [0.15, 0.2], [0.16, 0.35], [0.15, 0.55], [0.12, 0.68], [0.06, 0.72], [0.001, 0.72]], 8)), m, { col: [0.78, 0.78, 0.74] }, true);
  site.add('dressed', ball(0.1), m.clone().multiply(trs(0, 0.8, 0)), { col: [0.8, 0.8, 0.76] }, true);
  // yodarekake bib and a knitted cap
  site.add('plain', part('jizo-bib', () => lathe([[0.2, 0.44], [0.17, 0.56], [0.1, 0.66], [0.001, 0.68]], 10)), m.clone().multiply(trs(0, 0, 0.02)), { col: [0.55, 0.05, 0.035] });
  site.add('plain', part('jizo-cap', () => lathe([[0.105, 0], [0.1, 0.06], [0.06, 0.1], [0.001, 0.12]], 8)), m.clone().multiply(trs(0, 0.84, 0)), { col: [0.55, 0.05, 0.035] });
}

/** a pot of flowers or a clipped plant at local (x, z) */
function pot(site: Site, at: At, x: number, z: number, R: () => number) {
  const h = 0.26 + R() * 0.16, r = 0.15 + R() * 0.06;
  const glaze: RGB[] = [[0.2, 0.12, 0.08], [0.1, 0.16, 0.2], [0.26, 0.1, 0.05], [0.4, 0.38, 0.32]];
  site.add('plain', lathe([[r * 0.7, 0], [r, h * 0.2], [r * 1.08, h * 0.9], [r * 1.12, h], [r * 0.9, h]], 10), at(x, 0, z), { col: glaze[Math.floor(R() * 4)] });
  site.add('foliage', mound(r * 1.5, 0.35 + R() * 0.25), at(x, h - 0.04, z), { col: AZALEA[Math.floor(R() * AZALEA.length)] });
}

/** open wagasa umbrella (paper canopy on bamboo ribs), canopy apex at the origin, opening down */
function wagasa(site: Site, m: Matrix4, col: RGB, r = 0.62) {
  site.add('plain', part(`wagasa${r}`, () => lathe([[0.001, 0], [r * 0.2, -0.03], [r * 0.7, -0.14], [r, -0.26], [r * 1.01, -0.27]], 16)), m, { col });
  // the ring of white paper near the rim that every wagasa has
  site.add('plain', part(`wagasa-ring${r}`, () => lathe([[r * 0.8, -0.195], [r * 0.9, -0.23], [r * 0.905, -0.232]], 16)), m.clone().multiply(trs(0, 0.004, 0)), { col: [0.72, 0.68, 0.58] });
  site.add('plain', part('wagasa-shaft', () => cylinder(0.012, 0.012, 0.85, 5, false)), m.clone().multiply(trs(0, -0.85, 0)), { col: [0.5, 0.38, 0.2] });
}

/** a laundry line on bamboo trestles between local x0..x1 at depth z, with dyed cloths */
function laundry(t: T, site: Site, at: At, x0: number, x1: number, z: number) {
  for (const x of [x0, x1]) {
    for (const s of [-1, 1]) {
      const [ax, ay, az] = wp(at(x, 0, z + s * 0.35));
      const [bx_, by, bz] = wp(at(x, 2.05, z));
      rod(site, 'bamboo', [ax, ay, az], [bx_, by, bz], 0.025, [0.95, 0.85, 0.6], true);
    }
  }
  const [ax, ay, az] = wp(at(x0 - 0.2, 2.0, z)), [bx_, by, bz] = wp(at(x1 + 0.2, 2.0, z));
  rod(site, 'bamboo', [ax, ay, az], [bx_, by, bz], 0.022, [0.95, 0.85, 0.6], true);
  const dyes: RGB[] = [INK, [0.74, 0.7, 0.6], [0.07, 0.16, 0.34], [0.55, 0.3, 0.3], [0.3, 0.07, 0.16], [0.7, 0.66, 0.5]];
  const n = Math.max(2, Math.floor((x1 - x0) / 0.85));
  for (let i = 0; i < n; i++) {
    const x = x0 + ((i + 0.5) * (x1 - x0)) / n;
    const w = 0.5 + ((t.seed * 7 + i) % 3) * 0.12;
    cloth(t.cloth, at(x, 1.98, z), w, 0.7 + (i % 2) * 0.35, dyes[(t.seed + i) % dyes.length], (t.seed++ * 0.29) % 1, false);
  }
  count(t, 'laundry');
}

/** hoshigaki: strings of persimmons drying under an eave, along local x at depth z, top at y */
function persimmons(site: Site, at: At, x0: number, x1: number, y: number, z: number) {
  const n = Math.max(2, Math.round((x1 - x0) / 0.32));
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / Math.max(1, n - 1);
    site.add('rope', cylinder(0.006, 0.006, 1.05, 3, false), at(x, y - 1.05, z), { col: [0.55, 0.45, 0.3] }, true);
    for (let k = 0; k < 7; k++) site.add('plain', ball(0.045, 6), at(x, y - 0.12 - k * 0.135, z), { col: [0.62, 0.2, 0.02] });
  }
}

// ---------------------------------------------------------------------------------------------
// street houses: a cheap machiya (one to three hundred triangles of walls plus a lite roof). the
// local frame has its origin at the footprint center on the ground and +z out of the facade.

const SHOPS = new Set(Object.keys(SHOP_DYE));

function townhouse(t: T, site: Site, at: At, Y: number, w: number, d: number, role: string, R: () => number) {
  const hw = w / 2, hd = d / 2, fz = hd;
  const tone = TONES[Math.floor(R() * TONES.length)];
  const white: RGB = [tone[0] * (0.97 + R() * 0.05), tone[1] * (0.97 + R() * 0.04), tone[2] * (0.95 + R() * 0.05)];
  const gr = 0.5 + R() * 0.4, gs = R();
  const bengara: RGB | undefined = R() < 0.3 ? [1.35, 0.62, 0.42] : undefined;
  const tiles: RGB = R() < 0.5 ? [0.95, 1, 1.06] : [1.05, 1, 0.95];
  bx(site, 'dressed', at, w + 0.1, 0.45, d + 0.1, 0, -0.05, 0, [0.85, 0.85, 0.84]);
  if (role === 'kura') { kuraBody(site, at, w, d, white, R, tiles, gr, gs); count(t, 'kura'); return; }
  const shop = SHOPS.has(role);
  const one = role === 'one';
  const low = role === 'low';
  const G = 3.0;
  const H2 = one ? 0 : low ? 1.9 : 2.5;
  const eaveY = one ? G + 0.25 : G + 0.35 + H2;
  bx(site, 'cedar', at, w - 0.04, G + 0.1, d - 0.3, 0, (G + 0.1) / 2 + 0.15, -0.15);
  if (!one) bx(site, 'plaster', at, w, H2 + 0.35, d - 0.1, 0, G + (H2 + 0.35) / 2, -0.05, white, false, 0, [gr * 0.4, gs, 1.2 + G, 0]);
  for (const sx of [-1, 1]) bx(site, 'timber', at, 0.15, eaveY, 0.15, sx * (hw - 0.075), eaveY / 2, fz - 0.06);
  bx(site, 'timber', at, w + 0.1, 0.24, 0.2, 0, G - 0.05, fz - 0.05);

  if (shop) shopFront(t, site, at, Y, w, fz, G, role, R);
  else {
    const doorW = 1.7;
    const doorX = (R() < 0.5 ? -1 : 1) * (hw - doorW / 2 - 0.45);
    bx(site, 'dark', at, doorW - 0.1, G - 0.4, 0.02, doorX, (G - 0.4) / 2 + 0.1, fz - 0.35, [0.02, 0.018, 0.016]);
    bx(site, 'timber', at, doorW / 2, 2.1, 0.05, doorX - doorW / 4 + 0.2, 1.15, fz - 0.2);
    site.add('koshi', chamferBox(doorW / 2 - 0.14, 1.3, 0.02, 0), at(doorX - doorW / 4 + 0.2, 1.35, fz - 0.17), { col: slatCol(), v: [(doorW / 2 - 0.14) / 5, 0.14, 0.8, 0], uvo: [0.1, 0] });
    const d0 = doorX - doorW / 2, d1 = doorX + doorW / 2;
    const bays: [number, number][] = [];
    if (d0 + hw > 0.8) bays.push([-hw + 0.15, d0 - 0.05]);
    if (hw - d1 > 0.8) bays.push([d1 + 0.05, hw - 0.15]);
    for (const [x0, x1] of bays) {
      koshi(site, at, x0, x1, 0.45, 2.33, fz - 0.08, R, bengara);
      bx(site, 'timber', at, x1 - x0, 0.3, 0.12, (x0 + x1) / 2, 0.3, fz - 0.1);
      if (R() < 0.3) inuyarai(site, at, x0 + 0.1, x1 - 0.1, fz - 0.02);
    }
    noren(t, site, at(doorX, G - 0.3, fz + 0.06), doorW - 0.1, 0.95, 3, NOREN[Math.floor(R() * NOREN.length)]);
    if (R() < 0.55) lantern(t, at(doorX + (doorX > 0 ? -1 : 1) * (doorW / 2 + 0.35), G - 0.3, fz + 0.45), 0.25, R() < 0.5 ? PAPER : RED, 0.72);
    if (R() < 0.45) for (let i = 0; i < 3; i++) pot(site, at, (doorX > 0 ? -1 : 1) * (0.4 + i * 0.5), fz + 0.35, R);
  }

  if (!one) {
    roof(site, at(0, 0, fz - 0.1), { ex: hw + 0.1, ez: 1.0, tx: hw + 0.1, tz: 0, y0: G + 0.12, rise: 0.4, sides: [0], gable: true, verge: 0.12, ridge: false, rafters: false, thick: 0.14, sweep: 0.3, lite: true, verges: false, col: tiles });
    const uy0 = G + 0.35, uy1 = eaveY - 0.2;
    if (low) {
      // mushiko-mado: thick plastered bars (wide enough to stay put at a distance)
      const mw = Math.min(2.2, w * 0.36), mh = 0.7, cy = (uy0 + uy1) / 2 + 0.05;
      for (const cx of w > 7 ? [-w * 0.22, w * 0.22] : [0]) {
        bx(site, 'dark', at, mw, mh, 0.02, cx, cy, fz - 0.17, [0.03, 0.028, 0.025]);
        const n = Math.max(6, Math.round(mw / 0.16));
        for (let i = 0; i <= n; i++) bx(site, 'plaster', at, 0.075, mh, 0.1, cx - mw / 2 + (mw * i) / n, cy, fz - 0.07, white);
        bx(site, 'plaster', at, mw + 0.3, 0.1, 0.16, cx, cy + mh / 2 + 0.05, fz - 0.05, white);
        bx(site, 'plaster', at, mw + 0.3, 0.1, 0.18, cx, cy - mh / 2 - 0.05, fz - 0.05, white);
      }
    } else {
      const ww = Math.min(w - 1.2, 4.4), wy0 = uy0 + 0.7, wy1 = uy1 - 0.2;
      bx(site, 'cedar', at, ww + 0.4, wy0 - uy0 - 0.05, 0.04, 0, (uy0 + wy0) / 2, fz - 0.03);
      bx(site, 'timber', at, ww + 0.2, 0.09, 0.14, 0, wy0, fz - 0.02);
      bx(site, 'timber', at, ww + 0.2, 0.09, 0.14, 0, wy1, fz - 0.02);
      site.add('koshi', chamferBox(ww, wy1 - wy0, 0.04, 0), at(0, (wy0 + wy1) / 2, fz - 0.05), { col: slatCol(bengara), v: [ww / Math.round(ww / 0.12), 0.36, 0.85, 0], uvo: [ww / 2, 0] });
      if (R() < 0.4) bx(site, 'bamboo', at, ww * 0.9, (wy1 - wy0) * 0.55, 0.01, 0, wy1 - (wy1 - wy0) * 0.275, fz + 0.02, [0.9, 0.85, 0.75]);
    }
    // persimmons drying under the eave of some houses
    if (!shop && R() < 0.22) persimmons(site, at, -hw + 0.6, -hw + 0.6 + Math.min(2.2, w * 0.35), eaveY - 0.3, fz + 0.25);
  }
  rearFace(t, site, at, w, d, G, one, white, R);
  const pitch = one ? 0.56 : low ? 0.5 : 0.46;
  const ov = 0.8;
  if (!shop && !low && R() < 0.3) {
    // tsumairi: the gable end faces the street, breaking the run of eaves along it
    roof(site, at(0, 0, 0, Math.PI / 2), { ex: hd, ez: hw + ov, tx: hd, tz: 0, y0: eaveY, rise: (hw + ov) * pitch, gable: true, verge: 0.45, rafters: false, thick: 0.22, sweep: 0.35, lite: true, col: tiles });
    for (const sz of [-1, 1]) site.add('plaster', gableTri(hw - 0.05, eaveY - 0.25, (hw - 0.05) * pitch + 0.2, 0.2), at(0, 0, sz * (hd - 0.02), sz > 0 ? 0 : Math.PI), { col: white, v: [0.1, gs, 1.2 + G, 0] });
    count(t, 'gable fronts');
  } else {
    roof(site, at(0, 0, 0), { ex: hw, ez: hd + ov, tx: hw, tz: 0, y0: eaveY, rise: (hd + ov) * pitch, gable: true, verge: 0.45, rafters: false, thick: 0.22, sweep: 0.35, lite: true, col: tiles });
    for (const sx of [-1, 1]) site.add('plaster', gableTri(hd - 0.05, eaveY - 0.25, (hd - 0.05) * pitch + 0.2, 0.2), at(sx * (hw - 0.02), 0, 0, (sx * Math.PI) / 2), { col: white, v: [0.1, gs, 1.2 + G, 0] });
  }
  count(t, shop ? 'shops' : 'houses');
}

/**
 * the back of a street house: a small lattice window upstairs, a back door with a short noren, and
 * now and then pots, drying persimmons or a laundry line. on the river side of the street these
 * backs are what the boat sees through the gaps in the front rows.
 */
function rearFace(t: T, site: Site, at: At, w: number, d: number, G: number, one: boolean, white: RGB, R: () => number) {
  const hw = w / 2, bz = -d / 2 + 0.15;
  const dx = (R() - 0.5) * (w - 2.2);
  bx(site, 'dark', at, 0.95, 1.9, 0.04, dx, 1.1, bz - 0.02, [0.02, 0.018, 0.016]);
  bx(site, 'timber', at, 1.15, 0.12, 0.12, dx, 2.1, bz - 0.06);
  if (R() < 0.6) noren(t, site, at(dx, 2.0, bz - 0.12, Math.PI), 0.9, 0.55, 2, NOREN[Math.floor(R() * NOREN.length)], false);
  if (!one) {
    const wx = (R() - 0.5) * (w - 2.4), wy = G + 1.25;
    bx(site, 'timber', at, 1.5, 1.0, 0.1, wx, wy, bz - 0.04);
    site.add('koshi', chamferBox(1.3, 0.8, 0.04, 0), at(wx, wy, bz - 0.08, Math.PI), { col: slatCol(), v: [0.1, 0.34, 0.85, 0], uvo: [0.65, 0] });
    bx(site, 'plaster', at, 1.6, 0.08, 0.3, wx, wy + 0.56, bz - 0.14, white);
  } else {
    bx(site, 'dark', at, 1.2, 0.6, 0.04, -dx * 0.6, 1.9, bz - 0.02, [0.03, 0.028, 0.025]);
  }
  const r = R();
  if (r < 0.25) persimmons(site, at, -hw + 0.7, -hw + 0.7 + Math.min(1.8, w * 0.3), G - 0.05, bz - 0.3);
  else if (r < 0.45) laundry(t, site, at, -hw + 0.8, hw - 0.8, bz - 2.0);
  if (R() < 0.5) for (let i = 0; i < 2; i++) pot(site, at, dx + (i ? 0.8 : -0.8), bz - 0.35, R);
}

function kuraBody(site: Site, at: At, w: number, d: number, white: RGB, R: () => number, tiles: RGB, gr: number, gs: number, H = 5.3 + R() * 0.9) {
  const hw = w / 2, hd = d / 2;
  bx(site, 'plaster', at, w, H, d, 0, H / 2 + 0.15, 0, white, false, 0, [gr, gs, 1.45, 0]);
  const namakoSkirt = R() < 0.6, sk = namakoSkirt ? 1.3 : 1.6;
  for (const [sx, sz, lw, yaw] of [[0, hd + 0.02, w + 0.02, 0], [0, -hd - 0.02, w + 0.02, Math.PI], [hw + 0.02, 0, d + 0.02, Math.PI / 2], [-hw - 0.02, 0, d + 0.02, -Math.PI / 2]] as const) {
    site.add(namakoSkirt ? 'namako' : 'cedar', chamferBox(lw, sk, 0.03, 0), at(sx, 0.15 + sk / 2, sz, yaw), { col: [1, 1, 1] });
    site.add('plaster', chamferBox(lw + 0.04, 0.08, 0.07, 0), at(sx, 0.15 + sk + 0.04, sz, yaw), { col: white });
  }
  for (let k = 0; k < 2; k++) bx(site, 'plaster', at, w + 0.12 + k * 0.14, 0.12, d + 0.12 + k * 0.14, 0, H + 0.03 + k * 0.12, 0, white);
  bx(site, 'dark', at, 1.3, 1.9, 0.06, 0, 1.1, hd + 0.02, [0.02, 0.018, 0.015]);
  for (const sx of [-1, 1]) bx(site, 'plaster', at, 0.6, 2.0, 0.2, sx * 0.95, 1.15, hd + 0.1, white);
  roof(site, at(0, 0, hd + 0.05), { ex: 1.2, ez: 0.65, tx: 1.2, tz: 0, y0: 2.4, rise: 0.3, sides: [0], gable: true, verge: 0.1, ridge: false, rafters: false, thick: 0.12, sweep: 0.2, lite: true, verges: false, col: tiles });
  bx(site, 'dark', at, 0.6, 0.6, 0.05, 0, H - 1.3, hd + 0.02, [0.02, 0.018, 0.015]);
  for (const dx of [-1, 1]) bx(site, 'plaster', at, 0.3, 0.62, 0.1, dx * 0.46, H - 1.3, hd + 0.16, white, false, dx * 0.9);
  const pitch = 0.55, ov = 0.5;
  roof(site, at(0, 0, 0), { ex: hw, ez: hd + ov, tx: hw, tz: 0, y0: H + 0.2, rise: (hd + ov) * pitch, gable: true, verge: 0.4, rafters: false, thick: 0.32, sweep: 0.3, lite: true, col: tiles });
  for (const sx of [-1, 1]) site.add('plaster', gableTri(hd, H + 0.17, hd * pitch + 0.25, 0.3), at(sx * (hw - 0.05), 0, 0, (sx * Math.PI) / 2), { col: white });
}

function shopFront(t: T, site: Site, at: At, Y: number, w: number, fz: number, G: number, role: string, R: () => number) {
  const hw = w / 2;
  // open front onto a dark shop floor with shelves; a raised step and two posts
  bx(site, 'dark', at, w - 0.5, G - 0.5, 0.02, 0, (G - 0.5) / 2 + 0.15, fz - 0.8, [0.03, 0.025, 0.02]);
  bx(site, 'timber', at, w - 0.8, 0.08, 0.5, 0, 1.0, fz - 0.55);
  bx(site, 'timber', at, w - 0.8, 0.08, 0.4, 0, 1.65, fz - 0.6);
  bx(site, 'timber', at, w - 0.3, 0.38, 0.5, 0, 0.19, fz - 0.3);
  for (const sx of [-1, 1]) bx(site, 'timber', at, 0.14, G, 0.14, sx * hw * 0.42, G / 2, fz - 0.08);
  noren(t, site, at(0, G - 0.28, fz + 0.06), w - 0.6, 0.85, 5, SHOP_DYE[role] ?? INK);
  for (const sx of [-1, 1]) lantern(t, at(sx * (hw - 0.55), G - 0.25, fz + 0.45), 0.2, role === 'chaya' || role === 'soba' ? RED : PAPER, 0.8);
  // a hanging signboard at right angles to the street
  bx(site, 'timber', at, 0.08, 1.1, 0.5, hw - 0.3, G - 0.75, fz + 0.45, [0.9, 0.8, 0.65], true);
  bx(site, 'plain', at, 0.09, 0.8, 0.34, hw - 0.3, G - 0.75, fz + 0.45, [0.8, 0.72, 0.52]);
  const z = fz + 1.1;
  if (role === 'chaya') {
    for (const sx of [-1, 1]) bench(site, at, sx * (hw * 0.45), z + 0.3, true);
    for (const sx of [-1, 1]) spot(t.svc.seated, at, Y, sx * (hw * 0.45) + 0.35, 0.5, z + 0.3, 0);
    parasol(site, at, (R() < 0.5 ? -1 : 1) * (hw - 0.6), z + 0.7, RED);
    spot(t.svc.birds, at, Y, 0, 0, z + 1.6);
  } else if (role === 'sweets') {
    bx(site, 'timber', at, w * 0.6, 0.06, 0.7, 0, 0.8, z, [1.2, 1.1, 1.0]);
    for (const sx of [-1, 1]) bx(site, 'timber', at, 0.06, 0.8, 0.6, sx * w * 0.28, 0.4, z);
    const cols: RGB[] = [[0.8, 0.45, 0.5], [0.8, 0.78, 0.7], [0.25, 0.4, 0.08], [0.5, 0.25, 0.08]];
    for (let i = 0; i < 3; i++) {
      const x = -w * 0.2 + i * w * 0.2;
      bx(site, 'plain', at, 0.6, 0.04, 0.4, x, 0.85, z, [0.4, 0.06, 0.04]);
      for (let k = 0; k < 5; k++) for (let b = 0; b < 3; b++) site.add('plain', ball(0.035, 6), at(x - 0.22 + k * 0.11, 0.9, z - 0.08 + b * 0.08), { col: cols[(i + b) % 4] });
    }
  } else if (role === 'pottery') {
    for (const y of [0.45, 0.95]) bx(site, 'timber', at, w * 0.7, 0.05, 0.45, 0, y, z - 0.1);
    for (const sx of [-1, 1]) bx(site, 'timber', at, 0.06, 1.0, 0.45, sx * w * 0.35, 0.5, z - 0.1);
    const glaze: RGB[] = [[0.2, 0.3, 0.26], [0.16, 0.08, 0.04], [0.05, 0.08, 0.2], [0.6, 0.56, 0.46], [0.35, 0.15, 0.06]];
    for (const y of [0.475, 0.975]) for (let i = 0; i < 7; i++) {
      const x = -w * 0.32 + (i * w * 0.64) / 6, h = 0.16 + R() * 0.14, r = 0.07 + R() * 0.05;
      site.add('plain', lathe([[r * 0.6, 0], [r, h * 0.35], [r * 0.85, h * 0.8], [r * 0.5, h], [r * 0.55, h * 1.05]], 8), at(x, y, z - 0.1), { col: glaze[Math.floor(R() * 5)] });
    }
    for (const x of [-hw + 0.5, hw - 0.5]) site.add('plain', lathe([[0.2, 0], [0.34, 0.2], [0.36, 0.45], [0.25, 0.68], [0.22, 0.72]], 12), at(x, 0, z + 0.3), { col: glaze[Math.floor(R() * 5)] });
  } else if (role === 'umbrella') {
    for (let i = 0; i < 3; i++) wagasa(site, at(-hw * 0.5 + i * hw * 0.5, 1.15, z + 0.2, 0, -0.9 + R() * 0.3), WAGASA[(i + t.seed) % WAGASA.length], 0.55);
    for (let i = 0; i < 6; i++) site.add('plain', cylinder(0.05, 0.03, 0.9, 6), at(hw - 0.3, 0.05, fz + 0.2 - i * 0.12, 0, 0.12), { col: WAGASA[i % WAGASA.length] });
  } else if (role === 'rice') {
    const bale = part('tawara', () => lathe([[0.001, 0], [0.2, 0], [0.24, 0.1], [0.25, 0.4], [0.24, 0.7], [0.2, 0.8], [0.001, 0.8]], 10));
    const rows = [[-0.9, 0.24], [-0.45, 0.24], [0, 0.24], [0.45, 0.24], [-0.67, 0.68], [-0.22, 0.68], [0.23, 0.68], [-0.45, 1.1], [0, 1.1]];
    for (const [x, y] of rows) site.add('bamboo', bale, at(x - hw * 0.2, y, z, Math.PI / 2, 0, Math.PI / 2), { col: [1.25, 1.15, 0.8] });
  } else if (role === 'soba') {
    bench(site, at, -hw * 0.4, z + 0.2, false);
    spot(t.svc.seated, at, Y, -hw * 0.4, 0.5, z + 0.2, 0);
    lantern(t, at(hw * 0.35, G - 0.25, fz + 0.9), 0.15, RED, 1.35);
  } else if (role === 'fans') {
    for (let i = 0; i < 5; i++) {
      const x = -w * 0.3 + i * w * 0.15;
      site.add('plain', lathe([[0.001, 0], [0.32, 0], [0.33, 0.01]], 12, false), at(x, 1.7, fz + 0.12, 0, Math.PI / 2, 0), { col: WAGASA[(i + 2) % WAGASA.length] });
    }
  }
}

function bench(site: Site, at: At, x: number, z: number, red: boolean) {
  for (const dx of [-0.75, 0.75]) for (const dz of [-0.2, 0.2]) bx(site, 'timber', at, 0.08, 0.44, 0.08, x + dx, 0.22, z + dz, undefined, true);
  bx(site, red ? 'plain' : 'timber', at, 1.8, 0.07, 0.55, x, 0.47, z, red ? [0.42, 0.04, 0.03] : [1.1, 1.0, 0.9]);
}

function parasol(site: Site, at: At, x: number, z: number, col: RGB) {
  site.add('bamboo', cylinder(0.03, 0.03, 2.55, 6, false), at(x, 0, z), { col: [0.9, 0.8, 0.6] }, true);
  site.add('plain', part('parasol', () => lathe([[1.3, 2.2], [0.75, 2.46], [0.2, 2.6], [0.001, 2.64]], 18)), at(x, 0, z), { col });
}

// ---------------------------------------------------------------------------------------------
// paving and street lanterns

function pave(t: T, sites: (s: number) => Site, lane: Lane) {
  const w = lane.width;
  const world = t.ctx.world;
  const street = lane.id.startsWith('street');
  for (let i = 0; i + 1 < lane.pts.length; i++) {
    const a = lane.pts[i], b = lane.pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len, px = -uz, pz = ux;
    const site = sites(nearestRiver((a.x + b.x) / 2, (a.z + b.z) / 2).s);
    let top = 1.2;
    for (const k of [0, 0.5, 1]) for (const o of [-1, 0, 1]) top = Math.max(top, world.heightAt(a.x + dx * k + px * o * w * 0.5, a.z + dz * k + pz * o * w * 0.5));
    top += 0.06;
    const e0 = i === 0 ? 0 : 0.3, e1 = 0.3;
    const P = (along: number, across: number) => [a.x + ux * along + px * across, top, a.z + uz * along + pz * across];
    const p: Part = { pos: [], nor: [], uv: [] };
    polyOut(p, [P(-e0, -w / 2), P(len + e1, -w / 2), P(len + e1, w / 2), P(-e0, w / 2)], [0, 1, 0]);
    site.add('stone', p, trs(0, 0, 0), { col: [1.3, 1.26, 1.18] });
    // dressed kerbs along both edges, sunk so they read as a low edge, not a wall
    const yaw = Math.atan2(dx, dz);
    for (const s of [-1, 1]) {
      const cx = (a.x + b.x) / 2 + px * s * (w / 2 + 0.12), cz = (a.z + b.z) / 2 + pz * s * (w / 2 + 0.12);
      site.add('dressed', chamferBox(0.26, 0.2, len + 0.3, 0), trs(cx, top - 0.06, cz, yaw), { col: [0.95, 0.93, 0.88] });
    }
    count(t, 'paving m', Math.round(len));
  }
  // lantern strings across the street every ~16 m; lanes get a pair near their head
  if (!street) return;
  let acc = 7;
  for (let i = 0; i + 1 < lane.pts.length; i++) {
    const a = lane.pts[i], b = lane.pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    const px = -dz / len, pz = dx / len;
    while (acc < len) {
      const cx = a.x + (dx * acc) / len, cz = a.z + (dz * acc) / len;
      const site = sites(nearestRiver(cx, cz).s);
      const g = Math.max(1.2, world.heightAt(cx, cz));
      const half = w / 2 + 0.45, top = g + 4.5;
      for (const s of [-1, 1]) {
        const x = cx + px * s * half, z = cz + pz * s * half;
        site.add('timber', cylinder(0.07, 0.06, 4.7, 7, false), trs(x, g - 0.2, z), { col: [0.9, 0.82, 0.7] });
        site.add('dressed', chamferBox(0.28, 0.18, 0.28, 0), trs(x, g + 0.05, z), { col: STONE }, true);
      }
      const A = [cx - px * half, top - 0.1, cz - pz * half], B = [cx + px * half, top - 0.1, cz + pz * half];
      const Q = (u: number) => [A[0] + (B[0] - A[0]) * u, A[1] - 0.45 * 4 * u * (1 - u), A[2] + (B[2] - A[2]) * u];
      for (let k = 0; k < 6; k++) rod(site, 'rope', Q(k / 6), Q((k + 1) / 6), 0.012, [0.5, 0.43, 0.3], true, 4);
      for (const u of [0.22, 0.5, 0.78]) {
        const q = Q(u);
        hangLantern(t.sway, q[0], q[1] - 0.12, q[2], q[1], u === 0.5 ? PAPER : RED, (t.seed++ * 0.618) % 1, 0.85);
        count(t, 'lanterns');
      }
      acc += 16;
    }
    acc -= len;
  }
}

// ---------------------------------------------------------------------------------------------
// precincts

/** a precinct wall run from local (x0, z0) to (x1, z1): plaster on a stone base, tiled cap, and on
 *  temple walls the five white lines (suji-bei) of an imperially favoured temple */
function wall(site: Site, at: At, x0: number, z0: number, x1: number, z1: number, col: RGB, lines = false, h = 2.3) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const yaw = Math.atan2(x1 - x0, z1 - z0) - Math.PI / 2;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  site.add('stone', chamferBox(len + 0.1, 0.6, 0.75, 0), at(cx, 0.2, cz, yaw), { col: [0.9, 0.9, 0.9] });
  site.add('plaster', chamferBox(len, h, 0.5, 0), at(cx, 0.5 + h / 2, cz, yaw), { col, v: [0.5, 0.3, 1.7, 0] });
  if (lines) for (let k = 0; k < 5; k++) site.add('plaster', chamferBox(len, 0.05, 0.54, 0), at(cx, 1.05 + k * 0.3, cz, yaw), { col: [1.08, 1.06, 1.02] });
  site.add('kawara', chamferBox(len + 0.3, 0.16, 1.05, 0), at(cx, 0.55 + h, cz, yaw), { col: [0.9, 0.95, 1.0] });
  site.add('dark', chamferBox(len + 0.3, 0.22, 0.3, 0), at(cx, 0.72 + h, cz, yaw), { col: [0.005, 0.0055, 0.006] });
}

/** a two-storey vermilion sanmon (roumon) with a great red lantern under the gate, facing +z */
function sanmon(t: T, site: Site, at: At) {
  const W = 11, D = 5.4, H1 = 4.6;
  bx(site, 'dressed', at, W + 1.6, 0.5, D + 1.6, 0, 0.0, 0, STONE);
  for (let i = 0; i < 3; i++) bx(site, 'dressed', at, 4.2, 0.18, 0.4, 0, 0.09 - i * 0.0, D / 2 + 1.0 + i * 0.4, STONE);
  const xs = [-W / 2, -W / 6, W / 6, W / 2];
  for (const x of xs) for (const z of [-D / 2, 0, D / 2]) {
    site.add('lacquer', cylinder(0.24, 0.22, H1, 12), at(x, 0.2, z), { col: VER, v: [0, 0, 0, 0.12] });
    site.add('dressed', cylinder(0.36, 0.4, 0.25, 10), at(x, 0.1, z), { col: STONE });
  }
  // tie beams, the outer bays screened by vermilion lattices (the guardian bays)
  for (const z of [-D / 2, D / 2]) bx(site, 'lacquer', at, W + 0.6, 0.35, 0.3, 0, H1 - 0.2, z, VER, false, 0, [0, 0, 0, 0.1]);
  for (const x of xs) bx(site, 'lacquer', at, 0.3, 0.35, D + 0.6, x, H1 - 0.2, 0, VER, false, 0, [0, 0, 0, 0.1]);
  for (const sx of [-1, 1]) for (const z of [-D / 2, D / 2]) {
    const cx = sx * (W / 3);
    site.add('koshi', chamferBox(W / 3 - 0.5, 2.9, 0.06, 0), at(cx, 1.9, z), { col: [0.34, 0.04, 0.02], v: [0.16, 0.34, 0.06, 0], uvo: [0.05, 0] });
    bx(site, 'plaster', at, W / 3 - 0.5, 0.9, 0.2, cx, H1 - 0.85, z, WHITE);
  }
  // the great chochin in the middle bay
  lantern(t, at(0, H1 - 0.45, 0), 0.4, [0.52, 0.05, 0.03], 3.2);
  // lower roof skirt
  roof(site, at(0, 0, 0), { ex: W / 2 + 1.8, ez: D / 2 + 1.8, tx: W / 2 + 0.2, tz: D / 2 + 0.2, y0: H1 + 0.55, rise: 0.8, lift: 0.4, flare: 0.3, thick: 0.35, sweep: 0.5, rafterMat: 'lacquer', rafterCol: VER, hips: true, ridge: false });
  // upper storey: balcony, white walls between vermilion posts, lattice windows
  const y2 = H1 + 1.25;
  bx(site, 'timber', at, W + 0.9, 0.16, D + 0.9, 0, y2 - 0.08, 0, [1.1, 1.0, 0.95]);
  for (const [hx, hz] of [[W / 2 + 0.4, D / 2 + 0.4]]) {
    for (const z of [-hz, hz]) bx(site, 'lacquer', at, 2 * hx, 0.08, 0.08, 0, y2 + 0.85, z, VER);
    for (const x of [-hx, hx]) bx(site, 'lacquer', at, 0.08, 0.08, 2 * hz, x, y2 + 0.85, 0, VER);
    for (let i = 0; i <= 8; i++) for (const z of [-hz, hz]) bx(site, 'lacquer', at, 0.08, 0.85, 0.08, -hx + (i * 2 * hx) / 8, y2 + 0.42, z, VER);
  }
  bx(site, 'plaster', at, W - 0.4, 3.0, D - 0.6, 0, y2 + 1.5, 0, WHITE);
  for (const x of xs) for (const z of [-(D - 0.6) / 2, (D - 0.6) / 2]) bx(site, 'lacquer', at, 0.26, 3.0, 0.26, x * 0.93, y2 + 1.5, z, VER);
  for (const z of [-(D - 0.6) / 2 - 0.03, (D - 0.6) / 2 + 0.03]) {
    site.add('koshi', chamferBox(W / 3 - 0.8, 1.3, 0.04, 0), at(0, y2 + 1.6, z), { col: [0.34, 0.04, 0.02], v: [0.14, 0.3, 0.55, 0], uvo: [0.05, 0] });
    for (const sx of [-1, 1]) site.add('koshi', chamferBox(W / 3 - 1.2, 1.0, 0.04, 0), at(sx * W / 3, y2 + 1.7, z), { col: [0.34, 0.04, 0.02], v: [0.14, 0.3, 0.55, 0], uvo: [0.05, 0] });
  }
  // bracket band, then the upper hip-and-gable roof
  for (let l = 0; l < 3; l++) bx(site, 'lacquer', at, W - 0.2 + l * 0.35, 0.22, D - 0.4 + l * 0.35, 0, y2 + 3.1 + l * 0.22, 0, l === 1 ? [0.9, 0.88, 0.8] : VER);
  const eave = y2 + 3.85;
  roof(site, at(0, 0, 0), { ex: W / 2 + 2.3, ez: D / 2 + 2.3, tx: W / 2 - 0.6, tz: D / 2 - 1.2, y0: eave, rise: 1.9, lift: 0.6, flare: 0.45, thick: 0.4, sweep: 0.65, rafterMat: 'lacquer', rafterCol: VER, hips: true, ridge: false });
  const tz = D / 2 - 1.2, rise2 = tz * 1.3 + 0.4;
  roof(site, at(0, 0, 0), { ex: W / 2 - 0.6, ez: tz + 0.35, tx: W / 2 - 0.6, tz: 0, y0: eave + 1.65, rise: rise2, gable: true, verge: 0.35, rafters: false, thick: 0.3, sweep: 0.3 });
  for (const sx of [-1, 1]) site.add('plaster', gableTri(tz + 0.1, eave + 1.6, rise2 + 0.05, 0.25), at(sx * (W / 2 - 0.6), 0, 0, (sx * Math.PI) / 2), { col: WHITE });
  count(t, 'gates');
}

/** shoro: a bell tower on a stone base with the temple bell and its striking log */
function belfry(t: T, site: Site, at: At) {
  bx(site, 'stone', at, 4.8, 1.3, 4.8, 0, 0.45, 0, [0.95, 0.95, 0.95]);
  bx(site, 'dressed', at, 5.0, 0.14, 5.0, 0, 1.12, 0, STONE);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const a = [sx * 1.85, 1.15, sz * 1.85], b = [sx * 1.55, 5.2, sz * 1.55];
    const [ax, ay, az] = wp(at(a[0], a[1], a[2])), [bx_, by, bz] = wp(at(b[0], b[1], b[2]));
    rod(site, 'timber', [ax, ay, az], [bx_, by, bz], 0.16, [1.25, 1.15, 1.0], false, 8);
  }
  for (const y of [2.2, 4.9]) for (const [x, z, sx, sz] of [[0, 1.7, 3.8, 0.18], [0, -1.7, 3.8, 0.18], [1.7, 0, 0.18, 3.8], [-1.7, 0, 0.18, 3.8]]) bx(site, 'timber', at, sx, 0.22, sz, x * (y > 3 ? 0.9 : 1), y, z * (y > 3 ? 0.9 : 1), [1.2, 1.1, 1.0]);
  site.add('plain', lathe([[0.001, 3.0], [0.5, 3.0], [0.52, 3.1], [0.48, 3.6], [0.44, 4.1], [0.3, 4.3], [0.001, 4.35]], 16), at(0, 0, 0), { col: BRONZE });
  site.add('plain', cylinder(0.05, 0.05, 0.5, 6), at(0, 4.35, 0), { col: BRONZE });
  rod(site, 'timber', wp(at(0.8, 3.5, -1.1)), wp(at(0.8, 3.5, 1.1)), 0.11, [1.3, 1.2, 1.0]);
  roof(site, at(0, 0, 0), { ex: 3.3, ez: 3.3, tx: 1.8, tz: 0.9, y0: 5.4, rise: 1.3, lift: 0.5, flare: 0.35, thick: 0.3, sweep: 0.6, hips: true, ridge: false, rafters: false });
  roof(site, at(0, 0, 0), { ex: 1.8, ez: 1.25, tx: 1.8, tz: 0, y0: 6.55, rise: 1.0, gable: true, verge: 0.25, rafters: false, thick: 0.22, sweep: 0.3 });
  for (const sx of [-1, 1]) site.add('plaster', gableTri(0.95, 6.5, 1.05, 0.2), at(sx * 1.8, 0, 0, (sx * Math.PI) / 2), { col: WHITE });
  count(t, 'belfries');
}

/** chozuya: a covered stone basin with bamboo ladles, for rinsing hands before prayer */
function chozuya(site: Site, at: At) {
  bx(site, 'dressed', at, 1.9, 0.75, 0.9, 0, 0.37, 0, STONE);
  bx(site, 'water', at, 1.7, 0.02, 0.7, 0, 0.73, 0, [0.03, 0.05, 0.04]);
  for (let i = 0; i < 4; i++) site.add('bamboo', cylinder(0.012, 0.012, 0.5, 4, false), at(-0.6 + i * 0.4, 0.78, 0.35, 0, 0, Math.PI / 2 - 0.2), { col: [1, 0.9, 0.6] }, true);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) bx(site, 'timber', at, 0.16, 2.6, 0.16, sx * 1.2, 1.3, sz * 0.8, [1.2, 1.1, 1.0]);
  roof(site, at(0, 0, 0), { ex: 1.6, ez: 1.5, tx: 1.6, tz: 0, y0: 2.6, rise: 0.9, gable: true, verge: 0.3, rafters: false, thick: 0.18, sweep: 0.4, lite: true });
}

/** niwaki: a cloud-pruned pine, trunk leaning, pads of needles on its branches */
function niwaki(site: Site, at: At, x: number, z: number, R: () => number, s = 1) {
  const lean = (R() - 0.5) * 0.5;
  let px = x, py = 0, pz = z;
  const pts: number[][] = [[px, py, pz]];
  for (let k = 1; k <= 4; k++) {
    px += Math.sin(lean + k * 0.7) * 0.35 * s; py += 0.8 * s; pz += Math.cos(k * 1.3) * 0.2 * s;
    pts.push([px, py, pz]);
  }
  for (let k = 0; k < 4; k++) rod(site, 'timber', wp(at(pts[k][0], pts[k][1], pts[k][2])), wp(at(pts[k + 1][0], pts[k + 1][1], pts[k + 1][2])), (0.16 - k * 0.025) * s, [1.6, 1.3, 1.1], false, 6);
  for (let k = 1; k <= 4; k++) {
    const p = pts[k], a = R() * 6.28, r = (1.0 - k * 0.12) * s;
    const q = [p[0] + Math.cos(a) * r * 0.7, p[1] + 0.1, p[2] + Math.sin(a) * r * 0.7];
    rod(site, 'timber', wp(at(p[0], p[1], p[2])), wp(at(q[0], q[1], q[2])), 0.06 * s, [1.6, 1.3, 1.1], true, 5);
    site.add('foliage', lathe([[r * 0.85, 0], [r, 0.12 * s], [r * 0.8, 0.3 * s], [0.001, 0.38 * s]], 10), at(q[0], q[1] - 0.05, q[2]).multiply(trs(0, 0, 0, 0, 0, 0, 1, 1, 0.8)), { col: [0.04, 0.09, 0.035] });
  }
}

function templePrecinct(t: T, site: Site, sd: SiteDef, at: At, Y: number, R: () => number) {
  const hw = sd.w! / 2, hd = sd.d! / 2;
  const ochre: RGB = [1.0, 0.78, 0.46];
  // suji-bei walls round the precinct, the gate in the street wall
  wall(site, at, -hw, hd, -5.9, hd, ochre, true);
  wall(site, at, 5.9, hd, hw, hd, ochre, true);
  wall(site, at, -hw, -hd, hw, -hd, ochre, true);
  wall(site, at, -hw, -hd, -hw, hd, ochre, true);
  wall(site, at, hw, -hd, hw, hd, ochre, true);
  // the gate straddles the street wall; its front platform stops short of the paving
  sanmon(t, site, frame(...wp(at(0, 0, hd - 2.2)), Y));
  // the approach: paving, stone lantern pairs and the main hall
  const hallZ = -hd + 11.5;
  const path0 = hd - 5.2, path1 = hallZ + 7.8;
  for (let z = path1; z < path0; z += 0.95) bx(site, 'dressed', at, 2.8 + (R() - 0.5) * 0.2, 0.14, 0.85, (R() - 0.5) * 0.06, 0.04, z, [0.95, 0.94, 0.9], true);
  for (let z = path1 + 1.5; z < path0 - 1; z += 4.2) for (const sx of [-1, 1]) toro(site, at(sx * 2.6, 0, z, sx > 0 ? -Math.PI / 2 : Math.PI / 2), 2.1);
  buildHall(site, { ...(() => { const [x, , z] = wp(at(0, 0, hallZ)); return { x, z }; })(), y: sd.y, yaw: Y });
  // incense burner before the hall
  site.add('plain', lathe([[0.45, 0.6], [0.55, 0.75], [0.5, 1.05], [0.62, 1.1], [0.001, 1.1]], 12), at(0, 0, hallZ + 9.5), { col: BRONZE });
  for (let k = 0; k < 3; k++) site.add('plain', cylinder(0.05, 0.05, 0.62, 5), at(Math.cos(k * 2.1) * 0.35, 0, hallZ + 9.5 + Math.sin(k * 2.1) * 0.35), { col: BRONZE });
  bx(site, 'dressed', at, 1.3, 0.1, 1.3, 0, 0.05, hallZ + 9.5, STONE, true);
  belfry(t, site, frame(...wp(at(hw - 7, 0, 4)), Y + Math.PI / 2));
  chozuya(site, frame(...wp(at(-hw + 7.5, 0, hd - 7)), Y + Math.PI / 2));
  // jizo row along the street face of the wall, and one inside by the gate
  for (let i = 0; i < 6; i++) jizo(site, at, -hw + 3 + i * 0.75, hd + 1.0, 0, 0.9 + (i % 3) * 0.08);
  count(t, 'jizo', 6);
  spot(t.svc.cats, at, Y, -hw + 7.5, 0.0, hd + 1.3, 0.6);
  // a dry garden in the back corner: raked gravel, rock groups, moss islands and clipped azaleas
  const gx = -hw + 7.5, gz = -hd + 6.5;
  bx(site, 'gravel', at, 11, 0.1, 8.5, gx, 0.05, gz, [0.66, 0.64, 0.58]);
  for (const [x, z] of [[-5.6, 0], [5.6, 0], [0, -4.35], [0, 4.35]] as const) bx(site, 'dressed', at, x ? 0.25 : 11.4, 0.16, x ? 8.9 : 0.25, gx + x, 0.08, gz + z, [0.8, 0.8, 0.78]);
  for (const [x, z, n] of [[-2.8, -1.5, 3], [2.5, 1.2, 2], [0.5, -2.6, 1]] as const) {
    site.add('foliage', lathe([[1.2, 0], [1.1, 0.12], [0.6, 0.2], [0.001, 0.22]], 12), at(gx + x, 0.06, gz + z), { col: MOSS });
    for (let k = 0; k < n; k++) site.add('stone', rock(0.45 + k * 0.1, 0.5 + (n - k) * 0.25, k + n), at(gx + x + (k - 1) * 0.5, 0.05, gz + z + (k % 2) * 0.4, R() * 6), { col: [0.8, 0.8, 0.78] });
  }
  for (let i = 0; i < 10; i++) site.add('foliage', mound(0.6 + R() * 0.3, 0.7 + R() * 0.3), at(-hw + 1.5 + R() * 3, 0, -hd + 14 + i * 2.2), { col: AZALEA[i % AZALEA.length] });
  for (let i = 0; i < 8; i++) site.add('foliage', mound(0.55 + R() * 0.3, 0.6 + R() * 0.3), at(hw - 1.5 - R() * 2, 0, -hd + 3 + i * 2.3), { col: AZALEA[(i + 2) % AZALEA.length] });
  niwaki(site, at, -5.5, hd - 8, R, 1.2);
  niwaki(site, at, 6.5, hallZ + 10, R, 1.0);
  for (const [x, z] of [[1.5, hd - 5], [-1.2, hallZ + 12], [3, hallZ + 8]]) spot(t.svc.birds, at, Y, x, 0, z);
  for (const x of [-0.6, 0.7]) spot(t.svc.standing, at, Y, x, 0.14, hallZ + 8.6, Math.PI);
  count(t, 'temples');
}

function shrinePrecinct(t: T, site: Site, sd: SiteDef, at: At, Y: number, R: () => number) {
  const hw = sd.w! / 2, hd = sd.d! / 2;
  // a great vermilion torii on the street, a stone approach, lanterns and lion-dogs
  torii(site, at(0, 0, hd - 1.2), 6.4, 4.8);
  const hz = -hd + 12;
  for (let z = hz + 5; z < hd - 2; z += 0.95) bx(site, 'dressed', at, 2.4, 0.14, 0.85, 0, 0.04, z, [0.95, 0.94, 0.9], true);
  for (let z = hz + 6.5; z < hd - 4; z += 4.5) for (const sx of [-1, 1]) toro(site, at(sx * 2.4, 0, z, sx > 0 ? -Math.PI / 2 : Math.PI / 2), 1.9);
  for (const sx of [-1, 1]) {
    const m = at(sx * 2.2, 0, hz + 9);
    site.add('dressed', chamferBox(0.8, 0.9, 0.9, 0), m.clone().multiply(trs(0, 0.45, 0)), { col: STONE });
    site.add('dressed', lathe([[0.3, 0.9], [0.32, 1.2], [0.22, 1.55], [0.28, 1.75], [0.2, 1.95], [0.001, 2.0]], 8), m, { col: [0.72, 0.72, 0.68] });
  }
  // haiden: raised floor, vermilion posts, white walls, an open front with a thick shimenawa
  const W = 10, D = 6.5, fy = 1.0;
  const hm = frame(...wp(at(0, 0, hz)), Y);
  bx(site, 'stone', hm, W + 1.2, fy, D + 1.2, 0, fy / 2 - 0.1, 0, [0.95, 0.95, 0.95]);
  bx(site, 'timber', hm, W + 0.8, 0.12, D + 0.8, 0, fy + 0.02, 0, [1.1, 1.05, 1.0]);
  for (let i = 0; i < 3; i++) bx(site, 'dressed', hm, 3, 0.2 * (i + 1), 0.4, 0, 0.1 * (i + 1), D / 2 + 0.8 + (2 - i) * 0.4, STONE);
  for (let i = 0; i <= 4; i++) for (const z of [-D / 2, D / 2]) site.add('lacquer', cylinder(0.17, 0.16, 3.2, 10), hm(-W / 2 + (i * W) / 4, fy, z), { col: VER, v: [0, 0, 0, 0.12] });
  bx(site, 'plaster', hm, W - 0.2, 3.0, 0.2, 0, fy + 1.5, -D / 2 + 0.1, WHITE);
  for (const sx of [-1, 1]) bx(site, 'plaster', hm, 0.2, 3.0, D - 0.2, sx * (W / 2 - 0.1), fy + 1.5, 0, WHITE);
  bx(site, 'dark', hm, W - 0.6, 2.6, 0.05, 0, fy + 1.3, -D / 2 + 0.3, [0.05, 0.035, 0.025]);
  for (const z of [-D / 2, D / 2]) bx(site, 'lacquer', hm, W + 0.5, 0.3, 0.26, 0, fy + 3.1, z, VER);
  const rope: number[][] = [];
  for (let k = 0; k <= 10; k++) { const u = k / 10; rope.push([-W * 0.35 + u * W * 0.7, fy + 2.6 - Math.sin(u * Math.PI) * 0.35, D / 2 + 0.2]); }
  for (let k = 0; k < 10; k++) rod(site, 'rope', wp(hm(rope[k][0], rope[k][1], rope[k][2])), wp(hm(rope[k + 1][0], rope[k + 1][1], rope[k + 1][2])), 0.1 + 0.08 * Math.sin(((k + 0.5) / 10) * Math.PI), [0.42, 0.33, 0.17], true, 8);
  roof(site, hm(0, 0, 0.6), { ex: W / 2 + 1.1, ez: D / 2 + 2.0, tx: W / 2 + 1.1, tz: 0, y0: fy + 3.4, rise: 2.5, gable: true, verge: 0.6, rafters: true, thick: 0.3, sweep: 0.55, rafterMat: 'lacquer', rafterCol: VER });
  for (const sx of [-1, 1]) site.add('plaster', gableTri(D / 2 + 0.4, fy + 3.3, 2.1, 0.2), hm(sx * W / 2, 0, 0.3, (sx * Math.PI) / 2), { col: WHITE });
  // katsuogi billets along the ridge and chigi crossed at the gable ends
  for (let i = 0; i < 5; i++) site.add('dark', cylinder(0.14, 0.14, 1.2, 8), hm(-W / 2 + 1 + (i * (W - 2)) / 4, fy + 6.25, 0.6 - 0.6, 0, Math.PI / 2), { col: [0.03, 0.025, 0.02] });
  for (const sx of [-1, 1]) for (const r of [-1, 1]) site.add('dark', chamferBox(0.12, 1.9, 0.22, 0), hm(sx * (W / 2 + 0.9), fy + 6.3, 0.6 + r * 0.45, 0, r * 0.55), { col: [0.03, 0.025, 0.02] });
  // white lanterns under the eaves
  for (let i = 0; i < 4; i++) lantern(t, hm(-W * 0.36 + (i * W * 0.72) / 3, fy + 3.05, D / 2 + 1.0), 0.25, [0.8, 0.76, 0.64], 1.0);
  // honden behind within a vermilion fence
  const hn = frame(...wp(at(0, 0, hz - 9)), Y);
  bx(site, 'stone', hn, 5.2, 1.2, 4.4, 0, 0.5, 0, [0.95, 0.95, 0.95]);
  bx(site, 'cedar', hn, 3.4, 2.2, 2.6, 0, 2.2, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) site.add('lacquer', cylinder(0.12, 0.12, 2.4, 8), hn(sx * 1.7, 1.1, sz * 1.3), { col: VER });
  roof(site, hn(0, 0, 0.4), { ex: 2.3, ez: 2.6, tx: 2.3, tz: 0, y0: 3.4, rise: 1.6, gable: true, verge: 0.4, rafters: false, thick: 0.2, sweep: 0.55, lite: true });
  for (const [x0, z0, x1, z1] of [[-3.6, 3, 3.6, 3], [-3.6, -3, 3.6, -3], [-3.6, -3, -3.6, 3], [3.6, -3, 3.6, 3]]) {
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.round(len / 0.9);
    bx(site, 'lacquer', hn, Math.abs(x1 - x0) + 0.1, 0.1, Math.abs(z1 - z0) + 0.1, (x0 + x1) / 2, 1.15, (z0 + z1) / 2, VER);
    for (let i = 0; i <= n; i++) bx(site, 'lacquer', hn, 0.1, 1.2, 0.1, x0 + ((x1 - x0) * i) / n, 0.6, z0 + ((z1 - z0) * i) / n, VER);
  }
  // kagura stage, ema rack and omikuji ties
  const kg = frame(...wp(at(hw - 5.5, 0, hz + 3)), Y - Math.PI / 2);
  bx(site, 'timber', kg, 5.4, 1.0, 5.4, 0, 0.5, 0, [1.1, 1.0, 0.95]);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) site.add('lacquer', cylinder(0.13, 0.12, 3.0, 8), kg(sx * 2.5, 1.0, sz * 2.5), { col: VER });
  roof(site, kg(0, 0, 0), { ex: 3.5, ez: 3.5, tx: 1.6, tz: 0.6, y0: 4.1, rise: 1.4, lift: 0.4, flare: 0.3, thick: 0.25, sweep: 0.6, hips: true, ridge: true, rafters: false, lite: true });
  const em = frame(...wp(at(-hw + 4.5, 0, hz + 7)), Y + Math.PI / 2);
  for (const sx of [-1, 1]) bx(site, 'timber', em, 0.12, 2.0, 0.12, sx * 1.4, 1.0, 0);
  roof(site, em(0, 0, 0), { ex: 1.7, ez: 0.45, tx: 1.7, tz: 0, y0: 2.0, rise: 0.3, gable: true, verge: 0.1, rafters: false, ridge: false, thick: 0.08, sweep: 0.2, lite: true });
  for (let r = 0; r < 3; r++) for (let i = 0; i < 12; i++) bx(site, 'timber', em, 0.17, 0.12, 0.02, -1.2 + i * 0.22, 1.2 + r * 0.24, 0.08 + (i % 2) * 0.01, [1.6, 1.4, 1.1], true, (i % 3 - 1) * 0.1);
  for (let r = 0; r < 2; r++) {
    rod(site, 'rope', wp(em(-1.4, 0.9 + r * 0.35 - 0.6, -0.8)), wp(em(1.4, 0.9 + r * 0.35 - 0.6, -0.8)), 0.01, [0.6, 0.5, 0.35], true, 4);
    for (let i = 0; i < 14; i++) bx(site, 'plain', em, 0.05, 0.12, 0.03, -1.3 + i * 0.2, 0.25 + r * 0.35, -0.8, [0.8, 0.78, 0.72]);
  }
  // nobori banners along the approach
  for (let i = 0; i < 3; i++) for (const sx of [-1, 1]) {
    const z = hz + 7 + i * 4.5, x = sx * 3.6;
    site.add('timber', cylinder(0.035, 0.03, 4.4, 6, false), at(x, 0, z), { col: [0.9, 0.8, 0.7] }, true);
    site.add('timber', cylinder(0.02, 0.02, 0.65, 4, false), at(x, 4.2, z, 0, 0, Math.PI / 2), { col: [0.9, 0.8, 0.7] }, true);
    cloth(t.cloth, at(x - 0.33, 4.18, z + 0.05, 0), 0.6, 3.0, i % 2 ? [0.78, 0.74, 0.62] : RED, (t.seed++ * 0.41) % 1, false);
  }
  // clipped hedges down the sides, azaleas, and people at prayer
  for (const sx of [-1, 1]) site.add('foliage', chamferBox(0.9, 1.2, 2 * hd - 4, 0), at(sx * (hw - 0.6), 0.6, 0), { col: HEDGE });
  for (let i = 0; i < 8; i++) site.add('foliage', mound(0.55 + R() * 0.25, 0.6 + R() * 0.3), at((i % 2 ? 1 : -1) * (4.8 + R() * 1.5), 0, hz + 4 + i * 2.2), { col: AZALEA[i % AZALEA.length] });
  for (const x of [-0.8, 0.5]) spot(t.svc.standing, at, Y, x, 0.0, hz + D / 2 + 2.4, Math.PI);
  spot(t.svc.cats, at, Y, 2.2, 0.9, hz + 9.3, 0.3);
  spot(t.svc.birds, at, Y, -1.5, 0, hz + 12);
  count(t, 'shrines');
}

function brewery(t: T, site: Site, sd: SiteDef, at: At, Y: number, R: () => number) {
  const hw = sd.w! / 2, hd = sd.d! / 2;
  // the shop on the street: a long two-storey front in black cedar and white plaster
  const fw = 2 * hw - 2, fd = 10;
  const fm = frame(...wp(at(0, 0, hd - fd / 2)), Y);
  bx(site, 'dressed', fm, fw + 0.1, 0.45, fd + 0.1, 0, -0.05, 0, [0.85, 0.85, 0.84]);
  bx(site, 'cedar', fm, fw, 3.2, fd - 0.3, 0, 1.75, -0.15);
  bx(site, 'plaster', fm, fw, 2.9, fd - 0.1, 0, 4.7, -0.05, WHITE, false, 0, [0.4, 0.5, 4.4, 0]);
  bx(site, 'cedar', fm, fw + 0.02, 0.9, fd + 0.02, 0, 3.75, -0.05);
  koshi(site, fm, -fw / 2 + 0.3, -0.9, 0.45, 2.4, fd / 2 - 0.08, R);
  koshi(site, fm, 2.2, fw / 2 - 0.3, 0.45, 2.4, fd / 2 - 0.08, R);
  bx(site, 'dark', fm, 2.6, 2.6, 0.02, 0.6, 1.45, fd / 2 - 0.35, [0.02, 0.018, 0.016]);
  noren(t, site, fm(0.6, 2.9, fd / 2 + 0.06), 2.6, 1.1, 4, INK);
  roof(site, fm(0, 0, fd / 2 - 0.1), { ex: fw / 2 + 0.1, ez: 1.1, tx: fw / 2 + 0.1, tz: 0, y0: 3.3, rise: 0.45, sides: [0], gable: true, verge: 0.12, ridge: false, rafters: false, thick: 0.16, sweep: 0.3, lite: true, verges: false });
  for (const x of [-fw * 0.25, fw * 0.25]) {
    site.add('koshi', chamferBox(3.2, 1.2, 0.04, 0), fm(x, 4.8, fd / 2 - 0.02), { col: slatCol(), v: [0.12, 0.36, 0.85, 0], uvo: [1.6, 0] });
  }
  roof(site, fm(0, 0, 0), { ex: fw / 2, ez: fd / 2 + 0.9, tx: fw / 2, tz: 0, y0: 6.2, rise: (fd / 2 + 0.9) * 0.46, gable: true, verge: 0.5, rafters: false, thick: 0.26, sweep: 0.35, lite: true });
  for (const sx of [-1, 1]) site.add('plaster', gableTri(fd / 2 - 0.05, 5.95, (fd / 2) * 0.46 + 0.2, 0.2), fm(sx * (fw / 2 - 0.02), 0, 0, (sx * Math.PI) / 2), { col: WHITE });
  // the sugidama: a great ball of cedar sprigs hung at the door when the new sake is pressed
  site.add('foliage', ball(0.75, 14), fm(-1.6, 2.35, fd / 2 + 0.95), { col: [0.1, 0.16, 0.05] });
  rod(site, 'rope', wp(fm(-1.6, 3.1, fd / 2 + 0.95)), wp(fm(-1.6, 3.35, fd / 2 + 0.3)), 0.015, [0.5, 0.43, 0.3], true, 4);
  // komodaru stacked by the door
  const R2 = rng(4401);
  for (const [x, y, z] of [[2.9, 0, 0], [3.6, 0, 0], [4.3, 0, 0], [3.25, 0.62, 0], [3.95, 0.62, 0], [3.6, 1.24, 0]]) taru(site, fm(x, y, fd / 2 + 0.9 + z), R2);
  spot(t.svc.cats, fm, Y, 3.6, 1.86, fd / 2 + 0.9, 0.2);
  // storehouses and a yard of barrels behind
  for (const sx of [-1, 1]) {
    const km = frame(...wp(at(sx * (hw - 5), 0, -hd + 5.5)), Y);
    bx(site, 'dressed', km, 7.3, 0.45, 9.1, 0, -0.05, 0, [0.85, 0.85, 0.84]);
    kuraBody(site, km, 7.2, 9, WHITE, R, [1, 1, 1], 0.6, R(), 6.8);
  }
  for (let i = 0; i < 5; i++) taru(site, at(-1.5 + i * 0.75, 0, -hd + 9, R() * 3), R2);
  site.add('timber', lathe([[1.2, 0], [1.3, 1.1], [1.32, 1.2], [0.001, 1.2]], 16), at(1.5, 0, -hd + 13), { col: [1.2, 1.1, 0.9] });
  count(t, 'breweries');
}

/** a yatai: a wooden stall with a slanting board roof, striped curtain, goods, and two lanterns */
function yatai(t: T, site: Site, at: At, Y: number, kind: number, R: () => number) {
  bx(site, 'timber', at, 2.3, 0.9, 1.1, 0, 0.45, -0.1, [1.2, 1.05, 0.9]);
  bx(site, 'timber', at, 2.5, 0.07, 1.3, 0, 0.93, 0.0, [1.3, 1.2, 1.0]);
  for (const sx of [-1, 1]) for (const [z, h] of [[0.55, 2.45], [-0.6, 2.1]] as const) bx(site, 'timber', at, 0.08, h, 0.08, sx * 1.2, h / 2, z, [1.2, 1.05, 0.9], true);
  bx(site, 'timber', at, 2.8, 0.06, 1.8, 0, 2.3, 0.05, [1.1, 1.0, 0.9], false, 0);
  // striped maku along the front of the roof
  for (let i = 0; i < 8; i++) bx(site, 'plain', at, 0.34, 0.42, 0.02, -1.19 + i * 0.34, 2.05, 0.95, i % 2 ? [0.78, 0.76, 0.7] : [0.5, 0.05, 0.03]);
  const goods: RGB[][] = [
    [[0.6, 0.1, 0.05], [0.7, 0.4, 0.05], [0.8, 0.78, 0.7]],
    [[0.05, 0.2, 0.4], [0.62, 0.22, 0.02], [0.75, 0.62, 0.1]],
    [[0.5, 0.05, 0.1], [0.8, 0.5, 0.6], [0.3, 0.45, 0.1]],
  ];
  const g = goods[kind % 3];
  if (kind % 3 === 1) {
    // goldfish scooping: a shallow blue tub with orange fish
    site.add('plain', lathe([[0.001, 0.9], [0.55, 0.9], [0.6, 1.08], [0.001, 1.08]], 14), at(0, 0.0, 0.2), { col: [0.08, 0.2, 0.45] });
    for (let i = 0; i < 9; i++) bx(site, 'plain', at, 0.06, 0.02, 0.03, Math.cos(i * 2.3) * 0.4, 1.09, 0.2 + Math.sin(i * 2.3) * 0.35, g[1], false, i);
  } else {
    for (let i = 0; i < 10; i++) site.add('plain', ball(0.07 + (kind % 3 === 0 ? 0.03 : 0), 6), at(-0.9 + (i % 5) * 0.45, 1.02, (i < 5 ? 0.15 : 0.45)), { col: g[i % 3] });
  }
  for (const sx of [-1, 1]) lantern(t, at(sx * 1.25, 2.28, 0.95), 0.05, R() < 0.6 ? RED : PAPER, 0.62);
  spot(t.svc.standing, at, Y, (R() - 0.5) * 1.2, 0, 1.7, Math.PI);
  count(t, 'yatai');
}

function festival(t: T, site: Site, sd: SiteDef, at: At, Y: number, R: () => number) {
  const hd = sd.d! / 2;
  // the lane runs along local z through the middle; stalls face it from both sides
  let k = 0;
  for (let z = -hd + 2.2; z < hd - 1.5; z += 3.4) {
    for (const sx of [-1, 1]) {
      yatai(t, site, frame(...wp(at(sx * 4.0, 0, z)), Y + (sx > 0 ? -Math.PI / 2 : Math.PI / 2)), Y + (sx > 0 ? -Math.PI / 2 : Math.PI / 2), k++, R);
    }
  }
  // lantern strings down the lane and a torii-like gateway of poles at the water end
  for (const sx of [-1, 1]) {
    const A = wp(at(sx * 2.6, 4.2, -hd + 0.5)), B = wp(at(sx * 2.6, 4.2, hd - 0.5));
    for (const [p] of [[A], [B]]) {
      site.add('timber', cylinder(0.08, 0.07, 4.6, 7, false), trs(p[0], p[1] - 4.4, p[2]), { col: [0.9, 0.82, 0.7] });
    }
    const L = Math.hypot(B[0] - A[0], B[2] - A[2]);
    const n = Math.floor(L / 1.25);
    const Q = (u: number) => [A[0] + (B[0] - A[0]) * u, A[1] - 0.6 * 4 * u * (1 - u), A[2] + (B[2] - A[2]) * u];
    for (let i = 0; i < 16; i++) rod(site, 'rope', Q(i / 16), Q((i + 1) / 16), 0.012, [0.5, 0.43, 0.3], true, 4);
    for (let i = 1; i < n; i++) {
      const q = Q(i / n);
      hangLantern(t.sway, q[0], q[1] - 0.1, q[2], q[1], i % 3 === 1 ? PAPER : RED, (t.seed++ * 0.618) % 1, 0.8);
      count(t, 'lanterns');
    }
  }
  for (let i = 0; i < 6; i++) spot(t.svc.standing, at, Y, (R() - 0.5) * 2.4, 0, -hd + 3 + i * 5.5, R() * 6.28);
  for (const z of [-hd + 6, 4]) spot(t.svc.birds, at, Y, 0.5, 0, z);
  spot(t.svc.cats, at, Y, 3.4, 0, hd - 1.2, 1.2);
}

/** a koi garden behind a clipped hedge: pond, arched bridge, lanterns, moss, rocks, pines */
function garden(t: T, site: Site, sd: SiteDef, at: At, Y: number, R: () => number) {
  const hw = sd.w! / 2, hd = sd.d! / 2;
  for (const [x0, z0, x1, z1] of [[-hw, -hd, hw, -hd], [-hw, -hd, -hw, hd], [hw, -hd, hw, hd], [-hw, hd, -2, hd], [2, hd, hw, hd]]) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    site.add('foliage', chamferBox(len + 0.9, 1.35, 0.95, 0), at((x0 + x1) / 2, 0.67, (z0 + z1) / 2, Math.atan2(x1 - x0, z1 - z0) - Math.PI / 2), { col: HEDGE });
  }
  // roofed garden gate
  for (const sx of [-1, 1]) bx(site, 'timber', at, 0.18, 2.5, 0.18, sx * 1.4, 1.25, hd);
  roof(site, at(0, 0, hd), { ex: 1.9, ez: 0.9, tx: 1.9, tz: 0, y0: 2.5, rise: 0.55, gable: true, verge: 0.2, rafters: false, thick: 0.14, sweep: 0.3, lite: true });
  // moss carpet
  site.add('foliage', chamferBox(2 * hw - 2, 0.06, 2 * hd - 2, 0), at(0, 0.03, 0), { col: MOSS });
  // the pond: an irregular outline, dark bed, clear water above, a rim of rocks
  const px = -hw * 0.15, pz = -hd * 0.1, rx = Math.min(7, hw * 0.55), rz = Math.min(4.6, hd * 0.45);
  const N = 18, rim: number[][] = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const k = 1 + 0.14 * Math.sin(a * 3 + 1) + 0.08 * Math.sin(a * 5);
    rim.push([px + Math.cos(a) * rx * k, pz + Math.sin(a) * rz * k]);
  }
  const bed: Part = { pos: [], nor: [], uv: [] }, water: Part = { pos: [], nor: [], uv: [] };
  for (let i = 0; i < N; i++) {
    const a = rim[i], b = rim[(i + 1) % N];
    poly(bed, [[px, 0.08, pz], [b[0], 0.08, b[1]], [a[0], 0.08, a[1]]], 'y', [0, 1, 0]);
    poly(water, [[px, 0.2, pz], [b[0], 0.2, b[1]], [a[0], 0.2, a[1]]], 'y', [0, 1, 0]);
  }
  site.add('plain', bed, at(0, 0, 0), { col: [0.03, 0.045, 0.03] });
  t.pond.add(water, at(0, 0, 0), { col: [1, 1, 1] });
  for (let i = 0; i < N; i++) {
    const a = rim[i], b = rim[(i + 1) % N];
    for (const u of [0, 0.5]) site.add('stone', rock(0.38 + R() * 0.2, 0.32 + R() * 0.2, i + (u ? 20 : 0)), at(a[0] + (b[0] - a[0]) * u, 0.02, a[1] + (b[1] - a[1]) * u, R() * 6), { col: [0.85, 0.85, 0.82] });
  }
  const [cx, cy, cz] = wp(at(px, 0.2, pz));
  const [ax, , az] = wp(at(px + 1, 0.2, pz));
  t.svc.ponds.push({ x: cx, y: sd.y + 0.2, z: cz, ax: ax - cx, az: az - cz, rx: rx * 0.55, rz: rz * 0.5 });
  // taiko-bashi: a steep vermilion arched bridge across the pond's waist
  const bxz = px + rx * 0.35;
  const span = rz * 2 + 1.2, rise = 1.1;
  for (let i = 0; i < 12; i++) {
    const u0 = i / 12, u1 = (i + 1) / 12;
    const y0 = 0.2 + Math.sin(u0 * Math.PI) * rise, y1 = 0.2 + Math.sin(u1 * Math.PI) * rise;
    const z0 = pz - span / 2 + u0 * span, z1 = pz - span / 2 + u1 * span;
    const len = Math.hypot(z1 - z0, y1 - y0), pitch = -Math.atan2(y1 - y0, z1 - z0);
    site.add('lacquer', chamferBox(1.5, 0.12, len + 0.02, 0), at(bxz, (y0 + y1) / 2, (z0 + z1) / 2, 0, pitch), { col: VER, v: [0, 0, 0, 0.15] });
    for (const sx of [-1, 1]) site.add('lacquer', chamferBox(0.07, 0.07, len + 0.02, 0), at(bxz + sx * 0.72, (y0 + y1) / 2 + 0.75, (z0 + z1) / 2, 0, pitch), { col: VER });
    if (i % 3 === 0) for (const sx of [-1, 1]) bx(site, 'lacquer', at, 0.09, 0.8, 0.09, bxz + sx * 0.72, y0 + 0.4, z0, VER);
  }
  for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
    bx(site, 'lacquer', at, 0.12, 0.95, 0.12, bxz + sx * 0.72, 0.65, pz + sz * span / 2, VER);
    site.add('plain', lathe([[0.001, 0], [0.08, 0.02], [0.07, 0.1], [0.001, 0.2]], 8), at(bxz + sx * 0.72, 1.12, pz + sz * span / 2), { col: BRONZE });
  }
  // a snow-viewing lantern on three legs at the water's edge, and a standing lantern
  const yk = at(px - rx * 0.7, 0, pz + rz * 0.6);
  for (let k = 0; k < 3; k++) site.add('dressed', cylinder(0.07, 0.06, 0.8, 6), yk.clone().multiply(trs(Math.cos(k * 2.09) * 0.45, 0, Math.sin(k * 2.09) * 0.45, 0, 0, Math.cos(k * 2.09) * 0.15)), { col: STONE });
  site.add('dressed', chamferBox(0.45, 0.4, 0.45, 0), yk.clone().multiply(trs(0, 0.95, 0)), { col: STONE });
  site.add('paper', chamferBox(0.3, 0.26, 0.3, 0), yk.clone().multiply(trs(0, 0.97, 0)), { col: PAPER, v: [0, 0, 0, 0.12] }, true);
  site.add('dressed', lathe([[0.001, 1.15], [1.0, 1.15], [1.02, 1.2], [0.4, 1.4], [0.08, 1.5], [0.001, 1.62]], 6, false), yk, { col: STONE });
  toro(site, at(hw - 3, 0, hd - 3), 2.0);
  // an azumaya pavilion at the back, stepping stones, pines, rocks and clipped azaleas
  const az_ = frame(...wp(at(hw * 0.55, 0, -hd + 3.5)), Y);
  bx(site, 'dressed', az_, 3.6, 0.3, 3.6, 0, 0.1, 0, STONE);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) bx(site, 'timber', az_, 0.14, 2.4, 0.14, sx * 1.5, 1.4, sz * 1.5, [1.3, 1.2, 1.0]);
  bx(site, 'timber', az_, 2.6, 0.08, 0.5, 0, 0.5, 1.2, [1.2, 1.1, 1.0]);
  roof(site, az_(0, 0, 0), { ex: 2.4, ez: 2.4, tx: 0, tz: 0, y0: 2.6, rise: 1.6, lift: 0.25, flare: 0.2, thick: 0.2, sweep: 0.5, hips: true, ridge: false, rafters: false, lite: true });
  spot(t.svc.seated, az_, Y, 0.3, 0.52, 1.2, Math.PI);
  for (let i = 0; i < 7; i++) bx(site, 'dressed', at, 0.7, 0.1, 0.55, (R() - 0.5) * 0.4 + i * 0.35, 0.06, hd - 1.2 - i * 0.9, [0.9, 0.9, 0.86], true, R());
  niwaki(site, at, px + rx + 1.6, pz - 1.0, R, 1.3);
  niwaki(site, at, -hw + 3, hd - 4, R, 1.0);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.3;
    const x = px + Math.cos(a) * (rx + 2.2 + R() * 1.5), z = pz + Math.sin(a) * (rz + 1.8 + R() * 1.2);
    if (Math.abs(x) > hw - 1.5 || Math.abs(z) > hd - 1.5) continue;
    site.add('foliage', mound(0.5 + R() * 0.35, 0.55 + R() * 0.35), at(x, 0.02, z), { col: AZALEA[i % AZALEA.length] });
  }
  spot(t.svc.cats, at, Y, px + rx * 0.9, 0.3, pz + rz * 0.3, -1.0);
  spot(t.svc.standing, at, Y, bxz, 0.2 + rise, pz, Math.PI / 2);
  count(t, 'gardens');
}

/** a small inari shrine: a tunnel of little vermilion torii, fox guardians and a hokora */
function inari(t: T, site: Site, sd: SiteDef, at: At, Y: number, R: () => number) {
  const hd = sd.d! / 2;
  torii(site, at(0, 0, hd - 1), 4.0, 3.0);
  for (let z = hd - 3; z > -hd + 6; z -= 1.15) torii(site, at(0, 0, z), 2.5, 1.6);
  for (let z = hd - 2.5; z > -hd + 4; z -= 0.9) bx(site, 'dressed', at, 1.2, 0.1, 0.7, 0, 0.04, z, [0.9, 0.9, 0.86], true);
  const hk = frame(...wp(at(0, 0, -hd + 3.5)), Y);
  bx(site, 'stone', hk, 2.6, 0.9, 2.2, 0, 0.35, 0, [0.95, 0.95, 0.95]);
  bx(site, 'lacquer', hk, 1.6, 1.3, 1.2, 0, 1.45, 0, VER);
  bx(site, 'dark', hk, 0.9, 0.9, 0.02, 0, 1.4, 0.61, [0.03, 0.02, 0.015]);
  roof(site, hk(0, 0, 0.2), { ex: 1.2, ez: 1.3, tx: 1.2, tz: 0, y0: 2.1, rise: 0.8, gable: true, verge: 0.25, rafters: false, thick: 0.14, sweep: 0.5, lite: true });
  // fox guardians with red bibs
  for (const sx of [-1, 1]) {
    const m = at(sx * 1.6, 0, -hd + 6.5, sx * -0.3);
    site.add('dressed', chamferBox(0.6, 0.7, 0.6, 0), m.clone().multiply(trs(0, 0.35, 0)), { col: STONE });
    site.add('dressed', lathe([[0.22, 0.7], [0.25, 0.95], [0.16, 1.25], [0.13, 1.4], [0.001, 1.45]], 8), m, { col: [0.78, 0.78, 0.74] });
    site.add('dressed', lathe([[0.001, 0], [0.1, 0.02], [0.07, 0.18], [0.001, 0.26]], 6), m.clone().multiply(trs(0, 1.42, 0.08, 0, 0.9)), { col: [0.8, 0.8, 0.76] });
    site.add('plain', part('jizo-bib', () => lathe([[0.2, 0.44], [0.17, 0.56], [0.1, 0.66], [0.001, 0.68]], 10)), m.clone().multiply(trs(0, 0.72, 0.04, 0, 0, 0, 1.1, 0.8, 1.1)), { col: [0.55, 0.05, 0.035] });
  }
  // a heap of little offering torii and a jizo at the entrance
  for (let i = 0; i < 12; i++) torii(site, at(1.6 + (i % 4) * 0.3, 0, -hd + 4.5 + Math.floor(i / 4) * 0.35, R() * 0.3), 0.45, 0.3);
  jizo(site, at, -2.2, hd - 1.8, 0);
  count(t, 'jizo');
  for (const sx of [-1, 1]) for (let i = 0; i < 5; i++) site.add('foliage', mound(0.6 + R() * 0.3, 0.8 + R() * 0.4), at(sx * (2.4 + R()), 0, hd - 4 - i * 3.5), { col: AZALEA[(i + (sx > 0 ? 1 : 3)) % AZALEA.length] });
  spot(t.svc.cats, at, Y, 0.6, 0.1, hd - 2.0, 0.4);
  count(t, 'inari');
}

function kuraYard(t: T, site: Site, sd: SiteDef, at: At, Y: number, R: () => number) {
  const hw = sd.w! / 2, hd = sd.d! / 2;
  for (const [x, z, w, d, turn] of [[-hw + 4.5, hd - 6, 6.5, 8.5, 0], [hw - 4.5, hd - 6, 6, 8, 0], [0, -hd + 5, 7.5, 7.5, Math.PI]] as const) {
    const fm = frame(...wp(at(x, 0, z)), Y + turn);
    bx(site, 'dressed', fm, w + 0.1, 0.45, d + 0.1, 0, -0.05, 0, [0.85, 0.85, 0.84]);
    kuraBody(site, fm, w, d, TONES[Math.floor(R() * 4)], R, [1, 1, 1], 0.6, R());
  }
  laundry(t, site, at, -2.5, 2.5, 1.5);
  const R2 = rng(991);
  for (let i = 0; i < 4; i++) taru(site, at(-hw + 9 + i * 0.7, 0, -2), R2);
  bambooRun(site, at, -hw + 1, hd, hw - 1, hd);
  spot(t.svc.birds, at, Y, 0, 0, 3);
  spot(t.svc.cats, at, Y, -hw + 4.5, 0.2, hd - 1.2, 0.2);
}

/** misugaki bamboo fence along local (x0, z0) -> (x1, z1) */
function bambooRun(site: Site, at: At, x0: number, z0: number, x1: number, z1: number, h = 1.3) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const yaw = Math.atan2(x1 - x0, z1 - z0) - Math.PI / 2;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  site.add('bamboo', chamferBox(len, h, 0.05, 0), at(cx, h / 2 + 0.05, cz, yaw), { col: [1, 0.95, 0.85] });
  const posts = Math.max(2, Math.round(len / 1.8) + 1);
  for (let i = 0; i < posts; i++) {
    const u = i / (posts - 1);
    site.add('timber', cylinder(0.05, 0.05, h + 0.25, 6), at(x0 + (x1 - x0) * u, -0.1, z0 + (z1 - z0) * u), { col: [1.2, 1.1, 1] }, true);
  }
}

function wagasaYard(t: T, site: Site, sd: SiteDef, at: At, Y: number, R: () => number) {
  const hw = sd.w! / 2, hd = sd.d! / 2;
  // umbrellas opened to dry in rows, tilted to the sun
  let i = 0;
  for (let x = -hw + 1.3; x < hw - 1; x += 1.45) for (let z = -hd + 1.4; z < hd - 1.8; z += 1.5) {
    wagasa(site, at(x + (R() - 0.5) * 0.3, 0.72, z + (R() - 0.5) * 0.3, R() * 6, -0.35 + R() * 0.2, (R() - 0.5) * 0.3), WAGASA[(i++ * 7 + 3) % WAGASA.length], 0.6);
  }
  bambooRun(site, at, -hw, hd, hw, hd, 1.1);
  const sh = frame(...wp(at(hw - 2, 0, -hd + 1.8)), Y);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) bx(site, 'timber', sh, 0.12, 2.3, 0.12, sx * 1.2, 1.15, sz * 0.9);
  roof(site, sh(0, 0, 0), { ex: 1.6, ez: 1.3, tx: 1.6, tz: 0, y0: 2.3, rise: 0.6, gable: true, verge: 0.2, rafters: false, thick: 0.12, sweep: 0.3, lite: true });
  spot(t.svc.standing, at, Y, 0.5, 0, 0.3, 0.8);
  count(t, 'wagasa', i);
}

/** hinomi-yagura: a fire lookout tower with a ladder, a platform, a little roof and an alarm bell */
function fireTower(t: T, site: Site, at: At) {
  const H = 12.5, b = 1.6, top = 0.9;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    rod(site, 'timber', wp(at(sx * b, 0, sz * b)), wp(at(sx * top, H, sz * top)), 0.13, [1.2, 1.1, 1.0], false, 6);
    bx(site, 'dressed', at, 0.5, 0.3, 0.5, sx * b, 0.1, sz * b, STONE);
  }
  for (let k = 0; k < 3; k++) {
    const y0 = k * (H / 3) + 0.4, y1 = (k + 1) * (H / 3) - 0.2;
    const r0 = b - ((b - top) * y0) / H, r1 = b - ((b - top) * y1) / H;
    for (const s of [-1, 1]) {
      rod(site, 'timber', wp(at(-r0, y0, s * r0)), wp(at(r1, y1, s * r1)), 0.06, [1.2, 1.1, 1.0], false, 5);
      rod(site, 'timber', wp(at(s * r0, y0, -r0)), wp(at(s * r1, y1, r1)), 0.06, [1.2, 1.1, 1.0], false, 5);
    }
  }
  for (const s of [-0.25, 0.25]) rod(site, 'timber', wp(at(s, 0, b + 0.3)), wp(at(s, H, top + 0.05)), 0.045, [1.2, 1.1, 1.0], false, 5);
  bx(site, 'timber', at, 2.6, 0.14, 2.6, 0, H, 0, [1.2, 1.1, 1.0]);
  for (const s of [-1, 1]) { bx(site, 'timber', at, 2.6, 0.08, 0.08, 0, H + 0.95, s * 1.25, [1.2, 1.1, 1.0]); bx(site, 'timber', at, 0.08, 0.08, 2.6, s * 1.25, H + 0.95, 0, [1.2, 1.1, 1.0]); }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) bx(site, 'timber', at, 0.1, 2.2, 0.1, sx * 1.2, H + 1.1, sz * 1.2, [1.2, 1.1, 1.0]);
  roof(site, at(0, 0, 0), { ex: 1.75, ez: 1.75, tx: 0, tz: 0, y0: H + 2.2, rise: 1.2, lift: 0.2, flare: 0.15, thick: 0.15, sweep: 0.4, hips: true, ridge: false, rafters: false, lite: true });
  site.add('plain', lathe([[0.001, -0.5], [0.24, -0.5], [0.22, -0.2], [0.14, 0.0], [0.001, 0.02]], 10), at(0, H + 1.9, 0), { col: BRONZE });
  count(t, 'towers');
}

// ---------------------------------------------------------------------------------------------
// fields

function paddy(t: T, site: Site, sd: SiteDef, at: At, Y: number, R: () => number) {
  const hw = sd.w! / 2, hd = sd.d! / 2;
  const cells = Math.max(1, Math.round((2 * hw) / 16));
  const cw = (2 * hw) / cells;
  for (let i = 0; i < cells; i++) {
    const x = -hw + cw * (i + 0.5);
    const planted = R() < 0.55 ? 1 : 0;
    bx(site, 'water', at, cw - 0.7, 0.04, 2 * hd - 0.7, x, 0.04, 0, [0.05, 0.055, 0.035], false, 0, [planted, 0, 0, 0]);
    // aze levee between plots
    if (i > 0) site.add('foliage', part('levee', () => chamferBox(0.55, 0.3, 1, 0)), at(-hw + cw * i, 0.1, 0).multiply(trs(0, 0, 0, 0, 0, 0, 1, 1, 2 * hd)), { col: LEVEE });
  }
  // levees round the terrace, the river-side one taller where the step drops
  for (const [z, h] of [[hd, 0.4], [-hd, 0.3]] as const) site.add('foliage', chamferBox(2 * hw + 0.5, h, 0.6, 0), at(0, h / 2 - 0.1, z), { col: LEVEE });
  for (const x of [-hw, hw]) site.add('foliage', chamferBox(0.6, 0.3, 2 * hd, 0), at(x, 0.05, 0), { col: LEVEE });
  if (sd.front! > 64 && sd.front! < 70 && R() < 0.8) scarecrow(site, at, (R() - 0.5) * hw, (R() - 0.5) * hd, R);
  spot(t.svc.birds, at, Y, (R() - 0.5) * hw, 0.3, hd - 0.1);
  count(t, 'paddies', cells);
}

function scarecrow(site: Site, at: At, x: number, z: number, R: () => number) {
  site.add('bamboo', cylinder(0.035, 0.03, 1.9, 6, false), at(x, 0, z), { col: [1, 0.9, 0.6] }, true);
  site.add('bamboo', cylinder(0.025, 0.025, 1.4, 5, false), at(x - 0.7, 1.45, z, 0, 0, -Math.PI / 2), { col: [1, 0.9, 0.6] }, true);
  bx(site, 'plain', at, 1.1, 0.7, 0.18, x, 1.25, z, NOREN[Math.floor(R() * 6)]);
  site.add('plain', lathe([[0.36, 0], [0.34, 0.03], [0.05, 0.16], [0.001, 0.17]], 12), at(x, 1.85, z), { col: [0.45, 0.35, 0.17] });
  site.add('plain', ball(0.13), at(x, 1.78, z), { col: [0.75, 0.72, 0.62] });
}

function teaRows(t: T, site: Site, sd: SiteDef, at: At, Y: number, R: () => number) {
  const hw = sd.w! / 2, hd = sd.d! / 2;
  // rounded hedgerows of tea along the terrace, a narrow path between each
  const row = part('tea-row', () => {
    const p: Part = { pos: [], nor: [], uv: [] };
    const prof: number[][] = [];
    for (let i = 0; i <= 6; i++) { const a = (i / 6) * Math.PI; prof.push([Math.cos(a) * 0.62, 0.35 + Math.sin(a) * 0.62]); }
    prof.unshift([0.6, 0]); prof.push([-0.6, 0]);
    for (let i = 0; i + 1 < prof.length; i++) {
      const [x0, y0] = prof[i], [x1, y1] = prof[i + 1];
      polyOut(p, [[x0, y0, -0.5], [x0, y0, 0.5], [x1, y1, 0.5], [x1, y1, -0.5]], [(x0 + x1) / 2, (y0 + y1) / 2 - 0.2, 0]);
    }
    return p;
  });
  let n = 0;
  for (let z = -hd + 1.1; z < hd - 0.8; z += 1.85) {
    const len = 2 * hw - 1.2 - (n % 3) * 0.4;
    site.add('foliage', row, at(0, 0, z, Math.PI / 2).multiply(trs(0, 0, 0, 0, 0, 0, 1, 0.9 + ((n * 7) % 3) * 0.05, len)), { col: TEA });
    n++;
  }
  if (R() < 0.7) spot(t.svc.standing, at, Y, (R() - 0.5) * hw, 0, -hd + 1.1 + 0.92, Math.PI / 2);
  count(t, 'tea rows', n);
}

function yard(t: T, site: Site, sd: SiteDef, at: At, Y: number, R: () => number) {
  const hw = sd.w! / 2, hd = sd.d! / 2;
  bambooRun(site, at, -hw, hd - 0.2, -0.8, hd - 0.2);
  bambooRun(site, at, 0.8, hd - 0.2, hw, hd - 0.2);
  laundry(t, site, at, -hw + 0.8, hw - 0.8, -0.5);
  for (let i = 0; i < 3; i++) pot(site, at, hw - 0.6, hd - 1 - i * 0.55, R);
  bench(site, at, -hw + 1.3, -hd + 1.2, false);
  if (R() < 0.6) spot(t.svc.cats, at, Y, -hw + 1.3, 0.51, -hd + 1.2, R() * 6);
  else spot(t.svc.birds, at, Y, 0, 0, 1);
  count(t, 'yards');
}

// ---------------------------------------------------------------------------------------------

function pondMaterial() {
  const m = new MeshStandardNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
  m.colorNode = vec3(0.025, 0.05, 0.045).mul(mx_noise_float(positionWorld.mul(0.8)).mul(0.2).add(1));
  m.opacityNode = float(0.62);
  m.roughnessNode = float(0.04);
  m.metalnessNode = float(0);
  return m;
}

/** build the town into the village sites (by along-river s); returns the service for life and critters */
export async function buildTown(ctx: GameContext, mats: Materials | null, siteFor: (s: number) => Site, slice: () => Promise<void> = async () => {}) {
  const t0 = performance.now();
  const svc: TownService = { cats: [], birds: [], standing: [], seated: [], walks: [], ponds: [], stats: {} };
  const t: T = { ctx, cloth: new Bucket(), sway: new Bucket(), pond: new Bucket(), svc, seed: 1, n: {} };
  const safe = (label: string, fn: () => void) => {
    try { fn(); } catch (e) { console.error(`[structures] town ${label} failed`, e); }
  };
  for (const lane of LANES) safe(lane.id, () => pave(t, siteFor, lane));
  for (const sd of TOWN) {
    if (sd.s === undefined || !sd.side || !sd.kind || sd.kind === 'lane') continue;
    await slice();
    const site = siteFor(sd.s);
    const Y = yawFacing(sd.s, sd.side) + (sd.facing === -1 ? Math.PI : 0);
    const at = frame(sd.x, sd.y, sd.z, Y);
    const R = rng(Math.round(sd.s * 13 + sd.side * 7 + (sd.facing === -1 ? 5 : 0) + (sd.front ?? 0) * 3));
    const role = sd.role ?? '';
    safe(sd.id, () => {
      if (sd.kind === 'town') {
        if (role === 'yard') yard(t, site, sd, at, Y, R);
        else townhouse(t, site, at, Y, sd.w!, sd.d!, role, R);
        if (role === 'kura' && R() < 0.3) spot(svc.cats, at, Y, 0.9, 0.3, sd.d! / 2 + 0.3, R());
      } else if (role === 'temple') templePrecinct(t, site, sd, at, Y, R);
      else if (role === 'shrine') shrinePrecinct(t, site, sd, at, Y, R);
      else if (role === 'sake') brewery(t, site, sd, at, Y, R);
      else if (role === 'yatai') festival(t, site, sd, at, Y, R);
      else if (role === 'garden') garden(t, site, sd, at, Y, R);
      else if (role === 'inari') inari(t, site, sd, at, Y, R);
      else if (role === 'kurayard') kuraYard(t, site, sd, at, Y, R);
      else if (role === 'wagasa') wagasaYard(t, site, sd, at, Y, R);
      else if (role === 'tower') fireTower(t, site, at);
      else if (role === 'belfry') belfry(t, site, at);
      else if (role === 'paddy') paddy(t, site, sd, at, Y, R);
      else if (role === 'tea') teaRows(t, site, sd, at, Y, R);
    });
  }
  // strollers along both streets, in both directions
  for (const [side, s0, s1] of [[-1, 60, 660], [1, 62, 325], [1, 466, 658]] as [-1 | 1, number, number][]) {
    for (const o of [-0.9, 0.9]) svc.walks.push({ side, s0, s1, offset: STREET_Q + o });
    svc.walks.push({ side, s0: s0 + (s1 - s0) * 0.3, s1: s0 + (s1 - s0) * 0.75, offset: STREET_Q + 0.3 });
  }
  void STREET_HALF;

  const root = new Group();
  root.name = 'structures:town';
  // the swaying lanterns join the river life's hanging mesh (one draw for every lantern string)
  svc.sway = t.sway;
  const meshes: [Bucket, MeshStandardNodeMaterial, string, boolean][] = [
    [t.cloth, clothMaterial(), 'town:cloth', false],
    [t.pond, pondMaterial(), 'town:ponds', false],
  ];
  for (const [b, material, name, cast] of meshes) {
    if (!b.finite()) { console.error('[structures] town: non-finite', name); continue; }
    const g = b.build();
    if (!g) continue;
    const m = new Mesh(g, material);
    m.name = name;
    m.castShadow = cast;
    m.receiveShadow = true;
    m.layers.set(LAYERS.NO_REFLECT);
    // swaying geometry moves a little past its bounds; the sphere is widened rather than disabled
    g.boundingSphere!.radius += 1.5;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    root.add(m);
  }
  ctx.scene.add(root);
  svc.stats = { ...t.n, ms: Math.round(performance.now() - t0) };
  void mats;
  return { root, svc };
}

// ---------------------------------------------------------------------------------------------
// cats and sparrows: one draw each, placed once; every movement (a tail flick, a glance, hops and
// pecks) happens in the vertex shader from the shared clock, so they cost nothing per frame.

type N = any;
const TAIL: RGB = [1, 0, 0], HEAD: RGB = [0, 0, 1], BODY: RGB = [0, 0, 0];

function catGeometry() {
  const b = new Bucket();
  b.add(lathe([[0.001, 0], [0.085, 0.01], [0.105, 0.06], [0.098, 0.13], [0.07, 0.2], [0.045, 0.24], [0.001, 0.25]], 10), trs(0, 0, 0.03, 0, 0, 0, 1, 1, 1.3), { col: BODY });
  b.add(lathe([[0.001, 0], [0.035, 0.005], [0.03, 0.09], [0.001, 0.1]], 6), trs(0, 0.02, -0.07), { col: BODY });
  b.add(lathe([[0.001, -0.055], [0.045, -0.045], [0.062, 0], [0.05, 0.04], [0.001, 0.058]], 10), trs(0, 0.285, -0.04, 0, 0, 0, 1.1, 0.95, 1), { col: HEAD });
  for (const sx of [-1, 1]) b.add(lathe([[0.022, 0], [0.001, 0.05]], 4), trs(sx * 0.035, 0.325, -0.035, 0, 0, -sx * 0.25), { col: HEAD });
  b.add(lathe([[0.001, -0.02], [0.02, -0.01], [0.012, 0.012], [0.001, 0.02]], 6), trs(0, 0.275, -0.1), { col: HEAD });
  const pts = [[0.06, 0.02, 0.12], [0.11, 0.02, 0.08], [0.14, 0.025, 0.0], [0.13, 0.03, -0.07], [0.09, 0.035, -0.11]];
  for (let i = 0; i + 1 < pts.length; i++) {
    const q = segment(pts[i], pts[i + 1]);
    b.add(cylinder(0.018, 0.015, q.len, 5), q.m, { col: TAIL });
  }
  return b.build()!;
}

function catDeform(p: N, ph: N) {
  const tag = attribute('aCol', 'vec3') as N;
  const t = uTime.add(ph.mul(37));
  // tail tip flicks, the head turns to look around now and then
  const flick = sin(t.mul(1.9)).mul(0.3).mul(tag.x).mul(smoothstep(0.02, 0.15, abs(p.z.sub(0.1))));
  const look = smoothstep(0.6, 0.95, sin(t.mul(0.21))).sub(smoothstep(0.6, 0.95, sin(t.mul(0.17).add(2.3)))).mul(0.8).mul(tag.z);
  const a = flick.add(look);
  const c = cos(a), s = sin(a);
  const z0 = p.z.add(0.03);
  return vec3(p.x.mul(c).add(z0.mul(s)), p.y.add(sin(t.mul(1.1)).mul(0.003)), z0.mul(c).sub(p.x.mul(s)).sub(0.03));
}

function catColour(v: N, ph: N) {
  const tag = attribute('aCol', 'vec3') as N;
  const n = mx_noise_float(positionGeometry.mul(14).add(vec3(ph.mul(17), 0, 0))) as N;
  const black = vec3(0.018, 0.017, 0.016), ginger = vec3(0.42, 0.18, 0.05), grey = vec3(0.14, 0.13, 0.12), white = vec3(0.7, 0.68, 0.62);
  const calico = mix(mix(white, ginger, smoothstep(0.05, 0.15, n)), black, smoothstep(0.3, 0.4, n.mul(-1)));
  let c: N = mix(black, ginger, step(0.2, v));
  c = mix(c, grey, step(0.45, v));
  c = mix(c, calico, step(0.65, v));
  c = mix(c, white, step(0.87, v));
  // darker back and tail on the solid coats, a pale muzzle and chest
  const back = smoothstep(0.1, 0.25, positionGeometry.y).mul(smoothstep(-0.02, 0.1, positionGeometry.z)).mul(0.35);
  c = c.mul(float(1).sub(back.mul(step(v, 0.65))));
  const chest = smoothstep(0.02, -0.08, positionGeometry.z).mul(smoothstep(0.08, 0.2, positionGeometry.y)).mul(float(1).sub(tag.x));
  return mix(c, white, chest.mul(0.35).mul(step(0.2, v)));
}

function sparrowGeometry() {
  const b = new Bucket();
  b.add(body([[0, -0.07], [0.022, -0.045], [0.03, -0.005], [0.027, 0.03], [0, 0.052]], 8), trs(0, 0.045, 0), { col: [0.2, 0.12, 0.06] });
  b.add(lathe([[0.001, -0.022], [0.021, -0.012], [0.022, 0.008], [0.001, 0.022]], 8), trs(0, 0.075, -0.045), { col: [0.26, 0.11, 0.04] });
  b.add(lathe([[0.001, -0.012], [0.016, -0.004], [0.001, 0.012]], 6), trs(0, 0.058, -0.052), { col: [0.02, 0.02, 0.02] });
  for (const sx of [-1, 1]) b.add(lathe([[0.001, -0.008], [0.009, 0], [0.001, 0.008]], 5), trs(sx * 0.016, 0.072, -0.05), { col: [0.62, 0.6, 0.55] });
  b.add(lathe([[0.006, 0], [0.001, 0.014]], 4), trs(0, 0.074, -0.068, 0, -Math.PI / 2), { col: [0.05, 0.04, 0.03] });
  const tail: Part = { pos: [], nor: [], uv: [] };
  poly(tail, [[-0.018, 0.05, 0.04], [0.018, 0.05, 0.04], [0.014, 0.06, 0.1], [-0.014, 0.06, 0.1]], 'z', [0, 1, 0]);
  b.add(tail, new Matrix4(), { col: [0.15, 0.09, 0.05] });
  return b.build()!;
}

function sparrowDeform(p: N, ph: N) {
  const t = uTime.add(ph.mul(53));
  // bursts of hopping about the spot, pecking at the ground in between
  const burst = smoothstep(0.2, 0.55, sin(t.mul(0.8)));
  const hop = abs(sin(t.mul(10))).mul(0.05).mul(burst);
  const peck = smoothstep(0.6, 0.95, sin(t.mul(3.1))).mul(float(1).sub(burst)).mul(0.7);
  const c = cos(peck), s = sin(peck);
  const y = p.y.sub(0.02), z = p.z;
  const q = vec3(p.x, y.mul(c).add(z.mul(s)).add(0.02), z.mul(c).sub(y.mul(s)));
  const wander = vec3(sin(t.mul(0.31)).mul(0.45), hop, cos(t.mul(0.23)).mul(0.45));
  return q.add(wander);
}

export function createCritters(ctx: GameContext, svc: TownService) {
  const root = new Group();
  root.name = 'structures:critters';
  const cats = crowd(catGeometry(), Math.max(1, svc.cats.length), catDeform, catColour, 0.85);
  const birds = crowd(sparrowGeometry(), Math.max(1, svc.birds.length * 5), sparrowDeform, null, 0.85);
  svc.cats.forEach((c, i) => crowdSet(cats, i, c.x, c.y, c.z, c.yaw, (i * 0.37) % 1, 1, ((i * 0.618) % 1), 0));
  crowdCommit(cats, svc.cats.length);
  let n = 0;
  svc.birds.forEach((b, i) => {
    for (let k = 0; k < 5; k++) {
      const a = k * 1.3 + i, r = 0.25 + (k % 3) * 0.3;
      crowdSet(birds, n++, b.x + Math.cos(a) * r, b.y, b.z + Math.sin(a) * r, a * 2.1, (i * 5 + k) * 0.113 % 1, 1 + (k % 2) * 0.08, 0, 0);
    }
  });
  crowdCommit(birds, n);
  const pts = [...svc.cats, ...svc.birds];
  const center = new Vector3();
  for (const p of pts) center.add(new Vector3(p.x, p.y, p.z));
  if (pts.length) center.divideScalar(pts.length);
  let reach = 0;
  for (const p of pts) reach = Math.max(reach, center.distanceTo(new Vector3(p.x, p.y, p.z)));
  for (const c of [cats, birds]) {
    c.mesh.castShadow = false;
    c.mesh.receiveShadow = true;
    c.mesh.layers.set(LAYERS.NO_REFLECT);
    c.mesh.name = 'town:critters';
    root.add(c.mesh);
  }
  ctx.scene.add(root);
  ctx.onUpdate((c) => { root.visible = c.camera.position.distanceTo(center) - reach < 250; }, 23);
  return { root, counts: { cats: svc.cats.length, sparrows: n } };
}
