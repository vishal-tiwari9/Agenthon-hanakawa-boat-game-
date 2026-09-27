// japanese roofs: a parametric surface per side between an eave line and a top line, with a concave
// sweep, corner lift (sori) and corners that project in plan, a thick eave with rafter ends, the
// scalloped line of eave tile ends, and stacked ridge / hip tiles. covers hip (yosemune / hogyo),
// gable (kirizuma), pent (hisashi) and, stacked, hip-and-gable (irimoya) roofs.
import type { Matrix4 } from 'three/webgpu';
import { chamferBox, halfTube, trs, type Part, type RGB } from './geom';
import type { Site } from './builder';

export interface RoofSpec {
  /** eave half extents along local x and z (at the side centers) */
  ex: number;
  ez: number;
  /** top half extents; tz = 0 gives a ridge along x, both 0 a point */
  tx: number;
  tz: number;
  /** eave height at the side centers (local y) and rise to the top */
  y0: number;
  rise: number;
  /** corner lift and plan projection of the corners (hip roofs) */
  lift?: number;
  flare?: number;
  /** eave thickness */
  thick?: number;
  /** which sides: 0 front (+z), 1 right (+x), 2 back (-z), 3 left (-x) */
  sides?: number[];
  /** gable roof: sides run straight to the verges, no hips */
  gable?: boolean;
  /** extra overhang of a gable roof past the walls along x */
  verge?: number;
  ridge?: boolean;
  hips?: boolean;
  /** rafter ends under the eave (skip for small roofs) */
  rafters?: boolean;
  /** tint of the tiles */
  col?: RGB;
  /** soffit / rafter colour (vermilion on temples, dark timber on houses) */
  rafterCol?: RGB;
  rafterMat?: 'paint' | 'lacquer' | 'timber';
  /** concavity of the slope profile (0 straight .. 1 strong sweep) */
  sweep?: number;
  seg?: number;
  /** backstreet roofs: coarser slope mesh, no tile-end discs, flat ridge courses (same silhouette) */
  lite?: boolean;
  /** gable verge rolls and bargeboards (small pent roofs can skip them) */
  verges?: boolean;
}

type V3 = [number, number, number];

interface SideGeo {
  /** point on the tile surface; a in [-1,1] along the side, v in [0,1] eave to top */
  pt(a: number, v: number): V3;
  halfLenE: number;
  halfLenT: number;
  slopeLen: number;
  out: [number, number];
  along: [number, number];
}

function sideFrame(k: number): { out: [number, number]; along: [number, number] } {
  // outward normal and along-direction (counter-clockwise seen from above) in local xz
  const outs: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  const alongs: [number, number][] = [[1, 0], [0, -1], [-1, 0], [0, 1]];
  return { out: outs[k], along: alongs[k] };
}

function makeSide(r: RoofSpec, k: number): SideGeo {
  const { out, along } = sideFrame(k);
  const zSide = k % 2 === 0;
  const verge = r.gable ? r.verge ?? 0.6 : 0;
  const flare = r.gable ? 0 : r.flare ?? 0;
  const lift = r.gable ? 0 : r.lift ?? 0;
  const halfLenE = (zSide ? r.ex : r.ez) + verge;
  const halfDepE = zSide ? r.ez : r.ex;
  const halfLenT = r.gable ? halfLenE : zSide ? r.tx : r.tz;
  const halfDepT = zSide ? r.tz : r.tx;
  const sw = r.sweep ?? 0.6;
  const pt = (a: number, v: number): V3 => {
    const aa = Math.abs(a);
    const le = halfLenE + flare * (r.gable ? 0 : 1);
    const L = le + (halfLenT - le) * v;
    const oe = halfDepE + flare * aa * aa;
    const O = oe + (halfDepT - oe) * v;
    const prof = (1 - sw) * v + sw * v * v;
    const y = r.y0 + r.rise * prof + lift * Math.pow(aa, 2.6) * (1 - v) * (1 - v);
    const ax = a * L;
    return [out[0] * O + along[0] * ax, y, out[1] * O + along[1] * ax];
  };
  const p0 = pt(0, 0), p1 = pt(0, 1);
  const slopeLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  return { pt, halfLenE: halfLenE + flare, halfLenT, slopeLen, out, along };
}

function pushTri(p: Part, a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3, ua: number[], ub: number[], uc: number[]) {
  p.pos.push(...a, ...b, ...c);
  p.nor.push(...na, ...nb, ...nc);
  p.uv.push(...ua, ...ub, ...uc);
}

