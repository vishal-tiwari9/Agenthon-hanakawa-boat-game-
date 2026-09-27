// the lakeside teahouse on stilts and the water mill with its turning wheel.
import { Group, Mesh, type Matrix4 } from 'three/webgpu';
import { Bucket, chamferBox, cylinder, rng, trs, type RGB } from './geom';
import { BOARDS, COL, type Materials } from './materials';
import type { MatKey, Site } from './builder';
import { gableTri, roof } from './roofs';
import { chochin } from './machiya';

type At = (x: number, y: number, z: number, yaw?: number, pitch?: number, roll?: number) => Matrix4;

function box(site: Site, mat: MatKey, at: At, sx: number, sy: number, sz: number, x: number, y: number, z: number, col?: RGB, c = 0.01, grain: 'x' | 'y' | 'z' = 'y', yaw = 0, small = false) {
  site.add(mat, chamferBox(sx, sy, sz, c, grain), at(x, y, z, yaw), { col, v: [0.3, 0.5, 0, 0.15], uvo: [BOARDS.timber[Math.abs(Math.round(x * 7)) % 8], 0] }, small);
}

export interface PlacedOpts {
  x: number;
  z: number;
  y: number;
  /** yaw so +z faces the open water */
  yaw: number;
}

/**
 * chaya on stilts: a deck over the shallows with a small hipped pavilion, open shoji fronts, sudare
 * blinds, a railing and a walkway back to the bank. local +z faces the lake, -z the bank.
 */
