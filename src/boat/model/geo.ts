// small geometry toolkit for the launch: indexed builders with uv in meters, analytic or
// computed normals, tangents for every part, and per-material merging.
import { BufferAttribute, BufferGeometry, Float32BufferAttribute, LatheGeometry, Matrix4, ShapeUtils, TubeGeometry, Vector2, Vector3, type Curve } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type V3 = Vector3;
export type Pt = [number, number];

/** per-vertex constant attributes a part carries (e.g. wood seeds), name -> values */
export type Extra = Record<string, number[]>;

export class Geo {
  pos: number[] = [];
  nor: number[] = [];
  uvs: number[] = [];
  idx: number[] = [];
  extra: Record<string, { size: number; data: number[] }> = {};
  hasNormals = true;

  get count() {
    return this.pos.length / 3;
  }

  vert(p: V3, n: V3 | null, u: number, v: number, ex?: Extra) {
    this.pos.push(p.x, p.y, p.z);
    if (n) this.nor.push(n.x, n.y, n.z);
    else {
      this.nor.push(0, 1, 0);
      this.hasNormals = false;
    }
    this.uvs.push(u, v);
    if (ex) for (const k in ex) {
      const e = (this.extra[k] ??= { size: ex[k].length, data: [] });
      e.data.push(...ex[k]);
    }
    return this.count - 1;
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }

  /** quad wound so its face normal agrees with ref (or the stored vertex normals) */
  quadAuto(a: number, b: number, c: number, d: number, ref?: V3) {
    const P = this.pos, N = this.nor;
    const v = (i: number) => new Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    const pa = v(a), pb = v(b), pc = v(c), pd = v(d);
    const fn = new Vector3().subVectors(pc, pa).cross(new Vector3().subVectors(pd, pb));
    const r = ref ?? new Vector3(N[a * 3] + N[c * 3], N[a * 3 + 1] + N[c * 3 + 1], N[a * 3 + 2] + N[c * 3 + 2]);
    if (fn.dot(r) >= 0) this.quad(a, b, c, d);
    else this.quad(a, d, c, b);
  }

  build(computeNormals = !this.hasNormals) {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new Float32BufferAttribute(this.uvs, 2));
    for (const k in this.extra) g.setAttribute(k, new Float32BufferAttribute(this.extra[k].data, this.extra[k].size));
    g.setIndex(this.idx);
    if (computeNormals) g.computeVertexNormals();
    return g;
  }
}

/**
 * regular grid surface. fn(i, j) gives position (and optionally normal/uv); rows i along u,
 * columns j along v. winding makes (dP/du x dP/dv) the front face unless flip.
 */
export function grid(
  nu: number,
  nv: number,
  fn: (i: number, j: number) => { p: V3; n?: V3; uv: Pt },
  opts: { flip?: boolean; closeV?: boolean; extra?: Extra } = {},
) {
  const g = new Geo();
  const cols = opts.closeV ? nv : nv + 1;
  for (let i = 0; i <= nu; i++)
    for (let j = 0; j < cols; j++) {
      const r = fn(i, j);
      g.vert(r.p, r.n ?? null, r.uv[0], r.uv[1], opts.extra);
    }
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const j1 = opts.closeV ? (j + 1) % nv : j + 1;
      const a = i * cols + j, b = (i + 1) * cols + j, c = (i + 1) * cols + j1, d = i * cols + j1;
      if (opts.flip) g.quad(a, d, c, b);
      else g.quad(a, b, c, d);
    }
  return g;
}

/** frame along a sweep path: point, outward axis a, upward axis b */
export interface Frame {
  p: V3;
  a: V3;
  b: V3;
}

/**
 * sweep a 2d profile (coordinates along frame a and b) along frames. profile normals are
 * derived from neighbours unless a point repeats (crease). uv: u = path length, v = profile length.
 */
