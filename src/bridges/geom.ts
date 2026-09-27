// geometry accumulation for bridges and river works. every part is written straight into world-space
// flat arrays (position, normal, uv in meters, aTint linear tint, aVar misc) so a whole site merges
// into one draw call per material. parts are described in a local frame (set with at()), uvs are
// projected per face in that frame so texel density stays constant however a part is rotated.
//
// aVar: x = wear (lacquer chips, timber silvering), y = per-part random, z = moss, w = edge (chamfer faces)
import { BufferAttribute, BufferGeometry, Matrix3, Matrix4, ShapeUtils, Vector2, Vector3 } from 'three/webgpu';

export type V3 = [number, number, number];
export type Axis = 0 | 1 | 2;

export interface PartOpts {
  tint?: V3;
  wear?: number;
  seed?: number;
  moss?: number;
  /** uv offset in meters (decorrelates repeated parts) */
  uvo?: [number, number];
  /** local axis the texture v (grain) follows */
  grain?: Axis;
}

export class Geo {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  tint: number[] = [];
  vv: number[] = [];
  private m = new Matrix4();
  private nm = new Matrix3();
  private t: V3 = [1, 1, 1];
  private v = [0, 0, 0, 0];
  private uo: [number, number] = [0, 0];
  grain: Axis = 1;

  get count() {
    return this.pos.length / 3;
  }

  /** set the local frame for the following parts */
  at(m: Matrix4) {
    this.m.copy(m);
    this.nm.getNormalMatrix(m);
    return this;
  }

  /** per-part attributes for the following parts */
  part(o: PartOpts = {}) {
    this.t = o.tint ?? [1, 1, 1];
    this.v[0] = o.wear ?? 0;
    this.v[1] = o.seed ?? Math.random();
    this.v[2] = o.moss ?? 0;
    this.uo = o.uvo ?? [this.v[1] * 37.3, this.v[1] * 11.7];
    this.grain = o.grain ?? 1;
    return this;
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, edge: number) {
    // the frame transform inline (this runs for every vertex of every wall stone)
    const e = this.m.elements, q = this.nm.elements;
    this.pos.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
    const a = q[0] * nx + q[3] * ny + q[6] * nz, b = q[1] * nx + q[4] * ny + q[7] * nz, c = q[2] * nx + q[5] * ny + q[8] * nz;
    const l = 1 / (Math.sqrt(a * a + b * b + c * c) || 1);
    this.nor.push(a * l, b * l, c * l);
    this.uv.push(u + this.uo[0], v + this.uo[1]);
    this.tint.push(this.t[0], this.t[1], this.t[2]);
    this.vv.push(this.v[0], this.v[1], this.v[2], edge);
  }

  /** convex planar polygon, flat shaded, uv projected on the dominant axis with the grain preference */
  face(pts: V3[], edge = 0, normal?: V3) {
    let nx: number, ny: number, nz: number;
    if (normal) [nx, ny, nz] = normal;
    else [nx, ny, nz] = polyNormal(pts);
    const uvs = pts.map((p) => projUV(p, nx, ny, nz, this.grain));
    for (let i = 1; i < pts.length - 1; i++) {
      for (const k of [0, i, i + 1]) {
        const p = pts[k];
        this.vert(p[0], p[1], p[2], nx, ny, nz, uvs[k][0], uvs[k][1], edge);
      }
    }
  }

  build(): BufferGeometry | null {
    if (!this.pos.length) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('aTint', new BufferAttribute(new Float32Array(this.tint), 3));
    g.setAttribute('aVar', new BufferAttribute(new Float32Array(this.vv), 4));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    // the js arrays cost ~8x the typed ones and the site keeps its geos: drop them once built
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.tint = [];
    this.vv = [];
    return g;
  }
}

