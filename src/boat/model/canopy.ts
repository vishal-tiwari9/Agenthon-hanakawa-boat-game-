// the woven canopy (toma) over the midsection: a semi-elliptic mat with real thickness lying under
// bamboo hoops, a ridge pole, straw lashings, a rolled spare mat, and tatami on the floor beneath.
import { CatmullRomCurve3, LineCurve3, Matrix4, TorusGeometry, Vector3 } from 'three/webgpu';
import { sheerAt, stationAt } from '../hullSpec';
import { Geo, flatPoly, roundedPoly, roundedPrism, tube, withExtra, type Pt } from './geo';
import { LAYOUT, innerHalfWidth } from './lines';
import type { Parts } from './parts';

export const CANOPY = { rise: 0.8, hoops: 5, matT: 0.012, hoopR: 0.013, ridgeR: 0.017 };

/** hoop centerline at station z: half width a, base height y0, rise h */
function arch(z: number) {
  const s = stationAt(z);
  const y0 = sheerAt(s) + LAYOUT.railH * 0.55;
  return { a: innerHalfWidth(s, sheerAt(s)) - 0.006, y0, h: CANOPY.rise };
}

/** point on the arch at angle th, offset r along the ellipse normal */
function archPoint(z: number, th: number, r: number, out = new Vector3()) {
  const { a, y0, h } = arch(z);
  const c = Math.cos(th), s = Math.sin(th);
  const nx = c / a, ny = s / h, nl = Math.hypot(nx, ny) || 1;
  return out.set(a * c + (nx / nl) * r, y0 + h * s + (ny / nl) * r, z);
}

// cheap deterministic value noise for the mat's unevenness
function vnoise(x: number, y: number) {
  const h = (i: number, j: number) => {
    const t = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return t - Math.floor(t);
  };
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h(xi, yi) + (h(xi + 1, yi) - h(xi, yi)) * u;
  const b = h(xi, yi + 1) + (h(xi + 1, yi + 1) - h(xi, yi + 1)) * u;
  return a + (b - a) * v - 0.5;
}

export function buildCanopy(parts: Parts, fine: boolean) {
  const [z0, z1] = LAYOUT.canopy;
  const nh = CANOPY.hoops;
  const hoopZ = Array.from({ length: nh }, (_, k) => z0 + 0.03 + ((z1 - z0 - 0.06) * k) / (nh - 1));
  const gap = hoopZ[1] - hoopZ[0];
  const mz0 = z0 - 0.05, mz1 = z1 + 0.05;
  const nz = fine ? 56 : 24, nth = fine ? 44 : 20;
  const th0 = -0.035, th1 = Math.PI + 0.035;
  // offset of the mat surface from the hoop centerline at (z, th): under the hoops, sagging
  // between them at the crown, with a slight hand-made unevenness
  const off = (z: number, th: number, layer: number) => {
    let dz = Infinity;
    for (const hz of hoopZ) dz = Math.min(dz, Math.abs(z - hz));
    const between = Math.sin(Math.min(1, dz / gap) * Math.PI * 0.5) ** 2;
    const sag = -0.016 * between * Math.max(0, Math.sin(th)) ** 1.5;
    const rough = 0.006 * vnoise(z * 3.1, th * 4.3) + 0.003 * vnoise(z * 9.7 + 3, th * 11.1);
    const base = -CANOPY.hoopR - 0.001 - (layer ? CANOPY.matT : 0);
    return base + sag + rough;
  };
  const outer = new Geo(), inner = new Geo();
  const P = new Vector3();
  const arcLen: number[][] = [];
  for (let i = 0; i <= nz; i++) {
    const z = mz0 + ((mz1 - mz0) * i) / nz;
    const row: number[] = [0];
    let prev = archPoint(z, th0, 0).clone();
    for (let j = 1; j <= nth; j++) {
      const p = archPoint(z, th0 + ((th1 - th0) * j) / nth, 0).clone();
      row.push(row[j - 1] + p.distanceTo(prev));
      prev = p;
    }
    arcLen.push(row);
    for (let j = 0; j <= nth; j++) {
      const th = th0 + ((th1 - th0) * j) / nth;
      outer.vert(archPoint(z, th, off(z, th, 0), P).clone(), null, z, row[j]);
      inner.vert(archPoint(z, th, off(z, th, 1), P).clone(), null, z, row[j]);
    }
  }
  const cols = nth + 1;
  const center = (i: number, j: number) => new Vector3(0, arch(0).y0, mz0 + ((mz1 - mz0) * i) / nz);
  for (let i = 0; i < nz; i++)
    for (let j = 0; j < nth; j++) {
      const a = i * cols + j;
      const p = new Vector3(outer.pos[a * 3], outer.pos[a * 3 + 1], outer.pos[a * 3 + 2]);
      const out = p.clone().sub(center(i, j)).setZ(0);
      outer.quadAuto(a, a + cols, a + cols + 1, a + 1, out);
      inner.quadAuto(a, a + cols, a + cols + 1, a + 1, out.clone().negate());
    }
  parts.add('canopy', outer.build(true));
  parts.add('canopy', inner.build(true));
  // rims: fore and aft edges and the two lower edges, joining the layers
  const rim = new Geo();
  const edge = (pts: [Vector3, Vector3, number, number][]) => {
    const start = rim.count;
    for (const [o, n, u, v] of pts) {
      rim.vert(o, null, u, v);
      rim.vert(n, null, u, v + CANOPY.matT);
    }
    for (let k = 0; k < pts.length - 1; k++) {
      const a = start + k * 2;
      const mid = pts[k][0].clone().add(pts[k + 1][0]).multiplyScalar(0.5);
      const ref = mid.clone().sub(new Vector3(0, arch(0).y0 + 0.3, (mz0 + mz1) / 2));
      rim.quadAuto(a, a + 2, a + 3, a + 1, ref);
    }
  };
  const vtx = (g: Geo, k: number) => new Vector3(g.pos[k * 3], g.pos[k * 3 + 1], g.pos[k * 3 + 2]);
  for (const i of [0, nz]) edge(Array.from({ length: cols }, (_, j) => [vtx(outer, i * cols + j), vtx(inner, i * cols + j), arcLen[i][j], 0] as [Vector3, Vector3, number, number]));
  for (const j of [0, nth]) edge(Array.from({ length: nz + 1 }, (_, i) => [vtx(outer, i * cols + j), vtx(inner, i * cols + j), mz0 + ((mz1 - mz0) * i) / nz, 0] as [Vector3, Vector3, number, number]));
  parts.add('canopy', rim.build(true));

  // bamboo hoops, dropping just below the rail on each side
  hoopZ.forEach((hz, k) => {
    const pts: Vector3[] = [];
    for (let q = 0; q <= 40; q++) pts.push(archPoint(hz, -0.09 + ((Math.PI + 0.18) * q) / 40, 0).clone());
    parts.add('bamboo', tube(new CatmullRomCurve3(pts), fine ? 64 : 32, CANOPY.hoopR, fine ? 10 : 6, { seed: [k * 0.7] }));
  });
  // ridge pole resting on the hoop crowns
  const top = Math.max(...hoopZ.map((hz) => arch(hz).y0 + arch(hz).h)) + CANOPY.hoopR + CANOPY.ridgeR - 0.004;
  parts.add('bamboo', tube(new LineCurve3(new Vector3(0, top, z0 - 0.32), new Vector3(0, top - 0.012, z1 + 0.3)), 8, CANOPY.ridgeR, fine ? 12 : 8, { seed: [5.3] }));
  // straw lashings: an x-wrap at every crown, and a wrap where each hoop meets the rail
  if (fine) {
    for (const hz of hoopZ) {
      const c = new Vector3(0, arch(hz).y0 + arch(hz).h + 0.004, hz);
      for (const ang of [Math.PI / 4, -Math.PI / 4]) {
        const t = new TorusGeometry(0.024, 0.0042, 6, 18);
        t.applyMatrix4(new Matrix4().makeRotationY(ang));
        t.translate(c.x, c.y, c.z);
        parts.add('rope', t);
      }
      for (const th of [0.03, Math.PI - 0.03]) {
        const p = archPoint(hz, th, 0);
        for (let w = 0; w < 3; w++) {
          const t = new TorusGeometry(CANOPY.hoopR + 0.004, 0.0038, 6, 16);
          t.applyMatrix4(new Matrix4().makeRotationX(Math.PI / 2));
          t.translate(p.x, p.y + 0.012 + w * 0.008, p.z);
          parts.add('rope', t);
        }
      }
    }
    // rolled spare mat lying along the starboard side, tied twice
    rolledMat(parts, 0.44, LAYOUT.tatamiY, 0.05, 0.95);
  }
  tatami(parts);
}

