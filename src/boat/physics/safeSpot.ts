// unstuck search along the river: the nearest centerline point with enough water under and around
// the hull, away from bridges and the river ends, with the bow pointing upstream.
export interface RiverFrameLike {
  x: number;
  z: number;
  /** unit tangent pointing upstream */
  tx: number;
  tz: number;
  /** unit normal toward the right bank */
  nx: number;
  nz: number;
  width: number;
}

export interface RiverSpotOptions {
  minDepth: number;
  /** meters either side of the centerline that must also be deep enough */
  clearance: number;
  sMin: number;
  sMax: number;
  /** along-river ranges to keep out of (bridge spans): [s, half length] */
  avoid: [number, number][];
  /** how far up or down the river to look */
  maxSearch: number;
}

export interface SafeSpot {
  x: number;
  z: number;
  s: number;
  headingDeg: number;
}

const DEFAULTS: RiverSpotOptions = { minDepth: 1, clearance: 2.5, sMin: 30, sMax: Infinity, avoid: [], maxSearch: 400 };

export function findRiverSpot(
  s0: number,
  frame: (s: number) => RiverFrameLike,
  depthAt: (x: number, z: number) => number,
  opts: Partial<RiverSpotOptions> = {},
): SafeSpot | null {
  const o = { ...DEFAULTS, ...opts };
  const ok = (s: number) => {
    if (s < o.sMin || s > o.sMax) return null;
    for (const [c, h] of o.avoid) if (Math.abs(s - c) < h) return null;
    const f = frame(s);
    if (depthAt(f.x, f.z) < o.minDepth) return null;
    for (const d of [-o.clearance, o.clearance]) if (depthAt(f.x + f.nx * d, f.z + f.nz * d) < o.minDepth * 0.8) return null;
    const h = (Math.atan2(f.tx, -f.tz) * 180) / Math.PI;
    return { x: f.x, z: f.z, s, headingDeg: h < 0 ? h + 360 : h };
  };
  const start = Math.min(o.sMax, Math.max(o.sMin, s0));
  for (let d = 0; d <= o.maxSearch; d += 4) {
    const a = ok(start - d) ?? (d > 0 ? ok(start + d) : null);
    if (a) return a;
  }
  return null;
}
