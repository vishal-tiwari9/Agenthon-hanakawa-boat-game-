// surface and vegetation masks, river flow, wave scale and baked sky visibility (1024 grid).
import { cx, sample, blur, downsample } from './grid';
import { Noise, smooth, clamp01 } from './noise';
import { prof, type RiverField } from './river';
import { bankParams, gorgeZ, lakeZ, villageZ, FLOOD_L, FLOOD_R } from './valley';
import { bankPoint, LANDMARKS, RIVER_LENGTH } from '../../src/world/layout';
import { SITES } from '../../src/world/sites';

export const MASKS = ['sand', 'pebbles', 'grass', 'rock', 'cliff', 'moss', 'path', 'wet', 'trees', 'cherry', 'bamboo', 'reeds', 'flowers', 'shrubs', 'ao', 'waveScale', 'flowX', 'flowZ'] as const;
export type MaskName = (typeof MASKS)[number];

/** footpaths as [s, side, offset from the water's edge] */
export const PATHS: { id: string; width: number; pts: [number, -1 | 1, number][] }[] = [
  { id: 'towpath', width: 1.8, pts: [[336, -1, 7], [420, -1, 8], [520, -1, 9], [600, -1, 12], [680, -1, 9], [760, -1, 7], [805, -1, 5]] },
  { id: 'shrine', width: 1.6, pts: [[244, -1, 4], [258, -1, 7], [272, -1, 10]] },
  { id: 'pagoda', width: 2, pts: [[452, 1, 1.5], [440, 1, 12], [424, 1, 22], [404, 1, 28], [392, 1, 30]] },
  { id: 'red-bridge-right', width: 1.8, pts: [[304, 1, 4], [330, 1, 10], [360, 1, 22], [385, 1, 27]] },
  { id: 'lake-shore', width: 1.6, pts: [[1600, 1, 7], [1640, 1, 6], [1672, 1, 4], [1690, 1, 2]] },
  { id: 'mill', width: 1.6, pts: [[1940, -1, 5], [1962, -1, 5], [1980, -1, 3], [1992, -1, 6]] },
];

export function pathPolylines() {
  return PATHS.map((p) => ({ id: p.id, width: p.width, pts: p.pts.map(([s, side, o]) => { const b = bankPoint(s, side, o); return [b.x, b.z] as [number, number]; }) }));
}

export function polyDist(pts: [number, number][], x: number, z: number) {
  let best = 1e9;
  for (let k = 0; k + 1 < pts.length; k++) {
    const ax = pts[k][0], az = pts[k][1], bx = pts[k + 1][0], bz = pts[k + 1][1];
    const dx = bx - ax, dz = bz - az;
    const t = clamp01(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1));
    best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
  }
  return best;
}

/** cosine-weighted sky visibility from horizon angles in 16 directions */
function skyVisibility(h: Float32Array, res: number, R: number) {
  const out = new Float32Array(R * R);
  const dists = [1.5, 3, 5, 8, 12, 18, 27, 40, 60, 90, 135, 200, 300];
  const dirs: [number, number][] = [];
  for (let q = 0; q < 16; q++) { const a = ((q + 0.5) / 16) * Math.PI * 2; dirs.push([Math.cos(a), Math.sin(a)]); }
  for (let j = 0; j < R; j++) {
    const z0 = cx(j, R);
    for (let i = 0; i < R; i++) {
      const x0 = cx(i, R);
      const h0 = Math.max(sample(h, res, x0, z0), -0.2) + 0.3;
      let v = 0;
      for (const [dx, dz] of dirs) {
        let m = 0;
        for (const r of dists) {
          const t = (sample(h, res, x0 + dx * r, z0 + dz * r) - h0) / r;
          if (t > m) m = t;
        }
        v += 1 / (1 + m * m);
      }
      out[j * R + i] = v / 16;
    }
  }
  return out;
}

