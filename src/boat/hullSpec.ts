// shared description of the player's boat: a traditional japanese river boat (wasen) with a flat
// bottom (shiki), flared hard-chine side planks (tana), a long raked bow (misaki) and a small
// transom, fitted with a quiet inboard and a skeg. the model (src/boat/model) is lofted from these
// functions; physics derives buoyancy, collider and mass properties from them; the water hull mask
// uses the tsl port in src/boat/model/hullNodes.ts. change dimensions here, not in any consumer.
//
// local frame: origin at midships on the centerline at the design waterline.
// bow points to -z, starboard (right) is +x, up is +y.
//
// every function is closed form (pow/min/max/select only) so it ports to tsl one to one.
import { Vector3 } from 'three/webgpu';

export const HULL = {
  /** length overall (misaki tip to transom), meters */
  length: 7.5,
  /** max beam at the sheer */
  beam: 1.6,
  /** z of the bow tip and transom */
  bowZ: -3.75,
  sternZ: 3.75,
  /** flat bottom below the design waterline at midships */
  draft: 0.125,
  /** deepest point: skeg shoe under the propeller */
  maxDraft: 0.3,
  /** sheer (gunwale top) height above the waterline: midships, bow tip, transom */
  sheerMid: 0.42,
  sheerBow: 1.0,
  sheerStern: 0.5,
  /** transom half-width at the sheer */
  transomHalf: 0.5,
  /** flat bottom (shiki): no deadrise */
  deadriseDeg: 0,
  /** side plank flare from vertical, midships */
  flareDeg: 17,
  /** half-thickness of the bow post and skeg */
  keelHalf: 0.03,
  /** bottom height at the bow tip (the misaki post) and at the transom */
  bowFoot: 0.86,
  transomFoot: -0.05,
  /** design displacement mass, kg (hull, engine, fuel, helmsman) */
  mass: 750,
  /** center of mass in local coords (over the center of buoyancy, raised by the standing helmsman) */
  com: new Vector3(0, 0.12, 0.65),
};

// station breakpoints (normalized s)
const S_BOW = 0.4; // sheer and plan reach midships values
const S_FOOT = 0.3; // bottom begins sweeping up into the misaki
const S_RUN = 0.72; // bottom begins rising toward the transom
const S_AFT = 0.68; // plan starts narrowing toward the transom
const S_SKEG0 = 0.7; // skeg runs from here...
const S_AP = (3.18 - HULL.bowZ) / (HULL.sternZ - HULL.bowZ); // ...to the propeller aperture

/** station breakpoints, shared with the tsl port */
export const LINES = { S_BOW, S_FOOT, S_RUN, S_AFT, S_SKEG0, S_AP, bulge: 0.018 };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (t: number) => t * t * (3 - 2 * t);

/** normalized station s: 0 at the bow tip, 1 at the transom */
export function stationZ(s: number) {
  return HULL.bowZ + (HULL.sternZ - HULL.bowZ) * s;
}

/** inverse of stationZ */
export function stationAt(z: number) {
  return (z - HULL.bowZ) / (HULL.sternZ - HULL.bowZ);
}

/** sheer height (gunwale top) above waterline at station s */
export function sheerAt(s: number) {
  const mid = HULL.sheerMid;
  if (s < S_BOW) {
    // the misaki: a long graceful rise into the bow tip
    const u = 1 - Math.max(0, s) / S_BOW;
    return mid + (HULL.sheerBow - mid) * Math.pow(u, 2.3);
  }
  if (s <= 0.55) return mid;
  const t = (s - 0.55) / 0.45;
  return mid + (HULL.sheerStern - mid) * t * t;
}

/** half-beam at the sheer at station s (plan-view outline) */
export function halfBeamAt(s: number) {
  const b = HULL.beam / 2, kh = HULL.keelHalf;
  if (s < S_BOW) {
    // sharp, nearly straight entry (~22 deg at the sheer) easing into the parallel body
    const t = Math.max(0, s) / S_BOW;
    return kh + (b - kh) * (1 - Math.pow(1 - t, 1.65));
  }
  if (s <= S_AFT) return b;
  const t = (s - S_AFT) / (1 - S_AFT);
  return b + (HULL.transomHalf - b) * t * t;
}