function polyNormal(pts: V3[]): V3 {
  // newell's method: robust for slightly non-planar quads
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

function projUV(p: V3, nx: number, ny: number, nz: number, grain: Axis): [number, number] {
  const an = [Math.abs(nx), Math.abs(ny), Math.abs(nz)];
  const dom = an[0] > an[1] && an[0] > an[2] ? 0 : an[1] >= an[2] ? 1 : 2;
  const va = grain !== dom ? grain : dom === 1 ? 2 : 1;
  const ua = 3 - dom - va;
  return [p[ua], p[va]];
}

// ---- chamfered hexahedron -------------------------------------------------------------------------
// corners indexed x + 2y + 4z over the logical min/max sides. any convex hexahedron works (wedges,
// tapered posts, voussoirs); chamfer faces are flagged as edges so materials can wear them.
const HEX_FACES = [
  [0, 2, 6, 4],
  [1, 3, 7, 5],
  [0, 1, 5, 4],
  [2, 3, 7, 6],
  [0, 1, 3, 2],
  [4, 5, 7, 6],
];
const HEX_EDGES: [number, number, number, number][] = [];
const HEX_CORNERS: number[][] = [];
{
  for (let f = 0; f < 6; f++) {
    for (let g = f + 1; g < 6; g++) {
      const sh = HEX_FACES[f].filter((c) => HEX_FACES[g].includes(c));
      if (sh.length === 2) HEX_EDGES.push([f, g, sh[0], sh[1]]);
    }
  }
  for (let c = 0; c < 8; c++) HEX_CORNERS.push([0, 1, 2, 3, 4, 5].filter((f) => HEX_FACES[f].includes(c)));
}

/** faces: -x, +x, -y, +y, -z, +z */
export const FACE = { nx: 0, px: 1, ny: 2, py: 3, nz: 4, pz: 5 } as const;

function orient(pts: V3[], center: V3): V3[] {
  const n = polyNormal(pts);
  let cx = 0, cy = 0, cz = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; cz += p[2]; }
  cx = cx / pts.length - center[0];
  cy = cy / pts.length - center[1];
  cz = cz / pts.length - center[2];
  return n[0] * cx + n[1] * cy + n[2] * cz < 0 ? pts.slice().reverse() : pts;
}

export function hex(g: Geo, c: V3[], ch = 0, skip = 0) {
  const center: V3 = [0, 0, 0];
  for (const p of c) { center[0] += p[0] / 8; center[1] += p[1] / 8; center[2] += p[2] / 8; }
  if (ch <= 0) {
    for (let f = 0; f < 6; f++) if (!(skip & (1 << f))) g.face(orient(HEX_FACES[f].map((i) => c[i]), center));
    return;
  }
  // inset corner of face f at corner k: move along both face edges meeting at k
  const ins: V3[][] = [];
  for (let f = 0; f < 6; f++) {
    const cyc = HEX_FACES[f];
    ins[f] = [];
    for (let j = 0; j < 4; j++) {
      const k = cyc[j], a = c[cyc[(j + 3) % 4]], b = c[cyc[(j + 1) % 4]], p = c[k];
      const da = Math.hypot(a[0] - p[0], a[1] - p[1], a[2] - p[2]) || 1;
      const db = Math.hypot(b[0] - p[0], b[1] - p[1], b[2] - p[2]) || 1;
      const ca = Math.min(ch, da * 0.45), cb = Math.min(ch, db * 0.45);
      ins[f][k] = [
        p[0] + ((a[0] - p[0]) / da) * ca + ((b[0] - p[0]) / db) * cb,
        p[1] + ((a[1] - p[1]) / da) * ca + ((b[1] - p[1]) / db) * cb,
        p[2] + ((a[2] - p[2]) / da) * ca + ((b[2] - p[2]) / db) * cb,
      ];
    }
  }
  for (let f = 0; f < 6; f++) if (!(skip & (1 << f))) g.face(orient(HEX_FACES[f].map((k) => ins[f][k]), center));
  for (const [f, h, a, b] of HEX_EDGES) {
    if (skip & (1 << f) && skip & (1 << h)) continue;
    g.face(orient([ins[f][a], ins[f][b], ins[h][b], ins[h][a]], center), 1);
  }
  for (let k = 0; k < 8; k++) {
    const fs = HEX_CORNERS[k];
    g.face(orient(fs.map((f) => ins[f][k]), center), 1);
  }
}

/** axis-aligned (in the current frame) box centered at (x, y, z), optionally chamfered */
export function box(g: Geo, x: number, y: number, z: number, sx: number, sy: number, sz: number, ch = 0, skip = 0) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const c: V3[] = [];
  for (let i = 0; i < 8; i++) c.push([x + (i & 1 ? hx : -hx), y + (i & 2 ? hy : -hy), z + (i & 4 ? hz : -hz)]);
  hex(g, c, ch, skip);
}

/**
 * a straight member between two points with a rectangular section (w across `side`, h across the
 * third axis), chamfered. grain follows the member.
 */
