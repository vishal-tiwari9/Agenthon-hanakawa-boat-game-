// the riverside shrine (a small nagare-style hokora on a granite base, toro lanterns, a vermilion
// torii with a shimenawa, a stone path) and the torii generator used for the water gate.
import type { Matrix4 } from 'three/webgpu';
import { chamferBox, cylinder, lathe, rng, trs, type RGB } from './geom';
import { COL } from './materials';
import { placeHash, type Site } from './builder';
import { roof } from './roofs';

type At = (x: number, y: number, z: number, yaw?: number, pitch?: number, roll?: number) => Matrix4;

/**
 * myojin torii at matrix m (ground at y = 0, gate facing +z). h = post height, span = post spacing.
 * `wade` extends the posts below y = 0 (water torii) with black sleeves at the waterline.
 */
export function torii(site: Site, m: Matrix4, h: number, span: number, wade = 0) {
  const at: At = (x, y, z, yaw = 0, pitch = 0, roll = 0) => m.clone().multiply(trs(x, y, z, yaw, pitch, roll));
  const r = h * 0.042;
  const lean = 0.035; // posts lean slightly inward (uchikorobi)
  for (const sx of [-1, 1]) {
    const bot = -wade;
    const len = h - bot;
    site.add('lacquer', cylinder(r * 1.08, r * 0.92, len, 18), at(sx * span / 2, bot, 0, 0, 0, sx * lean), { col: COL.vermilion, v: [0, 0, 0, 0.25] });
    // black sleeve (nemaki) at the base or waterline
    const sy = wade > 0 ? -0.2 : 0;
    site.add('dark', cylinder(r * 1.22, r * 1.18, wade > 0 ? 0.9 : 0.5, 18), at(sx * span / 2 + sx * sy * lean, sy, 0, 0, 0, sx * lean), { col: [0.02, 0.02, 0.02] });
    if (wade === 0) site.add('dressed', cylinder(r * 1.9, r * 2.1, 0.25, 12), at(sx * span / 2, -0.1, 0), { col: [0.9, 0.9, 0.9] });
  }
  // nuki tie beam through the posts, projecting past them
  const ny = h * 0.72;
  site.add('lacquer', chamferBox(span + r * 7, h * 0.07, h * 0.045, 0.01, 'x'), at(0, ny, 0), { col: COL.vermilion, v: [0, 0, 0, 0.25] });
  // gakuzuka strut and plaque
  site.add('lacquer', chamferBox(r * 0.9, h * 0.13, r * 0.9, 0.01), at(0, ny + h * 0.1, 0), { col: COL.vermilion, v: [0, 0, 0, 0.2] });
  site.add('dark', chamferBox(span * 0.16, h * 0.14, 0.06, 0.01), at(0, ny + h * 0.1, r * 0.5), { col: [0.03, 0.025, 0.02] });
  // shimaki and kasagi: two lintels, the top one upswept at the ends with a black cap
  const ky = h * 0.93;
  site.add('lacquer', chamferBox(span + r * 9, h * 0.06, h * 0.07, 0.01, 'x'), at(0, ky, 0), { col: COL.vermilion, v: [0, 0, 0, 0.25] });
  const L = span + r * 14;
  const n = 10;
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    const x0 = -L / 2 + L * t0, x1 = -L / 2 + L * t1;
    const up = (x: number) => Math.pow(Math.abs(x) / (L / 2), 3) * h * 0.06;
    const y0 = ky + h * 0.07 + up(x0), y1 = ky + h * 0.07 + up(x1);
    const len = Math.hypot(x1 - x0, y1 - y0);
    const roll = Math.atan2(y1 - y0, x1 - x0);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    site.add('lacquer', chamferBox(len + 0.01, h * 0.055, h * 0.08, 0.008, 'x'), at(cx, cy, 0, 0, 0, roll), { col: COL.vermilion, v: [0, 0, 0, 0.25] });
    site.add('dark', chamferBox(len + 0.01, h * 0.035, h * 0.095, 0.01, 'x'), at(cx, cy + h * 0.045, 0, 0, 0, roll), { col: [0.015, 0.014, 0.013] });
  }
}

