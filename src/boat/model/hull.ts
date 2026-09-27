// the wasen hull: flat bottom (shiki), three flared side strakes a side (tana), transom, gunwale
// rails, funabari crossbeams whose ends pass through the planking, inner planking, floorboards,
// bow and stern decks, and the skeg. symmetric parts are built on starboard and mirrored.
import { BufferGeometry, Vector3 } from 'three/webgpu';
import { HULL, LINES, bodyAt, halfBeamAt, halfWidthAt, keelAt, sheerAt, stationAt, stationZ } from '../hullSpec';
import { Geo, flatPoly, mirrorX, roundedPoly, roundedPrism, sweep, sweepCaps, withExtra, type Extra, type Frame, type Pt, type PrismFrame } from './geo';
import { LAYOUT, NSTRAKE, PLANK_T, bottomNormal, bottomPos, deckY, innerHalfWidth, sideNormal, sidePos } from './lines';
import type { Parts } from './parts';

export interface HullDetail {
  ns: number;
  nt: number;
  fine: boolean;
}

/** wood attribute: mode (0 timber, 1 strake, 2 planked) + 10 when uv.x runs across the grain */
export const W = (mode: number, a: number, seed: number, trim = 0): Extra => ({ wood: [mode, a, seed, trim] });

/** station distribution: denser toward the bow where the misaki curves */
const stationS = (t: number) => t * t * 0.3 + t * 0.7;

function both(parts: Parts, key: string, g: BufferGeometry, seed2?: number) {
  parts.add(key, g);
  const m = mirrorX(g);
  if (seed2 !== undefined) {
    const w = m.getAttribute('wood');
    if (w) for (let i = 0; i < w.count; i++) w.setZ(i, seed2);
  }
  parts.add(key, m);
}

function girthOf(s: number) {
  let g = 0;
  const a = new Vector3(), b = new Vector3();
  sidePos(s, 0, a);
  for (let k = 1; k <= 12; k++) {
    sidePos(s, k / 12, b);
    g += a.distanceTo(b);
    a.copy(b);
  }
  return g;
}

function sides(parts: Parts, d: HullDetail) {
  const g = new Geo();
  const p = new Vector3(), n = new Vector3();
  for (let i = 0; i <= d.ns; i++) {
    const s = stationS(i / d.ns), girth = girthOf(s);
    for (let j = 0; j <= d.nt; j++) {
      const t = j / d.nt;
      sidePos(s, t, p);
      sideNormal(s, t, n);
      g.vert(p.clone(), n.clone(), p.z, t * NSTRAKE, W(1, girth, 1));
    }
  }
  const cols = d.nt + 1;
  for (let i = 0; i < d.ns; i++) for (let j = 0; j < d.nt; j++) g.quadAuto(i * cols + j, (i + 1) * cols + j, (i + 1) * cols + j + 1, i * cols + j + 1);
  both(parts, 'wood', g.build(false), 2);
}

function bottom(parts: Parts, d: HullDetail) {
  const g = new Geo();
  const p = new Vector3(), n = new Vector3();
  const ns = Math.round(d.ns * 0.7), nq = d.fine ? 10 : 4;
  for (let i = 0; i <= ns; i++) {
    const s = stationS(i / ns);
    bottomNormal(s, n);
    for (let j = 0; j <= nq; j++) {
      bottomPos(s, -1 + (2 * j) / nq, p);
      g.vert(p.clone(), n.clone(), p.z, p.x + 0.6, W(2, 0.4, 5));
    }
  }
  const cols = nq + 1;
  for (let i = 0; i < ns; i++) for (let j = 0; j < nq; j++) g.quadAuto(i * cols + j, (i + 1) * cols + j, (i + 1) * cols + j + 1, i * cols + j + 1);
  parts.add('wood', g.build(false));
}

/** transom: rows across the section at s = 1, horizontal boards */
function transom(parts: Parts) {
  const g = new Geo();
  const z = HULL.sternZ + 0.001, nz = new Vector3(0, 0, 1), p = new Vector3();
  const nr = 12, nc = 10;
  for (let r = 0; r <= nr; r++) {
    sidePos(1, r / nr, p);
    for (let c = 0; c <= nc; c++) {
      const x = -p.x + (2 * p.x * c) / nc;
      g.vert(new Vector3(x, p.y, z), nz, x, p.y, W(12, 0.17, 9));
    }
  }
  for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) g.quadAuto(r * (nc + 1) + c, r * (nc + 1) + c + 1, (r + 1) * (nc + 1) + c + 1, (r + 1) * (nc + 1) + c, nz);
  parts.add('wood', g.build(false));
  // end grain of the bow tip
  const s0 = 0, yb = bodyAt(s0), top = sheerAt(s0), kh = HULL.keelHalf;
  parts.add('wood', flatPoly([[-kh, yb], [kh, yb], [kh, top], [-kh, top]], { origin: new Vector3(0, 0, HULL.bowZ - 0.001), ax: new Vector3(1, 0, 0), ay: new Vector3(0, 1, 0), n: new Vector3(0, 0, -1) }, 0, W(0, 0, 3)));
}

