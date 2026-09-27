// hanakawa valley: height from the river field. per-side profiles along s shape the floodplain,
// the forested valley walls, the gorge's rock walls and the falls at the head; the channel
// cross-section has shallow pebbly margins, point bars on inner bends and pools on outer bends.
import { cx, blur, sample } from './grid';
import { Noise, smooth, smin, smax, clamp01, lerp } from './noise';
import { prof, POOL_R, type RiverField } from './river';
import { terraceValue } from './shape';
import { RIVER_LENGTH, BRIDGES, DOCKS, bankPoint, riverFrame } from '../../src/world/layout';
import { SITES } from '../../src/world/sites';

type K = [number, number][];
const L = RIVER_LENGTH;

// floodplain width from the water's edge (m), per bank
export const FLOOD_L: K = [[-40, 40], [0, 60], [80, 90], [200, 95], [300, 95], [400, 100], [500, 100], [600, 95], [700, 70], [760, 30], [805, 6], [840, 0], [1170, 0], [1210, 18], [1280, 45], [1400, 30], [1480, 22], [1560, 14], [1860, 16], [1930, 40], [2010, 32], [2070, 8], [2092, 0], [L, 0]];
export const FLOOD_R: K = [[-40, 40], [0, 60], [100, 90], [200, 95], [300, 90], [340, 95], [392, 110], [440, 100], [470, 95], [540, 100], [640, 90], [700, 70], [780, 25], [812, 4], [840, 0], [1170, 0], [1210, 14], [1300, 52], [1420, 40], [1500, 30], [1560, 20], [1690, 26], [1860, 20], [1930, 26], [2040, 15], [2080, 4], [2092, 0], [L, 0]];
// valley wall height above the floodplain at the ridge crest
const HILL_L: K = [[-40, 45], [100, 50], [250, 55], [400, 60], [600, 70], [760, 120], [800, 150], [1000, 170], [1200, 150], [1400, 118], [1600, 138], [1800, 158], [2000, 172], [L, 178]];
const HILL_R: K = [[-40, 40], [100, 48], [250, 52], [400, 58], [600, 70], [760, 118], [800, 142], [1000, 160], [1200, 146], [1400, 112], [1600, 128], [1800, 150], [2000, 165], [L, 172]];
// horizontal distance from the floodplain edge to the ridge crest
const SLOPE_L: K = [[-40, 220], [300, 220], [700, 200], [820, 120], [1000, 110], [1180, 125], [1300, 200], [1700, 235], [2000, 170], [L, 120]];
const SLOPE_R: K = [[-40, 225], [300, 225], [700, 205], [820, 125], [1000, 115], [1180, 130], [1300, 210], [1700, 240], [2000, 175], [L, 125]];
// floodplain level above the water
const FP: K = [[-40, 1.0], [40, 1.2], [720, 1.2], [780, 1.0], [800, 1.0], [1200, 1.0], [1540, 0.8], [1880, 0.8], [1950, 1.2], [L, 1.2]];
// rock walls at the water: the gorge, and the falls closing the valley
const WALL: K = [[790, 0], [840, 4], [900, 9], [960, 12], [1020, 14], [1070, 8], [1090, 8], [1140, 10], [1175, 5], [1215, 0], [2080, 0], [2098, 16], [2110, 30], [L, 32]];
// thalweg depth
const DEPTH: K = [[-40, 1.9], [0, 2.3], [100, 2.6], [300, 2.8], [600, 2.6], [820, 3.0], [1000, 3.3], [1180, 3.0], [1400, 2.6], [1520, 3.4], [1600, 5.2], [1750, 6.4], [1850, 5.0], [1920, 2.8], [2050, 2.6], [2090, 3.0], [L, 4.8]];

export const zone = (s: number, a0: number, a1: number, b0: number, b1: number) => smooth(a0, a1, s) * (1 - smooth(b0, b1, s));
export const gorgeZ = (s: number) => zone(s, 790, 840, 1170, 1220);
export const lakeZ = (s: number) => zone(s, 1500, 1570, 1860, 1930);
export const villageZ = (s: number, side: number) => (side < 0 ? zone(s, 30, 60, 700, 740) : zone(s, 36, 60, 700, 740));

export const CASCADE = { s: 960, side: -1 as const, step: 12.5, top: 13 };
export const FALLS = { lip: 30.5, top: 32 };