/** ishidoro: a granite lantern with a firebox and curled roof, base at y = 0 */
export function toro(site: Site, m: Matrix4, h = 2.0) {
  const at: At = (x, y, z, yaw = 0) => m.clone().multiply(trs(x, y, z, yaw));
  const k = h / 2.0;
  site.add('dressed', chamferBox(0.62 * k, 0.16 * k, 0.62 * k, 0.03), at(0, 0.08 * k, 0), {});
  site.add('dressed', lathe([[0.26 * k, 0.16 * k], [0.18 * k, 0.24 * k], [0.13 * k, 0.3 * k], [0.12 * k, 0.9 * k], [0.14 * k, 0.96 * k], [0.3 * k, 1.02 * k], [0.3 * k, 1.1 * k], [0.001, 1.1 * k]], 8, false, 0.2), at(0, 0, 0, Math.PI / 8), {});
  // firebox with dark openings that burn at night (aVar.y marks the fire, aVar.x its flicker phase)
  site.add('dressed', chamferBox(0.36 * k, 0.34 * k, 0.36 * k, 0.02), at(0, 1.27 * k, 0), {});
  const fire = placeHash(m);
  for (let s = 0; s < 2; s++) site.add('dark', chamferBox(0.2 * k, 0.2 * k, 0.37 * k, 0), at(0, 1.28 * k, 0, (s * Math.PI) / 2), { col: [0.02, 0.018, 0.015], v: [fire, 1, 0, 0] }, true);
  // roof: six-sided cap with upturned corners
  site.add('dressed', lathe([[0.001, 1.44 * k], [0.5 * k, 1.44 * k], [0.52 * k, 1.5 * k], [0.3 * k, 1.64 * k], [0.12 * k, 1.72 * k], [0.001, 1.74 * k]], 6, false, 0.3), at(0, 0, 0), {});
  site.add('dressed', lathe([[0.001, 1.72 * k], [0.09 * k, 1.74 * k], [0.1 * k, 1.84 * k], [0.05 * k, 1.95 * k], [0.001, 2.0 * k]], 8, true, 0.1), at(0, 0, 0), {});
}

/** shimenawa straw rope with shide paper zigzags, hung between two points at height y */
function shimenawa(site: Site, m: Matrix4, half: number, y: number, rand: () => number) {
  const n = 12;
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    const x0 = -half + 2 * half * t0, x1 = -half + 2 * half * t1;
    const s0 = -Math.sin(t0 * Math.PI) * 0.12, s1 = -Math.sin(t1 * Math.PI) * 0.12;
    const thick = 0.06 + 0.05 * Math.sin(((t0 + t1) / 2) * Math.PI);
    const len = Math.hypot(x1 - x0, s1 - s0);
    site.add('rope', cylinder(thick, thick, len, 8, false), m.clone().multiply(trs(x0, y + s0, 0, 0, 0, -Math.PI / 2 + Math.atan2(s1 - s0, x1 - x0))), { col: COL.straw }, true);
  }
  for (const t of [0.25, 0.5, 0.75]) {
    const x = -half + 2 * half * t;
    const sy = y - Math.sin(t * Math.PI) * 0.12 - 0.1;
    for (let z = 0; z < 4; z++) {
      site.add('paper', chamferBox(0.09, 0.09, 0.005, 0), m.clone().multiply(trs(x + (z % 2 ? 0.04 : -0.04), sy - z * 0.085, 0.07, 0, 0, (rand() - 0.5) * 0.2)), { col: [0.82, 0.8, 0.74] }, true);
    }
  }
}

export interface ShrineOpts {
  x: number;
  z: number;
  y: number;
  /** yaw so +z faces the river */
  yaw: number;
  /** distance from the shrine center to the water's edge (path length) */
  toEdge: number;
}

