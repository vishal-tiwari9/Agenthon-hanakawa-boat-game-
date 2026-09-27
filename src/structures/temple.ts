// the temple terrace: a five-storey pagoda (gojunoto) and the main hall on a granite-walled terrace
// above the right bank. pagoda proportions follow edo-period examples: a 6.4 m first storey tapering
// to two thirds at the top, deep swept eaves with lifted corners, bracket bands, balconies and a
// bronze sorin, about 29.5 m above the terrace.
import type { Matrix4 } from 'three/webgpu';
import { chamferBox, cylinder, lathe, rng, torus, trs, type RGB } from './geom';
import { COL } from './materials';
import type { MatKey, Site } from './builder';
import { gableTri, roof } from './roofs';

type At = (x: number, y: number, z: number, yaw?: number, pitch?: number, roll?: number) => Matrix4;

const VER = COL.vermilion;
const WHITE: RGB = [1.02, 1.0, 0.97];

function box(site: Site, mat: MatKey, at: At, sx: number, sy: number, sz: number, x: number, y: number, z: number, col?: RGB, c = 0.01, grain: 'x' | 'y' | 'z' = 'y', yaw = 0, small = false, wear = 0.15) {
  site.add(mat, chamferBox(sx, sy, sz, c, grain), at(x, y, z, yaw), { col, v: [0.3, 0.5, 0, wear] }, small);
}

/** four-sided band: boxes along each side of a square of half size h at height y */
function ring(site: Site, mat: MatKey, at: At, h: number, y: number, t: number, hgt: number, col?: RGB, c = 0.01) {
  for (let k = 0; k < 4; k++) {
    const yaw = (k * Math.PI) / 2;
    const [sx, sz] = [Math.sin(yaw), Math.cos(yaw)];
    box(site, mat, at, 2 * h + t, hgt, t, sx * h, y, sz * h, col, c, 'x', yaw);
  }
}

export interface PagodaOpts {
  x: number;
  z: number;
  y: number;
  /** yaw so the front (+z) faces the river */
  yaw: number;
}

