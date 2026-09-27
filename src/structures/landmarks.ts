// distant landmarks above the town: a white castle keep on its battered stone base (the hero seen
// over the roofs from the canal) and a hillside shrine reached by a tunnel of vermilion torii.
// both are merged into one site, a handful of draws; silhouette and colour carry them at 200-600 m.
import type { Matrix4 } from 'three/webgpu';
import { chamferBox, lathe, trs, type RGB } from './geom';
import type { MatKey, Site } from './builder';
import { COL } from './materials';
import { roof, gableTri } from './roofs';
import { buildShrine, toro, torii } from './shrine';
import { bankPoint } from '../world/layout';

type At = (x: number, y: number, z: number, yaw?: number, pitch?: number, roll?: number) => Matrix4;

const WHITE: RGB = [1.04, 1.02, 0.98];
const GOLD: RGB = [1.5, 1.05, 0.32];
const TILE: RGB = [0.62, 0.66, 0.72];

function box(site: Site, mat: MatKey, at: At, sx: number, sy: number, sz: number, x: number, y: number, z: number, col?: RGB, yaw = 0, small = false) {
  site.add(mat, chamferBox(sx, sy, sz, Math.min(0.04, sy / 6, sx / 6, sz / 6)), at(x, y, z, yaw), { col, v: [0.2, 0.5, 0, 0.1] }, small);
}

export interface LandmarkOpts {
  x: number;
  z: number;
  y: number;
  /** yaw so the front (+z) faces the river */
  yaw: number;
}

/** a row of dark windows with white frames on one face of a tier (face normal along local +z) */
function windows(site: Site, at: At, half: number, y: number, depth: number, n: number, h: number, yaw: number) {
  const [ox, oz] = [Math.sin(yaw), Math.cos(yaw)];
  const [tx, tz] = [Math.cos(yaw), -Math.sin(yaw)];
  for (let i = 0; i < n; i++) {
    const a = -half + ((i + 0.5) * 2 * half) / n;
    box(site, 'dark', at, 0.95, h, 0.12, ox * depth + tx * a, y, oz * depth + tz * a, [0.03, 0.026, 0.022], yaw);
  }
}

