// hull hydrostatics derived from hullSpec: 15 buoyancy cells (5 stations x port/center/starboard),
// each with a displaced volume table over the local water level, plus the convex collider points,
// principal inertia and the probe points used by the temporary terrain contact.
import { HULL, halfWidthAt, keelAt, sheerAt, stationZ } from '../hullSpec';
import { TUNING } from './tuning';

export interface HydroCell {
  station: number;
  /** -1 port, 0 center, 1 starboard */
  side: number;
  /** local x where the water level is sampled and the force applied */
  x: number;
  /** local z of the level sample (slab volume centroid at the design draft) */
  zRef: number;
  /** level table: level = yMin + i * yStep */
  yMin: number;
  yStep: number;
  n: number;
  vol: Float64Array;
  cy: Float64Array;
  cz: Float64Array;
  /** volume at the design waterline (level 0) */
  vDesign: number;
  /** share of the design displacement (surge/heave drag weight) */
  w: number;
  /** share of the lateral area (sway drag weight) */
  lat: number;
}

export interface Hydro {
  cells: HydroCell[];
  /** displaced volume at the design waterline, m^3 */
  vDesign: number;
  /** buoyancy multiplier so rho*g*vDesign*scale = mass*g */
  scale: number;
  /** waterplane area at the design draft */
  waterplane: number;
  colliderPoints: Float32Array;
  /** principal inertia about local x (pitch), y (yaw), z (roll) */
  inertia: { x: number; y: number; z: number };
  /** local points probed against the terrain height/shore fields */
  probes: { x: number; y: number; z: number; bottom: boolean }[];
  /** local point at the transom centerline, where the wake trail starts */
  stern: { x: number; y: number; z: number };
}

export const STATIONS = 5;
const LEVELS = 48;

function slabSection(s: number, level: number, ny: number) {
  const k = keelAt(s), top = Math.min(level, sheerAt(s));
  if (top <= k) return { a: 0, ay: 0 };
  const dy = (top - k) / ny;
  let a = 0, ay = 0;
  for (let j = 0; j < ny; j++) {
    const y = k + (j + 0.5) * dy;
    const w = 2 * halfWidthAt(s, y) * dy;
    a += w;
    ay += w * y;
  }
  return { a, ay };
}

export function buildHydro(stations = STATIONS): Hydro {
  const cells: HydroCell[] = [];
  const sub = 16, ny = 28;
  const lenZ = HULL.sternZ - HULL.bowZ;
  const slabs: { vol: Float64Array; cy: Float64Array; cz: Float64Array; yMin: number; yStep: number; xSide: number; zRef: number; lat: number; vDesign: number }[] = [];
  let waterplane = 0;
  for (let i = 0; i < stations; i++) {
    const s0 = i / stations, s1 = (i + 1) / stations;
    let yMin = Infinity, yMax = -Infinity;
    for (let k = 0; k <= sub; k++) {
      const s = s0 + ((s1 - s0) * k) / sub;
      yMin = Math.min(yMin, keelAt(s));
      yMax = Math.max(yMax, sheerAt(s));
    }
    const yStep = (yMax - yMin) / (LEVELS - 1);
    const vol = new Float64Array(LEVELS), cy = new Float64Array(LEVELS), cz = new Float64Array(LEVELS);
    const dz = (lenZ * (s1 - s0)) / sub;
    for (let j = 0; j < LEVELS; j++) {
      const level = yMin + j * yStep;
      let v = 0, my = 0, mz = 0;
      for (let k = 0; k < sub; k++) {
        const s = s0 + ((s1 - s0) * (k + 0.5)) / sub;
        const z = stationZ(s);
        const sec = slabSection(s, level, ny);
        v += sec.a * dz;
        my += sec.ay * dz;
        mz += sec.a * z * dz;
      }
      vol[j] = v;
      cy[j] = v > 1e-9 ? my / v : level;
      cz[j] = v > 1e-9 ? mz / v : stationZ((s0 + s1) / 2);
    }
    // waterplane second moment of the outer thirds -> side sample offset that reproduces
    // the true roll stiffness; lateral (sway) area with extra weight aft for the skeg
    let aSide = 0, iSide = 0, lat = 0, wp = 0, vD = 0, vDz = 0;
    for (let k = 0; k < sub; k++) {
      const s = s0 + ((s1 - s0) * (k + 0.5)) / sub;
      const w = halfWidthAt(s, 0);
      aSide += (2 / 3) * w * dz;
      iSide += (26 / 81) * w * w * w * dz;
      wp += 2 * w * dz;
      const skeg = 1 + TUNING.skegBias * Math.max(0, (s - 0.5) / 0.5);
      lat += Math.max(0, -keelAt(s)) * dz * skeg;
      const sec = slabSection(s, 0, ny);
      vD += sec.a * dz;
      vDz += sec.a * stationZ(s) * dz;
    }
    waterplane += wp;
    slabs.push({
      vol, cy, cz, yMin, yStep,
      xSide: aSide > 1e-9 ? Math.sqrt(iSide / aSide) : 0,
      zRef: vD > 1e-9 ? vDz / vD : stationZ((s0 + s1) / 2),
      lat,
      vDesign: vD,
    });
  }

  let vTotal = 0, latTotal = 0;
  for (const sl of slabs) { vTotal += sl.vDesign; latTotal += sl.lat; }
  slabs.forEach((sl, i) => {
    // the section splits into three strips of equal width at every level, so each strip holds a
    // third of the slab volume with the same vertical and longitudinal centroid
    for (const side of [-1, 0, 1]) {
      const third = (a: Float64Array) => a.map((v) => v / 3);
      cells.push({
        station: i, side,
        x: side * sl.xSide,
        zRef: sl.zRef,
        yMin: sl.yMin, yStep: sl.yStep, n: LEVELS,
        vol: third(sl.vol), cy: sl.cy, cz: sl.cz,
        vDesign: sl.vDesign / 3,
        w: sl.vDesign / 3 / vTotal,
        lat: sl.lat / 3 / latTotal,
      });
    }
  });

  const scale = TUNING.calibrateDisplacement ? HULL.mass / (TUNING.rho * vTotal) : 1;
  const g = TUNING.gyration, ad = TUNING.addedInertia, m = HULL.mass;
  const inertia = {
    x: m * g.pitch * g.pitch * ad.pitch,
    y: m * g.yaw * g.yaw * ad.yaw,
    z: m * g.roll * g.roll * ad.roll,
  };
  return { cells, vDesign: vTotal, scale, waterplane, colliderPoints: colliderPoints(), inertia, probes: probes(), stern: { x: 0, y: 0, z: HULL.sternZ } };
}