export function buildPagoda(site: Site, o: PagodaOpts) {
  const rand = rng(1392);
  const base = trs(o.x, o.y, o.z, o.yaw);
  const at: At = (x, y, z, yaw = 0, pitch = 0, roll = 0) => base.clone().multiply(trs(x, y, z, yaw, pitch, roll));

  // kidan: dressed granite platform with steps on the front and back
  const K = 5.8, KH = 1.2;
  box(site, 'stone', at, 2 * K, KH + 0.6, 2 * K, 0, KH / 2 - 0.3, 0, [0.95, 0.95, 0.95], 0.04);
  box(site, 'dressed', at, 2 * K + 0.1, 0.18, 2 * K + 0.1, 0, KH - 0.06, 0, [1, 1, 1], 0.03);
  for (const f of [1, -1]) {
    for (let i = 0; i < 5; i++) {
      const d = 0.34 * (5 - i);
      const top = (KH * (i + 1)) / 5.2;
      box(site, 'dressed', at, 2.6, top + 0.3, d, 0, (top - 0.3) / 2, f * (K + d / 2), [0.95, 0.95, 0.93], 0.02, 'x');
    }
  }
  site.box(o.x, o.y + KH / 2 - 1, o.z, K, KH / 2 + 1, K, o.yaw, 0.05);

  const b = [3.2, 2.93, 2.66, 2.39, 2.12];
  const ys = [KH, KH + 4.8, KH + 8.4, KH + 12.0, KH + 15.6];
  for (let k = 0; k < 5; k++) {
    const bk = b[k];
    const y = ys[k];
    const wallH = k === 0 ? 2.9 : 1.9;
    const brH = k === 0 ? 0.7 : 0.55;
    // floor platform / balcony deck
    if (k > 0) {
      box(site, 'lacquer', at, 2 * (bk + 0.55), 0.12, 2 * (bk + 0.55), 0, y + 0.06, 0, VER, 0.01, 'x');
      balcony(site, at, bk + 0.5, y + 0.12, 0.72);
    } else {
      box(site, 'dressed', at, 2 * bk + 0.6, 0.12, 2 * bk + 0.6, 0, y + 0.02, 0, [1, 1, 1], 0.02);
    }
    // walls: white plaster between vermilion posts, 3 bays per side
    box(site, 'plaster', at, 2 * bk - 0.1, wallH, 2 * bk - 0.1, 0, y + 0.12 + wallH / 2, 0, WHITE, 0.01);
    const bay = (2 * bk) / 3;
    for (let s = 0; s < 4; s++) {
      const yaw = (s * Math.PI) / 2;
      const [ox, oz] = [Math.sin(yaw), Math.cos(yaw)];
      const [tx, tz] = [Math.cos(yaw), -Math.sin(yaw)];
      for (let i = 0; i <= 3; i++) {
        const a = -bk + i * bay;
        box(site, 'lacquer', at, 0.26, wallH, 0.26, ox * (bk - 0.02) + tx * a, y + 0.12 + wallH / 2, oz * (bk - 0.02) + tz * a, VER, 0.02);
      }
      // center bay: a pair of lacquered doors; side bays on the first storey: renji slat windows
      const dh = Math.min(wallH - 0.35, 2.2);
      box(site, 'lacquer', at, bay - 0.3, dh, 0.08, ox * (bk + 0.0), y + 0.12 + dh / 2, oz * (bk + 0.0), [0.36, 0.045, 0.02], 0.01, 'y', yaw);
      box(site, 'bronze', at, 0.05, 0.3, 0.1, ox * (bk + 0.03) + tx * 0.08, y + 0.12 + dh / 2, oz * (bk + 0.03) + tz * 0.08, [1, 1, 1], 0.01, 'y', yaw, true);
      if (k === 0) {
        for (const side of [-1, 1]) {
          const cx = side * bay;
          box(site, 'dark', at, bay - 0.4, 1.0, 0.03, ox * (bk - 0.04) + tx * cx, y + 1.6, oz * (bk - 0.04) + tz * cx, [0.03, 0.02, 0.015], 0, 'y', yaw);
          for (let j = 0; j < 9; j++) {
            const sx = cx - (bay - 0.5) / 2 + (j * (bay - 0.5)) / 8;
            box(site, 'lacquer', at, 0.06, 1.0, 0.06, ox * bk + tx * sx, y + 1.6, oz * bk + tz * sx, VER, 0.005, 'y', yaw);
          }
        }
      }
    }
    // tie beams and the stepped bracket band (tokyo) under the eave
    const yb = y + 0.12 + wallH;
    ring(site, 'lacquer', at, bk + 0.02, yb - 0.3, 0.22, 0.22, VER);
    for (let l = 0; l < 3; l++) {
      ring(site, 'lacquer', at, bk + 0.15 + l * 0.2, yb + 0.1 + l * (brH / 3.2), 0.28, brH / 3.4, l === 1 ? [0.9, 0.9, 0.85] : VER, 0.02);
    }
    // bracket blocks between the bands
    for (let s = 0; s < 4; s++) {
      const yaw = (s * Math.PI) / 2;
      const [ox, oz] = [Math.sin(yaw), Math.cos(yaw)];
      const [tx, tz] = [Math.cos(yaw), -Math.sin(yaw)];
      const n = 7;
      for (let i = 0; i < n; i++) {
        const a = -bk + 0.2 + (i * (2 * bk - 0.4)) / (n - 1);
        box(site, 'lacquer', at, 0.24, 0.16, 0.5, ox * (bk + 0.4) + tx * a, yb + brH * 0.55, oz * (bk + 0.4) + tz * a, VER, 0.02, 'z', yaw);
      }
    }
    // roof
    const eave = yb + brH + 0.12;
    const E = bk + (k === 0 ? 2.45 : 2.2);
    const next = k < 4 ? b[k + 1] + 0.62 : 0.62;
    const topY = k < 4 ? ys[k + 1] + 0.05 : eave + 2.3;
    roof(site, at(0, 0, 0), {
      ex: E, ez: E, tx: next, tz: next, y0: eave, rise: topY - eave, lift: k === 4 ? 0.62 : 0.55, flare: 0.45,
      thick: 0.42, sweep: 0.72, rafters: true, rafterMat: 'lacquer', rafterCol: VER, seg: 0.5,
    });
    // double rafter ends: a second row of lacquered rafter tips with white faces
    void rand;
  }

  // sorin: roban, fukubachi, lotus, nine rings, water flame, dragon wheel and jewel on a mast
  const sy = ys[4] + 0.12 + 1.9 + 0.55 + 0.12 + 2.3 - 0.35;
  box(site, 'bronze', at, 1.1, 0.5, 1.1, 0, sy + 0.25, 0, [1, 1, 1], 0.04);
  const hemi: number[][] = [];
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * (Math.PI / 2);
    hemi.push([Math.max(0.001, Math.cos(a) * 0.55), sy + 0.5 + Math.sin(a) * 0.45]);
  }
  site.add('bronze', lathe([[0.55, sy + 0.5], ...hemi], 20, true), at(0, 0, 0), { col: [1, 1, 1] });
  site.add('bronze', lathe([[0.12, sy + 0.95], [0.5, sy + 1.15], [0.46, sy + 1.2], [0.12, sy + 1.12]], 20, false), at(0, 0, 0), { col: [1, 1, 1] });
  const mast = sy + 1.1;
  site.add('bronze', cylinder(0.1, 0.07, 7.6, 10), at(0, mast, 0), { col: [1, 1, 1] });
  for (let i = 0; i < 9; i++) {
    const r = 0.44 - i * 0.012;
    site.add('bronze', torus(r, 0.045, Math.PI * 2, 24, 6), at(0, mast + 0.55 + i * 0.4, 0, 0, Math.PI / 2), { col: [1, 1, 1] });
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      site.add('bronze', chamferBox(0.02, 0.4, 0.02, 0), at(Math.cos(a) * r, mast + 0.75 + i * 0.4, Math.sin(a) * r), { col: [1, 1, 1] }, true);
    }
  }
  const fy = mast + 0.55 + 9 * 0.4;
  for (let k = 0; k < 4; k++) {
    const flame: number[][] = [[0.02, 0], [0.34, 0.25], [0.28, 0.7], [0.12, 1.0], [0.02, 1.15]];
    site.add('bronze', lathe(flame, 4, false, 0.3), at(0, fy, 0, (k * Math.PI) / 2 + Math.PI / 4, 0, 0).multiply(trs(0, 0, 0, 0, 0, 0, 1, 1, 0.08)), { col: [1, 1, 1] });
  }
  const ball: number[][] = [];
  for (let i = 0; i <= 8; i++) {
    const a = -Math.PI / 2 + (i / 8) * Math.PI;
    ball.push([Math.max(0.001, Math.cos(a) * 0.16), fy + 1.4 + Math.sin(a) * 0.16]);
  }
  site.add('bronze', lathe(ball, 12, true), at(0, 0, 0), { col: [1, 1, 1] });
  const jewel: number[][] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    jewel.push([Math.max(0.001, 0.2 * Math.sin(t * Math.PI) * (1 - t * 0.35)), fy + 1.65 + t * 0.5]);
  }
  site.add('bronze', lathe(jewel, 12, true), at(0, 0, 0), { col: [1, 1, 1] });
  return { top: fy + 2.15 };
}

