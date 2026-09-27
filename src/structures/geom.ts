// geometry accumulation for static structures. every part is written straight into flat arrays
// (position, normal, uv in meters, aCol linear tint, aVar misc) so a whole site merges into one
// draw call per material. uvs are projected per face in the part's local frame, so texel density
// stays constant no matter how a part is rotated in the world.
import { Box3, BufferAttribute, BufferGeometry, Euler, Matrix3, Matrix4, Quaternion, Sphere, Vector3 } from 'three/webgpu';

export type Axis = 'x' | 'y' | 'z';
export type RGB = [number, number, number];

export interface PartOpts {
  /** linear tint multiplied into albedo */
  col?: RGB;
  /** [grime, seed, wetBias, extra] read by materials */
  v?: [number, number, number, number];
  /** texture grain direction in part-local space (v follows this axis where possible) */
  grain?: Axis;
  /** uv offset in meters (decorrelates repeated parts) */
  uvo?: [number, number];
}

const _nm = new Matrix3();
const _p = new Vector3();
const _n = new Vector3();
const ONE: RGB = [1, 1, 1];
const ZERO4: [number, number, number, number] = [0, 0, 0, 0];

/**
 * vertex accumulator on growable typed arrays. the transform is applied inline (no per-vertex
 * object math), and build() hands the arrays straight to the gpu without a js-array conversion.
 * pos/nor/uv/col/vv are live views of the filled range (writes go to the bucket).
 */
export class Bucket {
  private P = new Float32Array(0);
  private N = new Float32Array(0);
  private U = new Float32Array(0);
  private C = new Float32Array(0);
  private V = new Float32Array(0);
  private n = 0;

  get count() {
    return this.n;
  }
  get pos() { return this.P.subarray(0, this.n * 3); }
  get nor() { return this.N.subarray(0, this.n * 3); }
  get uv() { return this.U.subarray(0, this.n * 2); }
  get col() { return this.C.subarray(0, this.n * 3); }
  get vv() { return this.V.subarray(0, this.n * 4); }

  private grow(extra: number) {
    const need = this.n + extra;
    const cap0 = this.P.length / 3;
    if (need <= cap0) return;
    let cap = Math.max(4096, cap0);
    while (cap < need) cap *= 2;
    const g = (a: Float32Array, k: number) => {
      const b = new Float32Array(cap * k);
      b.set(a.subarray(0, this.n * k));
      return b;
    };
    this.P = g(this.P, 3); this.N = g(this.N, 3); this.U = g(this.U, 2); this.C = g(this.C, 3); this.V = g(this.V, 4);
  }

  /** append a triangle list in local space (flat arrays), transformed by m */
  pushLocal(p: ArrayLike<number>, n: ArrayLike<number>, uv: ArrayLike<number>, m: Matrix4, o: PartOpts = {}) {
    const cnt = (p.length / 3) | 0;
    this.grow(cnt);
    const e = m.elements;
    const q = _nm.getNormalMatrix(m).elements;
    const col = o.col ?? ONE, v = o.v ?? ZERO4;
    const uo = o.uvo ? o.uvo[0] : 0, vo = o.uvo ? o.uvo[1] : 0;
    const P = this.P, N = this.N, U = this.U, C = this.C, V = this.V;
    let i3 = this.n * 3, i2 = this.n * 2, i4 = this.n * 4;
    for (let i = 0, j3 = 0, j2 = 0; i < cnt; i++, j3 += 3, j2 += 2) {
      const x = p[j3], y = p[j3 + 1], z = p[j3 + 2];
      P[i3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      P[i3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      P[i3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      const a = n[j3], b = n[j3 + 1], c = n[j3 + 2];
      const nx = q[0] * a + q[3] * b + q[6] * c, ny = q[1] * a + q[4] * b + q[7] * c, nz = q[2] * a + q[5] * b + q[8] * c;
      const l = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
      N[i3] = nx * l; N[i3 + 1] = ny * l; N[i3 + 2] = nz * l;
      U[i2] = uv[j2] + uo; U[i2 + 1] = uv[j2 + 1] + vo;
      C[i3] = col[0]; C[i3 + 1] = col[1]; C[i3 + 2] = col[2];
      V[i4] = v[0]; V[i4 + 1] = v[1]; V[i4 + 2] = v[2]; V[i4 + 3] = v[3];
      i3 += 3; i2 += 2; i4 += 4;
    }
    this.n += cnt;
  }

  add(part: Part, m: Matrix4, o: PartOpts = {}) {
    this.pushLocal(part.pos, part.nor, part.uv, m, o);
  }

  /** append everything in another bucket (already in this bucket's space) */
  append(b: Bucket) {
    const k = b.count;
    this.grow(k);
    this.P.set(b.pos, this.n * 3); this.N.set(b.nor, this.n * 3); this.U.set(b.uv, this.n * 2);
    this.C.set(b.col, this.n * 3); this.V.set(b.vv, this.n * 4);
    this.n += k;
  }

  /** true when every position and normal is a finite number */
  finite() {
    const P = this.pos, N = this.nor;
    for (let i = 0; i < P.length; i++) if (!Number.isFinite(P[i]) || !Number.isFinite(N[i])) return false;
    return true;
  }

  build(): BufferGeometry | null {
    if (!this.n) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.pos.slice(), 3));
    g.setAttribute('normal', new BufferAttribute(this.nor.slice(), 3));
    g.setAttribute('uv', new BufferAttribute(this.uv.slice(), 2));
    g.setAttribute('aCol', new BufferAttribute(this.col.slice(), 3));
    g.setAttribute('aVar', new BufferAttribute(this.vv.slice(), 4));
    // bounds in one tight pass (the generic attribute walk was a noticeable part of the build)
    const P = this.P, n3 = this.n * 3;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < n3; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    g.boundingBox = new Box3(new Vector3(x0, y0, z0), new Vector3(x1, y1, z1));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new Sphere());
    return g;
  }

