// surface sampling for the wasen, straight from hullSpec: the flared side planks (tana) between the
// hard chine and the sheer, the flat bottom (shiki), inner offsets, deck heights and the layout of
// the open wells, canopy, engine box and stern deck.
import { Vector3 } from 'three/webgpu';
import { HULL, bodyAt, bottomHalfAt, halfBeamAt, halfWidthAt, sheerAt, stationAt, stationZ } from '../hullSpec';

/** side planks per side, chine to sheer (shita-, naka-, uwa-tana) */
export const NSTRAKE = 3;
/** side plank thickness */
export const PLANK_T = 0.03;
/** bottom plank thickness */
export const BOTTOM_T = 0.04;

export const LAYOUT = {
  /** small planked bow deck (omote) where the lantern pole and bow bitt stand */
  bowDeck: [-3.3, -2.45] as [number, number],
  /** woven canopy over the midsection */
  canopy: [-1.2, 1.85] as [number, number],
  /** engine box in the aft well */
  engine: [2.12, 2.66] as [number, number],
  /** stern deck the helmsman stands on */
  sternDeck: [2.72, HULL.sternZ] as [number, number],
  /** top of the floorboards on the bottom frames */
  floorY: -0.058,
  /** top of the tatami under the canopy */
  tatamiY: 0.0,
  /** funabari crossbeams (their ends pass through the planking) */
  beams: [-2.45, -1.2, -0.15, 0.85, 1.85, 2.72],
  /** gunwale rail: height above the sheer, width */
  railH: 0.032,
  railW: 0.062,
};

export { HULL, bodyAt, bottomHalfAt, halfBeamAt, halfWidthAt, sheerAt, stationAt, stationZ };

/** point on the (starboard) side planking: s station, t 0 at the chine .. 1 at the sheer */
export function sidePos(s: number, t: number, out = new Vector3()) {
  const yb = bodyAt(s), top = sheerAt(s);
  const y = yb + (top - yb) * t;
  return out.set(halfWidthAt(s, y + (t <= 0 ? 1e-6 : 0)), y, stationZ(s));
}

/** outward normal of the side planking at (s, t), from the continuous surface */
export function sideNormal(s: number, t: number, out = new Vector3()) {
  const e = 1.5e-3, et = 0.01;
  const a = sidePos(Math.max(0, s - e), t), b = sidePos(Math.min(1, s + e), t);
  const c = sidePos(s, Math.max(0, t - et)), d = sidePos(s, Math.min(1, t + et));
  const ds = b.sub(a), dt = d.sub(c);
  out.crossVectors(dt, ds).normalize();
  if (out.x < 0) out.negate();
  return out;
}

/** point on the flat bottom: q -1 (port chine) .. 1 (starboard chine) */
export function bottomPos(s: number, q: number, out = new Vector3()) {
  return out.set(q * bottomHalfAt(s), bodyAt(s), stationZ(s));
}

/** outward (downward) normal of the bottom, following the rocker */
export function bottomNormal(s: number, out = new Vector3()) {
  const e = 1.5e-3;
  const s0 = Math.max(0, s - e), s1 = Math.min(1, s + e);
  const dy = bodyAt(s1) - bodyAt(s0), dz = stationZ(s1) - stationZ(s0);
  return out.set(0, -dz, dy).normalize();
}

/** horizontal half-width of the inner face of the planking at height y */
export function innerHalfWidth(s: number, y: number) {
  const yb = bodyAt(s);
  const yy = Math.max(y, yb + 0.002);
  const x0 = halfWidthAt(s, yy), x1 = halfWidthAt(s, yy + 0.02);
  const slope = (x1 - x0) / 0.02;
  return x0 - PLANK_T * Math.sqrt(1 + slope * slope);
}

/** deck surface height (bow and stern decks sit just under the rail) */
export function deckY(z: number) {
  return sheerAt(stationAt(z)) - 0.004;
}

/** top of the gunwale rail */
export function railTop(z: number) {
  return sheerAt(stationAt(z)) + LAYOUT.railH;
}