export function beam(g: Geo, a: V3, b: V3, w: number, h: number, ch = 0, side: V3 = [0, 1, 0], skip = 0) {
  const d = new Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  if (len < 1e-5) return;
  d.divideScalar(len);
  let s = new Vector3(...side);
  s.addScaledVector(d, -s.dot(d));
  if (s.lengthSq() < 1e-6) s = Math.abs(d.y) < 0.9 ? new Vector3(0, 1, 0).cross(d) : new Vector3(1, 0, 0).cross(d);
  s.normalize();
  const u = new Vector3().crossVectors(d, s).normalize();
  const c: V3[] = [];
  for (let i = 0; i < 8; i++) {
    const t = i & 4 ? len : 0;
    const ss = (i & 1 ? 0.5 : -0.5) * w, uu = (i & 2 ? 0.5 : -0.5) * h;
    c.push([a[0] + d.x * t + s.x * ss + u.x * uu, a[1] + d.y * t + s.y * ss + u.y * uu, a[2] + d.z * t + s.z * ss + u.z * uu]);
  }
  // grain along the member: pick the local axis closest to d
  const ad = [Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)];
  const prev = g.grain;
  g.grain = (ad[0] > ad[1] && ad[0] > ad[2] ? 0 : ad[1] >= ad[2] ? 1 : 2) as Axis;
  hex(g, c, ch, skip);
  g.grain = prev;
}

// ---- round things --------------------------------------------------------------------------------

/** frustum along local y from y0 to y1, smooth sides; uv u around (meters), v along */
export function cyl(g: Geo, x: number, z: number, y0: number, y1: number, r0: number, r1: number, seg = 12, caps: 0 | 1 | 2 | 3 = 2, lean: [number, number] = [0, 0]) {
  const slope = (r0 - r1) / Math.max(1e-4, y1 - y0);
  const off = (Math.random() * 7) | 0;
  for (let i = 0; i < seg; i++) {
    const a0 = ((i + off) / seg) * Math.PI * 2, a1 = ((i + 1 + off) / seg) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const u0 = (i / seg) * Math.PI * 2 * (r0 + r1) * 0.5, u1 = ((i + 1) / seg) * Math.PI * 2 * (r0 + r1) * 0.5;
    const nl = Math.hypot(1, slope);
    const q = (c: number, s: number, y: number, r: number, u: number, v: number) => {
      const t = (y - y0) / Math.max(1e-4, y1 - y0);
      g.vert(x + c * r + lean[0] * t, y, z + s * r + lean[1] * t, c / nl, slope / nl, s / nl, u, v, 0);
    };
    q(c0, s0, y0, r0, u0, y0); q(c1, s1, y1, r1, u1, y1); q(c1, s1, y0, r0, u1, y0);
    q(c0, s0, y0, r0, u0, y0); q(c0, s0, y1, r1, u0, y1); q(c1, s1, y1, r1, u1, y1);
    if (caps & 2) {
      g.vert(x + lean[0], y1, z + lean[1], 0, 1, 0, 0, 0, 1);
      g.vert(x + c1 * r1 + lean[0], y1, z + s1 * r1 + lean[1], 0, 1, 0, c1 * r1, s1 * r1, 1);
      g.vert(x + c0 * r1 + lean[0], y1, z + s0 * r1 + lean[1], 0, 1, 0, c0 * r1, s0 * r1, 1);
    }
    if (caps & 1) {
      g.vert(x, y0, z, 0, -1, 0, 0, 0, 1);
      g.vert(x + c0 * r0, y0, z + s0 * r0, 0, -1, 0, c0 * r0, s0 * r0, 1);
      g.vert(x + c1 * r0, y0, z + s1 * r0, 0, -1, 0, c1 * r0, s1 * r0, 1);
    }
  }
}

/** round member between two arbitrary points (braces, poles), no caps */
export function rod(g: Geo, a: V3, b: V3, r: number, seg = 8, r1 = r) {
  const d = new Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  if (len < 1e-5) return;
  d.divideScalar(len);
  const s = Math.abs(d.y) < 0.9 ? new Vector3(0, 1, 0).cross(d).normalize() : new Vector3(1, 0, 0).cross(d).normalize();
  const t = new Vector3().crossVectors(d, s);
  const ring = (i: number) => {
    const an = (i / seg) * Math.PI * 2;
    return new Vector3().addScaledVector(s, Math.cos(an)).addScaledVector(t, Math.sin(an));
  };
  for (let i = 0; i < seg; i++) {
    const n0 = ring(i), n1 = ring(i + 1);
    const u0 = (i / seg) * Math.PI * 2 * r, u1 = ((i + 1) / seg) * Math.PI * 2 * r;
    const P = (n: Vector3, rr: number, at: V3, along: number, u: number) =>
      g.vert(at[0] + n.x * rr, at[1] + n.y * rr, at[2] + n.z * rr, n.x, n.y, n.z, u, along, 0);
    P(n0, r, a, 0, u0); P(n1, r, a, 0, u1); P(n1, r1, b, len, u1);
    P(n0, r, a, 0, u0); P(n1, r1, b, len, u1); P(n0, r1, b, len, u0);
  }
}