export function buildMasks(h: Float32Array, res: number, shore: Float32Array, field: RiverField, noise: Noise, R = 1024) {
  const N = R * R;
  const m = {} as Record<MaskName, Float32Array>;
  for (const n of MASKS) m[n] = new Float32Array(N);
  const f = res / R;
  const hm = downsample(h, res, f);
  const smoothH = blur(hm, R, 6);
  const sd = downsample(shore, res, f);
  const at = (arr: Float32Array, i: number, j: number) => arr[(j * f) * res + i * f];
  const paths = pathPolylines();
  const sites = SITES.map((p) => ({ p, r: (p.yawDeg * Math.PI) / 180 }));
  const cherrySpots = LANDMARKS.filter((l) => l.id === 'shrine' || l.id === 'pagoda' || l.id === 'teahouse' || l.id === 'mill' || l.id === 'village')
    .map((l) => ({ ...bankPoint(l.s, (l.side || 1) as -1 | 1, l.offset), r: l.id === 'village' ? 150 : l.id === 'pagoda' ? 70 : 45 }));

  for (let j = 0; j < R; j++) {
    const z = cx(j, R);
    for (let i = 0; i < R; i++) {
      const k = j * R + i;
      const x = cx(i, R);
      const v = hm[k], d = sd[k];
      const s = at(field.s, i, j), lat = at(field.lat, i, j), curv = at(field.curv, i, j);
      const side = lat < 0 ? -1 : 1;
      const b = bankParams(s, side, x, z, curv, noise);
      const F = prof(side < 0 ? FLOOD_L : FLOOD_R, s);
      const gx = sample(h, res, x + 1, z) - sample(h, res, x - 1, z);
      const gz = sample(h, res, x, z + 1) - sample(h, res, x, z - 1);
      const sl = Math.hypot(gx, gz) / 2;
      const nzN = -gz / 2 / Math.sqrt(1 + sl * sl); // normal z: < 0 faces north
      const curvH = smoothH[k] - v; // + hollow
      const n1 = noise.fbm(x / 23 + 5, z / 23, 3), n2 = noise.fbm(x / 11 - 9, z / 11 + 4, 3), n3 = noise.fbm(x / 60 + 20, z / 60, 3);
      const land = smooth(0.05, 0.4, v);
      const water = 1 - land;
      const depth = Math.max(0, -v);
      const lk = lakeZ(s), gor = gorgeZ(s);

      // sites and paths
      let site = 0;
      for (const { p, r } of sites) {
        const dx = x - p.x, dz = z - p.z;
        const lx = Math.abs(dx * Math.cos(r) - dz * Math.sin(r)) - p.hx, lz = Math.abs(dx * Math.sin(r) + dz * Math.cos(r)) - p.hz;
        site = Math.max(site, 1 - smooth(0, 4, Math.max(lx, lz)));
      }
      let path = 0;
      for (const p of paths) {
        const pd = polyDist(p.pts, x, z);
        if (pd < p.width + 3) path = Math.max(path, 1 - smooth(p.width * 0.35, p.width * 0.6 + 0.7, pd + 0.5 * noise.n2(x / 3, z / 3)));
      }
      m.path[k] = path * land;

      // rock: steep ground, gorge walls, the falls face, outcrops on ridges and spur noses
      const steep = smooth(1.0, 1.45, sl);
      const wallRock = smooth(0.8, 3, b.wall) * (1 - smooth(4, 12, d)) * land;
      const outcrop = land * smooth(0.78, 0.9, noise.ridged(x / 45 + 2, z / 45, 3) + 0.25 * smooth(0.6, 1.1, sl) - 0.05 * curvH) * smooth(8, 25, d - F);
      const bedRock = water * (gor * smooth(0, 0.3, n2 + 0.1) + smooth(0.25, 0.45, n2) * 0.5) * smooth(0.8, 2.5, depth);
      m.rock[k] = clamp01(Math.max(steep, wallRock, outcrop * 0.85, bedRock * 0.7) * (1 - path) * (1 - site));
      m.cliff[k] = clamp01(smooth(1.1, 1.8, sl) * land);

      // pebbles: shallow margins, point-bar beaches, the waterline strip
      const margin = water * (1 - smooth(0.6, 1.8, depth)) * (0.65 + 0.35 * smooth(-0.2, 0.3, n1));
      const beach = land * (1 - smooth(b.beachW + 0.5, b.beachW + 2.5, d)) * (1 - b.vill * 0.8) * (1 - smooth(1.5, 3, b.wall));
      const bedStones = water * smooth(0.1, 0.4, noise.fbm(x / 16, z / 16 + 13, 3)) * (1 - lk * 0.7);
      m.pebbles[k] = clamp01(Math.max(margin, beach, bedStones * 0.75) * (1 - m.rock[k] * 0.7));

      // sand and silt: pools, the lake bed, sandy patches on bars
      m.sand[k] = clamp01((water * smooth(0.8, 2.2, depth) * (0.55 + 0.45 * lk) + land * beach * smooth(0.2, 0.5, n3) * 0.5) * (1 - m.pebbles[k] * 0.8) * (1 - m.rock[k]));

      // moss: rock and damp ground in shade (gorge, north faces, near water, hollows)
      const damp = clamp01(0.45 * gor + 0.35 * smooth(0.05, -0.4, nzN) + 0.3 * (1 - smooth(2, 12, d)) + 0.2 * smooth(0, 1.5, curvH));
      m.moss[k] = clamp01(land * damp * smooth(-0.15, 0.25, n1 + 0.1));

      // forest: dense conifers on the valley walls, thinning to the floodplain, with clearings
      const wallZone = smooth(b.F + 4, b.F + 28, d + 10 * n3);
      const clearing = smooth(0.18, 0.34, noise.fbm(x / 140 + 70, z / 140, 3)) * (1 - smooth(60, 140, d - b.F)) * 0.85 * smooth(420, 760, s);
      const bankTrees = smooth(3, 8, d) * (1 - smooth(10, 26, d)) * smooth(0.02, 0.3, n3) * 0.55;
      let trees = Math.max(wallZone * (1 - clearing), bankTrees) * land;
      trees *= (1 - smooth(0.5, 0.9, m.rock[k])) * (1 - path) * (1 - site) * (1 - b.vill * (1 - smooth(F - 5, F + 20, d)));
      m.trees[k] = clamp01(trees);

      // cherry: village and temple grounds, scattered along the banks
      let ch = 0;
      for (const c of cherrySpots) ch = Math.max(ch, 1 - smooth(c.r * 0.4, c.r, Math.hypot(x - c.x, z - c.z)));
      const bankCherry = smooth(2, 5, d) * (1 - smooth(14, 30, d)) * smooth(0.08, 0.3, noise.fbm(x / 50 - 30, z / 50, 3)) * (1 - gor);
      m.cherry[k] = clamp01(land * Math.max(ch * smooth(2, 5, d) * (1 - smooth(60, 110, d)) * smooth(-0.15, 0.25, n3), bankCherry) * (1 - path) * (1 - site) * (1 - m.rock[k]));

      // bamboo: gorge slopes, and two groves downstream
      const grove = Math.max(gor, zone2(s, 520, 600, side > 0), zone2(s, 1240, 1330, side < 0));
      m.bamboo[k] = clamp01(land * grove * smooth(3, 8, d) * (1 - smooth(50, 90, d)) * smooth(-0.1, 0.25, noise.fbm(x / 30 + 8, z / 30, 3)) * (1 - m.rock[k]) * (1 - path));

      // reeds: lake margins and slow shallow edges (inner bends), and the weir pool
      const slowEdge = b.kin * 0.8 + lk + 0.6 * (1 - smooth(-10, 20, s));
      const reedBand = (water * (1 - smooth(0.4, 1.1, depth)) + land * (1 - smooth(0.5, 3, d))) * clamp01(slowEdge);
      m.reeds[k] = clamp01(reedBand * smooth(-0.05, 0.3, n2) * (1 - b.vill) * (1 - gor));

      // grass: meadows on the floodplain, bank grass, clearings; not under dense forest
      const gSlope = 1 - smooth(0.9, 1.3, sl);
      const bankStart = smooth(Math.max(0.4, b.beachW), b.beachW + 1.5, d);
      m.grass[k] = clamp01(land * bankStart * gSlope * (1 - m.rock[k]) * (1 - path) * (1 - site) * (1 - m.pebbles[k] * 0.9) * (1 - smooth(0.55, 0.95, m.trees[k]) * 0.85) * (0.8 + 0.2 * n2));

      // flowers: meadow patches
      m.flowers[k] = clamp01(m.grass[k] * smooth(-0.05, 0.25, noise.fbm(x / 18 + 3, z / 18 - 8, 3)) * (1 - smooth(0.4, 0.8, m.trees[k])) * (1 - b.vill * 0.15));

      // shrubs: forest edges, around outcrops, gully bottoms
      const edge = smooth(0.15, 0.45, m.trees[k]) * (1 - smooth(0.6, 0.95, m.trees[k]));
      m.shrubs[k] = clamp01(land * Math.max(edge * 0.8, smooth(0.1, 0.4, outcrop) * 0.5, smooth(0.5, 2, curvH) * 0.4) * gSlope * (1 - path) * (1 - site) * smooth(-0.1, 0.3, n1));

      // wet: the waterline band on banks
      m.wet[k] = clamp01((1 - smooth(0.08, 0.45, v)) * smooth(-0.5, -0.02, v));

      // current and wave scale
      if (v < 0) {
        const half = at(field.half, i, j);
        const t = clamp01(Math.abs(lat) / Math.max(1, half));
        const w = half * 2;
        let vc = Math.min(0.62, 0.45 * Math.pow(36 / w, 0.9)) * (1 - 0.85 * lk);
        if (s < -5) vc *= smooth(-38, -5, s);
        if (s > RIVER_LENGTH - 30) vc *= 1 - smooth(RIVER_LENGTH - 30, RIVER_LENGTH - 5, s);
        const prof2 = Math.sqrt(Math.max(0, 1 - t * t)) * smooth(0.1, 1.2, depth);
        const tx = at(field.tx, i, j), tz = at(field.tz, i, j);
        m.flowX[k] = -tx * vc * prof2;
        m.flowZ[k] = -tz * vc * prof2;
        m.waveScale[k] = clamp01((0.28 + 0.3 * lk) * smooth(0.2, 2.5, depth) + 0.05);
      }
    }
  }
  // wave scale continues a little onto land so gpu sampling at the waterline stays continuous
  const ws = m.waveScale;
  const wsb = blur(ws, R, 3);
  const wm = blur(hm.map((v) => (v < 0 ? 1 : 0)), R, 3);
  for (let k = 0; k < N; k++) if (hm[k] >= 0) ws[k] = wm[k] > 0.02 ? Math.min(1, wsb[k] / wm[k]) : 0.2;
  for (const n of ['flowers', 'shrubs', 'trees', 'cherry', 'bamboo', 'reeds'] as const) m[n] = blur(m[n], R, 1, 1);
  m.ao = skyVisibility(h, res, R);
  return m;
}

function zone2(s: number, a: number, b: number, ok: boolean) {
  return ok ? smooth(a - 20, a, s) * (1 - smooth(b, b + 20, s)) : 0;
}