/** tenshu: stone base, four diminishing white tiers with flared grey roofs, chidori gables, gold shachi */
export function buildCastle(site: Site, o: LandmarkOpts) {
  const base = trs(o.x, o.y, o.z, o.yaw);
  const at: At = (x, y, z, yaw = 0, pitch = 0, roll = 0) => base.clone().multiply(trs(x, y, z, yaw, pitch, roll));

  // ishigaki: a battered granite base, concave (gentle at the foot, near vertical at the top)
  const BH = 8.5;
  const prof: number[][] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const half = 13.5 - 3.4 * Math.pow(t, 0.55);
    prof.push([half * Math.SQRT2, -1.8 + (BH + 1.8) * t]);
  }
  prof.push([0.001, BH]);
  site.add('stone', lathe(prof, 4, false, 0.25), at(0, 0, 0, Math.PI / 4), { col: [0.9, 0.88, 0.84] });
  box(site, 'dressed', at, 20.6, 0.35, 20.6, 0, BH + 0.1, 0, [0.95, 0.94, 0.9]);

  // tiers: white plaster, a dark board skirt, windows, a flared hip roof between each
  const T: [number, number][] = [[9, 8], [7.5, 6.7], [6.1, 5.4], [4.7, 4.2]];
  const H = [4.4, 3.9, 3.6, 3.6];
  let y = BH + 0.25;
  for (let k = 0; k < T.length; k++) {
    const [hx, hz] = T[k];
    const h = H[k];
    box(site, 'plaster', at, 2 * hx, h, 2 * hz, 0, y + h / 2, 0, WHITE);
    // black shitami-ita boards on the lower third of each tier, as on matsumoto
    box(site, 'dark', at, 2 * hx + 0.08, h * 0.32, 2 * hz + 0.08, 0, y + h * 0.16, 0, [0.05, 0.045, 0.04]);
    const wy = y + h * 0.62;
    windows(site, at, hx - 0.8, wy, hz + 0.04, Math.max(2, Math.round(hx / 1.9)), 1.05, 0);
    windows(site, at, hx - 0.8, wy, hz + 0.04, Math.max(2, Math.round(hx / 1.9)), 1.05, Math.PI);
    windows(site, at, hz - 0.8, wy, hx + 0.04, Math.max(2, Math.round(hz / 1.9)), 1.05, Math.PI / 2);
    windows(site, at, hz - 0.8, wy, hx + 0.04, Math.max(2, Math.round(hz / 1.9)), 1.05, -Math.PI / 2);
    const eave = y + h + 0.1;
    const last = k === T.length - 1;
    const next = last ? null : T[k + 1];
    const rise = last ? 3.4 : 1.7;
    roof(site, at(0, 0, 0), {
      ex: hx + 1.9, ez: hz + 1.9,
      tx: last ? hx * 0.55 : next![0] + 0.25, tz: last ? 0 : next![1] + 0.25,
      y0: eave, rise, lift: 0.65, flare: 0.5, thick: 0.45, sweep: 0.7, rafters: false,
      col: TILE, rafterCol: WHITE, rafterMat: 'paint', seg: 0.55,
    });
    // chidori-hafu: triangular dormer gables on the front and back slopes of the middle roofs
    if (k === 1 || k === 2) {
      for (const sz of [1, -1]) {
        const gz = sz * (hz + 1.0);
        const gy = eave + 0.25;
        site.add('plaster', gableTri(2.1, gy, 1.5, 0.3), at(0, 0, gz, sz > 0 ? 0 : Math.PI), { col: WHITE });
        roof(site, at(0, 0, gz, sz > 0 ? Math.PI / 2 : -Math.PI / 2), {
          ex: 1.3, ez: 2.4, tx: 1.3, tz: 0, y0: gy - 0.1, rise: 1.6, gable: true, verge: 0.3, rafters: false,
          thick: 0.22, sweep: 0.4, sides: [0, 2], col: TILE, seg: 0.5,
        });
        // a gold ornament at the gable peak
        box(site, 'bronze', at, 0.35, 0.35, 0.12, 0, gy + 1.25, gz + sz * 0.22, GOLD);
      }
    }
    if (last) {
      // irimoya gable ends under the top ridge, and gold shachi at both ridge ends
      for (const sx of [-1, 1]) site.add('plaster', gableTri(hz * 0.7, eave + 1.2, 2.0, 0.3), at(sx * hx * 0.56, 0, 0, sx * Math.PI / 2), { col: WHITE });
      const ridgeY = eave + rise + 0.25;
      for (const sx of [-1, 1]) {
        const fish: number[][] = [[0.001, 0], [0.24, 0.12], [0.28, 0.45], [0.2, 0.85], [0.32, 1.15], [0.12, 1.45], [0.001, 1.55]];
        site.add('bronze', lathe(fish, 8, true), at(sx * (hx * 0.55 - 0.1), ridgeY, 0, 0, 0, -sx * 0.22), { col: GOLD });
      }
    }
    y = eave + rise + (last ? 0 : 0.05);
  }

  // dobei: low white walls with tiled caps around the pad, a gate gap facing the town
  const W = 18.5;
  for (let k = 0; k < 4; k++) {
    const yaw = (k * Math.PI) / 2;
    const [ox, oz] = [Math.sin(yaw), Math.cos(yaw)];
    const [tx, tz] = [Math.cos(yaw), -Math.sin(yaw)];
    const segs = k === 0 ? [[-W, -2.4], [2.4, W]] : [[-W, W]];
    for (const [a, b] of segs) {
      const len = b - a, mid = (a + b) / 2;
      box(site, 'plaster', at, len, 2.0, 0.45, ox * W + tx * mid, 1.0, oz * W + tz * mid, WHITE, yaw);
      box(site, 'kawara', at, len + 0.2, 0.22, 1.0, ox * W + tx * mid, 2.1, oz * W + tz * mid, TILE, yaw);
      box(site, 'dark', at, len + 0.02, 0.35, 0.5, ox * W + tx * mid, 0.18, oz * W + tz * mid, [0.05, 0.045, 0.04], yaw);
    }
  }
  // a corner turret (yagura) on the front-left of the wall
  {
    const cx = -W + 3.2, cz = W - 3.2;
    box(site, 'plaster', at, 5.2, 3.6, 5.2, cx, 1.8, cz, WHITE);
    box(site, 'dark', at, 5.3, 1.1, 5.3, cx, 0.55, cz, [0.05, 0.045, 0.04]);
    roof(site, at(cx, 0, cz), { ex: 3.9, ez: 3.9, tx: 2.0, tz: 2.0, y0: 3.7, rise: 1.2, lift: 0.4, flare: 0.3, thick: 0.3, sweep: 0.6, rafters: false, col: TILE, seg: 0.6 });
    box(site, 'plaster', at, 3.8, 2.6, 3.8, cx, 6.2, cz, WHITE);
    roof(site, at(cx, 0, cz), { ex: 2.9, ez: 2.9, tx: 1.4, tz: 0, y0: 7.6, rise: 1.7, lift: 0.45, flare: 0.3, thick: 0.28, sweep: 0.65, rafters: false, col: TILE, seg: 0.6 });
  }
  return { top: o.y + y + 1.6 };
}