  /** release the backing arrays once the geometry is built */
  clear() {
    this.P = new Float32Array(0); this.N = new Float32Array(0); this.U = new Float32Array(0);
    this.C = new Float32Array(0); this.V = new Float32Array(0); this.n = 0;
  }
}

// generated parts are never mutated after creation, so repeated shapes are built once. the cache is
// dropped when the structures module finishes building.
const partCache = new Map<string, Part>();
export function cachedPart(key: string, make: () => Part): Part {
  let p = partCache.get(key);
  if (!p) partCache.set(key, (p = make()));
  return p;
}
export function clearPartCache() {
  partCache.clear();
}

/** a local-space triangle soup with meter uvs */
export interface Part {
  pos: number[];
  nor: number[];
  uv: number[];
}

function newPart(): Part {
  return { pos: [], nor: [], uv: [] };
}

const AX = { x: 0, y: 1, z: 2 } as const;

/** planar uv for a point given the face's dominant axis and the grain preference */
function projUV(px: number, py: number, pz: number, dom: number, grain: number): [number, number] {
  const c = [px, py, pz];
  let va: number;
  if (grain !== dom) va = grain;
  else va = dom === 1 ? 2 : 1;
  const ua = 3 - dom - va;
  return [c[ua], c[va]];
}

/** convex planar polygon (ccw seen from outside), flat shaded, auto-projected uvs */
export function poly(part: Part, pts: number[][], grain: Axis = 'y', normal?: number[]) {
  let nx: number, ny: number, nz: number;
  if (normal) [nx, ny, nz] = normal;
  else {
    const [a, b, c] = pts;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    nx = uy * vz - uz * vy;
    ny = uz * vx - ux * vz;
    nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
  }
  const an = [Math.abs(nx), Math.abs(ny), Math.abs(nz)];
  const dom = an[0] > an[1] && an[0] > an[2] ? 0 : an[1] >= an[2] ? 1 : 2;
  const g = AX[grain];
  const va = g !== dom ? g : dom === 1 ? 2 : 1;
  const ua = 3 - dom - va;
  for (let i = 1; i < pts.length - 1; i++) {
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? pts[0] : k === 1 ? pts[i] : pts[i + 1];
      part.pos.push(p[0], p[1], p[2]);
      part.nor.push(nx, ny, nz);
      part.uv.push(p[ua], p[va]);
    }
  }
}

/**
 * box centered at the origin with chamfered edges (c = chamfer size, 0 for a plain box).
 * chamfers catch light along edges the way real cut stone and sawn timber do.
 */
export function chamferBox(sx: number, sy: number, sz: number, c = 0, grain: Axis = 'y'): Part {
  // a chamfer under ~1.5 cm is below a pixel from the river but quadruples the triangles
  if (c < 0.016) c = 0;
  return cachedPart(`b${sx.toFixed(4)},${sy.toFixed(4)},${sz.toFixed(4)},${c},${grain}`, () => makeBox(sx, sy, sz, c, grain));
}

