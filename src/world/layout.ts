// authored layout of hanakawa, a river valley. everything is placed along one river centerline
// spline so terrain, structures, gameplay and audio stay consistent when the river is reshaped.
// world: meters, y up, river surface at y = 0. north = -z, east = +x. headings are compass degrees
// (0 = north, 90 = east) and describe where the bow points.
//
// along-river coordinate `s`: meters along the centerline from the downstream end (s = 0, the weir
// at the south) to the upstream end (s = RIVER_LENGTH, the falls at the north).
// `side`: -1 = left bank, +1 = right bank, as seen facing upstream (the player's travel direction
// at the start). `offset`: meters from the water's edge onto the bank (negative = out over the water).

export const WORLD_SIZE = 2048;
/** kept for older consumers; the valley banks bound the player now, so this never triggers */
export const BOUNDARY_RADIUS = 5000;

/** centerline control points from downstream to upstream: [x, z, width at the waterline] */
export const RIVER_POINTS: [number, number, number][] = [
  [-150, 900, 24],
  [-120, 760, 21],
  [-60, 620, 20],
  [20, 500, 21],
  [60, 360, 23],
  [0, 220, 26],
  [-120, 100, 28],
  [-180, -60, 26],
  [-120, -220, 28],
  [20, -330, 32],
  [160, -420, 64],
  [240, -560, 100],
  [200, -760, 30],
  [120, -880, 26],
];

export interface RiverFrame {
  s: number;
  x: number;
  z: number;
  /** unit tangent pointing upstream */
  tx: number;
  tz: number;
  /** unit normal pointing to the right bank (facing upstream) */
  nx: number;
  nz: number;
  /** width at the waterline */
  width: number;
}

function cr(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

// dense arc-length table: [s, x, z, width] every ~0.5 m
const TABLE: number[] = [];
{
  const P = RIVER_POINTS, n = P.length, steps = 400;
  let s = 0, px = P[0][0], pz = P[0][1];
  for (let i = 0; i < n - 1; i++) {
    const a = P[Math.max(0, i - 1)], b = P[i], c = P[i + 1], d = P[Math.min(n - 1, i + 2)];
    for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
      const t = k / steps;
      const x = cr(a[0], b[0], c[0], d[0], t), z = cr(a[1], b[1], c[1], d[1], t);
      // width eases between control points
      const u = t * t * (3 - 2 * t);
      const w = b[2] + (c[2] - b[2]) * u;
      s += Math.hypot(x - px, z - pz);
      px = x;
      pz = z;
      TABLE.push(s, x, z, w);
    }
  }
}
const ROWS = TABLE.length / 4;

export const RIVER_LENGTH = TABLE[(ROWS - 1) * 4];

/** position, direction and width of the river at along-river distance s (clamped) */
export function riverFrame(s: number, out: RiverFrame = { s: 0, x: 0, z: 0, tx: 0, tz: -1, nx: 1, nz: 0, width: 30 }): RiverFrame {
  s = Math.max(0, Math.min(RIVER_LENGTH, s));
  let lo = 0, hi = ROWS - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (TABLE[m * 4] < s) lo = m;
    else hi = m;
  }
  const s0 = TABLE[lo * 4], s1 = TABLE[hi * 4];
  const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
  const x0 = TABLE[lo * 4 + 1], z0 = TABLE[lo * 4 + 2], x1 = TABLE[hi * 4 + 1], z1 = TABLE[hi * 4 + 2];
  const i0 = Math.max(0, lo - 2), i1 = Math.min(ROWS - 1, hi + 2);
  let tx = TABLE[i1 * 4 + 1] - TABLE[i0 * 4 + 1], tz = TABLE[i1 * 4 + 2] - TABLE[i0 * 4 + 2];
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl;
  tz /= tl;
  out.s = s;
  out.x = x0 + (x1 - x0) * f;
  out.z = z0 + (z1 - z0) * f;
  out.tx = tx;
  out.tz = tz;
  // right of upstream-facing: rotate tangent clockwise seen from above (north = -z, east = +x)
  out.nx = -tz;
  out.nz = tx;
  out.width = TABLE[lo * 4 + 3] + (TABLE[hi * 4 + 3] - TABLE[lo * 4 + 3]) * f;
  return out;
}