/** flat-bottom height at station s (rocker, the sweep up into the misaki, rise to the transom) */
export function bodyAt(s: number) {
  const mid = -HULL.draft;
  if (s < S_FOOT) {
    const u = 1 - Math.max(0, s) / S_FOOT;
    return mid + (HULL.bowFoot - mid) * Math.pow(u, 1.7);
  }
  if (s <= S_RUN) return mid;
  const t = clamp01((s - S_RUN) / (1 - S_RUN));
  return mid + (HULL.transomFoot - mid) * smooth(t);
}

/** lowest point of the hull at station s: the bottom, or the skeg aft */
export function keelAt(s: number) {
  const b = bodyAt(s);
  if (s < S_SKEG0) return b;
  if (s < S_AP) {
    // skeg deepens smoothly from nothing to the shoe depth
    const t = (s - S_SKEG0) / (S_AP - S_SKEG0);
    return Math.min(b, b + (-HULL.maxDraft - b) * smooth(Math.min(1, t * 1.6)));
  }
  return -HULL.maxDraft;
}

/** side flare from vertical in degrees: a touch more in the bow */
export function flareAt(s: number) {
  const f = 1 - clamp01(s / 0.3);
  return HULL.flareDeg + 8 * f * f;
}

/** half-width of the flat bottom (chine position) at station s */
export function bottomHalfAt(s: number) {
  const h = Math.max(0, sheerAt(s) - bodyAt(s));
  return Math.max(HULL.keelHalf, halfBeamAt(s) - h * Math.tan((flareAt(s) * Math.PI) / 180));
}

/**
 * hull half-width at station s and height y (y relative to waterline).
 * zero below the hull, keelHalf through the skeg, the chine width at the bottom, then the side
 * planks flaring (with a slight outward bow) to halfBeamAt(s) at the sheer. used by physics for
 * submerged volume and by the water mask; the model is lofted from exactly this function.
 */
export function halfWidthAt(s: number, y: number) {
  const k = keelAt(s);
  if (y < k) return 0;
  const yb = bodyAt(s);
  if (y < yb) return HULL.keelHalf;
  const top = sheerAt(s);
  const h = Math.max(1e-3, top - yb);
  const t = Math.min(1, (y - yb) / h);
  const bw = bottomHalfAt(s), hb = halfBeamAt(s);
  // side planks are bent, not flat: a faint convexity that dies out at the ends
  const bulge = LINES.bulge * Math.min(1, (hb - HULL.keelHalf) / 0.3) * 4 * t * (1 - t);
  return bw + (hb - bw) * t + bulge;
}

/** anchor points in local space, shared by model, physics, camera, gameplay and water fx */
export const ANCHORS = {
  /** helmsman's eyes, standing on the stern deck (~1.58 m above it) */
  helmEye: new Vector3(0, 2.06, 3.02),
  /** tiller pivot at the rudder head (the model exposes a `wheel` proxy that physics rotates) */
  wheel: new Vector3(0, 0.6, 3.55),
  propeller: new Vector3(0, -0.175, 3.32),
  rudder: new Vector3(0, -0.15, 3.56),
  /** where the stem meets the waterline (bow wave origin) */
  bow: new Vector3(0, 0.02, -2.17),
  /** wooden mooring bitts (heads, where lines are made fast) */
  bowCleat: new Vector3(0, 0.72, -2.72),
  sternCleatPort: new Vector3(-0.38, 0.56, 3.3),
  sternCleatStarboard: new Vector3(0.38, 0.56, 3.3),
  midCleatPort: new Vector3(-0.68, 0.57, -1.62),
  midCleatStarboard: new Vector3(0.68, 0.57, -1.62),
  /** on the tatami under the canopy */
  cargo: new Vector3(0, 0.0, 0.35),
  /** follow camera looks at this point */
  cameraTarget: new Vector3(0, 0.95, 0.6),
};
