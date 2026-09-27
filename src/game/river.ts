// river navigation checks, resolved at runtime against the current bake. every objective point
// (berths, bridge passages, lantern gates, landmark approaches) must be reachable by water from the
// village landing with at least MIN_DEPTH under the keel all the way, following the river spline.
import { BRIDGES, DOCKS, POIS, RIVER_LENGTH, nearestRiver, riverFrame } from '../world/layout';
import type { GatePoint } from './types';

export interface Sampler {
  depth(x: number, z: number): number;
}

/** minimum water under the keel anywhere on a route (m) */
export const MIN_DEPTH = 1.2;
const STEP = 2; // along-river sampling (m)
const LAT = 1; // across-river sampling (m)

const dist = (ax: number, az: number, bx: number, bz: number) => Math.hypot(bx - ax, bz - az);

/** navigable lateral offsets at every STEP along the river, computed once per bake */
export class NavTable {
  readonly rows: Float32Array[] = [];

  constructor(private s: Sampler) {
    for (let t = 0; t <= RIVER_LENGTH; t += STEP) {
      const f = riverFrame(t);
      const half = f.width / 2 + 4;
      const ok: number[] = [];
      for (let l = -half; l <= half; l += LAT) if (s.depth(f.x + f.nx * l, f.z + f.nz * l) >= MIN_DEPTH) ok.push(l);
      this.rows.push(new Float32Array(ok));
    }
  }

  private row(t: number) {
    return this.rows[Math.max(0, Math.min(this.rows.length - 1, Math.round(t / STEP)))];
  }

  /** navigable lateral nearest to `lat` at along-river t, or null */
  nearest(t: number, lat: number) {
    const r = this.row(t);
    let best: number | null = null, bd = Infinity;
    for (let i = 0; i < r.length; i++) {
      const d = Math.abs(r[i] - lat);
      if (d < bd) { bd = d; best = r[i]; }
    }
    return best;
  }

  /**
   * follow navigable water from (s0, lat0) to s1, never jumping more than a boat's width sideways
   * between samples. returns the lateral reached at s1, or the along-river distance where it blocks.
   */
  walk(s0: number, lat0: number, s1: number): { ok: true; lat: number } | { ok: false; at: number } {
    let lat = this.nearest(s0, lat0);
    if (lat === null) return { ok: false, at: s0 };
    const dir = s1 >= s0 ? 1 : -1;
    for (let t = s0; dir > 0 ? t < s1 : t > s1; t += dir * STEP) {
      const n = this.nearest(t, lat);
      if (n === null || Math.abs(n - lat) > 6) return { ok: false, at: t };
      lat = n;
    }
    return { ok: true, lat };
  }
}

export interface Reach {
  id: string;
  ok: boolean;
  /** navigable point closest to the target (the hud aims here, tests teleport here) */
  x: number;
  z: number;
  /** meters from that point to the target itself */
  gap: number;
  note?: string;
}

/**
 * can the boat get within `within` meters of (x, z) from the village landing? walks the river to the
 * target's along-river position, then heads straight for the target until the water gets too shallow.
 */