/** convex hull cloud: keel line plus both sides at several heights up to the sheer */
function colliderPoints() {
  const pts: number[] = [];
  // dense near the bottom so the thin keel/skeg and the bilge both shape the hull
  const n = 20, fr = [0.06, 0.14, 0.24, 0.36, 0.5, 0.66, 0.83, 1];
  for (let i = 0; i <= n; i++) {
    const s = i / n, z = stationZ(s), k = keelAt(s), top = sheerAt(s);
    pts.push(0, k, z);
    for (const f of fr) {
      const y = k + (top - k) * f;
      const hw = halfWidthAt(s, y);
      if (hw < 1e-3) pts.push(0, y, z);
      else pts.push(-hw, y, z, hw, y, z);
    }
  }
  return new Float32Array(pts);
}

function probes() {
  const out: Hydro['probes'] = [];
  // where the hull meets the water forward: raked bows overhang well ahead of it
  let sw = 0;
  while (sw < 0.9 && halfWidthAt(sw, 0.02) < 0.05) sw += 0.005;
  const wl = (u: number) => sw + (1 - sw) * u;
  // bottom: overhanging bow tip, forefoot, flat run, deepest point aft
  out.push({ x: 0, y: keelAt(0.06), z: stationZ(0.06), bottom: true });
  for (const u of [0.03, 0.4, 0.95]) out.push({ x: 0, y: keelAt(wl(u)), z: stationZ(wl(u)), bottom: true });
  for (const u of [0.3, 0.8]) {
    // bilge/chine point: lowest height where the section reaches 60% of its waterline half-width
    const s = wl(u), w0 = halfWidthAt(s, 0);
    let y = keelAt(s);
    while (y < 0 && halfWidthAt(s, y) < w0 * 0.6) y += 0.01;
    const hw = halfWidthAt(s, y);
    out.push({ x: -hw, y, z: stationZ(s), bottom: true }, { x: hw, y, z: stationZ(s), bottom: true });
  }
  // waterline ring: stem, shoulders, midships, quarters
  out.push({ x: 0, y: 0.05, z: stationZ(sw), bottom: false });
  for (const u of [0.12, 0.45, 0.97]) {
    const s = wl(u), hw = halfWidthAt(s, 0.05);
    out.push({ x: -hw, y: 0.05, z: stationZ(s), bottom: false }, { x: hw, y: 0.05, z: stationZ(s), bottom: false });
  }
  return out;
}

/** interpolated table lookup; writes [volume, centroid y, centroid z] */
export function cellAt(c: HydroCell, level: number, out: number[]) {
  const f = (level - c.yMin) / c.yStep;
  if (f <= 0) {
    out[0] = 0;
    out[1] = c.cy[0];
    out[2] = c.cz[0];
    return out;
  }
  const last = c.n - 1;
  if (f >= last) {
    out[0] = c.vol[last];
    out[1] = c.cy[last];
    out[2] = c.cz[last];
    return out;
  }
  const i = Math.floor(f), t = f - i;
  out[0] = c.vol[i] + (c.vol[i + 1] - c.vol[i]) * t;
  out[1] = c.cy[i] + (c.cy[i + 1] - c.cy[i]) * t;
  out[2] = c.cz[i] + (c.cz[i + 1] - c.cz[i]) * t;
  return out;
}