/** the per-bank shaping parameters at a cell (shared by the height and the masks) */
export function bankParams(s: number, side: number, x: number, z: number, curv: number, noise: Noise) {
  const vill = villageZ(s, side);
  const gor = gorgeZ(s);
  const kin = smooth(0.002, 0.009, curv * side);
  const kout = smooth(0.002, 0.009, -curv * side);
  const F = Math.max(0, prof(side < 0 ? FLOOD_L : FLOOD_R, s) * (1 + 0.28 * noise.fbm(x / 120, z / 120, 3)));
  const wall = prof(WALL, s) * (1 + 0.35 * noise.fbm(x / 40 + side * 50, z / 40, 3));
  const beachW = (1 - vill) * (1 - smooth(0.5, 2, wall)) * Math.max(0, 1.0 + 9 * kin + 3.5 * smooth(0.05, 0.5, noise.fbm(x / 35, z / 35, 3)) - 1.5 * kout);
  return { vill, gor, kin, kout, F, wall, beachW };
}

/**
 * per-bank profiles sampled at the nearest centerline point jump across medial axes (where two
 * reaches are equidistant). far from the water the profiles come from a widely blurred field.
 */
function farProfiles(field: RiverField, noise: Noise) {
  const res = field.res, R = 512, f = res / R;
  const F = new Float32Array(R * R), H = new Float32Array(R * R), W = new Float32Array(R * R);
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    const k = (j * f) * res + i * f;
    const s = field.s[k], side = field.lat[k] < 0 ? -1 : 1;
    F[j * R + i] = prof(side < 0 ? FLOOD_L : FLOOD_R, s);
    H[j * R + i] = prof(side < 0 ? HILL_L : HILL_R, s);
    W[j * R + i] = prof(side < 0 ? SLOPE_L : SLOPE_R, s);
  }
  void noise;
  return { R, F: blur(F, R, 12), H: blur(H, R, 16), W: blur(W, R, 16) };
}