function makeBox(sx: number, sy: number, sz: number, c: number, grain: Axis): Part {
  const part = newPart();
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  c = Math.min(c, hx * 0.45, hy * 0.45, hz * 0.45);
  const ix = hx - c, iy = hy - c, iz = hz - c;
  // main faces
  poly(part, [[hx, -iy, iz], [hx, -iy, -iz], [hx, iy, -iz], [hx, iy, iz]], grain);
  poly(part, [[-hx, -iy, -iz], [-hx, -iy, iz], [-hx, iy, iz], [-hx, iy, -iz]], grain);
  poly(part, [[-ix, hy, iz], [ix, hy, iz], [ix, hy, -iz], [-ix, hy, -iz]], grain);
  poly(part, [[-ix, -hy, -iz], [ix, -hy, -iz], [ix, -hy, iz], [-ix, -hy, iz]], grain);
  poly(part, [[-ix, -iy, hz], [ix, -iy, hz], [ix, iy, hz], [-ix, iy, hz]], grain);
  poly(part, [[ix, -iy, -hz], [-ix, -iy, -hz], [-ix, iy, -hz], [ix, iy, -hz]], grain);
  if (c <= 0) return part;
  // edge strips
  for (const sx_ of [1, -1]) for (const sy_ of [1, -1]) {
    // edges along z between x and y faces
    const a = [sx_ * hx, sy_ * iy], b = [sx_ * ix, sy_ * hy];
    const q = [[a[0], a[1], iz], [a[0], a[1], -iz], [b[0], b[1], -iz], [b[0], b[1], iz]];
    orient(part, q, [sx_, sy_, 0], grain);
  }
  for (const sx_ of [1, -1]) for (const sz_ of [1, -1]) {
    const a = [sx_ * hx, sz_ * iz], b = [sx_ * ix, sz_ * hz];
    const q = [[a[0], iy, a[1]], [a[0], -iy, a[1]], [b[0], -iy, b[1]], [b[0], iy, b[1]]];
    orient(part, q, [sx_, 0, sz_], grain);
  }
  for (const sy_ of [1, -1]) for (const sz_ of [1, -1]) {
    const a = [sy_ * hy, sz_ * iz], b = [sy_ * iy, sz_ * hz];
    const q = [[ix, a[0], a[1]], [-ix, a[0], a[1]], [-ix, b[0], b[1]], [ix, b[0], b[1]]];
    orient(part, q, [0, sy_, sz_], grain);
  }
  // corner triangles
  for (const a of [1, -1]) for (const b of [1, -1]) for (const d of [1, -1]) {
    const t = [[a * hx, b * iy, d * iz], [a * ix, b * hy, d * iz], [a * ix, b * iy, d * hz]];
    orient(part, t, [a, b, d], grain);
  }
  return part;
}

/** add a polygon, flipping winding so its normal points along `out` */
function orient(part: Part, pts: number[][], out: number[], grain: Axis) {
  const [a, b, c] = pts;
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (nx * out[0] + ny * out[1] + nz * out[2] < 0) pts = pts.slice().reverse();
  poly(part, pts, grain);
}

/**
 * surface of revolution around y. profile: [radius, y] pairs from bottom to top.
 * uv: u = arc length around at the local radius (meters), v = distance along the profile.
 */
export function lathe(profile: number[][], seg: number, smooth = true, uScaleR?: number): Part {
  let key = `l${seg},${smooth ? 1 : 0},${uScaleR ?? ''}`;
  for (const q of profile) key += `|${q[0].toFixed(4)},${q[1].toFixed(4)}`;
  return cachedPart(key, () => makeLathe(profile, seg, smooth, uScaleR));
}