function sub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a: V3, b: V3): V3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a: V3): V3 { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

/** build a roof into the site at matrix m (local frame: x right, z front, y up). returns side geometry */
export function roof(site: Site, m: Matrix4, r: RoofSpec): SideGeo[] {
  const sides = r.sides ?? (r.gable ? [0, 2] : [0, 1, 2, 3]);
  const thick = r.thick ?? 0.3;
  const tiles: Part = { pos: [], nor: [], uv: [] };
  const soffit: Part = { pos: [], nor: [], uv: [] };
  const fascia: Part = { pos: [], nor: [], uv: [] };
  const geos: SideGeo[] = [];
  for (const k of sides) {
    const g = makeSide(r, k);
    geos.push(g);
    const NA = r.lite ? Math.max(4, Math.min(16, Math.round((g.halfLenE * 2) / 1.3))) : Math.max(6, Math.min(40, Math.round((g.halfLenE * 2) / (r.seg ?? 0.55))));
    const NV = r.lite ? 3 : 7;
    const P: V3[][] = [], N: V3[][] = [], U: number[][][] = [];
    for (let j = 0; j <= NV; j++) {
      const v = j / NV;
      const row: V3[] = [], nrow: V3[] = [], urow: number[][] = [];
      for (let i = 0; i <= NA; i++) {
        const a = -1 + (2 * i) / NA;
        const p = g.pt(a, v);
        const e = 1e-3;
        const da = sub(g.pt(Math.min(1, a + e), v), g.pt(Math.max(-1, a - e), v));
        const dv = sub(g.pt(a, Math.min(1, v + e)), g.pt(a, Math.max(0, v - e)));
        let n = norm(cross(dv, da));
        if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
        const L = g.halfLenE + (g.halfLenT - g.halfLenE) * v;
        row.push(p);
        nrow.push(n);
        urow.push([a * L, v * g.slopeLen]);
      }
      P.push(row); N.push(nrow); U.push(urow);
    }
    // winding so tiles face up/out
    for (let j = 0; j < NV; j++) for (let i = 0; i < NA; i++) {
      const a = P[j][i], b = P[j][i + 1], c = P[j + 1][i + 1], d = P[j + 1][i];
      const na = N[j][i], nb = N[j][i + 1], nc = N[j + 1][i + 1], nd = N[j + 1][i];
      const ua = U[j][i], ub = U[j][i + 1], uc = U[j + 1][i + 1], ud = U[j + 1][i];
      const fn = cross(sub(b, a), sub(d, a));
      if (fn[1] >= 0) {
        pushTri(tiles, a, b, c, na, nb, nc, ua, ub, uc);
        pushTri(tiles, a, c, d, na, nc, nd, ua, uc, ud);
      } else {
        pushTri(tiles, a, c, b, na, nc, nb, ua, uc, ub);
        pushTri(tiles, a, d, c, na, nd, nc, ua, ud, uc);
      }
      // underside, dropped by the eave thickness (fading toward the top so it stays inside)
      const dn = (q: V3, v: number): V3 => [q[0], q[1] - thick * (1 - 0.4 * v), q[2]];
      const vj = j / NV, vj1 = (j + 1) / NV;
      const A = dn(a, vj), B = dn(b, vj), C = dn(c, vj1), D = dn(d, vj1);
      const down: V3 = [0, -1, 0];
      const fu = [ua[0], ua[1]], fb = [ub[0], ub[1]], fc = [uc[0], uc[1]], fd = [ud[0], ud[1]];
      if (fn[1] >= 0) {
        pushTri(soffit, A, C, B, down, down, down, fu, fc, fb);
        pushTri(soffit, A, D, C, down, down, down, fu, fd, fc);
      } else {
        pushTri(soffit, A, B, C, down, down, down, fu, fb, fc);
        pushTri(soffit, A, C, D, down, down, down, fu, fc, fd);
      }
    }
    // fascia along the eave (v = 0), facing out
    for (let i = 0; i < NA; i++) {
      const a = P[0][i], b = P[0][i + 1];
      const A: V3 = [a[0], a[1] - thick, a[2]], B: V3 = [b[0], b[1] - thick, b[2]];
      const o: V3 = norm([g.out[0], 0.15, g.out[1]]);
      const t = sub(b, a);
      const fo = cross(t, [0, -1, 0]);
      const ua = [U[0][i][0], 0], ub = [U[0][i + 1][0], 0], uA = [U[0][i][0], thick], uB = [U[0][i + 1][0], thick];
      if (fo[0] * g.out[0] + fo[2] * g.out[1] >= 0) {
        pushTri(fascia, a, A, B, o, o, o, ua, uA, uB);
        pushTri(fascia, a, B, b, o, o, o, ua, uB, ub);
      } else {
        pushTri(fascia, a, B, A, o, o, o, ua, uB, uA);
        pushTri(fascia, a, b, B, o, o, o, ua, ub, uB);
      }
    }
    // eave tile ends: a semicircular end on every roll, and a lip along the eave
    const rowP = 0.27;
    const nEnds = r.lite ? -1 : Math.floor((g.halfLenE * 2) / rowP);
    const endCol: RGB = r.col ?? [1, 1, 1];
    for (let e = 0; e <= nEnds; e++) {
      const a = -1 + (e + 0.5) * (2 / (nEnds + 1));
      const p = g.pt(a, 0);
      const q = g.pt(a, 0.02);
      const slope = Math.atan2(q[1] - p[1], Math.hypot(q[0] - p[0], q[2] - p[2]));
      const yaw = Math.atan2(g.out[0], g.out[1]);
      // tile ends are too small for the mirror or the shadow maps
      site.add('kawara', endDisc(), m.clone().multiply(trs(p[0] + g.out[0] * 0.02, p[1] - 0.02, p[2] + g.out[1] * 0.02, yaw, slope)), { col: endCol }, true);
    }
    // rafter ends below the eave
    if (r.rafters !== false) {
      const nr = Math.floor((g.halfLenE * 2) / 0.28);
      for (let e = 0; e <= nr; e++) {
        const a = -0.97 + e * (1.94 / nr);
        const p = g.pt(a, 0.05);
        const yaw = Math.atan2(g.out[0], g.out[1]);
        site.add(r.rafterMat ?? 'timber', chamferBox(0.09, 0.1, 0.5, 0, 'z'), m.clone().multiply(trs(p[0] - g.out[0] * 0.15, p[1] - thick - 0.03, p[2] - g.out[1] * 0.15, yaw)), { col: r.rafterCol ?? [1, 1, 1], v: [0, 0, 0, 0.2] }, true);
      }
    }
  }
  site.add('kawara', tiles, m, { col: r.col ?? [1, 1, 1] });
  site.add(r.rafterMat ?? 'timber', soffit, m, { col: r.rafterCol ?? [0.8, 0.8, 0.8], v: [0, 0, 0, 0.2] });
  site.add('timber', fascia, m, { col: [0.7, 0.7, 0.7] });

  const ridgeCol: RGB = r.col ?? [1, 1, 1];
  // hips: from each eave corner up to the top corner
  if (!r.gable && r.hips !== false) {
    for (const g of geos) {
      const pts: V3[] = [];
      const nh = r.lite ? 3 : 8;
      for (let j = 0; j <= nh; j++) pts.push(g.pt(1, j / nh));
      ridgeLine(site, m, pts, 0.24, 0.22, ridgeCol, true, false, r.lite);
    }
  }
  // top ridge
  if (r.ridge !== false && r.tz === 0 && r.tx > 0.05 && geos.length) {
    const g = geos.find((q, i) => (r.sides ?? [0])[i] === 0) ?? geos[0];
    const a = g.pt(-1, 1), b = g.pt(1, 1);
    ridgeLine(site, m, [a, b], 0.34, 0.42, ridgeCol, false, true, r.lite);
  }
  // gable verges: a roll of tiles and a bargeboard down each verge
  if (r.gable && r.verges !== false) {
    for (const g of geos) {
      for (const aa of [-1, 1]) {
        const pts: V3[] = [];
        const nv = r.lite ? 2 : 4;
        for (let j = 0; j <= nv; j++) pts.push(g.pt(aa, j / nv));
        ridgeLine(site, m, pts, 0.2, 0.14, ridgeCol, false, false, r.lite);
        if (r.lite) continue;
        for (let j = 0; j < nv; j++) {
          const p = pts[j], q = pts[j + 1];
          const len = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
          const yaw = Math.atan2(q[0] - p[0], q[2] - p[2]);
          const pitch = -Math.asin((q[1] - p[1]) / len);
          site.add('timber', chamferBox(0.05, 0.3, len + 0.02, 0, 'z'), m.clone().multiply(trs((p[0] + q[0]) / 2 + aa * 0.04 * Math.abs(g.along[0]), (p[1] + q[1]) / 2 - thick * 0.75, (p[2] + q[2]) / 2 + aa * 0.04 * Math.abs(g.along[1]), yaw, pitch)), { col: [0.8, 0.8, 0.8] });
        }
      }
    }
  }
  return geos;
}

let _disc: Part | null = null;
/** the round end of an eave tile (tomoe-gawara), facing +z */
function endDisc(): Part {
  if (_disc) return _disc;
  const p: Part = { pos: [], nor: [], uv: [] };
  const r = 0.085, seg = 5;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI, a1 = ((i + 1) / seg) * Math.PI;
    const c: V3 = [0, 0.02, 0.02];
    const A: V3 = [Math.cos(a0) * r, Math.sin(a0) * r + 0.02, 0.02], B: V3 = [Math.cos(a1) * r, Math.sin(a1) * r + 0.02, 0.02];
    pushTri(p, c, A, B, [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0], [0.01, 0], [0, 0.01]);
    // short barrel behind the disc
    const A2: V3 = [A[0], A[1], -0.2], B2: V3 = [B[0], B[1], -0.2];
    const na: V3 = [Math.cos(a0), Math.sin(a0), 0], nb: V3 = [Math.cos(a1), Math.sin(a1), 0];
    pushTri(p, A, A2, B2, na, na, nb, [0, 0], [0, 0.01], [0.01, 0.01]);
    pushTri(p, A, B2, B, na, nb, nb, [0, 0], [0.01, 0.01], [0.01, 0]);
  }
  _disc = p;
  return p;
}