export function compose(field: RiverField, noise: Noise) {
  const res = field.res, N = res * res;
  const h = new Float32Array(N);
  const far = farProfiles(field, noise);
  for (let j = 0; j < res; j++) {
    const z = cx(j, res);
    for (let i = 0; i < res; i++) {
      const k = j * res + i;
      const x = cx(i, res);
      const s = field.s[k], lat = field.lat[k], q = field.q[k], curv = field.curv[k];
      const side = lat < 0 ? -1 : 1;
      const b = bankParams(s, side, x, z, curv, noise);
      const fp = prof(FP, s) + 0.22 * noise.fbm(x / 50, z / 50, 3) * (1 - b.vill);
      const tf = smooth(12, 80, q);
      if (tf > 0) b.F = lerp(b.F, sample(far.F, far.R, x, z) * (1 + 0.28 * noise.fbm(x / 120, z / 120, 3)), tf);
      if (q >= 0) {
        const top = Math.max(fp, b.wall);
        const bankW = b.vill > 0.5 ? 0.9 : b.wall > 1 ? 2.2 + 1.2 * noise.n2(x / 9, z / 9) : 2.2 + 2.2 * smooth(-0.3, 0.5, noise.fbm(x / 28 + 4, z / 28, 2));
        const beachTop = 0.32 + 0.12 * noise.n2(x / 6, z / 6);
        let v: number;
        if (q < b.beachW) v = beachTop * smooth(0, b.beachW, q) * (b.beachW > 0.6 ? 1 : 0);
        else {
          const u = Math.min(1, (q - b.beachW) / bankW);
          const from = b.beachW > 0.6 ? beachTop : 0;
          v = from + (top - from) * (1 - (1 - u) * (1 - u));
          v += 0.012 * Math.max(0, q - b.beachW - bankW) * (1 - b.vill);
        }
        // natural terrace on the right bank under the pagoda
        if (side > 0) v += 5.3 * zone(s, 330, 360, 430, 460) * smooth(22, 36, q + 6 * noise.fbm(x / 30, z / 30, 2));
        // valley walls: spurs and ravines by warping the lateral distance
        const H = lerp(prof(side < 0 ? HILL_L : HILL_R, s), sample(far.H, far.R, x, z), tf) * (1 + 0.18 * noise.fbm(x / 260 + 11, z / 260, 3));
        const W = lerp(prof(side < 0 ? SLOPE_L : SLOPE_R, s), sample(far.W, far.R, x, z), tf) * (1 + 0.2 * noise.fbm(x / 200 - 7, z / 200, 3));
        const warp = (34 * noise.fbm(x / 170, z / 170, 4) + 14 * noise.fbm(x / 60 + 3, z / 60, 3)) * smooth(0, 40, q - b.F * 0.5);
        const u = (q + warp - b.F) / W;
        let P = 0;
        if (u > 0) P = u < 1 ? 0.5 * (1 - Math.pow(1 - u, 2.3)) + 0.5 * u * u * (3 - 2 * u) : 1 + 0.22 * (1 - Math.exp(-(u - 1) / 1.2));
        const rough = H * (0.15 * (noise.ridged(x / 150, z / 150, 4) - 0.4) + 0.07 * noise.fbm(x / 55, z / 55, 3)) * smooth(0.04, 0.5, u);
        // beyond the crests: independent ridged mountains so divides never run straight
        const mtn = 55 * (noise.ridged(x / 330 + 40, z / 330, 4) - 0.45) * smooth(0.7, 1.6, u);
        const hill = top + H * P + rough + mtn;
        v = u > 0 ? smax(v, hill, 1.5) : v;
        h[k] = Math.min(300, v);
      } else {
        const e = -q;
        let D = prof(DEPTH, s) + 0.7 * b.kout;
        const lk = lakeZ(s), g = b.gor;
        let a = 0.16 * (1 - 0.5 * b.kin + 0.9 * b.kout), c = 0.018 * (1 - 0.5 * b.kin + 0.9 * b.kout);
        a = lerp(lerp(a, 0.05, lk), 0.55, g);
        c = lerp(lerp(c, 0.0035, lk), 0.07, g);
        if (s > L - 25) { a = lerp(a, 0.5, smooth(L - 25, L - 10, s)); c = lerp(c, 0.05, smooth(L - 25, L - 10, s)); }
        let depth = smin(a * e + c * e * e, D, 0.6);
        depth += 0.16 * noise.fbm(x / 7, z / 7, 2) * smooth(0.2, 1, depth) + 0.3 * noise.fbm(x / 38, z / 38, 3) * smooth(1, 3, depth);
        h[k] = -Math.max(0.02, depth);
      }
    }
  }
  return h;
}

/** hardness for erosion: rock walls, floodplains and the village resist, hillsides erode */
export function hardness(field: RiverField, h: Float32Array, noise: Noise) {
  const res = field.res, N = res * res;
  const out = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const x = cx(k % res, res), z = cx((k / res) | 0, res);
    const s = field.s[k], side = field.lat[k] < 0 ? -1 : 1;
    const F = prof(side < 0 ? FLOOD_L : FLOOD_R, s);
    const nearFlat = 1 - smooth(F, F + 25, field.q[k]);
    const wall = prof(WALL, s) > 1 ? 1 - smooth(4, 12, field.q[k]) : 0;
    out[k] = clamp01(Math.max(nearFlat * 0.95, wall, villageZ(s, side)) + 0.12 + 0.1 * noise.n2(x / 40, z / 40));
    if (h[k] < 1.5) out[k] = 1;
  }
  return out;
}

/** layered rock on steep walls (gorge, falls, ravine step) */
export function strata(h: Float32Array, field: RiverField, noise: Noise) {
  const res = field.res;
  const out = h.slice();
  for (let j = 1; j < res - 1; j++) {
    const z = cx(j, res);
    for (let i = 1; i < res - 1; i++) {
      const k = j * res + i;
      const v = h[k];
      if (v < 1) continue;
      const gx = (h[k + 1] - h[k - 1]) / 2, gz = (h[k + res] - h[k - res]) / 2;
      const sl = Math.hypot(gx, gz);
      // layered rock only on the walls: the gorge, the falls and the cascade step (not on hillsides)
      const wallZ = prof(WALL, field.s[k]) > 1 ? 1 - smooth(10, 22, field.q[k]) : 0;
      const w = smooth(0.9, 1.7, sl) * wallZ * smooth(1, 3, v);
      if (w < 0.01) continue;
      const x = cx(i, res);
      const Lt = 2.3 * (1 + 0.3 * noise.fbm(x / 70 + 9, z / 70, 2));
      const y = v + 0.01 * x - 0.006 * z;
      out[k] = v + (terraceValue(y, Lt, 0.22 + 0.1 * noise.n2(x / 20, z / 20)) - y) * w;
    }
  }
  return out;
}

