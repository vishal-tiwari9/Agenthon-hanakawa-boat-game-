// paper lanterns (chochin) hung from poles along the waterfront. geometry goes into a site's buckets;
// the returned point is the lantern center in world space (for gameplay / audio / night lights).
import { beam, cyl, lathe, rod, type V3 } from './geom';
import { C, jitter } from './parts';
import type { Site } from './site';
import type { LanternInfo } from './types';

/** body, rims and cap of one chochin hanging with its top at (x, y, z) (site-local) */
function chochin(site: Site, x: number, y: number, z: number, tint: V3, R: () => number, s = 1) {
  const gp = site.g('paper');
  gp.part({ tint, seed: R() });
  const hL = 0.46 * s;
  const prof: [number, number][] = [];
  for (let k = 0; k <= 12; k++) {
    const t = k / 12;
    prof.push([(0.115 + 0.09 * Math.sin(Math.PI * t)) * s, y - 0.05 * s - hL + t * hL]);
  }
  lathe(gp, x, z, prof, 16);
  const gb = site.g('plain');
  gb.part({ tint: C.black, wear: 0.45, seed: R() });
  // bottom and top rims, the little lid and the hook
  lathe(gb, x, z, [[0.085 * s, y - 0.07 * s - hL], [0.125 * s, y - 0.068 * s - hL], [0.128 * s, y - 0.03 * s - hL], [0.1 * s, y - 0.025 * s - hL]], 14);
  lathe(gb, x, z, [[0.1 * s, y - 0.06 * s], [0.128 * s, y - 0.057 * s], [0.125 * s, y - 0.02 * s], [0.06 * s, y - 0.005 * s], [0.012, y + 0.02 * s]], 14);
  return [x, y - 0.05 * s - hL / 2, z] as V3;
}

/**
 * a square timber post with an arm reaching toward the water (dir, site-local unit xz) and a chochin
 * hanging from its end. (x, z) is the post foot, y the ground.
 */
export function postLantern(site: Site, x: number, y: number, z: number, dir: [number, number], R: () => number, o: { height?: number; reach?: number; red?: boolean } = {}): LanternInfo {
  const h = o.height ?? 2.35, reach = o.reach ?? 0.55;
  const g = site.g('timber');
  g.part({ tint: jitter(C.pile, R, 0.12), wear: 0.35, seed: R(), grain: 1 });
  beam(g, [x, y - 0.3, z], [x, y + h, z], 0.1, 0.1, 0.012, [dir[0], 0, dir[1]]);
  const ax = x + dir[0] * reach, az = z + dir[1] * reach;
  g.part({ tint: jitter(C.pile, R, 0.12), wear: 0.35, seed: R() });
  beam(g, [x - dir[0] * 0.08, y + h - 0.12, z - dir[1] * 0.08], [ax + dir[0] * 0.06, y + h - 0.12, az + dir[1] * 0.06], 0.06, 0.08, 0.008, [0, 1, 0]);
  g.part({ tint: jitter(C.pile, R, 0.12), wear: 0.35, seed: R() });
  beam(g, [x, y + h - 0.55, z], [x + dir[0] * reach * 0.55, y + h - 0.15, z + dir[1] * reach * 0.55], 0.045, 0.06, 0.006, [-dir[1], 0, dir[0]]);
  const gb = site.g('plain');
  gb.part({ tint: C.black, wear: 0.5, seed: R() });
  rod(gb, [ax, y + h - 0.16, az], [ax, y + h - 0.32, az], 0.006, 4);
  const tint: V3 = o.red ? [0.85, 0.3, 0.2] : [1, 0.99, 0.96];
  const c = chochin(site, ax, y + h - 0.3, az, tint, R);
  const w = site.world(c[0], c[1], c[2]);
  return { x: w.x, y: w.y, z: w.z, kind: 'post' };
}

/** ref1's lantern: a bamboo pole curving out over the water with a chochin at its tip */
export function bambooLantern(site: Site, x: number, y: number, z: number, dir: [number, number], R: () => number): LanternInfo {
  const g = site.g('timber');
  const H = 3.1, reach = 1.05;
  const pts: V3[] = [];
  for (let k = 0; k <= 7; k++) {
    const t = k / 7;
    const out = reach * t * t;
    pts.push([x + dir[0] * out, y - 0.4 + (H + 0.4) * (1 - (1 - t) * (1 - t) * 0.08) * t, z + dir[1] * out]);
  }
  for (let k = 0; k < pts.length - 1; k++) {
    const r0 = 0.042 - k * 0.0035, r1 = 0.042 - (k + 1) * 0.0035;
    g.part({ tint: jitter(C.bamboo, R, 0.08, 0.06), wear: 0.25, seed: R(), grain: 1 });
    rod(g, pts[k], pts[k + 1], r0, 8, r1);
    // node rings
    g.part({ tint: jitter([0.22, 0.19, 0.1], R, 0.06), wear: 0.2, seed: R() });
    const p = pts[k + 1];
    cyl(g, p[0], p[2], p[1] - 0.012, p[1] + 0.012, r1 + 0.006, r1 + 0.006, 8, 0);
  }
  const tip = pts[pts.length - 1];
  const gb = site.g('plain');
  gb.part({ tint: C.black, wear: 0.5, seed: R() });
  rod(gb, [tip[0], tip[1] - 0.03, tip[2]], [tip[0], tip[1] - 0.42, tip[2]], 0.006, 4);
  const c = chochin(site, tip[0], tip[1] - 0.4, tip[2], [1, 0.99, 0.96], R, 1.12);
  const w = site.world(c[0], c[1], c[2]);
  return { x: w.x, y: w.y, z: w.z, kind: 'hanging' };
}