/** surface of revolution about local y through (x, z). profile [radius, y] from bottom to top */
export function lathe(g: Geo, x: number, z: number, prof: [number, number][], seg = 16, edge = 0) {
  // smooth profile normals from neighbouring segments
  const nrm: [number, number][] = prof.map((_, i) => {
    const a = prof[Math.max(0, i - 1)], b = prof[Math.min(prof.length - 1, i + 1)];
    const dr = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dr, dy) || 1;
    return [dy / l, -dr / l];
  });
  const vs: number[] = [0];
  for (let i = 1; i < prof.length; i++) vs.push(vs[i - 1] + Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]));
  for (let i = 0; i < prof.length - 1; i++) {
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
      const P = (j: number, an: number, kk: number) => {
        const c = Math.cos(an), s = Math.sin(an);
        const [r, y] = prof[j];
        g.vert(x + c * r, y, z + s * r, c * nrm[j][0], nrm[j][1], s * nrm[j][0], (kk / seg) * 0.6, vs[j], edge);
      };
      P(i, a0, k); P(i + 1, a1, k + 1); P(i, a1, k + 1);
      P(i, a0, k); P(i + 1, a0, k); P(i + 1, a1, k + 1);
    }
  }
}

// ---- swept sections -----------------------------------------------------------------------------

/**
 * rectangular section swept along a polyline. `side` is a fixed local direction the section's width
 * follows (e.g. across a bridge); height is perpendicular to both. smooth along the length.
 */
export function sweep(g: Geo, path: V3[], side: V3, w: number, h: number, caps = true, offset: [number, number] = [0, 0]) {
  const n = path.length;
  if (n < 2) return;
  const S = new Vector3(...side).normalize();
  const rings: { p: Vector3; s: Vector3; u: Vector3; d: number }[] = [];
  let dist = 0;
  for (let i = 0; i < n; i++) {
    const a = new Vector3(...path[Math.max(0, i - 1)]), b = new Vector3(...path[Math.min(n - 1, i + 1)]);
    const t = b.sub(a).normalize();
    const s = S.clone().addScaledVector(t, -S.dot(t)).normalize();
    const u = new Vector3().crossVectors(s, t).normalize();
    // keep the frame right-handed: flip the side rather than the up vector
    if (u.y < 0) { u.negate(); s.negate(); }
    if (i > 0) dist += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]);
    const p = new Vector3(...path[i]).addScaledVector(s, offset[0]).addScaledVector(u, offset[1]);
    rings.push({ p, s, u, d: dist });
  }
  const hw = w / 2, hh = h / 2;
  // faces: +u (top), -u, +s, -s
  const sides: [number, number, number, number, number][] = [
    // [su0, uu0, su1, uu1, normal: 0 top 1 bottom 2 +s 3 -s]
    [-hw, hh, hw, hh, 0],
    [hw, -hh, -hw, -hh, 1],
    [hw, hh, hw, -hh, 2],
    [-hw, -hh, -hw, hh, 3],
  ];
  for (const [s0, u0, s1, u1, k] of sides) {
    const width = Math.hypot(s1 - s0, u1 - u0);
    for (let i = 0; i < n - 1; i++) {
      const A = rings[i], B = rings[i + 1];
      const P = (R: typeof A, ss: number, uu: number, across: number) => {
        const nn = k === 0 ? R.u : k === 1 ? R.u.clone().negate() : k === 2 ? R.s : R.s.clone().negate();
        g.vert(R.p.x + R.s.x * ss + R.u.x * uu, R.p.y + R.s.y * ss + R.u.y * uu, R.p.z + R.s.z * ss + R.u.z * uu, nn.x, nn.y, nn.z, across, R.d, 0);
      };
      P(A, s0, u0, 0); P(A, s1, u1, width); P(B, s1, u1, width);
      P(A, s0, u0, 0); P(B, s1, u1, width); P(B, s0, u0, 0);
    }
  }
  if (caps) {
    for (const [R, sgn] of [[rings[0], -1], [rings[n - 1], 1]] as const) {
      const pts: V3[] = [[-hw, -hh, 0], [hw, -hh, 0], [hw, hh, 0], [-hw, hh, 0]].map(([ss, uu]) => [
        R.p.x + R.s.x * ss + R.u.x * uu, R.p.y + R.s.y * ss + R.u.y * uu, R.p.z + R.s.z * ss + R.u.z * uu,
      ]);
      const t = new Vector3().crossVectors(R.u, R.s).multiplyScalar(-1);
      const nn: V3 = [t.x * sgn, t.y * sgn, t.z * sgn];
      g.face(orientTo(pts, nn), 1, nn);
    }
  }
}