export function buildTeahouse(site: Site, world: { heightAt(x: number, z: number): number }, o: PlacedOpts, toBank: number) {
  const rand = rng(1702);
  const base = trs(o.x, 0, o.z, o.yaw);
  const at: At = (x, y, z, yaw = 0, pitch = 0, roll = 0) => base.clone().multiply(trs(x, y, z, yaw, pitch, roll));
  const W = 9, D = 7, deckY = 1.15;
  // stilts in a grid, with bracing close to the water
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 3; j++) {
    const x = -W / 2 + 0.2 + (i * (W - 0.4)) / 4, z = -D / 2 + 0.2 + (j * (D - 0.4)) / 3;
    const c = base.clone().multiply(trs(x, 0, z));
    const wx = c.elements[12], wz = c.elements[14];
    const bed = Math.min(world.heightAt(wx, wz), -0.3) - 0.5;
    box(site, 'timber', at, 0.22, deckY - 0.12 - bed, 0.22, x, (deckY - 0.12 + bed) / 2, z, [1.1, 1.05, 1], 0.015);
  }
  for (let j = 0; j <= 3; j++) {
    const z = -D / 2 + 0.2 + (j * (D - 0.4)) / 3;
    box(site, 'timber', at, W, 0.14, 0.12, 0, 0.35, z, [1, 1, 1], 0.01, 'x');
    box(site, 'timber', at, W + 0.2, 0.22, 0.18, 0, deckY - 0.2, z, [1, 1, 1], 0.01, 'x');
  }
  // deck boards
  const nb = Math.floor(D / 0.2);
  for (let k = 0; k < nb; k++) {
    site.add('deck', chamferBox(W + 0.1, 0.05, 0.19, 0.005, 'x'), at((rand() - 0.5) * 0.03, deckY - 0.03, -D / 2 + 0.1 + k * 0.2), { uvo: [BOARDS.grey[k % 5], rand()], col: [0.95 + rand() * 0.15, 0.95, 0.92] });
  }
  // railing around the lake sides
  for (const [x0, z0, x1, z1] of [[-W / 2 + 0.1, D / 2 - 0.1, W / 2 - 0.1, D / 2 - 0.1], [-W / 2 + 0.1, -D / 2 + 0.1, -W / 2 + 0.1, D / 2 - 0.1], [W / 2 - 0.1, -D / 2 + 0.1, W / 2 - 0.1, D / 2 - 0.1]]) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const yaw = Math.atan2(x1 - x0, z1 - z0);
    const n = Math.round(len / 1.1);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      box(site, 'timber', at, 0.09, 0.8, 0.09, x0 + (x1 - x0) * t, deckY + 0.4, z0 + (z1 - z0) * t, [1, 1, 1], 0.01, 'y', 0, true);
    }
    site.add('timber', chamferBox(0.08, 0.07, len, 0.01, 'z'), at((x0 + x1) / 2, deckY + 0.78, (z0 + z1) / 2, yaw), {});
    site.add('timber', chamferBox(0.05, 0.05, len, 0.005, 'z'), at((x0 + x1) / 2, deckY + 0.35, (z0 + z1) / 2, yaw), {}, true);
  }
  // pavilion: posts, low plaster walls at the back, shoji fronts half open, sudare
  const bw = 3.0, bd = 2.2, py = deckY, ph = 2.5;
  const bz = -D / 2 + bd + 0.6;
  for (const sx of [-1, 0, 1]) for (const sz of [-1, 1]) box(site, 'timber', at, 0.16, ph, 0.16, sx * bw, py + ph / 2, bz + sz * bd, [1.1, 1.0, 0.95], 0.015);
  for (const sz of [-1]) box(site, 'plaster', at, 2 * bw, ph, 0.12, 0, py + ph / 2, bz + sz * bd, [1, 0.98, 0.95], 0.01, 'x');
  for (const sx of [-1, 1]) {
    box(site, 'plaster', at, 0.12, ph * 0.45, 2 * bd, sx * bw, py + ph * 0.225, bz, [1, 0.98, 0.95], 0.01);
    box(site, 'shoji', at, 0.03, ph * 0.5, 2 * bd - 0.2, sx * bw, py + ph * 0.7, bz, [0.74, 0.7, 0.6]);
  }
  for (let i = 0; i < 4; i++) {
    const x = -bw + 0.75 + i * 1.5;
    if (i === 1 || i === 2) continue;
    box(site, 'shoji', at, 1.45, ph - 0.25, 0.03, x, py + (ph - 0.25) / 2, bz + bd - 0.02, [0.74, 0.7, 0.6]);
  }
  box(site, 'dark', at, 2 * bw - 0.2, ph - 0.1, 0.02, 0, py + ph / 2, bz - bd + 0.08, [0.05, 0.04, 0.03]);
  box(site, 'deck', at, 2 * bw - 0.2, 0.06, 2 * bd - 0.2, 0, py + 0.08, bz, [0.75, 0.72, 0.55]);
  box(site, 'bamboo', at, 2 * bw * 0.8, 0.9, 0.012, 0, py + ph - 0.55, bz + bd + 0.35, [0.95, 0.88, 0.75]);
  box(site, 'timber', at, 2 * bw + 0.3, 0.2, 0.2, 0, py + ph + 0.05, bz + bd, [1, 1, 1], 0.01, 'x');
  box(site, 'timber', at, 2 * bw + 0.3, 0.2, 0.2, 0, py + ph + 0.05, bz - bd, [1, 1, 1], 0.01, 'x');
  // hipped roof with a gentle sweep
  roof(site, at(0, 0, bz), { ex: bw + 1.3, ez: bd + 1.3, tx: bw * 0.45, tz: 0, y0: py + ph + 0.3, rise: 2.1, lift: 0.3, flare: 0.25, thick: 0.28, sweep: 0.55 });
  // cushions and a low table on the open front, lanterns at the corners
  box(site, 'deck', at, 1.2, 0.3, 0.7, 0.6, deckY + 0.15, D / 2 - 1.6, [1.3, 1.2, 1.1], 0.02, 'x', 0, true);
  for (const sx of [-1, 1]) {
    box(site, 'dark', at, 0.5, 0.08, 0.5, 0.6 + sx * 0.9, deckY + 0.04, D / 2 - 1.6, [0.35, 0.05, 0.04], 0.02, 'x', 0, true);
    chochin(site, at(sx * (bw + 1.1), py + ph - 0.25, bz + bd + 1.1), 0.18, 0.42, COL.paperWarm, 0.35);
  }
  // walkway back to the bank
  const wl = toBank + 1.5;
  for (let k = 0; k < Math.floor(wl / 0.2); k++) {
    site.add('deck', chamferBox(1.6, 0.05, 0.19, 0.005, 'x'), at(-W / 2 + 1.4, deckY - 0.03, -D / 2 - 0.1 - k * 0.2), { uvo: [BOARDS.grey[k % 5], rand()] });
  }
  for (let k = 0; k <= Math.floor(wl / 2); k++) {
    const z = -D / 2 - 0.2 - k * 2;
    for (const sx of [-0.7, 0.7]) {
      const c = base.clone().multiply(trs(-W / 2 + 1.4 + sx, 0, z));
      const bed = Math.min(world.heightAt(c.elements[12], c.elements[14]), deckY - 0.3) - 0.5;
      box(site, 'timber', at, 0.14, deckY - bed, 0.14, -W / 2 + 1.4 + sx, (deckY + bed) / 2 - 0.05, z, [1, 1, 1], 0.01);
    }
  }
  // collider: the whole stilt platform
  site.box(o.x, (deckY - 2.2) / 2, o.z, W / 2 + 0.1, (deckY + 2.2) / 2, D / 2 + 0.1, o.yaw, 0.2);
}

