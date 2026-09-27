// vegetation field: per-texel grass density, tallness, dryness, lushness, flower and shrub
// suitability derived from the baked world. it shares the world grid (texel centers at
// (i + 0.5) * size / res) so cpu placement and the gpu field texture agree.
// optional bake channels are used by name when present: cliff, path, ao, flowers, shrubs, trees.
import type { WorldData } from '../world/worldData';
import { SITES } from '../world/sites';

/** flattened building sites are excluded from grass and tree placement */
export interface Pad { id: string; x: number; z: number; hx: number; hz: number; yawDeg: number; y: number; blend: number }
export const layoutPads = (): Pad[] => SITES;
import { clamp01, fbm, smooth, vnoise } from './noise';

export type HeightFn = (x: number, z: number) => number;

/** prevailing wind blows toward the north-east (from the south-west); matches uWindDir's default */
export const PREVAILING = { x: 0.78, z: -0.62 };

export class VegetationField {
  res: number;
  size: number;
  half: number;
  cell: number;
  /** 0..1 grass clump density */
  density: Float32Array;
  /** 0..1 clump tallness */
  tall: Float32Array;
  /** 0..1 sea-breeze dryness (straw tips) */
  dry: Float32Array;
  /** 0..1 sheltered lushness (darker, taller) */
  lush: Float32Array;
  /** 0..1 flower patch strength */
  flower: Float32Array;
  /** 0..1 shrub suitability */
  shrub: Float32Array;
  /** 0..1 open land usable for trees (flat, grassy, not on pads) */
  open: Float32Array;
  /** 0..1 reeds and irises at slow water margins */
  reed: Float32Array;
  /** rgba8 far bloom colour (sqrt rgb) and coverage, for the ground tint of flower drifts */
  bloom: Uint8Array;
  /** per-texel terrain normal (x, z); y is derived */
  nx: Float32Array;
  nz: Float32Array;

  world: WorldData;

  private prep: any = null;
  private done: Uint8Array;
  private pending: number;

  /** deferred = true leaves the rows to buildAsync() (near-first, time-sliced) */
  constructor(world: WorldData, heightAt: HeightFn, deferred = false) {
    this.world = world;
    // the field runs on the mask grid (capped at 1024); height may be baked finer and is resampled
    const res = Math.min(1024, world.channels.get('grass')?.res ?? world.channels.get('height')?.res ?? 1024);
    this.res = res;
    this.size = world.size;
    this.half = world.size / 2;
    this.cell = world.size / res;
    const n = res * res;
    this.density = new Float32Array(n);
    this.tall = new Float32Array(n);
    this.dry = new Float32Array(n);
    this.lush = new Float32Array(n);
    this.flower = new Float32Array(n);
    this.shrub = new Float32Array(n);
    this.open = new Float32Array(n);
    this.reed = new Float32Array(n);
    this.bloom = new Uint8Array(n * 4);
    this.nx = new Float32Array(n);
    this.nz = new Float32Array(n);
    this.done = new Uint8Array(res);
    this.pending = res;
    this.prepare(heightAt);
    if (!deferred) for (let j = 0; j < res; j++) this.row(j);
  }

  get ready() { return this.pending === 0; }

  /** shipped layout: three rgba8 planes (density dry lush flower | tall shrub open reed | bloom) */
  pack(): Uint8Array {
    const n = this.res * this.res;
    const out = new Uint8Array(n * 12);
    out.set(this.packRGBA(), 0);
    const q = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
    for (let k = 0; k < n; k++) {
      const o = n * 4 + k * 4;
      out[o] = q(this.tall[k]); out[o + 1] = q(this.shrub[k]); out[o + 2] = q(this.open[k]); out[o + 3] = q(this.reed[k]);
    }
    out.set(this.bloom, n * 8);
    return out;
  }