/** nearest centerline point to (x, z): along-river s, signed lateral distance (+ toward the right bank) */
export function nearestRiver(x: number, z: number) {
  let best = 0, bd = Infinity;
  for (let r = 0; r < ROWS; r += 8) {
    const d = (TABLE[r * 4 + 1] - x) ** 2 + (TABLE[r * 4 + 2] - z) ** 2;
    if (d < bd) { bd = d; best = r; }
  }
  const a = Math.max(0, best - 8), b = Math.min(ROWS - 1, best + 8);
  for (let r = a; r <= b; r++) {
    const d = (TABLE[r * 4 + 1] - x) ** 2 + (TABLE[r * 4 + 2] - z) ** 2;
    if (d < bd) { bd = d; best = r; }
  }
  const f = riverFrame(TABLE[best * 4]);
  const lateral = (x - f.x) * f.nx + (z - f.z) * f.nz;
  return { s: f.s, lateral, width: f.width, dist: Math.sqrt(bd) };
}

/** world point on a bank: `offset` meters beyond the water's edge on `side`, at along-river s */
export function bankPoint(s: number, side: -1 | 1, offset = 0) {
  const f = riverFrame(s);
  const d = side * (f.width / 2 + offset);
  return { x: f.x + f.nx * d, z: f.z + f.nz * d, frame: f };
}

/** compass heading of the river direction at s (upstream = true) */
export function riverHeading(s: number, upstream = true) {
  const f = riverFrame(s);
  return forwardToHeading(upstream ? f.tx : -f.tx, upstream ? f.tz : -f.tz);
}

export interface Dock {
  id: string;
  name: string;
  s: number;
  side: -1 | 1;
  /** boat hull center when moored, derived: ~1.5 m off the bank edge, bow upstream */
  moorX: number;
  moorZ: number;
  headingDeg: number;
  /** landing deck top above the water */
  deckY: number;
  minDepth: number;
}

function dock(id: string, name: string, s: number, side: -1 | 1, deckY = 0.7): Dock {
  // the landing deck extends ~3 m from the bank; the hull (beam ~1.6 m) lies alongside its outer edge
  const p = bankPoint(s, side, -4.2);
  return { id, name, s, side, moorX: p.x, moorZ: p.z, headingDeg: riverHeading(s), deckY, minDepth: 1.6 };
}

export const DOCKS: Dock[] = [
  dock('village', 'Hanakawa Village Landing', 190, -1),
  dock('temple', 'Temple Steps', 452, 1),
  dock('teahouse', 'Lakeside Teahouse', 1690, 1),
  dock('mill', 'Mill Landing', 1980, -1),
];

export type BridgeType = 'red-arch' | 'stone-arch' | 'covered' | 'plank';

export interface Bridge {
  id: string;
  name: string;
  type: BridgeType;
  s: number;
  /** minimum clear height above the water across the navigable channel (boat canopy is ~2.3 m) */
  clearance: number;
  deckWidth: number;
}

export const BRIDGES: Bridge[] = [
  { id: 'red-bridge', name: 'Vermilion Bridge', type: 'red-arch', s: 300, clearance: 4.2, deckWidth: 3.2 },
  { id: 'stone-bridge', name: 'Spectacles Bridge', type: 'stone-arch', s: 680, clearance: 4.0, deckWidth: 4.0 },
  { id: 'covered-bridge', name: 'Gorge Covered Bridge', type: 'covered', s: 1080, clearance: 5.5, deckWidth: 3.0 },
  { id: 'plank-bridge', name: 'Heron Footbridge', type: 'plank', s: 1380, clearance: 3.4, deckWidth: 1.6 },
];