export function sweep(frames: Frame[], profile: Pt[], opts: { closedProfile?: boolean; flip?: boolean; extra?: Extra; uScale?: number } = {}) {
  const np = profile.length;
  // 2d profile normals (outward = right-hand of the walking direction for a ccw profile)
  const pn: Pt[] = [];
  const pl: number[] = [0];
  for (let k = 1; k < np; k++) pl.push(pl[k - 1] + Math.hypot(profile[k][0] - profile[k - 1][0], profile[k][1] - profile[k - 1][1]));
  for (let k = 0; k < np; k++) {
    const prev = profile[opts.closedProfile ? (k - 1 + np) % np : Math.max(0, k - 1)];
    const next = profile[opts.closedProfile ? (k + 1) % np : Math.min(np - 1, k + 1)];
    let tx = next[0] - prev[0], ty = next[1] - prev[1];
    // crease handling: if next == this, use the incoming segment, if prev == this, the outgoing one
    const cur = profile[k];
    if (next[0] === cur[0] && next[1] === cur[1]) { tx = cur[0] - prev[0]; ty = cur[1] - prev[1]; }
    if (prev[0] === cur[0] && prev[1] === cur[1]) { tx = next[0] - cur[0]; ty = next[1] - cur[1]; }
    const l = Math.hypot(tx, ty) || 1;
    pn.push([ty / l, -tx / l]);
  }
  const lens: number[] = [0];
  for (let i = 1; i < frames.length; i++) lens.push(lens[i - 1] + frames[i].p.distanceTo(frames[i - 1].p));
  const us = opts.uScale ?? 1;
  const tmp = new Vector3(), tn = new Vector3();
  const g = grid(
    frames.length - 1,
    opts.closedProfile ? np : np - 1,
    (i, j) => {
      const f = frames[i], q = profile[j], n = pn[j];
      const p = tmp.copy(f.p).addScaledVector(f.a, q[0]).addScaledVector(f.b, q[1]).clone();
      const nn = tn.set(0, 0, 0).addScaledVector(f.a, n[0]).addScaledVector(f.b, n[1]).normalize().clone();
      if (opts.flip) nn.negate();
      return { p, n: nn, uv: [lens[i] * us, pl[j]] };
    },
    { flip: !opts.flip, closeV: opts.closedProfile, extra: opts.extra },
  );
  return g;
}

/** frames along a polyline with a preferred up vector (b), a = b x t */
export function framesAlong(points: V3[], up: V3 | ((i: number) => V3)) {
  const out: Frame[] = [];
  for (let i = 0; i < points.length; i++) {
    const t = new Vector3().subVectors(points[Math.min(points.length - 1, i + 1)], points[Math.max(0, i - 1)]).normalize();
    const u = typeof up === 'function' ? up(i) : up;
    const a = new Vector3().crossVectors(u, t).normalize();
    const b = new Vector3().crossVectors(t, a).normalize();
    out.push({ p: points[i].clone(), a, b });
  }
  return out;
}

/** outline with rounded corners (ccw, xz plane viewed from +y is irrelevant: keeps input order) */
export function roundedPoly(corners: Pt[], radius: number | number[], segs = 5): Pt[] {
  const n = corners.length, out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p = corners[i], a = corners[(i - 1 + n) % n], b = corners[(i + 1) % n];
    const r0 = Array.isArray(radius) ? radius[i] : radius;
    const da = new Vector2(a[0] - p[0], a[1] - p[1]), db = new Vector2(b[0] - p[0], b[1] - p[1]);
    const la = da.length(), lb = db.length();
    da.normalize(); db.normalize();
    const ang = Math.acos(Math.min(1, Math.max(-1, da.dot(db))));
    if (r0 <= 0 || ang > Math.PI - 1e-3) { out.push(p); continue; }
    const t = Math.min(r0 / Math.tan(ang / 2), la * 0.49, lb * 0.49);
    const p0 = new Vector2(p[0] + da.x * t, p[1] + da.y * t), p1 = new Vector2(p[0] + db.x * t, p[1] + db.y * t);
    // quadratic bezier through the corner is visually a fillet and never self-intersects
    for (let k = 0; k <= segs; k++) {
      const s = k / segs, w0 = (1 - s) * (1 - s), w1 = 2 * s * (1 - s), w2 = s * s;
      out.push([w0 * p0.x + w1 * p[0] + w2 * p1.x, w0 * p0.y + w1 * p[1] + w2 * p1.y]);
    }
  }
  return out;
}