function rolledMat(parts: Parts, x: number, y: number, za: number, zb: number) {
  const R = 0.11, r0 = 0.025, turns = 3.2, th = 0.009;
  const outerPath: Pt[] = [], innerPath: Pt[] = [];
  const n = 90;
  for (let k = 0; k <= n; k++) {
    const phi = (k / n) * turns * Math.PI * 2;
    const r = r0 + ((R - r0) * k) / n;
    outerPath.push([Math.cos(phi) * r, Math.sin(phi) * r]);
    innerPath.push([Math.cos(phi) * (r - th), Math.sin(phi) * (r - th)]);
  }
  const outline = [...outerPath, ...innerPath.reverse()];
  const cy = y + R + 0.004;
  const frame = { origin: new Vector3(x, cy, 0), ax: new Vector3(1, 0, 0), ay: new Vector3(0, 1, 0), n: new Vector3(0, 0, 1) };
  const body = roundedPrism(outline, za, zb, 0.002, { frame, rings: 1, roundSegs: 2 });
  parts.add('canopy', body.side);
  parts.add('canopy', body.top);
  parts.add('canopy', flatPoly(outline, { ...frame, n: new Vector3(0, 0, -1), origin: new Vector3(x, cy, 0) }, -za));
  for (const zt of [za + 0.2, zb - 0.2]) {
    const t = new TorusGeometry(R + 0.004, 0.006, 6, 28);
    t.translate(x, cy, zt);
    parts.add('rope', t);
  }
}

/** tatami under the canopy, laid athwartships with the heri on the long edges */
function tatami(parts: Parts) {
  const [z0, z1] = LAYOUT.canopy;
  const n = 3, gap = 0.012, L = (z1 - 0.06 - (z0 + 0.06) - gap * (n - 1)) / n;
  for (let k = 0; k < n; k++) {
    const za = z0 + 0.06 + k * (L + gap);
    const s = stationAt(za + L / 2);
    const X = Math.min(innerHalfWidth(stationAt(za), LAYOUT.tatamiY), innerHalfWidth(stationAt(za + L), LAYOUT.tatamiY), innerHalfWidth(s, LAYOUT.tatamiY)) - 0.012;
    const outline = roundedPoly([[0, 0], [2 * X, 0], [2 * X, L], [0, L]], 0.01, 2);
    const b = roundedPrism(outline, LAYOUT.floorY - 0.004, LAYOUT.tatamiY, 0.008, { rings: 1, roundSegs: 3 });
    const m = new Matrix4().makeTranslation(-X, 0, za);
    parts.add('tatami', b.side.applyMatrix4(m));
    parts.add('tatami', b.top.applyMatrix4(m));
  }
}

export { withExtra };