/** gunwale rail swept along the sheer (capped), and across the transom */
function rails(parts: Parts, d: HullDetail) {
  const { railH, railW } = LAYOUT;
  const prof: Pt[] = roundedPoly([[-railW + 0.013, -0.014], [0.013, -0.014], [0.013, railH], [-railW + 0.013, railH]], [0.004, 0.006, 0.01, 0.01], 3);
  const frames: Frame[] = [];
  const n = Math.round(d.ns * 0.8);
  for (let i = 0; i <= n; i++) {
    const s = 0.004 + 0.998 * stationS(i / n);
    const p = new Vector3(halfBeamAt(Math.min(1, s)), sheerAt(Math.min(1, s)), stationZ(s));
    frames.push({ p, a: new Vector3(), b: new Vector3() });
  }
  for (let i = 0; i < frames.length; i++) {
    const t = new Vector3().subVectors(frames[Math.min(frames.length - 1, i + 1)].p, frames[Math.max(0, i - 1)].p).normalize();
    const a = new Vector3(t.z, 0, -t.x).normalize();
    if (a.x < 0) a.negate();
    const b = new Vector3().crossVectors(t, a).normalize();
    frames[i].a.copy(a);
    frames[i].b.copy(b);
  }
  const ex = W(10, 0, 13, 1);
  // frames: a outward, b up, t aft; a x b = t on starboard, so the ccw profile faces out
  const rail = sweep(frames, prof, { closedProfile: true, extra: ex }).build(false);
  both(parts, 'wood', rail);
  for (const c of sweepCaps(frames, prof, ex)) both(parts, 'wood', c);
  // transom rail
  const hb = halfBeamAt(1) + 0.01;
  const tf: Frame[] = [];
  // walk -x so (a = +z out, b = +y) is right-handed with the path, like the side rails
  for (let k = 0; k <= 8; k++) {
    const x = hb - (2 * hb * k) / 8;
    tf.push({ p: new Vector3(x, sheerAt(1), HULL.sternZ), a: new Vector3(0, 0, 1), b: new Vector3(0, 1, 0) });
  }
  parts.add('wood', sweep(tf, prof, { closedProfile: true, extra: ex }).build(false));
  for (const c of sweepCaps(tf, prof, ex)) parts.add('wood', c);
}

/** funabari: crossbeams at the sheer whose squared ends stand proud of the planking */
function beams(parts: Parts) {
  for (const zb of LAYOUT.beams) {
    const s = stationAt(zb);
    const top = sheerAt(s) - 0.012, bot = top - 0.078;
    const X = halfWidthAt(s, (top + bot) / 2) + 0.028;
    const frame: PrismFrame = { origin: new Vector3(0, 0, 0), ax: new Vector3(0, 0, 1), ay: new Vector3(0, 1, 0), n: new Vector3(1, 0, 0) };
    const out = roundedPoly([[zb - 0.036, bot], [zb + 0.036, bot], [zb + 0.036, top], [zb - 0.036, top]], 0.008, 2);
    const b = roundedPrism(out, 0, X, 0.006, { frame, roundSegs: 3, rings: 1 });
    both(parts, 'wood', withExtra(b.side, W(10, 0, 30 + zb, 1)));
    both(parts, 'wood', withExtra(b.top, W(0, 0, 31 + zb, 1)));
  }
}

/** inner face of the planking between the floor and the sheer, along the open wells */
function innerSides(parts: Parts, d: HullDetail) {
  const g = new Geo();
  const p = new Vector3(), n = new Vector3();
  const z0 = LAYOUT.bowDeck[1] - 0.05, z1 = LAYOUT.sternDeck[0] + 0.05;
  const ns = Math.round(d.ns * 0.55), nt = Math.max(6, Math.round(d.nt * 0.6));
  for (let i = 0; i <= ns; i++) {
    const z = z0 + ((z1 - z0) * i) / ns, s = stationAt(z);
    const yb = bodyAt(s), top = sheerAt(s);
    const t0 = Math.max(0, (LAYOUT.floorY - 0.025 - yb) / (top - yb));
    const girth = girthOf(s);
    for (let j = 0; j <= nt; j++) {
      const t = t0 + ((1 - t0) * j) / nt;
      sidePos(s, t, p);
      sideNormal(s, t, n);
      const q = p.clone().addScaledVector(n, -PLANK_T);
      g.vert(q, n.clone().negate(), q.z, t * NSTRAKE, W(1, girth, 7));
    }
  }
  const cols = nt + 1;
  for (let i = 0; i < ns; i++) for (let j = 0; j < nt; j++) g.quadAuto(i * cols + j, (i + 1) * cols + j, (i + 1) * cols + j + 1, i * cols + j + 1);
  both(parts, 'wood', g.build(false), 8);
}