function balcony(site: Site, at: At, h: number, y: number, rh: number) {
  for (let s = 0; s < 4; s++) {
    const yaw = (s * Math.PI) / 2;
    const [ox, oz] = [Math.sin(yaw), Math.cos(yaw)];
    const [tx, tz] = [Math.cos(yaw), -Math.sin(yaw)];
    const n = Math.round((2 * h) / 0.7);
    for (let i = 0; i <= n; i++) {
      const a = -h + (i * 2 * h) / n;
      box(site, 'lacquer', at, 0.07, rh, 0.07, ox * h + tx * a, y + rh / 2, oz * h + tz * a, VER, 0.008, 'y', 0, true);
    }
    box(site, 'lacquer', at, 2 * h + 0.1, 0.07, 0.09, ox * h, y + rh, oz * h, VER, 0.01, 'x', yaw);
    box(site, 'lacquer', at, 2 * h, 0.05, 0.05, ox * h, y + rh * 0.45, oz * h, VER, 0.008, 'x', yaw, true);
  }
}

/** main hall (hondo): vermilion posts, white walls, a veranda and a hip-and-gable roof */
export function buildHall(site: Site, o: PagodaOpts) {
  const base = trs(o.x, o.y, o.z, o.yaw);
  const at: At = (x, y, z, yaw = 0, pitch = 0, roll = 0) => base.clone().multiply(trs(x, y, z, yaw, pitch, roll));
  const bw = 5.2, bd = 4.0; // body half sizes (x along the river)
  const KH = 0.8;
  box(site, 'stone', at, 2 * bw + 3.2, KH + 0.5, 2 * bd + 3.2, 0, KH / 2 - 0.25, 0, [0.95, 0.95, 0.95], 0.04);
  box(site, 'dressed', at, 2 * bw + 3.3, 0.14, 2 * bd + 3.3, 0, KH - 0.05, 0, [1, 1, 1], 0.02);
  for (let i = 0; i < 4; i++) {
    const d = 0.34 * (4 - i);
    const top = (KH * (i + 1)) / 4.2;
    box(site, 'dressed', at, 3.2, top + 0.3, d, 0, (top - 0.3) / 2, bd + 1.6 + d / 2, [0.95, 0.95, 0.93], 0.02, 'x');
  }
  // veranda deck and railing
  box(site, 'deck', at, 2 * bw + 2.2, 0.1, 2 * bd + 2.2, 0, KH + 0.55, 0, [1.1, 1.05, 1], 0.01, 'x');
  for (const [hx, hz] of [[bw + 1.05, bd + 1.05]]) {
    for (let s = 0; s < 4; s++) {
      const yaw = (s * Math.PI) / 2;
      const half = s % 2 ? hz : hx;
      const dist = s % 2 ? hx : hz;
      const [ox, oz] = [Math.sin(yaw), Math.cos(yaw)];
      if (s === 0) {
        // opening for the stairs
        for (const side of [-1, 1]) box(site, 'lacquer', at, half - 1.6, 0.07, 0.08, side * (half + 1.6) / 2, KH + 1.25, dist, VER, 0.01, 'x');
      } else box(site, 'lacquer', at, 2 * half, 0.07, 0.08, ox * dist, KH + 1.25, oz * dist, VER, 0.01, 'x', yaw);
    }
  }
  const y0 = KH + 0.6;
  const wallH = 3.6;
  box(site, 'plaster', at, 2 * bw - 0.1, wallH, 2 * bd - 0.1, 0, y0 + wallH / 2, 0, WHITE, 0.01);
  // posts: 5 bays along, 4 across
  for (let i = 0; i <= 5; i++) for (const sz of [-1, 1]) {
    const x = -bw + (i * 2 * bw) / 5;
    box(site, 'lacquer', at, 0.3, wallH + 0.4, 0.3, x, y0 + (wallH + 0.4) / 2, sz * (bd - 0.02), VER, 0.02);
  }
  for (let i = 1; i < 4; i++) for (const sx of [-1, 1]) {
    const z = -bd + (i * 2 * bd) / 4;
    box(site, 'lacquer', at, 0.3, wallH + 0.4, 0.3, sx * (bw - 0.02), y0 + (wallH + 0.4) / 2, z, VER, 0.02);
  }
  // front: latticed doors (shitomi) across the middle three bays
  for (let i = 1; i < 4; i++) {
    const x = -bw + ((i + 0.5) * 2 * bw) / 5;
    const bwid = (2 * bw) / 5 - 0.4;
    box(site, 'dark', at, bwid, 2.8, 0.03, x, y0 + 1.5, bd + 0.02, [0.03, 0.02, 0.015], 0);
    for (let j = 0; j <= 8; j++) box(site, 'lacquer', at, 0.05, 2.8, 0.06, x - bwid / 2 + (j * bwid) / 8, y0 + 1.5, bd + 0.04, VER, 0.005, 'y', 0, true);
    for (let j = 0; j <= 10; j++) box(site, 'lacquer', at, bwid, 0.05, 0.06, x, y0 + 0.1 + (j * 2.8) / 10, bd + 0.05, VER, 0.005, 'x', 0, true);
  }
  // bracket band
  for (let l = 0; l < 3; l++) {
    const ex = bw + 0.1 + l * 0.2, ez = bd + 0.1 + l * 0.2;
    for (let s = 0; s < 4; s++) {
      const yaw = (s * Math.PI) / 2;
      const half = s % 2 ? ez : ex, dist = s % 2 ? ex : ez;
      box(site, 'lacquer', at, 2 * half + 0.3, 0.2, 0.3, Math.sin(yaw) * dist, y0 + wallH + 0.15 + l * 0.2, Math.cos(yaw) * dist, l === 1 ? [0.9, 0.9, 0.85] : VER, 0.02, 'x', yaw);
    }
  }
  // irimoya: hipped skirt, then a gable with plastered, latticed ends
  const eave = y0 + wallH + 0.9;
  const ex = bw + 2.3, ez = bd + 2.3;
  const tx = bw * 0.78, tz = bd * 0.42;
  const rise1 = 2.0;
  roof(site, at(0, 0, 0), { ex, ez, tx, tz, y0: eave, rise: rise1, lift: 0.5, flare: 0.4, thick: 0.4, sweep: 0.65, rafterMat: 'lacquer', rafterCol: VER, hips: true, ridge: false });
  const y1 = eave + rise1;
  const rise2 = tz * 1.25 + 0.4;
  roof(site, at(0, 0, 0), { ex: tx, ez: tz + 0.35, tx, tz: 0, y0: y1 - 0.25, rise: rise2, gable: true, verge: 0.35, rafters: false, thick: 0.3, sweep: 0.3 });
  for (const sx of [-1, 1]) {
    const gm = at(sx * tx, 0, 0, sx * Math.PI / 2);
    site.add('plaster', gableTri(tz + 0.1, y1 - 0.3, rise2 + 0.05, 0.25), gm, { col: WHITE, v: [0.05, 0.5, 0, 0] });
    // kitsuregoshi lattice on the gable
    for (let j = -4; j <= 4; j++) {
      const x = (j / 4) * (tz * 0.85);
      const hgt = (rise2 + 0.05) * (1 - Math.abs(x) / (tz + 0.1)) - 0.15;
      if (hgt > 0.1) site.add('lacquer', chamferBox(0.05, hgt, 0.04, 0.005), gm.clone().multiply(trs(x, y1 - 0.3 + hgt / 2, 0.03)), { col: VER, v: [0, 0, 0, 0.1] }, true);
    }
  }
  site.box(o.x, o.y + 1, o.z, bw + 1.6, 2, bd + 1.6, o.yaw, 0.05);
}