export interface MillBuild {
  wheel: Group;
}

/**
 * suisha-goya: a boarded mill hut close to the edge, an undershot wheel standing in the river with
 * its axle running into the hut, a bearing post, a millstone leaning by the door.
 * local +z faces the river.
 */
export function buildMill(site: Site, mats: Materials, o: PlacedOpts, toEdge: number): MillBuild {
  const rand = rng(1992);
  const base = trs(o.x, o.y, o.z, o.yaw);
  const at: At = (x, y, z, yaw = 0, pitch = 0, roll = 0) => base.clone().multiply(trs(x, y, z, yaw, pitch, roll));
  const hw = 3.2, hd = 2.6, H = 3.2;
  site.add('dressed', chamferBox(2 * hw + 0.2, 0.5, 2 * hd + 0.2, 0.03), at(0, -0.1, 0), { col: [0.85, 0.85, 0.84] });
  site.add('cedar', chamferBox(2 * hw, H, 2 * hd, 0), at(0, H / 2 + 0.15, 0), { uvo: [0.4, 0], col: [1.15, 1.1, 1.05] });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(site, 'timber', at, 0.18, H, 0.18, sx * (hw - 0.05), H / 2 + 0.15, sz * (hd - 0.05), [1, 1, 1], 0.015);
  box(site, 'timber', at, 2 * hw + 0.1, 0.2, 0.2, 0, H + 0.1, hd, [1, 1, 1], 0.01, 'x');
  box(site, 'dark', at, 1.3, 2.0, 0.03, -hw + 1.3, 1.15, hd + 0.01, [0.03, 0.025, 0.02]);
  box(site, 'timber', at, 1.1, 2.0, 0.05, -hw + 1.6, 1.15, hd + 0.03, [1.2, 1.1, 1.0], 0.01);
  box(site, 'shoji', at, 1.2, 0.7, 0.02, hw - 1.4, 2.1, hd + 0.01, [0.72, 0.68, 0.58]);
  for (let i = 0; i <= 6; i++) box(site, 'timber', at, 0.035, 0.7, 0.04, hw - 2.0 + i * 0.2, 2.1, hd + 0.03, [1, 1, 1], 0, 'y', 0, true);
  const pitch = 0.62, ov = 0.7;
  roof(site, at(0, 0, 0), { ex: hw, ez: hd + ov, tx: hw, tz: 0, y0: H + 0.15, rise: (hd + ov) * pitch, gable: true, verge: 0.45, rafters: true, thick: 0.22, sweep: 0.3 });
  for (const sx of [-1, 1]) site.add('cedar', gableTri(hd, H + 0.1, hd * pitch + 0.2, 0.15), at(sx * (hw - 0.02), 0, 0, sx * Math.PI / 2), { uvo: [0.4, 0] });
  // millstone leaning against the wall, a basket and sacks by the door
  site.add('dressed', cylinder(0.55, 0.55, 0.22, 20), at(-hw - 0.15, 0.55, 0.6, 0, 0, Math.PI / 2 - 0.2), { col: [0.9, 0.9, 0.88] });
  site.prop('basket', at(-hw + 2.6, 0.15, hd + 0.5, rand() * 6), true);

  // wheel: in the river, axle across toward the hut
  const R = 2.15, Wd = 0.85;
  const wheelZ = toEdge + 1.1; // wheel center out over the water (local +z is toward the river)
  const axleY = 1.85;
  const wheel = new Group();
  wheel.name = 'structures:mill-wheel';
  const bk = new Bucket();
  const N = 18;
  for (const side of [-1, 1]) {
    const x = (side * Wd) / 2;
    // rim of short straight segments
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const len = 2 * R * Math.sin(Math.PI / N) + 0.02;
      bk.add(chamferBox(0.09, 0.16, len, 0.01, 'z'), trs(x, Math.cos(am) * (R - 0.08), Math.sin(am) * (R - 0.08), 0, am), { col: [1.1, 1.05, 1.0] });
    }
    // spokes
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      bk.add(chamferBox(0.08, R - 0.25, 0.1, 0.01, 'y'), trs(x, Math.cos(a) * (R - 0.25) / 2, Math.sin(a) * (R - 0.25) / 2, 0, a), { col: [1.1, 1.05, 1.0] });
    }
  }
  // paddles between the rims
  for (let i = 0; i < N; i++) {
    const a = ((i + 0.5) / N) * Math.PI * 2;
    bk.add(chamferBox(Wd + 0.08, 0.5, 0.035, 0.005, 'x'), trs(0, Math.cos(a) * (R - 0.22), Math.sin(a) * (R - 0.22), 0, a), { col: [1.05, 1.0, 0.95] });
  }
  // hub
  bk.add(cylinder(0.28, 0.28, Wd + 0.3, 12), trs(-(Wd + 0.3) / 2, 0, 0, 0, 0, -Math.PI / 2), { col: [1, 1, 1] });
  const geo = bk.build()!;
  const wm = new Mesh(geo, mats.timber);
  wm.castShadow = true;
  wm.receiveShadow = true;
  wheel.add(wm);
  const wp = base.clone().multiply(trs(0, axleY - o.y, wheelZ, Math.PI / 2));
  wheel.matrixAutoUpdate = true;
  wp.decompose(wheel.position, wheel.quaternion, wheel.scale);
  // axle and a bearing post at the bank
  const axleLen = wheelZ - hd + 0.2;
  site.add('timber', cylinder(0.12, 0.12, axleLen, 10), at(0, axleY - o.y, hd - 0.1, 0, Math.PI / 2), { col: [1, 1, 1] });
  box(site, 'timber', at, 0.3, axleY - o.y + 0.9, 0.3, 0, (axleY - o.y + 0.9) / 2 - 0.7, toEdge - 0.3, [1, 1, 1], 0.02);
  // millrace guide walls in the water, and a collider around the wheel
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const x = sx * (Wd / 2 + 0.35);
      box(site, 'timber', at, 0.14, 2.2, 0.14, -3 + k * 2 + 0.0, 0.1 - 1.0, wheelZ + x * 0 + sx * 0.9, [1, 1, 1], 0.01);
    }
    site.add('deck', chamferBox(6.6, 0.6, 0.06, 0.005, 'x'), at(0, 0.05, wheelZ + sx * 0.9), { col: [0.9, 0.85, 0.8] });
  }
  const wc = base.clone().multiply(trs(0, 0, wheelZ));
  site.box(wc.elements[12], 0.2, wc.elements[14], 3.3, 1.2, 1.2, o.yaw, 0.2);
  void rand;
  return { wheel };
}