/**
 * stacked ridge tiles along a polyline: layered noshi courses under a round cap. `down` lets hips
 * sit on the slope; `oni` adds ogre-tile end blocks on a top ridge.
 */
export function ridgeLine(site: Site, m: Matrix4, pts: V3[], w: number, h: number, col: RGB, down: boolean, oni = false, lite = false) {
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    if (len < 1e-3) continue;
    const yaw = Math.atan2(q[0] - p[0], q[2] - p[2]);
    const pitch = -Math.asin((q[1] - p[1]) / len);
    const cx = (p[0] + q[0]) / 2, cy = (p[1] + q[1]) / 2, cz = (p[2] + q[2]) / 2;
    const base = m.clone().multiply(trs(cx, cy - (down ? 0.02 : 0), cz, yaw, pitch));
    const layers = Math.max(2, Math.round(h / 0.08));
    if (lite) {
      // one block for the stacked noshi courses
      site.add('dark', chamferBox(w * 0.9, layers * 0.075, len + 0.03, 0, 'z'), base.clone().multiply(trs(0, 0.04 + layers * 0.0375, 0)), { col: [col[0] * 0.07, col[1] * 0.075, col[2] * 0.085] });
    } else {
      for (let l = 0; l < layers; l++) {
        const lw = w * (1 - l * 0.06);
        site.add('dark', chamferBox(lw, 0.075, len + 0.03, 0, 'z'), base.clone().multiply(trs(0, 0.04 + l * 0.075, 0)), { col: [col[0] * 0.07, col[1] * 0.075, col[2] * 0.085] });
      }
    }
    // the cap's underside and end rims sit hidden on the courses and against the next segment
    if (!lite) site.add('dark', halfTube(w * 0.36, len + 0.03, 6, 0.03, 0, true), base.clone().multiply(trs(0, 0.04 + layers * 0.075 - 0.01, -len / 2 - 0.015)), { col: [col[0] * 0.075, col[1] * 0.08, col[2] * 0.09] });
  }
  if (oni && pts.length >= 2) {
    for (const [p, q] of [[pts[0], pts[1]], [pts[pts.length - 1], pts[pts.length - 2]]] as const) {
      const yaw = Math.atan2(p[0] - q[0], p[2] - q[2]);
      const hh = h + 0.35;
      site.add('dark', chamferBox(w + 0.2, hh, 0.14, lite ? 0 : 0.04), m.clone().multiply(trs(p[0], p[1] + hh / 2, p[2], yaw)), { col: [col[0] * 0.07, col[1] * 0.075, col[2] * 0.085] });
      site.add('dark', chamferBox(w + 0.34, 0.12, 0.2, lite ? 0 : 0.04), m.clone().multiply(trs(p[0], p[1] + hh, p[2], yaw)), { col: [col[0] * 0.07, col[1] * 0.075, col[2] * 0.085] });
    }
  }
}

/** vertical triangle filling a gable end between the walls and the roof underside (local xz frame) */
export function gableTri(half: number, yBase: number, rise: number, depth: number): Part {
  const p: Part = { pos: [], nor: [], uv: [] };
  const A: V3 = [-half, yBase, 0], B: V3 = [half, yBase, 0], C: V3 = [0, yBase + rise, 0];
  const Ai: V3 = [-half, yBase, -depth], Bi: V3 = [half, yBase, -depth], Ci: V3 = [0, yBase + rise, -depth];
  const f: V3 = [0, 0, 1], b: V3 = [0, 0, -1];
  pushTri(p, A, B, C, f, f, f, [A[0], A[1]], [B[0], B[1]], [C[0], C[1]]);
  pushTri(p, Ai, Ci, Bi, b, b, b, [Ai[0], Ai[1]], [Ci[0], Ci[1]], [Bi[0], Bi[1]]);
  return p;
}