/** granite retaining wall with a batter along a straight run, and an optional stair in the middle */
export function terraceWall(site: Site, world: { heightAt(x: number, z: number): number }, ax: number, az: number, bx: number, bz: number, top: number, outX: number, outZ: number, stairAt?: number) {
  const len = Math.hypot(bx - ax, bz - az);
  const dx = (bx - ax) / len, dz = (bz - az) / len;
  const yaw = Math.atan2(outX, outZ);
  const segs = Math.max(1, Math.round(len / 4));
  for (let i = 0; i < segs; i++) {
    const t0 = (i / segs) * len, t1 = ((i + 1) / segs) * len;
    const tc = (t0 + t1) / 2;
    if (stairAt !== undefined && Math.abs(tc - stairAt) < 1.4 && len > 6) continue;
    const cx = ax + dx * tc, cz = az + dz * tc;
    let lo = Infinity;
    for (const t of [t0, tc, t1]) lo = Math.min(lo, world.heightAt(ax + dx * t + outX * 2.5, az + dz * t + outZ * 2.5));
    const bot = lo - 0.6;
    const h = top - bot;
    if (h < 0.4) continue;
    // battered face: lean back 1:5
    const lean = Math.atan(0.2);
    site.add('stone', chamferBox(t1 - t0 + 0.02, h / Math.cos(lean), 1.6, 0.03), trs(cx + outX * (h * 0.1 - 0.8), bot + h / 2, cz + outZ * (h * 0.1 - 0.8), yaw, -lean), { col: [0.95, 0.95, 0.95], uvo: [tc, 0] });
    site.add('dressed', chamferBox(t1 - t0 + 0.02, 0.2, 0.6, 0.03, 'x'), trs(cx - outX * 0.2, top + 0.02, cz - outZ * 0.2, yaw), { col: [0.95, 0.95, 0.93] });
  }
  if (stairAt !== undefined && len > 6) {
    const cx = ax + dx * stairAt, cz = az + dz * stairAt;
    const base = world.heightAt(cx + outX * 3, cz + outZ * 3);
    const rise = top - base;
    const n = Math.max(3, Math.ceil(rise / 0.17));
    const run = 0.32;
    for (let i = 0; i < n; i++) {
      const yTop = top - (rise * i) / n;
      const out = run * i;
      const bot = base - 0.4;
      site.add('dressed', chamferBox(2.6, yTop - bot, run + 0.01, 0.02, 'x'), trs(cx + outX * (out + run / 2 - 0.3), (yTop + bot) / 2, cz + outZ * (out + run / 2 - 0.3), yaw), { col: [0.9, 0.9, 0.88] });
    }
    for (const side of [-1, 1]) {
      const L = n * run;
      site.add('stone', chamferBox(0.5, rise + 0.5, L, 0.03), trs(cx + dx * side * 1.55 + outX * (L / 2 - 0.3), base + (rise + 0.5) / 2 - 0.4, cz + dz * side * 1.55 + outZ * (L / 2 - 0.3), yaw), { col: [0.95, 0.95, 0.95] });
    }
  }
}