  /** fill every row from a shipped bake (see pack); then fillNormals() over all rows */
  unpack(bytes: ArrayBuffer) {
    const n = this.res * this.res;
    const b = new Uint8Array(bytes);
    if (b.byteLength < n * 12) throw new Error('vegetation field bake has the wrong size');
    const k = 1 / 255;
    const { density, dry, lush, flower, tall, shrub, open, reed } = this;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      density[i] = b[o] * k; dry[i] = b[o + 1] * k; lush[i] = b[o + 2] * k; flower[i] = b[o + 3] * k;
      const o2 = n * 4 + o;
      tall[i] = b[o2] * k; shrub[i] = b[o2 + 1] * k; open[i] = b[o2 + 2] * k; reed[i] = b[o2 + 3] * k;
    }
    this.packed = b.subarray(0, n * 4);
    this.bloom.set(b.subarray(n * 8, n * 12));
    this.done.fill(1);
    this.pending = 0;
  }

  /** terrain normals of rows [j0, j1) from the height grid (a shipped field does not carry them) */
  fillNormals(j0: number, j1: number) {
    const { res, cell } = this;
    const { H, hAt } = this.prep;
    for (let j = j0; j < Math.min(res, j1); j++) for (let i = 0; i < res; i++) {
      const idx = j * res + i;
      if (H[idx] < 0.4) continue;
      const hx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * cell);
      const hz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * cell);
      const inv = 1 / Math.hypot(hx, 1, hz);
      this.nx[idx] = -hx * inv;
      this.nz[idx] = -hz * inv;
    }
  }

  private packed: Uint8Array | null = null;

  /** build the remaining rows nearest to world z first, yielding every `budgetMs` */
  async buildAsync(nearZ: number, budgetMs = 40) {
    const order = Array.from({ length: this.res }, (_, j) => j)
      .sort((a, b) => Math.abs(-this.half + (a + 0.5) * this.cell - nearZ) - Math.abs(-this.half + (b + 0.5) * this.cell - nearZ));
    let t0 = performance.now();
    for (const j of order) {
      this.row(j);
      if (performance.now() - t0 > budgetMs) {
        this.busyMs += performance.now() - t0;
        await new Promise<void>((r) => setTimeout(r, 0));
        t0 = performance.now();
      }
    }
    this.busyMs += performance.now() - t0;
  }

  /** main-thread time spent in buildAsync */
  busyMs = 0;

  private prepare(heightAt: HeightFn) {
    void heightAt;
    const w = this.world;
    const { res, cell, half } = this;
    const has = (c: string) => w.has(c);
    const ch = (c: string) => (has(c) ? w.channels.get(c)!.data : null);
    const hc = w.channels.get('height')!;
    let H = hc.data;
    if (hc.res === res * 2) {
      // a texel centre is the centre of a 2x2 block of height texels: their mean is the bilinear sample
      H = new Float32Array(res * res);
      const hr = hc.res, D = hc.data;
      for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
        const k = 2 * j * hr + 2 * i;
        H[j * res + i] = (D[k] + D[k + 1] + D[k + hr] + D[k + hr + 1]) * 0.25;
      }
    } else if (hc.res !== res) {
      H = new Float32Array(res * res);
      for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) H[j * res + i] = w.sample('height', -half + (i + 0.5) * cell, -half + (j + 0.5) * cell);
    }
    const G = ch('grass'), S = ch('sand'), R = ch('rock'), SH = ch('shore');
    const CLIFF = ch('cliff'), PATH = ch('path'), AO = ch('ao'), FL = ch('flowers'), SB = ch('shrubs');
    const TR = ch('trees'), PEB = ch('pebbles'), RD = ch('reeds');
    const chRes = (c: string) => w.channels.get(c)?.res ?? res;
    // channels may have other resolutions; sample by world position when they do
    const at = (arr: Float32Array | null, name: string, x: number, z: number, i: number, j: number) => {
      if (!arr) return 0;
      if (chRes(name) === res) return arr[j * res + i];
      return w.sample(name, x, z);
    };
    const hAt = (i: number, j: number) => H[(j < 0 ? 0 : j >= res ? res - 1 : j) * res + (i < 0 ? 0 : i >= res ? res - 1 : i)];
    const pads = layoutPads().map(padFrame);
    // pads only matter within ~6 m of their rectangle: bucket them on a coarse grid so each field cell
    // tests the few nearby pads instead of every building in the valley (the town has ~100)
    const B = 32;
    const buckets = new Map<number, PadFrame[]>();
    const bkey = (bx: number, bz: number) => (bx + 512) * 1024 + (bz + 512);
    for (const p of pads) {
      const r = Math.hypot(p.pad.hx, p.pad.hz) + 6 + p.pad.blend * 0.15 + 1;
      for (let bz = Math.floor((p.pad.z - r) / B); bz <= Math.floor((p.pad.z + r) / B); bz++)
        for (let bx = Math.floor((p.pad.x - r) / B); bx <= Math.floor((p.pad.x + r) / B); bx++) {
          const k = bkey(bx, bz);
          let list = buckets.get(k);
          if (!list) buckets.set(k, (list = []));
          list.push(p);
        }
    }
    const k4 = Math.max(1, Math.round(4 / cell)), k8 = Math.max(1, Math.round(8 / cell));
    this.prep = { w, H, G, S, R, SH, CLIFF, PATH, AO, FL, SB, TR, PEB, RD, chRes, at, hAt, buckets, bkey, B, k4, k8 };
  }

  private row(j: number) {
    if (this.done[j]) return;
    this.done[j] = 1;
    this.pending--;
    const { res, cell, half } = this;
    const { w, H, G, S, R, SH, CLIFF, PATH, AO, FL, SB, TR, PEB, RD, chRes, at, hAt, buckets, bkey, B, k4, k8 } = this.prep;
    void w;
    const z = -half + (j + 0.5) * cell;
    for (let i = 0; i < res; i++) {
      const idx = j * res + i;
      const h = H[idx];
      if (h < 0.4) continue;
      const x = -half + (i + 0.5) * cell;

      // slope from central differences
      const hx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * cell);
      const hz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * cell);
      const inv = 1 / Math.hypot(hx, 1, hz);
      const ny = inv;
      this.nx[idx] = -hx * inv;
      this.nz[idx] = -hz * inv;

      // river world: y = 0 is the water surface, `shore` is the signed distance to the waterline
      const shore = SH ? at(SH, 'shore', x, z, i, j) : h * 4;
      const land = smooth(0.15, 0.55, h) * smooth(0.2, 1.2, shore);
      if (land <= 0) continue;
      const sand = at(S, 'sand', x, z, i, j);
      const rock = at(R, 'rock', x, z, i, j);
      const grassMask = G ? at(G, 'grass', x, z, i, j) : 1 - Math.max(sand, rock);
      const path = at(PATH, 'path', x, z, i, j);
      const cliffHere = at(CLIFF, 'cliff', x, z, i, j);

      // pads: none on the pad, trampled and sparse in the blend ring
      let padD = 1e9;
      const near = buckets.get(bkey(Math.floor(x / B), Math.floor(z / B)));
      if (near) for (const p of near) padD = Math.min(padD, padDistance(p, x, z) - p.pad.blend * 0.15);
      const padMask = smooth(0.5, 6, padD);

      const slopeOk = smooth(0.6, 0.86, ny);
      const base = clamp01(grassMask * 1.15) * (1 - smooth(0.2, 0.5, sand)) * (1 - smooth(0.25, 0.55, rock)) *
        (1 - smooth(0.2, 0.6, path)) * (1 - smooth(0.3, 0.7, cliffHere)) * land * slopeOk * padMask;

      // curvature at ~8 m: + = hollow (sheltered), - = ridge (exposed)
      const ring8 = (hAt(i + k8, j) + hAt(i - k8, j) + hAt(i, j + k8) + hAt(i, j - k8)) * 0.25;
      const curv = ring8 - h;
      const hollow = smooth(0.1, 1.1, curv);
      const ridge = smooth(0.15, 1.4, -curv);

      // cliff edge proximity: steep ground or rock / cliff mask within ~4-8 m
      let edge = 0;
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        for (const k of [k4, k8]) {
          const ii = i + Math.round(Math.cos(ang) * k), jj = j + Math.round(Math.sin(ang) * k);
          if (ii < 0 || jj < 0 || ii >= res || jj >= res) continue;
          const id2 = jj * res + ii;
          const drop = h - H[id2];
          let e = smooth(2.5, 7, drop) * (k === k4 ? 1 : 0.7);
          if (CLIFF) e = Math.max(e, (chRes('cliff') === res ? CLIFF[id2] : 0) * (k === k4 ? 1 : 0.6));
          else if (R) e = Math.max(e, (chRes('rock') === res ? R[id2] : 0) * smooth(4, 10, h) * (k === k4 ? 0.8 : 0.5));
          edge = Math.max(edge, e);
        }
      }
      const sandAt = (dx: number, dz: number) => at(S, 'sand', x + dx * cell, z + dz * cell, Math.min(res - 1, Math.max(0, i + dx)), Math.min(res - 1, Math.max(0, j + dz)));
      const nearSand = S ? Math.max(sandAt(k4, 0), sandAt(-k4, 0), sandAt(0, k4), sandAt(0, -k4)) : 0;

      // windward faces (toward the south-west) are more exposed
      const windward = smooth(0.05, 0.45, -(this.nx[idx] * PREVAILING.x + this.nz[idx] * PREVAILING.z)) * smooth(6, 30, h);
      const exposure = clamp01(ridge * 0.7 + windward * 0.5 + smooth(25, 60, h) * 0.3);
      const ao = AO ? 1 - at(AO, 'ao', x, z, i, j) : 0;

      const nBig = fbm(x / 46, z / 46, 3, 11);
      const nMid = fbm(x / 13, z / 13, 3, 12);
      const nTall = fbm(x / 9, z / 9, 3, 13);

      // river banks: lush, tall natural clumps right down to the water, like the reference
      const bank = SH ? smooth(16, 2.5, shore) * smooth(0.2, 1.2, shore) : 0;
      const trees = at(TR, 'trees', x, z, i, j);
      const lush = clamp01(hollow * 0.85 + ao * 0.4 + (nBig - 0.5) * 0.5 - edge * 0.6 - exposure * 0.25 + bank * 0.3);
      const dry = clamp01(edge * 0.9 + exposure * 0.35 + nearSand * 0.45 + (0.5 - nBig) * 0.35 + (1 - padMask) * 0.4 - hollow * 0.5);
      const patch = smooth(0.28, 0.66, nMid);
      const peb = at(PEB, 'pebbles', x, z, i, j);
      const density = base * (0.62 + 0.38 * patch) * (0.85 + 0.3 * lush) * (1 - 0.25 * edge) * (1 - 0.55 * trees) * (1 - 0.6 * smooth(0.3, 0.8, peb)) * (1 + 0.35 * bank);
      const tall = clamp01(0.32 + (nTall - 0.5) * 0.9 + lush * 0.3 + bank * 0.45 - exposure * 0.3 - edge * 0.45 - (1 - padMask) * 0.5 - path * 0.5 - trees * 0.2);

      this.density[idx] = clamp01(density);
      this.tall[idx] = tall;
      this.dry[idx] = dry;
      this.lush[idx] = lush;

      // broad flower drifts follow sheltered banks, with lighter breaks between the pockets, and a
      // sprinkle of single flowers through every lawn
      const fpatch = smooth(0.5, 0.7, fbm((x + 413) / 9.5, (z - 271) / 9.5, 3, 21));
      const bankPatch = bank * smooth(0.36, 0.6, fbm((x - 175) / 14, (z + 89) / 14, 2, 25));
      const fAuthored = FL ? at(FL, 'flowers', x, z, i, j) : 0;
      const fl = Math.max(fAuthored, fpatch * (0.55 + 0.3 * vnoise(x / 30, z / 30, 22)), bankPatch * 0.95, 0.09);
      const flower = clamp01(fl * base * (1 - lush * 0.15) * (1 - path) * (1 - trees * 0.55));
      this.flower[idx] = flower;
      if (flower > 0.02) {
        // mean bloom colour of the drift, as seen from far away
        const bw = flowerBlend(x, z, dry, lush, shore);
        let r = 0, g = 0, b = 0;
        for (let k = 0; k < 5; k++) { r += bw[k] * FLOWER_RGB[k][0]; g += bw[k] * FLOWER_RGB[k][1]; b += bw[k] * FLOWER_RGB[k][2]; }
        const o4 = idx * 4;
        this.bloom[o4] = Math.round(Math.sqrt(r) * 255);
        this.bloom[o4 + 1] = Math.round(Math.sqrt(g) * 255);
        this.bloom[o4 + 2] = Math.round(Math.sqrt(b) * 255);
        this.bloom[o4 + 3] = Math.round(clamp01(flower * bw[5]) * 255);
      }

      // shrubs: sheltered hollows, lee slopes, near paths and rock outcrops, not on cliff edges
      const sAuthored = SB ? at(SB, 'shrubs', x, z, i, j) : -1;
      const shelter = clamp01(hollow * 0.8 + (1 - exposure) * 0.3 + smooth(0.1, 0.4, rock) * 0.3 + smooth(0.05, 0.3, path) * 0.35);
      const sBase = land * smooth(0.55, 0.8, ny) * padMask * (1 - smooth(0.2, 0.5, sand)) * (1 - smooth(0.4, 0.7, rock)) * (1 - edge * 0.8) * (1 - smooth(0.5, 0.8, path));
      this.shrub[idx] = clamp01((sAuthored >= 0 ? sAuthored : shelter * smooth(0.45, 0.75, fbm(x / 22, z / 22, 3, 31))) * sBase);
      this.reed[idx] = RD ? clamp01(at(RD, 'reeds', x, z, i, j)) : 0;
      this.open[idx] = land * smooth(0.8, 0.93, ny) * padMask * (1 - smooth(0.3, 0.6, sand)) * (1 - smooth(0.3, 0.6, rock)) * (1 - smooth(0.2, 0.5, path)) * clamp01(grassMask * 1.3);
    }
  }

  /** bilinear sample of a field array at world (x, z) */
  sample(arr: Float32Array, x: number, z: number): number {
    const n = this.res;
    const fx = ((x + this.half) / this.size) * n - 0.5;
    const fz = ((z + this.half) / this.size) * n - 0.5;
    let x0 = Math.floor(fx), z0 = Math.floor(fz);
    const tx = fx - x0, tz = fz - z0;
    let x1 = x0 + 1, z1 = z0 + 1;
    x0 = x0 < 0 ? 0 : x0 >= n ? n - 1 : x0;
    x1 = x1 < 0 ? 0 : x1 >= n ? n - 1 : x1;
    z0 = z0 < 0 ? 0 : z0 >= n ? n - 1 : z0;
    z1 = z1 < 0 ? 0 : z1 >= n ? n - 1 : z1;
    const a = arr[z0 * n + x0], b = arr[z0 * n + x1], c = arr[z1 * n + x0], e = arr[z1 * n + x1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (e - c) * tx) * tz;
  }

  /** max of a field over a world-space square (coarse, texel stride) */
  maxOver(arr: Float32Array, x0: number, z0: number, x1: number, z1: number): number {
    const n = this.res;
    const i0 = Math.max(0, Math.floor((x0 + this.half) / this.cell) - 1), i1 = Math.min(n - 1, Math.ceil((x1 + this.half) / this.cell) + 1);
    const j0 = Math.max(0, Math.floor((z0 + this.half) / this.cell) - 1), j1 = Math.min(n - 1, Math.ceil((z1 + this.half) / this.cell) + 1);
    let m = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const v = arr[j * n + i]; if (v > m) m = v; }
    return m;
  }

  /** rgba8 packing for the gpu: density, dry, lush, flower */
  packRGBA(): Uint8Array {
    if (this.packed) return this.packed;
    const n = this.res * this.res;
    const out = new Uint8Array(n * 4);
    for (let k = 0; k < n; k++) {
      out[k * 4] = Math.round(this.density[k] * 255);
      out[k * 4 + 1] = Math.round(this.dry[k] * 255);
      out[k * 4 + 2] = Math.round(this.lush[k] * 255);
      out[k * 4 + 3] = Math.round(this.flower[k] * 255);
    }
    return out;
  }
}