function box(res: number, x0: number, z0: number, x1: number, z1: number, fn: (k: number, x: number, z: number) => void) {
  const c = 2048 / res;
  const i0 = Math.max(0, Math.floor((x0 + 1024) / c)), i1 = Math.min(res - 1, Math.ceil((x1 + 1024) / c));
  const j0 = Math.max(0, Math.floor((z0 + 1024) / c)), j1 = Math.min(res - 1, Math.ceil((z1 + 1024) / c));
  for (let j = j0; j <= j1; j++) {
    const z = cx(j, res);
    for (let i = i0; i <= i1; i++) fn(j * res + i, cx(i, res), z);
  }
}

/** maiden falls: a hanging side ravine on the left bank with a rock step for the cascade */
export function applyCascade(h: Float32Array, res: number, noise: Noise) {
  const f = riverFrame(CASCADE.s);
  const b = bankPoint(CASCADE.s, CASCADE.side, 0);
  const ax = f.nx * CASCADE.side, az = f.nz * CASCADE.side;
  box(res, b.x - 320, b.z - 320, b.x + 320, b.z + 320, (k, x, z) => {
    const rx = x - b.x, rz = z - b.z;
    const a = rx * ax + rz * az, p = rx * f.tx + rz * f.tz;
    if (a < -4 || a > 300) return;
    const wob = (5 + 0.1 * Math.max(0, a - 20)) * noise.fbm(a / 45, 3.3, 3) + 3 * noise.n2(a / 12, 1.7);
    const pp = Math.abs(p - wob);
    let floor: number;
    if (a < CASCADE.step) floor = -0.7 + 0.9 * smooth(CASCADE.step - 4, CASCADE.step, a);
    else floor = CASCADE.top + 0.11 * (a - CASCADE.step - 1.5);
    const hw = (a < CASCADE.step ? 7 : 4.5) + 0.07 * Math.max(0, a - CASCADE.step);
    const walls = floor + Math.max(0, pp - hw) * (a < CASCADE.step + 3 ? 2.6 : 1.9);
    const fade = 1 - smooth(140, 200, a);
    if (pp > 70) return;
    const v = Math.max(smin(h[k], walls, 1.5), h[k] - 32);
    if (a < CASCADE.step + 1.5 && a > CASCADE.step - 1 && pp < hw) {
      // the rock step itself: near vertical
      const t = smooth(CASCADE.step - 1, CASCADE.step + 1.2, a);
      h[k] = lerp(h[k], lerp(floor, CASCADE.top, t), fade);
      return;
    }
    h[k] = lerp(h[k], Math.min(h[k], v), fade);
  });
}

/** the lip notch of hanakawa falls and the small stream above it */
export function applyFallsLip(h: Float32Array, res: number, noise: Noise) {
  const f = riverFrame(L);
  box(res, f.x - 240, f.z - 240, f.x + 240, f.z + 240, (k, x, z) => {
    const rx = x - f.x, rz = z - f.z;
    const a = rx * f.tx + rz * f.tz, p = rx * f.nx + rz * f.nz;
    if (a < POOL_R - 4 || a > 230) return;
    const wob = 3 * noise.fbm(a / 30, 7.1, 2);
    const pp = Math.abs(p - wob);
    const floor = FALLS.lip - 0.8 + 0.035 * Math.max(0, a - POOL_R);
    const hw = 3 + 0.02 * a;
    const walls = floor + Math.max(0, pp - hw) * 2.2;
    if (pp > 30) return;
    if (a > POOL_R - 1) h[k] = Math.min(h[k], Math.max(smin(h[k], walls, 1.2), h[k] - 9));
  });
}

function padLocal(p: { x: number; z: number; yawDeg: number }, x: number, z: number) {
  const r = (p.yawDeg * Math.PI) / 180;
  const dx = x - p.x, dz = z - p.z;
  return { lx: dx * Math.cos(r) - dz * Math.sin(r), lz: dx * Math.sin(r) + dz * Math.cos(r) };
}