export type LandmarkKind = 'village' | 'pagoda' | 'shrine' | 'torii' | 'teahouse' | 'mill' | 'waterfall' | 'gorge' | 'weir' | 'falls';

export interface Landmark {
  id: string;
  name: string;
  kind: LandmarkKind;
  s: number;
  side: -1 | 0 | 1;
  /** meters from the water's edge onto the bank (negative = over the water) */
  offset: number;
  /** discovery radius in meters */
  radius: number;
}

export const LANDMARKS: Landmark[] = [
  { id: 'weir', name: 'Old Weir', kind: 'weir', s: 8, side: 0, offset: 0, radius: 60 },
  { id: 'village', name: 'Hanakawa', kind: 'village', s: 180, side: -1, offset: 25, radius: 140 },
  { id: 'shrine', name: 'Riverside Shrine', kind: 'shrine', s: 272, side: -1, offset: 16, radius: 40 },
  { id: 'pagoda', name: 'Five-Storey Pagoda', kind: 'pagoda', s: 392, side: 1, offset: 42, radius: 90 },
  { id: 'torii', name: 'Water Gate', kind: 'torii', s: 440, side: 1, offset: -2, radius: 45 },
  { id: 'gorge', name: 'Bamboo Gorge', kind: 'gorge', s: 980, side: 0, offset: 0, radius: 160 },
  { id: 'cascade', name: 'Maiden Falls', kind: 'waterfall', s: 960, side: -1, offset: 10, radius: 50 },
  { id: 'teahouse', name: 'Lakeside Teahouse', kind: 'teahouse', s: 1702, side: 1, offset: -6, radius: 70 },
  { id: 'mill', name: 'Water Mill', kind: 'mill', s: 1992, side: -1, offset: 8, radius: 55 },
  { id: 'falls', name: 'Hanakawa Falls', kind: 'falls', s: RIVER_LENGTH - 6, side: 0, offset: 0, radius: 80 },
];

export function landmarkPoint(l: Landmark) {
  if (l.side === 0) {
    const f = riverFrame(l.s);
    return { x: f.x, z: f.z, frame: f };
  }
  return bankPoint(l.s, l.side, l.offset);
}

export interface PointOfInterest {
  id: string;
  name: string;
  kind: string;
  x: number;
  z: number;
  radius: number;
}

export const POIS: PointOfInterest[] = [
  ...LANDMARKS.filter((l) => l.kind !== 'village').map((l) => {
    const p = landmarkPoint(l);
    return { id: l.id, name: l.name, kind: l.kind, x: p.x, z: p.z, radius: l.radius };
  }),
  ...BRIDGES.map((b) => {
    const f = riverFrame(b.s);
    return { id: b.id, name: b.name, kind: 'bridge', x: f.x, z: f.z, radius: 30 };
  }),
];

/** village quay center (older consumers read HARBOR) */
const vq = bankPoint(180, -1, 6);
export const HARBOR = { quayX: vq.x, quayZ: vq.z, facingDeg: riverHeading(180) + 90, quayY: 1.2 };

/** where the player boat spawns on a fresh save: moored at the village landing, bow upstream */
export const SPAWN = { x: DOCKS[0].moorX, z: DOCKS[0].moorZ, headingDeg: DOCKS[0].headingDeg };

/** mid-morning sun from the south-south-east, roughly along the valley: warm side light on the village
 *  facades, and the valley walls' shadows fall along the river instead of across the houses (a low
 *  eastern sun put the whole village in the east ridge's shadow, which only rendered near the camera) */
export const SUN = { azimuthDeg: 150, elevationDeg: 38 };

export function headingToForward(headingDeg: number) {
  const a = (headingDeg * Math.PI) / 180;
  return { x: Math.sin(a), z: -Math.cos(a) };
}

export function forwardToHeading(fx: number, fz: number) {
  const d = (Math.atan2(fx, -fz) * 180) / Math.PI;
  return d < 0 ? d + 360 : d;
}
