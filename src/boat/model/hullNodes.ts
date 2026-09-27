// tsl port of src/boat/hullSpec.ts for gpu consumers (the water hull mask). same formulas,
// branch for branch, written against a small ops table so the identical code can also run with
// numeric ops to check parity against hullSpec (see test/scripts/boatmodel-parity.mjs).
//
// usage (water):
//   import { hullLines } from '../boat/model/hullNodes';
//   const hull = hullLines();
//   const inside = hull.inside(localPos, 0.015); // bool node: below the gunwale, inside the planking
import { abs, clamp, float, max, min, pow, select, tan } from 'three/tsl';
import { HULL, LINES } from '../hullSpec';

type N = any;

export interface HullOps {
  float(v: number): N;
  pow(a: N, e: number): N;
  max(a: N, b: N | number): N;
  min(a: N, b: N | number): N;
  clamp(a: N, lo: number, hi: number): N;
  select(cond: N, a: N, b: N): N;
  tan(a: N): N;
  abs(a: N): N;
}

const TSL_OPS: HullOps = { float, pow, max, min, clamp, select, tan, abs } as unknown as HullOps;

export function hullLines(o: HullOps = TSL_OPS) {
  const { S_BOW, S_FOOT, S_RUN, S_AFT, S_SKEG0, S_AP } = LINES;
  const kh = HULL.keelHalf, b = HULL.beam / 2, sMid = HULL.sheerMid, dMid = -HULL.draft;
  const one = () => o.float(1);
  const smooth = (t: N) => t.mul(t).mul(o.float(3).sub(t.mul(2)));

  const sheerAt = (s: N): N => {
    const u = one().sub(o.max(s, 0).div(S_BOW));
    const bow = o.pow(o.max(u, 0), 2.3).mul(HULL.sheerBow - sMid).add(sMid);
    const t = s.sub(0.55).div(0.45);
    const aft = t.mul(t).mul(HULL.sheerStern - sMid).add(sMid);
    return o.select(s.lessThan(S_BOW), bow, o.select(s.lessThanEqual(0.55), o.float(sMid), aft));
  };

  const halfBeamAt = (s: N): N => {
    const t = o.max(s, 0).div(S_BOW);
    const fwd = one().sub(o.pow(o.max(one().sub(t), 0), 1.65)).mul(b - kh).add(kh);
    const ta = s.sub(S_AFT).div(1 - S_AFT);
    const aft = ta.mul(ta).mul(HULL.transomHalf - b).add(b);
    return o.select(s.lessThan(S_BOW), fwd, o.select(s.lessThanEqual(S_AFT), o.float(b), aft));
  };

  const bodyAt = (s: N): N => {
    const u = one().sub(o.max(s, 0).div(S_FOOT));
    const fwd = o.pow(o.max(u, 0), 1.7).mul(HULL.bowFoot - dMid).add(dMid);
    const t = o.clamp(s.sub(S_RUN).div(1 - S_RUN), 0, 1);
    const aft = smooth(t).mul(HULL.transomFoot - dMid).add(dMid);
    return o.select(s.lessThan(S_FOOT), fwd, o.select(s.lessThanEqual(S_RUN), o.float(dMid), aft));
  };

  const keelAt = (s: N): N => {
    const bb = bodyAt(s);
    const t = o.clamp(s.sub(S_SKEG0).div(S_AP - S_SKEG0).mul(1.6), 0, 1);
    const skeg = o.min(bb, bb.add(o.float(-HULL.maxDraft).sub(bb).mul(smooth(t))));
    return o.select(s.lessThan(S_SKEG0), bb, o.select(s.lessThan(S_AP), skeg, o.float(-HULL.maxDraft)));
  };

  const flareRad = (s: N): N => {
    const f = one().sub(o.clamp(s.div(0.3), 0, 1));
    return f.mul(f).mul(8).add(HULL.flareDeg).mul(Math.PI / 180);
  };

  const bottomHalfAt = (s: N): N => {
    const h = o.max(sheerAt(s).sub(bodyAt(s)), 0);
    return o.max(o.float(kh), halfBeamAt(s).sub(h.mul(o.tan(flareRad(s)))));
  };

  const halfWidthAt = (s: N, y: N): N => {
    const k = keelAt(s), yb = bodyAt(s), top = sheerAt(s);
    const h = o.max(top.sub(yb), 1e-3);
    const t = o.min(y.sub(yb).div(h), 1);
    const bw = bottomHalfAt(s), hb = halfBeamAt(s);
    const bulge = o.min(hb.sub(kh).div(0.3), 1).mul(t.mul(one().sub(t))).mul(4 * LINES.bulge);
    const side = hb.sub(bw).mul(t).add(bw).add(bulge);
    return o.select(y.lessThan(k), o.float(0), o.select(y.lessThan(yb), o.float(kh), side));
  };

  /** normalized station of a local z */
  const stationOf = (z: N): N => z.sub(HULL.bowZ).div(HULL.sternZ - HULL.bowZ);

  /** true inside the planking below the gunwale (lp: boat-local position), shrunk by inset meters */
  const inside = (lp: N, inset = 0.015): N => {
    const s = stationOf(lp.z);
    const sc = o.clamp(s, 0, 1);
    return s.greaterThan(0.002).and(s.lessThan(0.998))
      .and(o.abs(lp.x).lessThan(halfWidthAt(sc, lp.y).sub(inset)))
      .and(lp.y.lessThan(sheerAt(sc)));
  };

  return { sheerAt, halfBeamAt, bodyAt, keelAt, bottomHalfAt, halfWidthAt, stationOf, inside };
}