/** building footprints from src/world/sites.ts (land only) */
export function applySites(h: Float32Array, res: number) {
  for (const p of SITES) {
    const R = Math.max(p.hx, p.hz) + p.blend + 4;
    box(res, p.x - R * 1.5, p.z - R * 1.5, p.x + R * 1.5, p.z + R * 1.5, (k, x, z) => {
      const { lx, lz } = padLocal(p, x, z);
      const ox = Math.abs(lx) - p.hx, oz = Math.abs(lz) - p.hz;
      const d = Math.hypot(Math.max(ox, 0), Math.max(oz, 0));
      const inside = ox <= 0 && oz <= 0;
      if (!inside && h[k] < 0.2) return;
      const w = inside ? 1 : 1 - smooth(0, p.blend, d);
      if (w > 0) h[k] = lerp(h[k], p.y, w);
    });
  }
}

/** bridge abutment pad heights (bank level at each end) */
export const ABUTMENT_Y: Record<string, number> = { 'red-bridge': 1.4, 'stone-bridge': 1.5, 'covered-bridge': 8.5, 'plank-bridge': 1.2 };

/** bridges: flat abutment pads on both banks and a clean, deep enough channel under the span */
export function applyBridges(h: Float32Array, field: RiverField) {
  const res = field.res;
  for (const br of BRIDGES) {
    const f = riverFrame(br.s);
    const y = ABUTMENT_Y[br.id] ?? 1.4;
    const along = br.deckWidth / 2 + 3.5;
    box(res, f.x - 90, f.z - 90, f.x + 90, f.z + 90, (k, x, z) => {
      const rx = x - f.x, rz = z - f.z;
      const a = rx * f.tx + rz * f.tz, p = rx * f.nx + rz * f.nz;
      const half = f.width / 2;
      const q = Math.abs(p) - half;
      // channel under the span: no bars, at least 1.3 m once 1.5 m off the edge
      const wa = 1 - smooth(along + 2, along + 14, Math.abs(a));
      if (q < -1.2 && wa > 0) h[k] = Math.min(h[k], lerp(h[k], -1.45 - 0.4 * smooth(1.5, 6, -q), wa));
      // abutment pads
      if (q > -0.5 && q < 14) {
        const w = (1 - smooth(along, along + 5, Math.abs(a))) * (1 - smooth(10, 14, q));
        if (w > 0) h[k] = lerp(h[k], q < 0.5 ? Math.min(h[k], y) : y, w);
      }
    });
  }
}

/** dock landings: level bank behind a straight edge, dredged berth alongside */
export function applyDocks(h: Float32Array, res: number) {
  for (const d of DOCKS) {
    const f = riverFrame(d.s);
    const bank = bankPoint(d.s, d.side, 0);
    const y = Math.max(1.1, d.deckY + 0.5);
    box(res, bank.x - 40, bank.z - 40, bank.x + 40, bank.z + 40, (k, x, z) => {
      const rx = x - bank.x, rz = z - bank.z;
      const a = rx * f.tx + rz * f.tz;
      const o = (rx * f.nx + rz * f.nz) * d.side; // + inland
      const wa = 1 - smooth(9, 15, Math.abs(a));
      if (wa <= 0) return;
      if (o > 0 && o < 14) h[k] = lerp(h[k], y, wa * (1 - smooth(9, 14, o)));
      if (o <= 0 && o > -12) {
        const target = -(d.minDepth + 0.35) * smooth(0, 2.2, -o);
        if (o < -0.4 && h[k] > target) h[k] = lerp(h[k], target, wa * smooth(-12, -8, o));
      }
    });
  }
}

/** navigable line: 12 m wide down the whole river with at least 1.75 m of water */
export function applyNavigable(h: Float32Array, field: RiverField) {
  const N = field.res * field.res;
  for (let k = 0; k < N; k++) {
    const s = field.s[k];
    if (s < -28 || s > L - 6) continue;
    const a = Math.abs(field.lat[k]);
    if (a < 9 && field.q[k] < -1) {
      const t = -1.75 - 0.3 * (1 - smooth(4, 9, a));
      const w = 1 - smooth(6, 9, a);
      if (h[k] > t) h[k] = lerp(h[k], t, w);
    }
  }
}