function orientTo(pts: V3[], n: V3): V3[] {
  const m = polyNormal(pts);
  return m[0] * n[0] + m[1] * n[1] + m[2] * n[2] < 0 ? pts.slice().reverse() : pts;
}

// ---- masonry slabs -------------------------------------------------------------------------------

/**
 * a stone cut to an arbitrary outline in the local xy plane: the face at z = zf looks along +z and is
 * inset by `bev` with a chamfer back to the full outline, sides run back `depth`. used for spandrel
 * blocks clipped around arch rings. poly may be concave; it is triangulated with earcut.
 */
export function slab(g: Geo, poly: [number, number][], zf: number, depth: number, bev = 0.03) {
  let pts = dedupe(poly);
  if (pts.length < 3) return;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (Math.abs(area) < 1e-4) return;
  if (area < 0) pts = pts.reverse();
  const n = pts.length;
  // miter inset
  const inset: [number, number][] = pts.map((p, i) => {
    const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
    const e0 = new Vector2(p[0] - a[0], p[1] - a[1]).normalize(), e1 = new Vector2(b[0] - p[0], b[1] - p[1]).normalize();
    // inward normals of a ccw polygon point left of the edge direction
    const n0 = new Vector2(-e0.y, e0.x), n1 = new Vector2(-e1.y, e1.x);
    const m = n0.clone().add(n1);
    const ml = m.length();
    if (ml < 1e-4) return [p[0] + n0.x * bev, p[1] + n0.y * bev];
    m.divideScalar(ml);
    const k = Math.min(bev / Math.max(0.3, m.dot(n0)), bev * 2.5);
    return [p[0] + m.x * k, p[1] + m.y * k];
  });
  const tris = ShapeUtils.triangulateShape(inset.map((p) => new Vector2(p[0], p[1])), []);
  const prev = g.grain;
  g.grain = 1;
  for (const [a, b, c] of tris) {
    const cr = (inset[b][0] - inset[a][0]) * (inset[c][1] - inset[a][1]) - (inset[b][1] - inset[a][1]) * (inset[c][0] - inset[a][0]);
    for (const k of cr >= 0 ? [a, b, c] : [a, c, b]) g.vert(inset[k][0], inset[k][1], zf, 0, 0, 1, inset[k][0], inset[k][1], 0);
  }
  const zb = zf - bev, zk = zf - depth;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // chamfer strip
    g.face([[inset[i][0], inset[i][1], zf], [pts[i][0], pts[i][1], zb], [pts[j][0], pts[j][1], zb], [inset[j][0], inset[j][1], zf]], 1);
    // side
    if (depth > bev) g.face([[pts[i][0], pts[i][1], zb], [pts[i][0], pts[i][1], zk], [pts[j][0], pts[j][1], zk], [pts[j][0], pts[j][1], zb]], 0);
  }
  g.grain = prev;
}

function dedupe(p: [number, number][]) {
  const out: [number, number][] = [];
  for (const q of p) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(l[0] - q[0], l[1] - q[1]) > 0.012) out.push(q);
  }
  while (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 0.012) out.pop();
  return out;
}

// ---- misc -----------------------------------------------------------------------------------------

/** deterministic rng (mulberry32) */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a site frame: x across the river (toward the right bank), y up, z downstream */
export function frameMatrix(x: number, y: number, z: number, nx: number, nz: number, tx: number, tz: number) {
  return new Matrix4().makeBasis(new Vector3(nx, 0, nz), new Vector3(0, 1, 0), new Vector3(-tx, 0, -tz)).setPosition(x, y, z);
}