function polyArea(o: Pt[]) {
  let a = 0;
  for (let i = 0; i < o.length; i++) {
    const p = o[i], q = o[(i + 1) % o.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** outward unit normals of a closed outline (per vertex, averaged) */
function outlineNormals(o: Pt[]): Pt[] {
  const s = polyArea(o) > 0 ? 1 : -1;
  return o.map((p, i) => {
    const a = o[(i - 1 + o.length) % o.length], b = o[(i + 1) % o.length];
    const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
    return [(s * ty) / l, (-s * tx) / l];
  });
}

export interface PrismFrame {
  origin: V3;
  /** outline x axis */
  ax: V3;
  /** outline y axis */
  ay: V3;
  /** extrusion (height) axis; the top cap faces +n */
  n: V3;
}

export const FRAME_Y: PrismFrame = { origin: new Vector3(), ax: new Vector3(1, 0, 0), ay: new Vector3(0, 0, 1), n: new Vector3(0, 1, 0) };

/**
 * rounded prism: a closed outline extruded from h0 to h1 along the frame normal with a rounded
 * top edge (radius r) and an optionally domed top cap (puff). returns two parts so the side wall
 * and the top can carry different uv mappings; the seam sits at the middle of the round (where
 * an upholstery welt or a joinery edge would be). uv in meters: side = (perimeter, height),
 * top = outline coordinates (optionally swapped so grain runs along the long axis).
 */
export function roundedPrism(
  outline: Pt[],
  h0: number,
  h1: number,
  r: number,
  opts: { frame?: PrismFrame; puff?: number; rings?: number; roundSegs?: number; topUvSwap?: boolean; extra?: Extra; bottomR?: number } = {},
) {
  const f = opts.frame ?? FRAME_Y;
  const ns = outline.length;
  const on = outlineNormals(outline);
  const cx = outline.reduce((a, p) => a + p[0], 0) / ns, cy = outline.reduce((a, p) => a + p[1], 0) / ns;
  const per: number[] = [0];
  for (let i = 1; i <= ns; i++) {
    const p = outline[i % ns], q = outline[i - 1];
    per.push(per[i - 1] + Math.hypot(p[0] - q[0], p[1] - q[1]));
  }
  const rs = Math.max(2, opts.roundSegs ?? 4);
  const puff = opts.puff ?? 0;
  const map = (x: number, y: number, h: number) => f.origin.clone().addScaledVector(f.ax, x).addScaledVector(f.ay, y).addScaledVector(f.n, h);
  const dir = (nx: number, ny: number, nh: number) => new Vector3().addScaledVector(f.ax, nx).addScaledVector(f.ay, ny).addScaledVector(f.n, nh).normalize();
  // side: optional bottom round, wall, lower half of the top round
  const br = opts.bottomR ?? 0;
  const prof: { d: number; h: number; nd: number; nh: number }[] = [];
  if (br > 0) for (let k = 0; k <= rs; k++) {
    const a = (-Math.PI / 2) * (1 - k / rs);
    prof.push({ d: -br + br * Math.cos(a), h: h0 + br + br * Math.sin(a), nd: Math.cos(a), nh: Math.sin(a) });
  }
  else prof.push({ d: 0, h: h0, nd: 1, nh: 0 });
  const half = Math.max(1, Math.floor(rs / 2));
  for (let k = 0; k <= half; k++) {
    const a = (Math.PI / 4) * (k / half);
    prof.push({ d: -r + r * Math.cos(a), h: h1 - r + r * Math.sin(a), nd: Math.cos(a), nh: Math.sin(a) });
  }
  const pl = [0];
  for (let k = 1; k < prof.length; k++) pl.push(pl[k - 1] + Math.hypot(prof[k].d - prof[k - 1].d, prof[k].h - prof[k - 1].h));
  const side = new Geo();
  for (let k = 0; k < prof.length; k++)
    for (let i = 0; i <= ns; i++) {
      const o = outline[i % ns], n = on[i % ns], q = prof[k];
      side.vert(map(o[0] + n[0] * q.d, o[1] + n[1] * q.d, q.h), dir(n[0] * q.nd, n[1] * q.nd, q.nh), per[i], pl[k] + h0, opts.extra);
    }
  for (let k = 0; k < prof.length - 1; k++)
    for (let i = 0; i < ns; i++) {
      const a = k * (ns + 1) + i, b = a + 1, c = a + ns + 2, d = a + ns + 1;
      side.quadAuto(a, b, c, d);
    }
  // top: upper half of the round, then concentric rings to the centroid
  const top = new Geo();
  const rings = opts.rings ?? 4;
  const tp: { d: number; h: number; nd: number; nh: number; scale: number }[] = [];
  for (let k = 0; k <= rs - half; k++) {
    const a = Math.PI / 4 + (Math.PI / 4) * (k / (rs - half));
    tp.push({ d: -r + r * Math.cos(a), h: h1 - r + r * Math.sin(a), nd: Math.cos(a), nh: Math.sin(a), scale: 1 });
  }
  for (let k = 1; k <= rings; k++) tp.push({ d: -r, h: h1, nd: 0, nh: 1, scale: 1 - k / rings });
  for (let k = 0; k < tp.length; k++)
    for (let i = 0; i < ns; i++) {
      const o = outline[i], n = on[i], q = tp[k];
      // inset by r, then shrink toward the centroid for the inner rings
      let x = o[0] + n[0] * q.d, y = o[1] + n[1] * q.d;
      x = cx + (x - cx) * q.scale;
      y = cy + (y - cy) * q.scale;
      const dome = puff * (1 - q.scale * q.scale);
      const u = opts.topUvSwap ? y : x, v = opts.topUvSwap ? x : y;
      top.vert(map(x, y, q.h + dome), q.scale < 1 ? null : dir(n[0] * q.nd, n[1] * q.nd, q.nh), u, v, opts.extra);
    }
  for (let k = 0; k < tp.length - 1; k++)
    for (let i = 0; i < ns; i++) {
      const i1 = (i + 1) % ns;
      const a = k * ns + i, b = k * ns + i1, c = (k + 1) * ns + i1, d = (k + 1) * ns + i;
      top.quadAuto(a, b, c, d, f.n);
    }
  const topGeo = top.build(false);
  if (tp.length > rs - half + 1) {
    // domed rings: compute normals, but keep the analytic ones on the rounded edge
    const keep = (rs - half + 1) * ns;
    const nAttr = topGeo.getAttribute('normal');
    const saved = (nAttr.array as Float32Array).slice(0, keep * 3);
    topGeo.computeVertexNormals();
    (nAttr.array as Float32Array).set(saved, 0);
    const arr = nAttr.array as Float32Array;
    // the first computed ring blends toward the up axis to avoid a crease
    for (let i = keep; i < arr.length / 3; i++) {
      const v = new Vector3(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]);
      if (puff === 0) v.copy(f.n);
      v.normalize();
      arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z;
    }
  }
  return { side: side.build(false), top: topGeo, outlineNormals: on };
}

/** triangulated flat polygon in a frame (cap), uv = outline coords */
export function flatPoly(outline: Pt[], frame: PrismFrame, h: number, extra?: Extra, flip = false) {
  const g = new Geo();
  const n = frame.n.clone();
  if (flip) n.negate();
  for (const o of outline) g.vert(frame.origin.clone().addScaledVector(frame.ax, o[0]).addScaledVector(frame.ay, o[1]).addScaledVector(frame.n, h), n, o[0], o[1], extra);
  const tris = ShapeUtils.triangulateShape(outline.map((p) => new Vector2(p[0], p[1])), []);
  // wind every triangle to face n
  const P = g.pos, v = (i: number) => new Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
  for (const t of tris) {
    const fn = new Vector3().subVectors(v(t[1]), v(t[0])).cross(new Vector3().subVectors(v(t[2]), v(t[0])));
    fn.dot(n) >= 0 ? g.tri(t[0], t[1], t[2]) : g.tri(t[0], t[2], t[1]);
  }
  return g.build(false);
}

/** lathe around +y from a (radius, y) profile; uv = (angle * radius_ref, profile length) */
export function lathe(profile: Pt[], segs: number, extra?: Extra) {
  const g = new LatheGeometry(profile.map((p) => new Vector2(Math.max(p[0], 1e-5), p[1])), segs);
  return withExtra(g, extra);
}

/** tube along a curve; uv = (length m, around 0..1 * circumference m) */
export function tube(curve: Curve<Vector3>, segs: number, radius: number, radial = 8, extra?: Extra) {
  const g = new TubeGeometry(curve, segs, radius, radial, false);
  const len = curve.getLength();
  const uv = g.getAttribute('uv') as BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len, uv.getY(i) * Math.PI * 2 * radius);
  return withExtra(g, extra);
}

export function withExtra(g: BufferGeometry, extra?: Extra) {
  if (extra) {
    const n = g.getAttribute('position').count;
    for (const k in extra) {
      const v = extra[k], data = new Float32Array(n * v.length);
      for (let i = 0; i < n; i++) data.set(v, i * v.length);
      g.setAttribute(k, new Float32BufferAttribute(data, v.length));
    }
  }
  return g;
}

export function xform(g: BufferGeometry, m: Matrix4) {
  g.applyMatrix4(m);
  return g;
}

/**
 * merge parts for one material. every part gets the attribute set in `attrs` (missing ones are
 * filled with the given default), is converted to indexed form and gets tangents.
 */
export function mergeParts(parts: BufferGeometry[], attrs: Record<string, number[]> = {}) {
  const ready: BufferGeometry[] = [];
  for (let g of parts) {
    if (!g.index) {
      const n = g.getAttribute('position').count;
      g.setIndex([...Array(n).keys()]);
    }
    for (const k in attrs) if (!g.getAttribute(k)) withExtra(g, { [k]: attrs[k] });
    const keep = new Set(['position', 'normal', 'uv', ...Object.keys(attrs)]);
    for (const k of Object.keys(g.attributes)) if (!keep.has(k)) g.deleteAttribute(k);
    g.computeTangents();
    // degenerate uv triangles leave nan tangents; replace with a stable fallback
    const t = g.getAttribute('tangent').array as Float32Array;
    for (let i = 0; i < t.length; i += 4) if (!Number.isFinite(t[i]) || !Number.isFinite(t[i + 1]) || !Number.isFinite(t[i + 2]) || t[i] * t[i] + t[i + 1] * t[i + 1] + t[i + 2] * t[i + 2] < 1e-8) { t[i] = 1; t[i + 1] = 0; t[i + 2] = 0; t[i + 3] = 1; }
    const nrm = g.getAttribute('normal').array as Float32Array;
    for (let i = 0; i < nrm.length; i += 3) if (!Number.isFinite(nrm[i]) || nrm[i] * nrm[i] + nrm[i + 1] * nrm[i + 1] + nrm[i + 2] * nrm[i + 2] < 1e-8) { nrm[i] = 0; nrm[i + 1] = 1; nrm[i + 2] = 0; }
    ready.push(g);
  }
  if (!ready.length) return null;
  const merged = mergeGeometries(ready, false);
  for (const g of ready) g.dispose();
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

export const rot = (axis: V3, angle: number) => new Matrix4().makeRotationAxis(axis.clone().normalize(), angle);
export const at = (x: number, y: number, z: number) => new Matrix4().makeTranslation(x, y, z);

/** tube with a per-point radius (cleat horns, tapered ends); ends close when the radius is 0 */
export function ringTube(points: V3[], radii: number[], up: V3, radial = 12, extra?: Extra) {
  const frames = framesAlong(points, up);
  const g = new Geo();
  let len = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) len += points[i].distanceTo(points[i - 1]);
    const f = frames[i];
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const r = radii[i];
      const p = f.p.clone().addScaledVector(f.a, Math.cos(a) * r).addScaledVector(f.b, Math.sin(a) * r);
      g.vert(p, null, len, (k / radial) * Math.PI * 2 * Math.max(r, 0.002), extra);
    }
  }
  const cols = radial + 1;
  for (let i = 0; i < points.length - 1; i++)
    for (let k = 0; k < radial; k++) {
      const a = i * cols + k;
      const ang = ((k + 0.5) / radial) * Math.PI * 2;
      const ref = frames[i].a.clone().multiplyScalar(Math.cos(ang)).addScaledVector(frames[i].b, Math.sin(ang));
      g.quadAuto(a, a + cols, a + cols + 1, a + 1, ref);
    }
  return g.build(true);
}