/** the hillside shrine on its pad, and a path of vermilion torii climbing to it from the town floor */
export function buildHillShrine(site: Site, world: { heightAt(x: number, z: number): number }, o: LandmarkOpts, s: number) {
  buildShrine(site, { x: o.x, z: o.z, y: o.y, yaw: o.yaw, toEdge: 6 });
  // path: a gap between the front-row houses, between the second-row plots, then up the slope
  const pts = [bankPoint(s - 8, 1, 6), bankPoint(s - 8, 1, 17.5), bankPoint(s - 7, 1, 36), bankPoint(s - 3, 1, 80), bankPoint(s, 1, 150 - 9 - 7)];
  const path: { x: number; z: number }[] = [];
  let total = 0;
  const lens: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    lens.push(total);
  }
  const P = (d: number) => {
    let i = 1;
    while (i < lens.length - 1 && lens[i] < d) i++;
    const t = (d - lens[i - 1]) / Math.max(1e-6, lens[i] - lens[i - 1]);
    const a = pts[i - 1], b = pts[i];
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx: b.x - a.x, dz: b.z - a.z };
  };
  let gates = 0;
  // sparse gates across the town floor, a dense senbon-torii tunnel once the path starts climbing
  let d = 1.5;
  while (d < total - 2) {
    const q = P(d);
    const g = world.heightAt(q.x, q.z);
    const yaw = Math.atan2(q.dx, q.dz);
    torii(site, trs(q.x, Math.max(0.8, g) - 0.05, q.z, yaw), 2.9, 1.9);
    gates++;
    d += g < 3 ? 6 : 1.9;
    path.push({ x: q.x, z: q.z });
  }
  // stone lanterns flank the foot of the climb
  const foot = P(Math.min(total - 1, 30));
  const fy = Math.max(0.8, world.heightAt(foot.x, foot.z));
  const fyaw = Math.atan2(foot.dx, foot.dz);
  for (const sx of [-1, 1]) {
    const lx = foot.x + Math.cos(fyaw) * sx * 1.9, lz = foot.z - Math.sin(fyaw) * sx * 1.9;
    toro(site, trs(lx, Math.max(0.8, world.heightAt(lx, lz)) - 0.05, lz, fyaw), 1.8);
  }
  void fy; void COL;
  return { gates, path };
}