/** a horizontal-ish planked surface bounded by the inner planking: floor, decks */
function planking(parts: Parts, z0: number, z1: number, yAt: (z: number) => number, pw: number, seed: number, athwart: boolean, nz: number, nx: number) {
  const g = new Geo();
  const up = new Vector3(0, 1, 0);
  for (let i = 0; i <= nz; i++) {
    const z = z0 + ((z1 - z0) * i) / nz, s = stationAt(z), y = yAt(z);
    const X = Math.max(0.002, innerHalfWidth(s, y) + 0.004);
    for (let j = 0; j <= nx; j++) {
      const x = -X + (2 * X * j) / nx;
      // athwart boards: grain across the boat (uv.x = x), seams along z
      g.vert(new Vector3(x, y, z), null, athwart ? x : z, athwart ? z : x, W(2, pw, seed));
    }
  }
  for (let i = 0; i < nz; i++) for (let j = 0; j < nx; j++) g.quadAuto(i * (nx + 1) + j, (i + 1) * (nx + 1) + j, (i + 1) * (nx + 1) + j + 1, i * (nx + 1) + j + 1, up);
  parts.add('wood', g.build(true));
}

/** vertical board face closing a deck edge down to the floor */
function deckFront(parts: Parts, z: number, face: number, seed: number) {
  const s = stationAt(z), yTop = deckY(z), y0 = LAYOUT.floorY - 0.01;
  const g = new Geo();
  const nrm = new Vector3(0, 0, face);
  const nr = 6, nc = 8;
  for (let r = 0; r <= nr; r++) {
    const y = y0 + ((yTop - y0) * r) / nr;
    const X = innerHalfWidth(s, y) + 0.004;
    for (let c = 0; c <= nc; c++) {
      const x = -X + (2 * X * c) / nc;
      g.vert(new Vector3(x, y, z), nrm, y, x, W(2, 0.12, seed));
    }
  }
  for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) g.quadAuto(r * (nc + 1) + c, r * (nc + 1) + c + 1, (r + 1) * (nc + 1) + c + 1, (r + 1) * (nc + 1) + c, nrm);
  parts.add('wood', g.build(false));
}

/** skeg: a thin fin under the run, ending at the propeller aperture */
function skeg(parts: Parts) {
  const out: Pt[] = [];
  const s0 = LINES.S_SKEG0, s1 = LINES.S_AP;
  for (let k = 0; k <= 24; k++) {
    const s = s0 + ((s1 - s0) * k) / 24;
    out.push([stationZ(s), keelAt(s) - 0.002]);
  }
  for (let k = 24; k >= 0; k--) {
    const s = s0 + ((s1 - s0) * k) / 24;
    out.push([stationZ(s), bodyAt(s) + 0.03]);
  }
  const kh = HULL.keelHalf;
  const frame: PrismFrame = { origin: new Vector3(), ax: new Vector3(0, 0, 1), ay: new Vector3(0, 1, 0), n: new Vector3(1, 0, 0) };
  const b = roundedPrism(out, 0, kh, 0.01, { frame, roundSegs: 3, rings: 1 });
  both(parts, 'wood', withExtra(b.side, W(0, 0, 41)));
  both(parts, 'wood', withExtra(b.top, W(0, 0, 42)));
}

export function buildHull(parts: Parts, d: HullDetail) {
  sides(parts, d);
  bottom(parts, d);
  transom(parts);
  rails(parts, d);
  beams(parts);
  innerSides(parts, d);
  const [bz0, bz1] = LAYOUT.bowDeck, [sz0, sz1] = LAYOUT.sternDeck;
  planking(parts, bz1 - 0.02, LAYOUT.sternDeck[0] + 0.02, () => LAYOUT.floorY, 0.15, 21, true, d.fine ? 50 : 20, d.fine ? 10 : 6);
  planking(parts, HULL.bowZ + 0.025, bz1, deckY, 0.095, 23, false, d.fine ? 30 : 14, d.fine ? 8 : 4);
  planking(parts, sz0, sz1 - 0.004, deckY, 0.13, 25, true, d.fine ? 16 : 8, d.fine ? 10 : 6);
  deckFront(parts, bz1 + 0.001, 1, 27);
  deckFront(parts, sz0 - 0.001, -1, 28);
  skeg(parts);
  void bz0;
}