function makeLathe(profile: number[][], seg: number, smooth: boolean, uScaleR?: number): Part {
  const part = newPart();
  const vlen: number[] = [0];
  for (let i = 1; i < profile.length; i++) vlen.push(vlen[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  const ringN: number[][] = [];
  for (let i = 0; i < profile.length; i++) {
    // profile normal in (r, y): perpendicular to the averaged tangent
    const a = profile[Math.max(0, i - 1)], b = profile[Math.min(profile.length - 1, i + 1)];
    const tr = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tr, ty) || 1;
    ringN.push([ty / l, -tr / l]);
  }
  const R = uScaleR ?? Math.max(...profile.map((p) => p[0]));
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, y0] = profile[i], [r1, y1] = profile[i + 1];
    let n0 = ringN[i], n1 = ringN[i + 1];
    if (!smooth) {
      const tr = r1 - r0, ty = y1 - y0, l = Math.hypot(tr, ty) || 1;
      n0 = n1 = [ty / l, -tr / l];
    }
    for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const P = (r: number, y: number, c: number, sn: number) => [r * c, y, r * sn];
      const N = (n: number[], c: number, sn: number) => [n[0] * c, n[1], n[0] * sn];
      const u0 = a0 * R, u1 = a1 * R;
      const quad = [
        [P(r0, y0, c0, s0), N(n0, c0, s0), [u0, vlen[i]]],
        [P(r0, y0, c1, s1), N(n0, c1, s1), [u1, vlen[i]]],
        [P(r1, y1, c1, s1), N(n1, c1, s1), [u1, vlen[i + 1]]],
        [P(r1, y1, c0, s0), N(n1, c0, s0), [u0, vlen[i + 1]]],
      ];
      // winding: outward facing for ccw around +y seen from outside
      for (const k of [0, 2, 1, 0, 3, 2]) {
        const [p, n, uv] = quad[k];
        part.pos.push(p[0], p[1], p[2]);
        part.nor.push(n[0], n[1], n[2]);
        part.uv.push(uv[0], uv[1]);
      }
    }
  }
  return part;
}

/** closed cylinder (optionally tapered) along y, base at y=0 */
export function cylinder(r0: number, r1: number, h: number, seg: number, caps = true): Part {
  return cachedPart(`c${r0.toFixed(4)},${r1.toFixed(4)},${h.toFixed(4)},${seg},${caps ? 1 : 0}`, () => makeCylinder(r0, r1, h, seg, caps));
}

function makeCylinder(r0: number, r1: number, h: number, seg: number, caps: boolean): Part {
  const part = makeLathe([[r0, 0], [r1, h]], seg, false);
  if (caps) {
    const top = newPart(), bot = newPart();
    for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
      poly(top, [[0, h, 0], [r1 * Math.cos(a1), h, r1 * Math.sin(a1)], [r1 * Math.cos(a0), h, r1 * Math.sin(a0)]], 'z', [0, 1, 0]);
      poly(bot, [[0, 0, 0], [r0 * Math.cos(a0), 0, r0 * Math.sin(a0)], [r0 * Math.cos(a1), 0, r0 * Math.sin(a1)]], 'z', [0, -1, 0]);
    }
    concat(part, top);
    concat(part, bot);
  }
  return part;
}

export function concat(a: Part, b: Part) {
  a.pos.push(...b.pos);
  a.nor.push(...b.nor);
  a.uv.push(...b.uv);
  return a;
}

/** transform a part in place (bake an offset into a reusable local part) */
export function transformPart(p: Part, m: Matrix4): Part {
  _nm.getNormalMatrix(m);
  for (let i = 0; i < p.pos.length; i += 3) {
    _p.set(p.pos[i], p.pos[i + 1], p.pos[i + 2]).applyMatrix4(m);
    _n.set(p.nor[i], p.nor[i + 1], p.nor[i + 2]).applyMatrix3(_nm).normalize();
    p.pos[i] = _p.x; p.pos[i + 1] = _p.y; p.pos[i + 2] = _p.z;
    p.nor[i] = _n.x; p.nor[i + 1] = _n.y; p.nor[i + 2] = _n.z;
  }
  return p;
}

/** torus segment in the xy plane around the origin (hoops, rings, handles) */
export function torus(R: number, r: number, arc: number, seg: number, rseg: number): Part {
  const part = newPart();
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < rseg; j++) {
      const q: number[][][] = [];
      for (const [di, dj] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const u = ((i + di) / seg) * arc, v = ((j + dj) / rseg) * Math.PI * 2;
        const cx = Math.cos(u) * R, cy = Math.sin(u) * R;
        const nx = Math.cos(u) * Math.cos(v), ny = Math.sin(u) * Math.cos(v), nz = Math.sin(v);
        q.push([[cx + nx * r, cy + ny * r, nz * r], [nx, ny, nz], [u * R, v * r]]);
      }
      for (const k of [0, 1, 2, 0, 2, 3]) {
        part.pos.push(...q[k][0]);
        part.nor.push(...q[k][1]);
        part.uv.push(...q[k][2]);
      }
    }
  }
  return part;
}