/** linear flower colours in species order (palette.ts FLOWER_SPECIES; duplicated here to keep this file plain ts) */
const FLOWER_RGB: [number, number, number][] = [[0.8, 0.74, 0.74], [0.62, 0.17, 0.4], [0.82, 0.58, 0.035], [0.78, 0.77, 0.7], [0.8, 0.46, 0.02]];

/** which drift a point is in: 0 nanohana (yellow), 1 renge (pink), 2 mixed lawn flowers */
function flowerDrift(x: number, z: number, dry: number, lush: number, shore: number) {
  const bank = smooth(18, 3, shore);
  const nano = fbm((x - 190) / 13, (z + 55) / 13, 2, 42) + bank * 0.18 + dry * 0.05;
  if (nano > 0.6) return 0;
  const renge = fbm((x + 77) / 10, (z - 33) / 10, 2, 41) + lush * 0.14 - bank * 0.06;
  return renge > 0.55 ? 1 : 2;
}

/**
 * flower species at a point for a per-flower random r: 0 harujion fleabane (white), 1 renge (pink),
 * 2 nanohana (yellow), 3 white clover, 4 dandelion. drifts are mostly one species.
 */
export function flowerSpecies(x: number, z: number, dry: number, lush: number, shore: number, r: number) {
  const d = flowerDrift(x, z, dry, lush, shore);
  if (d === 0) return r < 0.88 ? 2 : 0;
  if (d === 1) return r < 0.86 ? 1 : 3;
  return r < 0.42 ? 0 : r < 0.72 ? 3 : 4;
}

