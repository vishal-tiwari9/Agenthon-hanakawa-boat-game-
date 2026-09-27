// building footprints the bake flattens (owner: structures). derived from the river layout so they
// follow the river when it is reshaped. y is the ground height above the river surface.
// yawDeg is a three.js yaw about +y: local -z points upstream, local +x toward the right bank, so
// hx is the half depth across the river and hz the half frontage along it.
// structures builds each building on its site; the extra fields (kind, s, side, front, w, d)
// describe the building and are ignored by the bake.
import { bankPoint, LANDMARKS, riverHeading } from './layout';

export type SiteKind = 'machiya' | 'machiya-low' | 'kura' | 'shop' | 'shrine' | 'pagoda' | 'hall' | 'teahouse' | 'mill' | 'castle' | 'hillshrine'
  | 'town' | 'lane' | 'precinct' | 'field';

export interface Site {
  id: string;
  x: number;
  z: number;
  hx: number;
  hz: number;
  /** degrees, three.js yaw about +y */
  yawDeg: number;
  y: number;
  /** meters over which terrain blends back to natural */
  blend: number;
  kind?: SiteKind;
  s?: number;
  side?: -1 | 1;
  /** distance of the river-facing facade from the water's edge */
  front?: number;
  /** building frontage along the river and depth across it */
  w?: number;
  d?: number;
  /** riverside veranda between the facade and the embankment */
  veranda?: boolean;
  /** town buildings: 1 when the facade faces the river, -1 when it faces away onto the inland street */
  facing?: 1 | -1;
  /** what a town building, precinct or field is (house, kura, chaya, temple, paddy, ...) */
  role?: string;
}

function at(id: string, hx: number, hz: number, y: number, blend = 8, kind?: SiteKind): Site {
  const l = LANDMARKS.find((m) => m.id === id)!;
  const side = (l.side || 1) as -1 | 1;
  const p = bankPoint(l.s, side, l.offset);
  return { id, x: p.x, z: p.z, hx, hz, yawDeg: -riverHeading(l.s), y, blend, kind, s: l.s, side };
}

/** a site whose center is `offset` meters in from the water's edge at along-river s */
function plot(id: string, kind: SiteKind, s: number, side: -1 | 1, front: number, w: number, d: number, y = 1.2, veranda = false): Site {
  const p = bankPoint(s, side, front + d / 2);
  return { id, kind, s, side, front, w, d, veranda, x: p.x, z: p.z, hx: d / 2 + 1, hz: w / 2 + 1, yawDeg: -riverHeading(s), y, blend: 4 };
}

function onBank(id: string, kind: SiteKind, s: number, side: -1 | 1, offset: number, hx: number, hz: number, y: number, blend = 6): Site {
  const p = bankPoint(s, side, offset);
  return { id, kind, s, side, x: p.x, z: p.z, hx, hz, yawDeg: -riverHeading(s), y, blend };
}