export function buildShrine(site: Site, o: ShrineOpts) {
  const rand = rng(272);
  const base = trs(o.x, o.y, o.z, o.yaw);
  const at: At = (x, y, z, yaw = 0, pitch = 0, roll = 0) => base.clone().multiply(trs(x, y, z, yaw, pitch, roll));
  // granite base: two courses of blocks and a dressed top slab
  const bw = 1.7, bd = 1.5;
  site.add('stone', chamferBox(2 * bw + 0.5, 0.9, 2 * bd + 0.5, 0.04), at(0, 0.25, -1.5), { col: [0.95, 0.95, 0.95] });
  site.add('dressed', chamferBox(2 * bw + 0.3, 0.15, 2 * bd + 0.3, 0.02, 'x'), at(0, 0.75, -1.5), {});
  for (let i = 0; i < 3; i++) site.add('dressed', chamferBox(1.2, 0.2 * (i + 1) + 0.2, 0.3, 0.02, 'x'), at(0, 0.1 * (i + 1) - 0.1, -1.5 + bd + 0.35 + 0.3 * (2 - i)), {});
  // honden: dark aged cedar on posts, latticed doors, a nagare roof sweeping forward
  const y0 = 0.85;
  const hw = 1.05, hd = 0.8;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) site.add('timber', chamferBox(0.14, 1.6, 0.14, 0.01), at(sx * hw, y0 + 0.8, -1.5 + sz * hd), { col: [1.2, 1.1, 1.0] });
  site.add('cedar', chamferBox(2 * hw, 1.45, 2 * hd - 0.1, 0), at(0, y0 + 0.78, -1.55), { uvo: [0.3, 0] });
  site.add('dark', chamferBox(1.2, 1.0, 0.02, 0), at(0, y0 + 0.75, -1.5 + hd - 0.02), { col: [0.03, 0.022, 0.016] });
  for (let i = 0; i <= 8; i++) site.add('timber', chamferBox(0.03, 1.0, 0.03, 0), at(-0.6 + i * 0.15, y0 + 0.75, -1.5 + hd), { col: [1.2, 1.1, 1.0] }, true);
  // front veranda boards and a little rail
  site.add('deck', chamferBox(2 * hw + 0.2, 0.06, 0.55, 0.01, 'x'), at(0, y0 + 0.02, -1.5 + hd + 0.3), { col: [1.1, 1.0, 0.95] });
  site.add('timber', chamferBox(2 * hw, 0.14, 0.1, 0.01, 'x'), at(0, y0 + 1.62, -1.5 + hd), {});
  // nagare-zukuri: front slope much longer than the back, both ends gabled
  roof(site, at(0, 0, -1.5), { ex: hw + 0.05, ez: hd + 1.25, tx: hw + 0.05, tz: 0, y0: y0 + 1.55, rise: 1.25, gable: true, verge: 0.3, rafters: false, thick: 0.16, sweep: 0.55, sides: [0], seg: 0.4 });
  roof(site, at(0, 0, -1.5), { ex: hw + 0.05, ez: hd + 0.45, tx: hw + 0.05, tz: 0, y0: y0 + 2.5, rise: 0.3, gable: true, verge: 0.3, rafters: false, thick: 0.16, sweep: 0.3, sides: [2], seg: 0.4, ridge: false });
  // offering box
  site.add('timber', chamferBox(0.7, 0.45, 0.4, 0.02), at(0, 0.23, -1.5 + bd + 1.2), { col: [1.3, 1.2, 1.1] }, true);
  // toro pair and a gravel-edged stone path toward the river, the torii at the path's head
  for (const sx of [-1, 1]) toro(site, at(sx * 1.9, 0, 1.2), 1.9);
  const pathLen = Math.max(4, o.toEdge - 1.6);
  for (let i = 0; i < Math.floor(pathLen / 0.75); i++) {
    const z = 1.0 + i * 0.75;
    site.add('dressed', chamferBox(0.9 + (rand() - 0.5) * 0.2, 0.12, 0.6, 0.03, 'x'), at((rand() - 0.5) * 0.1, 0.02, z, (rand() - 0.5) * 0.1), { col: [0.92, 0.92, 0.9] }, true);
  }
  const tz = Math.min(pathLen - 0.5, 4.2);
  torii(site, at(0, 0, tz), 3.4, 2.4);
  shimenawa(site, at(0, 0, tz + 0.12), 1.15, 2.5, rand);
  // shimenawa across the shrine front too
  shimenawa(site, at(0, 0, -1.5 + hd + 0.12), hw, y0 + 1.5, rand);
}

export function waterTorii(site: Site, m: Matrix4) {
  torii(site, m, 6.8, 4.6, 1.6);
}

export const TORII_COLOR: RGB = COL.vermilion;
