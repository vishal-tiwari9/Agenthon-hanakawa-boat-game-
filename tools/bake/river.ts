// river field: for every cell, the nearest point on the river centerline (along-river s, signed
// lateral offset, local width, bend curvature) and the distance q to the water's edge (+ land,
// - water). the channel runs ~40 m past the weir (s = 0) and closes in a rounded end; the upstream
// end closes at the falls in a round plunge pool.
import { riverFrame, RIVER_LENGTH } from '../../src/world/layout';
import { edt, cx } from './grid';
import { smooth } from './noise';

export const DOWN_END = -40;
export const POOL_R = 17;

export interface RiverField {
  res: number;
  s: Float32Array;
  lat: Float32Array;
  /** half width of the water at s */
  half: Float32Array;
  /** distance to the water's edge: + inland, - in the water */
  q: Float32Array;
  /** signed curvature (1/m) at s: + bends toward the right bank */
  curv: Float32Array;
  /** tangent (upstream) at s, for flow */
  tx: Float32Array;
  tz: Float32Array;
}

interface Sample { s: number; x: number; z: number; tx: number; tz: number; nx: number; nz: number; half: number; k: number }

function frameAt(s: number): Sample {
  const c = Math.max(0, Math.min(RIVER_LENGTH, s));
  const f = riverFrame(c);
  const ex = s - c;
  let half = f.width / 2;
  // plunge pool: the channel opens into a round pool at the falls
  if (s > RIVER_LENGTH - 30) half = Math.max(half, half + (POOL_R - half) * smooth(RIVER_LENGTH - 30, RIVER_LENGTH - 8, s));
  return { s, x: f.x + f.tx * ex, z: f.z + f.tz * ex, tx: f.tx, tz: f.tz, nx: f.nx, nz: f.nz, half, k: 0 };
}

export function sampleRiver(step = 0.5): Sample[] {
  const out: Sample[] = [];
  for (let s = DOWN_END; s <= RIVER_LENGTH + 1e-6; s += step) out.push(frameAt(s));
  // curvature from tangent turning over +-6 m
  const d = Math.round(6 / step);
  for (let i = 0; i < out.length; i++) {
    const a = out[Math.max(0, i - d)], b = out[Math.min(out.length - 1, i + d)];
    const cross = a.tx * b.tz - a.tz * b.tx;
    const ds = b.s - a.s || 1;
    // with n = (-tz, tx), turning toward the right bank gives a positive cross product
    out[i].k = cross / ds;
  }
  return out;
}

export function buildRiverField(res: number): RiverField {
  const N = res * res;
  const samples = sampleRiver(0.5);
  const sites = new Uint8Array(N);
  const id = new Int32Array(N).fill(-1);
  const toC = (v: number) => Math.floor(((v + 1024) * res) / 2048);
  samples.forEach((p, k) => {
    const i = toC(p.x), j = toC(p.z);
    if (i < 0 || j < 0 || i >= res || j >= res) return;
    sites[j * res + i] = 1;
    id[j * res + i] = k;
  });
  const { near } = edt(sites, res);
  const f: RiverField = {
    res, s: new Float32Array(N), lat: new Float32Array(N), half: new Float32Array(N), q: new Float32Array(N),
    curv: new Float32Array(N), tx: new Float32Array(N), tz: new Float32Array(N),
  };
  const last = samples.length - 1;
  for (let j = 0; j < res; j++) {
    const z = cx(j, res);
    for (let i = 0; i < res; i++) {
      const k = j * res + i;
      const x = cx(i, res);
      // refine around the edt's nearest sample
      let best = id[near[k]], bd = 1e18;
      for (let o = -6; o <= 6; o++) {
        const t = Math.max(0, Math.min(last, best + o));
        const p = samples[t];
        const dd = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (dd < bd) { bd = dd; best = t; }
      }
      const p = samples[best];
      const dx = x - p.x, dz = z - p.z;
      const lat = dx * p.nx + dz * p.nz;
      const along = dx * p.tx + dz * p.tz;
      let q: number;
      if (best === 0 && along < 0) q = Math.hypot(lat, along) - p.half;
      else if (best === last && along > 0) q = Math.hypot(lat, along) - p.half;
      else q = Math.abs(lat) - p.half;
      f.s[k] = p.s + (best === 0 || best === last ? 0 : along);
      f.lat[k] = lat;
      f.half[k] = p.half;
      f.q[k] = q;
      f.curv[k] = p.k;
      f.tx[k] = p.tx;
      f.tz[k] = p.tz;
    }
  }
  return f;
}

/** smooth piecewise profile over along-river s: keys [s, value] sorted by s */
export function prof(keys: [number, number][], s: number) {
  if (s <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (s <= keys[i][0]) {
      const [s0, v0] = keys[i - 1], [s1, v1] = keys[i];
      const t = (s - s0) / (s1 - s0);
      return v0 + (v1 - v0) * t * t * (3 - 2 * t);
    }
  }
  return keys[keys.length - 1][1];
}