// hanakawa: machiya townhouses, kura storehouses and two shops facing the river across a narrow lane
const VILLAGE: Site[] = [
  plot('v-68', 'kura', 68, -1, 6.5, 5.6, 7.4),
  plot('v-82', 'machiya', 82, -1, 5.2, 7.2, 10, 1.2, true),
  plot('v-99', 'machiya-low', 99, -1, 5.6, 6.6, 9),
  plot('v-114', 'machiya', 114, -1, 5.0, 7.8, 10),
  plot('v-130', 'kura', 130, -1, 7.4, 5.2, 7),
  plot('v-145', 'machiya-low', 145, -1, 5.2, 6.8, 9),
  plot('v-161', 'shop', 161, -1, 6.0, 7.4, 9.5),
  plot('v-214', 'machiya', 214, -1, 5.2, 7.6, 10, 1.2, true),
  plot('v-231', 'machiya-low', 231, -1, 6.0, 6.2, 9),
  plot('v-246', 'kura', 246, -1, 7.0, 5.6, 7.4),
  plot('v-320', 'machiya', 320, -1, 5.6, 7.2, 10),
  plot('v-141r', 'machiya', 141, 1, 5.6, 7.4, 10),
  plot('v-226r', 'machiya-low', 226, 1, 5.4, 6.8, 9, 1.2, true),
  plot('v-243r', 'machiya', 243, 1, 5.0, 7.8, 10),
  plot('v-262r', 'shop', 262, 1, 6.2, 6.6, 9),
  // the right bank is a full street too
  plot('v-62r', 'kura', 62, 1, 6.4, 5.4, 7.2),
  plot('v-77r', 'machiya', 77, 1, 5.2, 7.4, 10, 1.2, true),
  plot('v-93r', 'shop', 93, 1, 5.8, 7, 9),
  plot('v-109r', 'machiya-low', 109, 1, 5.4, 6.6, 9),
  plot('v-124r', 'machiya', 124, 1, 5.0, 7.2, 10),
  plot('v-158r', 'kura', 158, 1, 7.0, 5.4, 7.2),
  plot('v-174r', 'shop', 174, 1, 5.6, 7.2, 9.5, 1.2, true),
  plot('v-191r', 'machiya-low', 191, 1, 5.8, 6.6, 9),
  plot('v-207r', 'machiya', 207, 1, 5.2, 7.4, 10),
  plot('v-280r', 'machiya-low', 280, 1, 5.6, 6.6, 9),
  // a second row behind the waterfront gives the town a skyline and depth
  plot('v2-75', 'machiya', 75, -1, 19.5, 7.6, 10),
  plot('v2-104', 'kura', 104, -1, 20.5, 5.6, 7.4),
  plot('v2-136', 'machiya-low', 136, -1, 19.5, 7, 9),
  plot('v2-222', 'machiya', 222, -1, 19.5, 7.8, 10),
  plot('v2-252', 'kura', 252, -1, 20.5, 5.4, 7.2),
  plot('v2-86r', 'machiya-low', 86, 1, 19.5, 7, 9),
  plot('v2-117r', 'kura', 117, 1, 20.5, 5.6, 7.4),
  plot('v2-167r', 'machiya', 167, 1, 19.5, 7.6, 10),
  plot('v2-236r', 'machiya-low', 236, 1, 19.5, 6.8, 9),
  // the town continues past the vermilion bridge to the stone bridge, three rows deep, so the view
  // upstream is roofs, streets and landmarks rather than a hillside
  plot('t1-322', 'machiya', 322, -1, 5.4, 7.4, 10),
  plot('t1-338', 'machiya-low', 338, -1, 5.4, 6.8, 9, 1.2, true),
  plot('t1-354', 'shop', 354, -1, 5.4, 7.2, 9.5),
  plot('t1-370', 'kura', 370, -1, 5.4, 5.6, 7.4),
  plot('t1-386', 'machiya', 386, -1, 5.4, 7.4, 10),
  plot('t1-402', 'machiya-low', 402, -1, 5.4, 6.8, 9, 1.2, true),
  plot('t1-418', 'machiya', 418, -1, 5.4, 7.4, 10),
  plot('t1-434', 'shop', 434, -1, 5.4, 7.2, 9.5),
  plot('t1-450', 'kura', 450, -1, 5.4, 5.6, 7.4),
  plot('t1-466', 'machiya-low', 466, -1, 5.4, 6.8, 9, 1.2, true),
  plot('t1-482', 'machiya', 482, -1, 5.4, 7.4, 10),
  plot('t1-498', 'machiya-low', 498, -1, 5.4, 6.8, 9),
  plot('t1-514', 'shop', 514, -1, 5.4, 7.2, 9.5),
  plot('t1-530', 'kura', 530, -1, 5.4, 5.6, 7.4, 1.2, true),
  plot('t1-546', 'machiya', 546, -1, 5.4, 7.4, 10),
  plot('t1-562', 'machiya-low', 562, -1, 5.4, 6.8, 9),
  plot('t1-578', 'machiya', 578, -1, 5.4, 7.4, 10),
  plot('t1-594', 'shop', 594, -1, 5.4, 7.2, 9.5, 1.2, true),
  plot('t1-610', 'kura', 610, -1, 5.4, 5.6, 7.4),
  plot('t1-626', 'machiya-low', 626, -1, 5.4, 6.8, 9),
  plot('t1-642', 'machiya', 642, -1, 5.4, 7.4, 10),
  plot('t1-658', 'machiya-low', 658, -1, 5.4, 6.8, 9, 1.2, true),
  plot('t2-330', 'kura', 330, -1, 19.5, 5.6, 7.4),
  plot('t2-362', 'machiya', 362, -1, 19.5, 7.4, 10),
  plot('t2-396', 'machiya-low', 396, -1, 19.5, 6.8, 9),
  plot('t2-430', 'machiya', 430, -1, 19.5, 7.4, 10),
  plot('t2-466', 'shop', 466, -1, 19.5, 7.2, 9.5),
  plot('t2-500', 'kura', 500, -1, 19.5, 5.6, 7.4),
  plot('t2-536', 'machiya-low', 536, -1, 19.5, 6.8, 9),
  plot('t2-570', 'machiya', 570, -1, 19.5, 7.4, 10),
  plot('t2-604', 'machiya-low', 604, -1, 19.5, 6.8, 9),
  plot('t2-640', 'shop', 640, -1, 19.5, 7.2, 9.5),
  plot('t3-346', 'machiya-low', 346, -1, 34, 6.8, 9),
  plot('t3-414', 'machiya', 414, -1, 34, 7.4, 10),
  plot('t3-484', 'shop', 484, -1, 34, 7.2, 9.5),
  plot('t3-552', 'kura', 552, -1, 34, 5.6, 7.4),
  plot('t3-620', 'machiya-low', 620, -1, 34, 6.8, 9),
  plot('t1-318r', 'shop', 318, 1, 5.4, 7.2, 9.5),
  plot('t1-334r', 'kura', 334, 1, 5.4, 5.6, 7.4, 1.2, true),
  plot('t1-350r', 'machiya', 350, 1, 5.4, 7.4, 10),
  plot('t1-364r', 'machiya-low', 364, 1, 5.4, 6.8, 9),
  plot('t1-472r', 'machiya', 472, 1, 5.4, 7.4, 10),
  plot('t1-488r', 'machiya-low', 488, 1, 5.4, 6.8, 9, 1.2, true),
  plot('t1-504r', 'machiya', 504, 1, 5.4, 7.4, 10),
  plot('t1-520r', 'shop', 520, 1, 5.4, 7.2, 9.5),
  plot('t1-536r', 'kura', 536, 1, 5.4, 5.6, 7.4),
  plot('t1-552r', 'machiya-low', 552, 1, 5.4, 6.8, 9, 1.2, true),
  plot('t1-568r', 'machiya', 568, 1, 5.4, 7.4, 10),
  plot('t1-584r', 'machiya-low', 584, 1, 5.4, 6.8, 9),
  plot('t1-600r', 'shop', 600, 1, 5.4, 7.2, 9.5),
  plot('t1-616r', 'kura', 616, 1, 5.4, 5.6, 7.4, 1.2, true),
  plot('t1-632r', 'machiya', 632, 1, 5.4, 7.4, 10),
  plot('t1-648r', 'machiya-low', 648, 1, 5.4, 6.8, 9),
  plot('t1-664r', 'machiya', 664, 1, 5.4, 7.4, 10),
  plot('t2-326r', 'machiya-low', 326, 1, 19.5, 6.8, 9),
  plot('t2-356r', 'shop', 356, 1, 19.5, 7.2, 9.5),
  plot('t2-482r', 'kura', 482, 1, 19.5, 5.6, 7.4),
  plot('t2-514r', 'machiya', 514, 1, 19.5, 7.4, 10),
  plot('t2-548r', 'machiya-low', 548, 1, 19.5, 6.8, 9),
  plot('t2-582r', 'machiya', 582, 1, 19.5, 7.4, 10),
  plot('t2-616r', 'shop', 616, 1, 19.5, 7.2, 9.5),
  plot('t2-652r', 'kura', 652, 1, 19.5, 5.6, 7.4),
  plot('t3-500r', 'machiya', 500, 1, 34, 7.4, 10),
  plot('t3-570r', 'shop', 570, 1, 34, 7.2, 9.5),
  plot('t3-640r', 'kura', 640, 1, 34, 5.6, 7.4),
  // distant landmarks: a castle keep on the left hills, a hillside shrine on the right
  onBank('castle', 'castle', 520, -1, 150, 22, 22, 20, 18),
  onBank('hill-shrine', 'hillshrine', 600, 1, 150, 9, 9, 22, 12),
];