// matrix helpers -------------------------------------------------------------

const _q = new Quaternion();
const _s = new Vector3();
const _t = new Vector3();
const _e = new Euler();
const _up = new Vector3(0, 1, 0);

/** translation + yaw/pitch/roll (radians, three.js convention, order YXZ) + scale */
export function trs(x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0, sx = 1, sy = 1, sz = 1): Matrix4 {
  _q.setFromEuler(_e.set(pitch, yaw, roll, 'YXZ'));
  return new Matrix4().compose(_t.set(x, y, z), _q, _s.set(sx, sy, sz));
}

/** rigid matrix mapping local +y onto the direction a->b, origin at a. build the part with height = len */
export function segment(a: ArrayLike<number>, b: ArrayLike<number>, twist = 0): { m: Matrix4; len: number } {
  const d = new Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  d.divideScalar(len || 1);
  const q = new Quaternion().setFromUnitVectors(_up, d);
  if (twist) q.multiply(new Quaternion().setFromAxisAngle(_up, twist));
  return { m: new Matrix4().compose(new Vector3(a[0], a[1], a[2]), q, new Vector3(1, 1, 1)), len };
}

/**
 * cooperative time slicing for long builds: await the returned function often; it yields to the
 * event loop (so frames keep drawing) once `budget` ms of work have passed since the last yield
 */
export function slicer(budget = 24) {
  let t = performance.now();
  return async () => {
    if (performance.now() - t < budget) return;
    await new Promise<void>((r) => setTimeout(r, 0));
    t = performance.now();
  };
}

/** deterministic rng (mulberry32) so layouts are stable between reloads */
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

/** polygon with winding fixed so the normal points along `out` */
export function polyOut(part: Part, pts: number[][], out: number[], grain: Axis = 'y') {
  orient(part, pts, out, grain);
}

/** open half tube (canal tile, ridge tile) along +z from 0..len, arch over +y, with thickness */
export function halfTube(r: number, len: number, seg = 8, t = 0.014, flare = 0, outerOnly = false): Part {
  return cachedPart(`h${r.toFixed(4)},${len.toFixed(4)},${seg},${t},${flare},${outerOnly ? 1 : 0}`, () => makeHalfTube(r, len, seg, t, flare, outerOnly));
}

function makeHalfTube(r: number, len: number, seg: number, t: number, flare: number, outerOnly: boolean): Part {
  const part = newPart();
  for (const [rad, sgn] of (outerOnly ? [[r, 1]] : [[r, 1], [r - t, -1]]) as [number, number][]) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI, a1 = ((i + 1) / seg) * Math.PI;
      const q: number[][][] = [];
      for (const [a, zz] of [[a0, 0], [a1, 0], [a1, len], [a0, len]] as const) {
        const rr = rad * (1 + flare * (1 - zz / len));
        q.push([[Math.cos(a) * rr, Math.sin(a) * rr, zz], [Math.cos(a) * sgn, Math.sin(a) * sgn, 0], [a * r, zz]]);
      }
      const order = sgn > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
      for (const k of order) {
        part.pos.push(...q[k][0]);
        part.nor.push(...q[k][1]);
        part.uv.push(...q[k][2]);
      }
    }
  }
  // end rims
  if (outerOnly) return part;
  for (const zz of [0, len]) {
    const rr = r * (1 + flare * (1 - zz / len));
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI, a1 = ((i + 1) / seg) * Math.PI;
      const ri = rr - t;
      const pts = [[Math.cos(a0) * rr, Math.sin(a0) * rr, zz], [Math.cos(a1) * rr, Math.sin(a1) * rr, zz], [Math.cos(a1) * ri, Math.sin(a1) * ri, zz], [Math.cos(a0) * ri, Math.sin(a0) * ri, zz]];
      orient(part, pts, [0, 0, zz === 0 ? -1 : 1], 'y');
    }
  }
  return part;
}

/** translate a part in place */
export function shift(p: Part, x: number, y: number, z: number): Part {
  for (let i = 0; i < p.pos.length; i += 3) {
    p.pos[i] += x;
    p.pos[i + 1] += y;
    p.pos[i + 2] += z;
  }
  return p;
}

/** merge several parts into one */
export function merge(...parts: Part[]): Part {
  const out = newPart();
  for (const p of parts) concat(out, p);
  return out;
}