/** species weights of a drift plus how much of the ground it colours from afar */
function flowerBlend(x: number, z: number, dry: number, lush: number, shore: number) {
  const d = flowerDrift(x, z, dry, lush, shore);
  if (d === 0) return [0.12, 0, 0.88, 0, 0, 0.8];
  if (d === 1) return [0, 0.86, 0, 0.14, 0, 0.62];
  return [0.42, 0, 0, 0.3, 0.28, 0.3];
}

interface PadFrame { pad: Pad; c: number; s: number }

function padFrame(p: Pad): PadFrame {
  const r = (p.yawDeg * Math.PI) / 180;
  return { pad: p, c: Math.cos(r), s: Math.sin(r) };
}

/** signed-ish distance outside a pad rectangle (0 inside) */
function padDistance(f: PadFrame, x: number, z: number) {
  const dx = x - f.pad.x, dz = z - f.pad.z;
  const lx = Math.abs(dx * f.c - dz * f.s) - f.pad.hx;
  const lz = Math.abs(dx * f.s + dz * f.c) - f.pad.hz;
  return Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) + Math.min(Math.max(lx, lz), 0);
}

/** footprint exclusion used for structures published at runtime */
export interface Footprint { x: number; z: number; hx: number; hz: number; yawDeg?: number; margin?: number }

export function footprintDistance(f: Footprint, x: number, z: number) {
  const r = ((f.yawDeg ?? 0) * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const dx = x - f.x, dz = z - f.z;
  const lx = Math.abs(dx * c - dz * s) - f.hx;
  const lz = Math.abs(dx * s + dz * c) - f.hz;
  return Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) + Math.min(Math.max(lx, lz), 0) - (f.margin ?? 1);
}