const LANDMARK_SITES: Site[] = [
  at('shrine', 7, 6, 1.6, 8, 'shrine'),
  // the temple terrace carries the pagoda and the main hall behind it
  { ...onBank('pagoda', 'pagoda', 405, 1, 43, 13, 27, 6.5, 5) },
  onBank('temple-hall', 'hall', 421, 1, 43, 6.5, 7.5, 6.5, 4),
  onBank('teahouse', 'teahouse', 1702, 1, 3, 4, 6, 1.2, 4),
  // the mill hut stands close to the edge so its wheel can dip into the river
  onBank('mill', 'mill', 1992, -1, 4.6, 3.6, 5, 1.4, 6),
];

// ---------------------------------------------------------------------------------------------
// the town behind the waterfront (s 55-670). an inland street runs parallel to the canal on each
// bank with shops facing it from both sides; paved cross lanes open views from the water through
// the gaps in the front rows; a temple (left) and a shrine (right) front the street; gardens,
// flooded paddies and tea rows fill the floor where it meets the hills. everything is generated
// here so the bake levels each footprint and keeps grass and trees out of it.

/** inland street centerline, meters from the water's edge, and its paved half width */
export const STREET_Q = 50;
export const STREET_HALF = 2.2;
const LAND_FRONT = STREET_Q + STREET_HALF + 1;
const RIVER_FRONT = STREET_Q - STREET_HALF - 1;