export function reachFrom(nav: NavTable, s: Sampler, id: string, x: number, z: number, within: number): Reach {
  const start = DOCKS.find((d) => d.id === 'village') ?? DOCKS[0];
  const a = nearestRiver(start.moorX, start.moorZ);
  const b = nearestRiver(x, z);
  const w = nav.walk(a.s, a.lateral, b.s);
  if (!w.ok) {
    const f = riverFrame(b.s);
    return { id, ok: false, x: f.x, z: f.z, gap: dist(f.x, f.z, x, z), note: `${id}: river blocked (under ${MIN_DEPTH} m) at s ${w.at.toFixed(0)}` };
  }
  // try the channel point we arrived at, then nearby along-river positions, for the best approach
  let best: { x: number; z: number; gap: number } | null = null;
  for (const ds of [0, -6, 6, -12, 12, -20, 20]) {
    const t = Math.max(0, Math.min(RIVER_LENGTH, b.s + ds));
    const w2 = ds === 0 ? w : nav.walk(b.s, w.lat, t);
    if (!w2.ok) continue;
    const f = riverFrame(t);
    const cx = f.x + f.nx * w2.lat, cz = f.z + f.nz * w2.lat;
    const d = dist(cx, cz, x, z);
    const n = Math.max(1, Math.ceil(d / 1));
    let px = cx, pz = cz;
    for (let i = 1; i <= n; i++) {
      const qx = cx + ((x - cx) * i) / n, qz = cz + ((z - cz) * i) / n;
      if (s.depth(qx, qz) < MIN_DEPTH) break;
      px = qx;
      pz = qz;
    }
    const gap = dist(px, pz, x, z);
    if (!best || gap < best.gap) best = { x: px, z: pz, gap };
    if (gap <= within * 0.6) break;
  }
  const r = best!;
  const ok = r.gap <= within;
  return { id, ok, x: r.x, z: r.z, gap: r.gap, note: ok ? undefined : `${id}: closest water is ${r.gap.toFixed(0)} m away (needs ${within.toFixed(0)} m)` };
}

/** the lantern run: pairs of floating lanterns weaving across the lake, upstream */
export function lanternGates(nav: NavTable, s: Sampler, notes: string[]): GatePoint[] {
  // center the run on the widest reach of the river (the lake), wherever the spline puts it
  let mid = RIVER_LENGTH * 0.8, widest = 0;
  for (let t = 0; t <= RIVER_LENGTH; t += 10) {
    const w = riverFrame(t).width;
    if (w > widest) { widest = w; mid = t; }
  }
  const plan: [number, number][] = [[-120, -0.16], [-72, 0.18], [-24, -0.12], [24, 0.2], [72, -0.16], [120, 0.08]];
  const half = 4.6;
  const gates: GatePoint[] = [];
  for (const [ds, frac] of plan) {
    const t = Math.max(0, Math.min(RIVER_LENGTH, mid + ds));
    const f = riverFrame(t);
    const want = frac * f.width;
    // the gate and both lantern clusters need water; slide toward the channel until they fit
    let lat: number | null = null;
    for (const k of [0, 0.25, 0.5, 0.75, 1]) {
      const l = want * (1 - k);
      const ok = [-half - 0.8, 0, half + 0.8].every((o) => s.depth(f.x + f.nx * (l + o), f.z + f.nz * (l + o)) >= MIN_DEPTH);
      if (ok) { lat = l; break; }
    }
    if (lat === null) {
      lat = nav.nearest(t, 0) ?? 0;
      notes.push(`lantern gate at s ${t.toFixed(0)} has no room for both lanterns; placed at lateral ${lat.toFixed(1)}`);
    } else if (Math.abs(lat - want) > 0.5) notes.push(`lantern gate at s ${t.toFixed(0)} moved ${Math.abs(lat - want).toFixed(1)} m toward the channel`);
    gates.push({ x: f.x + f.nx * lat, z: f.z + f.nz * lat, dx: f.tx, dz: f.tz, half, s: t });
  }
  return gates;
}

/** every place an objective can send the player, checked for water access */
export function objectiveReach(nav: NavTable, s: Sampler, dockRange: number) {
  const out: Reach[] = [];
  for (const d of DOCKS) {
    const r = reachFrom(nav, s, `dock:${d.id}`, d.moorX, d.moorZ, dockRange - 2);
    const berth = s.depth(d.moorX, d.moorZ);
    if (berth < MIN_DEPTH) r.note = `${r.note ? r.note + '; ' : ''}dock ${d.id}: berth itself is ${berth.toFixed(2)} m deep`;
    out.push(r);
  }
  for (const b of BRIDGES) {
    const f = riverFrame(b.s);
    out.push(reachFrom(nav, s, `bridge:${b.id}`, f.x, f.z, f.width / 2));
  }
  for (const p of POIS) {
    if (p.kind === 'bridge') continue;
    out.push(reachFrom(nav, s, `poi:${p.id}`, p.x, p.z, p.radius));
  }
  return out;
}