/** geometry from raw arrays; normals computed */
export function rawGeo(pos: number[], uvs: number[], idx: number[]) {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** mirror across the x = 0 plane (winding flipped so faces stay outward) */
export function mirrorX(src: BufferGeometry, extra?: Extra) {
  const g = src.clone();
  g.applyMatrix4(new Matrix4().makeScale(-1, 1, 1));
  const idx = g.getIndex();
  if (idx) {
    const a = idx.array as Uint32Array | Uint16Array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    idx.needsUpdate = true;
  } else {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const u = g.getAttribute('uv');
    for (let i = 0; i < p.count; i += 3) for (const at of [p, n, u]) {
      if (!at) continue;
      for (let c = 0; c < at.itemSize; c++) { const t = at.getComponent(i + 1, c); at.setComponent(i + 1, c, at.getComponent(i + 2, c)); at.setComponent(i + 2, c, t); }
    }
  }
  if (extra) withExtra(g, extra);
  return g;
}

/** flat caps closing both ends of a sweep (profile polygon placed in the end frames) */
export function sweepCaps(frames: Frame[], profile: Pt[], extra?: Extra) {
  const out: BufferGeometry[] = [];
  for (const [f, dir] of [[frames[0], -1], [frames[frames.length - 1], 1]] as const) {
    const i = dir < 0 ? 0 : frames.length - 1, j = dir < 0 ? 1 : frames.length - 2;
    const t = new Vector3().subVectors(frames[i].p, frames[j].p).normalize();
    out.push(flatPoly(profile, { origin: f.p, ax: f.a, ay: f.b, n: t }, 0, extra));
  }
  return out;
}