/** meters of ground per meter of s at a lateral offset (the banks stretch on outer bends) */
function stretch(s: number, side: -1 | 1, q: number) {
  const a = bankPoint(s - 1, side, q), b = bankPoint(s + 1, side, q);
  return Math.hypot(b.x - a.x, b.z - a.z) / 2;
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Taken { side: number; s0: number; s1: number; q0: number; q1: number }
const taken: Taken[] = [];
const occupy = (side: number, s0: number, s1: number, q0: number, q1: number) => { taken.push({ side, s0, s1, q0, q1 }); };
const free = (side: number, s0: number, s1: number, q0: number, q1: number) =>
  !taken.some((b) => b.side === side && b.s0 < s1 && s0 < b.s1 && b.q0 < q1 && q0 < b.q1);

// the waterfront rows, the riverside shrine and the temple terrace are already there
for (const v of VILLAGE) {
  if (v.front === undefined || !v.w || !v.d || !v.side || v.s === undefined) continue;
  const h = (v.w / 2 + 1) / stretch(v.s, v.side, v.front + v.d / 2);
  occupy(v.side, v.s - h, v.s + h, v.front - 0.5, v.front + v.d + 0.5);
}
occupy(-1, 265, 279, 8, 24);
occupy(1, 330, 462, 22, 120);
// the hill shrine's torii path crosses the right bank floor at s ~592-600
occupy(1, 585, 606, 0, 160);
// bridge landings
for (const [s, h] of [[300, 9], [680, 10]]) { occupy(-1, s - h, s + h, 0, 13); occupy(1, s - h, s + h, 0, 13); }

function townPlot(id: string, s: number, side: -1 | 1, front: number, w: number, d: number, facing: 1 | -1, role: string): Site {
  const p = bankPoint(s, side, front + (facing * d) / 2);
  return { id, kind: 'town', role, s, side, front, w, d, facing, x: p.x, z: p.z, hx: d / 2 + 0.5, hz: w / 2 + 0.5, yawDeg: -riverHeading(s), y: 1.2, blend: 3 };
}

/** a walled precinct or open ground at along-river s: q0..q1 from the water's edge, halfW along */
function precinct(id: string, role: string, s: number, side: -1 | 1, q0: number, q1: number, halfW: number, y = 1.2, kind: SiteKind = 'precinct', blend = 4): Site {
  const qc = (q0 + q1) / 2;
  const p = bankPoint(s, side, qc);
  const hs = halfW / stretch(s, side, qc);
  occupy(side, s - hs, s + hs, q0, q1);
  return { id, kind, role, s, side, front: q0, w: halfW * 2, d: q1 - q0, x: p.x, z: p.z, hx: (q1 - q0) / 2, hz: halfW, yawDeg: -riverHeading(s), y, blend };
}

/** stepped fields climbing the hill foot: [q0, q1, level] per step, between s0 and s1 */
function terraces(id: string, role: string, side: -1 | 1, s0: number, s1: number, steps: [number, number, number][]): Site[] {
  const sc = (s0 + s1) / 2;
  return steps.map(([q0, q1, y], i) => precinct(`${id}-${i}`, role, sc, side, q0, q1, ((s1 - s0) / 2) * stretch(sc, side, (q0 + q1) / 2), y, 'field', i === 0 ? 3 : 1.2));
}

export interface Lane { id: string; side: -1 | 1; width: number; pts: { x: number; z: number }[] }
/** paved streets and lanes (the structures module lays the paving; the bake clears the ground) */
export const LANES: Lane[] = [];

function lane(id: string, side: -1 | 1, width: number, path: [number, number][], block = true): Site[] {
  const pts = path.map(([s, q]) => { const b = bankPoint(s, side, q); return { x: b.x, z: b.z }; });
  LANES.push({ id, side, width, pts });
  const out: Site[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    const [sa, qa] = path[i], [sb, qb] = path[i + 1];
    if (block) {
      const hs = (width / 2 + 0.8) / stretch((sa + sb) / 2, side, (qa + qb) / 2);
      occupy(side, Math.min(sa, sb) - hs, Math.max(sa, sb) + hs, Math.min(qa, qb) - 0.5, Math.max(qa, qb) + 0.5);
    }
    out.push({ id: `${id}-${i}`, kind: 'lane', side, s: (sa + sb) / 2, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, hx: width / 2, hz: len / 2 + 0.6, yawDeg: (Math.atan2(dx, dz) * 180) / Math.PI, y: 1.2, blend: 2 });
  }
  return out;
}

/** a street along the bank at offset q from s0 to s1, in ~15 m chords (a few cm off the true curve) */
function street(id: string, side: -1 | 1, s0: number, s1: number): Site[] {
  const path: [number, number][] = [];
  const n = Math.ceil((s1 - s0) / 15);
  for (let i = 0; i <= n; i++) path.push([s0 + ((s1 - s0) * i) / n, STREET_Q]);
  return lane(id, side, STREET_HALF * 2, path, false);
}

const SHOPS = ['chaya', 'sweets', 'pottery', 'umbrella', 'rice', 'soba', 'chaya', 'sweets', 'fans'];
const SIZE: Record<string, [number, number, number, number]> = {
  house: [6.4, 8.4, 8.6, 10], low: [6.2, 7.6, 8.2, 9.2], kura: [5.0, 6.0, 6.4, 7.4], one: [6.8, 8.6, 7.2, 8.2],
  yard: [6.0, 8.0, 6.5, 8.0],
};
let shopIx = 0;

/** a row of buildings facing the inland street from one side */
function streetRow(side: -1 | 1, s0: number, s1: number, facing: 1 | -1, seed: number): Site[] {
  const R = mulberry(seed);
  const out: Site[] = [];
  const front = facing > 0 ? LAND_FRONT : RIVER_FRONT;
  let s = s0, run = 0, i = 0;
  while (s < s1) {
    let role: string;
    if (facing > 0) role = i % 3 === 1 ? SHOPS[shopIx % SHOPS.length] : ((r) => (r < 0.62 ? 'house' : r < 0.88 ? 'low' : 'one'))(R());
    else { const r = R(); role = r < 0.28 ? 'kura' : r < 0.52 ? 'low' : r < 0.7 ? 'one' : r < 0.86 ? 'house' : 'yard'; }
    const sz = SIZE[role] ?? [6.8, 8.4, 8.2, 9.2];
    const w = sz[0] + (sz[1] - sz[0]) * R(), d = sz[2] + (sz[3] - sz[2]) * R();
    const q0 = Math.min(front, front + facing * d), q1 = Math.max(front, front + facing * d);
    const st = stretch(s, side, (q0 + q1) / 2);
    const half = w / 2 / st;
    const c = s + half;
    if (c + half > s1) break;
    if (!free(side, c - half - 0.4, c + half + 0.4, q0, q1)) { s += 1.2; run = 0; continue; }
    if (facing > 0 && i % 3 === 1) shopIx++;
    out.push(townPlot(`tw${side < 0 ? 'l' : 'r'}${facing > 0 ? 'a' : 'b'}-${Math.round(c)}`, c, side, front, w, d, facing, role));
    occupy(side, c - half, c + half, q0, q1);
    i++; run++;
    // a narrow alley every few houses
    let gap = 0.25 + R() * 0.5;
    if (run >= 4 + Math.floor(R() * 3)) { gap = 3.0 + R() * 1.4; run = 0; }
    s = c + half + gap / st;
  }
  return out;
}

function buildTown(): Site[] {
  const out: Site[] = [];
  // streets first (they do not block), then the lanes and precincts that break the street rows
  out.push(...street('street-l', -1, 56, 668), ...street('street-r', 1, 58, 328), ...street('street-r2', 1, 463, 662));
  // cross lanes from the water: the landing to the temple gate, the festival lane at the vermilion
  // bridge, lanes through gaps in the front rows, and the paved torii path to the hill shrine
  out.push(...lane('lane-dock', -1, 3.8, [[190, 2], [190, STREET_Q]]));
  out.push(...lane('lane-fest', -1, 4.0, [[303, 12], [303, STREET_Q]]));
  out.push(...lane('lane-l91', -1, 3.0, [[90.6, 3], [90.6, STREET_Q]]));
  out.push(...lane('lane-l458', -1, 3.0, [[458, 3], [458, STREET_Q]]));
  out.push(...lane('lane-l586', -1, 3.0, [[586, 3], [586, STREET_Q]]));
  out.push(...lane('lane-r101', 1, 3.0, [[101, 3], [101, STREET_Q]]));
  out.push(...lane('lane-r150', 1, 3.4, [[150, 3], [150, STREET_Q]]));
  out.push(...lane('lane-r300', 1, 3.6, [[300, 13], [300, STREET_Q]]));
  out.push(...lane('lane-r623', 1, 3.0, [[623.5, 3], [623.5, STREET_Q]]));
  out.push(...lane('lane-torii', 1, 2.6, [[592, 5], [592, 17.5], [593, 36], [597, 80]], false));

  // precincts and open grounds
  out.push(precinct('temple', 'temple', 191, -1, 55, 92, 22));
  out.push(precinct('town-shrine', 'shrine', 150, 1, 55, 88, 19));
  out.push(precinct('brewery', 'sake', 247, -1, LAND_FRONT, 80, 14));
  out.push(precinct('festival', 'yatai', 303, -1, 13, 46.5, 7.5));
  out.push(precinct('garden-l', 'garden', 131, -1, 66, 89, 17));
  out.push(precinct('garden-r', 'garden', 522, 1, 66, 88, 16));
  out.push(precinct('inari', 'inari', 486, -1, 65, 92, 13));
  out.push(precinct('kurayard-r', 'kurayard', 481, 1, 65, 90, 16));
  out.push(precinct('wagasa', 'wagasa', 379, -1, 35.5, RIVER_FRONT, 7));
  out.push(precinct('tower-l', 'tower', 436, -1, 66, 71, 2.5));
  out.push(precinct('tower-r', 'tower', 188, 1, 66, 71, 2.5));
  out.push(precinct('belfry', 'belfry', 402, 1, 62, 80, 9, 6.5));
  // flooded paddies and tea where the floor meets the hills (levels follow the natural rise)
  out.push(...terraces('paddy-l1', 'paddy', -1, 58, 110, [[66, 84, 1.2], [85, 92, 1.9]]));
  out.push(...terraces('paddy-l2', 'paddy', -1, 360, 420, [[66, 88, 1.2], [89, 97, 1.6], [98, 104, 2.6]]));
  out.push(...terraces('paddy-l3', 'paddy', -1, 505, 556, [[65, 94, 1.2], [95, 102, 2.4]]));
  out.push(...terraces('paddy-r1', 'paddy', 1, 62, 118, [[66, 75, 1.2], [76, 82, 2.0], [83, 88, 3.0]]));
  out.push(...terraces('paddy-r2', 'paddy', 1, 545, 584, [[66, 90, 1.2], [91, 98, 2.0], [99, 106, 3.4]]));
  out.push(...terraces('tea-l', 'tea', -1, 560, 640, [[66, 96, 1.2]]));
  out.push(...terraces('tea-r', 'tea', 1, 205, 290, [[66, 95, 1.2]]));
  out.push(...terraces('tea-r2', 'tea', 1, 610, 650, [[66, 80, 1.2], [81, 87, 2.4]]));

  // buildings facing the street from the land side (shops) and from the river side
  out.push(...streetRow(-1, 58, 667, 1, 11), ...streetRow(-1, 60, 667, -1, 12));
  out.push(...streetRow(1, 60, 327, 1, 21), ...streetRow(1, 464, 661, 1, 22));
  out.push(...streetRow(1, 60, 327, -1, 23), ...streetRow(1, 464, 661, -1, 24));
  return out;
}

export const TOWN: Site[] = buildTown();

export const SITES: Site[] = [...LANDMARK_SITES, ...VILLAGE, ...TOWN];
