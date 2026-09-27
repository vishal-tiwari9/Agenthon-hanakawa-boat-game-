// village buildings: machiya townhouses (full or low second floor), kura storehouses and shops.
// local frame: origin at the footprint center on the ground, +z is the river-facing facade, x runs
// along the river. dark cedar boards, koshi lattice with shoji behind, a tiled pent roof on
// brackets, white plaster above, kawara gable roofs, noren, paper lanterns and bamboo fences.
import type { Matrix4 } from 'three/webgpu';
import { chamferBox, cylinder, lathe, rng, trs, type Part, type RGB } from './geom';
import { BOARDS, COL } from './materials';
import type { MatKey, Site } from './builder';
import { gableTri, roof } from './roofs';

export interface HouseSpec {
  kind: 'machiya' | 'machiya-low' | 'kura' | 'shop';
  x: number;
  z: number;
  y: number;
  /** three.js yaw so local +z faces the river */
  yaw: number;
  w: number;
  d: number;
  seed: number;
  veranda?: boolean;
  /** distance from the facade to the water's edge (veranda length) */
  front?: number;
}

type At = (x: number, y: number, z: number, yaw?: number, pitch?: number, roll?: number) => Matrix4;

const TIMBER: RGB = [1, 1, 1];

function box(site: Site, mat: MatKey, at: At, sx: number, sy: number, sz: number, x: number, y: number, z: number, o: { c?: number; grain?: 'x' | 'y' | 'z'; col?: RGB; v?: [number, number, number, number]; uvo?: [number, number]; yaw?: number } = {}, small = false) {
  site.add(mat, chamferBox(sx, sy, sz, o.c ?? 0, o.grain ?? 'y'), at(x, y, z, o.yaw ?? 0), { col: o.col, v: o.v, uvo: o.uvo }, small);
}

export function buildHouse(site: Site, s: HouseSpec) {
  const rand = rng(s.seed);
  const R = (a: number, b: number) => a + (b - a) * rand();
  const base = trs(s.x, s.y, s.z, s.yaw);
  const at: At = (x, y, z, yaw = 0, pitch = 0, roll = 0) => base.clone().multiply(trs(x, y, z, yaw, pitch, roll));
  const { w, d } = s;
  const hw = w / 2, hd = d / 2;
  const grime: [number, number, number, number] = [R(0.5, 0.9), R(0, 1), s.y + 0.25, 0];
  // plaster palette per house: warm cream, earthen ochre (kyo-kabe), pale apricot, a few crisp white,
  // so a street reads as a mix of real traditional finishes rather than uniform white
  const pick = rand();
  const tone: RGB = pick < 0.34 ? [1.0, 0.95, 0.84] : pick < 0.62 ? [0.98, 0.8, 0.56] : pick < 0.82 ? [1.02, 0.88, 0.74] : [1.0, 0.99, 0.96];
  const white: RGB = [tone[0] * R(0.97, 1.02), tone[1] * R(0.97, 1.01), tone[2] * R(0.95, 1.0)];
  // about a third of the houses have bengara (red-ochre) lacquered lattice fronts
  const bengara: RGB | undefined = rand() < 0.34 ? [1.35, 0.62, 0.42] : undefined;

  // stone footing band all round
  box(site, 'dressed', at, w + 0.12, 0.5, d + 0.12, 0, -0.1, 0, { c: 0.03, col: [0.85, 0.85, 0.84] });

  if (s.kind === 'kura') {
    kura(site, at, s, rand, grime, white);
    return;
  }

  const G = 3.05; // ground floor height to the pent roof beam
  const low = s.kind === 'machiya-low';
  const H2 = low ? 1.95 : 2.55;
  const eaveY = G + 0.35 + H2;
  const fz = hd; // facade plane

  // ground floor core (cedar boards on sides/back; front hidden behind lattice and shoji)
  box(site, 'cedar', at, w - 0.04, G + 0.1, d - 0.4, 0, (G + 0.1) / 2 + 0.15, -0.2, { grain: 'y', uvo: [R(0, 2), 0] });
  // upper floor: plastered volume set slightly back
  box(site, 'plaster', at, w, H2 + 0.35, d - 0.1, 0, G + (H2 + 0.35) / 2, -0.05, { col: white, v: [grime[0] * 0.4, grime[1], s.y + G, 0], uvo: [R(0, 3), R(0, 3)] });
  // cedar skirt on the upper side walls and a tie beam line at the floor level
  for (const sx of [-1, 1]) {
    box(site, 'cedar', at, 0.03, 0.8, d - 0.1, sx * (hw + 0.012), G + 0.4, -0.05, { grain: 'y', uvo: [R(0, 2), 0] });
  }

  // posts and beams on the facade
  const post = (x: number, y0: number, y1: number, zz = fz - 0.06, t = 0.15) => box(site, 'timber', at, t, y1 - y0, t, x, (y0 + y1) / 2, zz, { c: 0.012, uvo: [BOARDS.timber[Math.floor(rand() * 8)], R(0, 2)] });
  post(-hw + 0.075, 0.1, eaveY);
  post(hw - 0.075, 0.1, eaveY);
  // head beam over the ground floor and the floor beam above the pent roof
  box(site, 'timber', at, w + 0.1, 0.26, 0.2, 0, G - 0.05, fz - 0.05, { c: 0.015, grain: 'x', uvo: [BOARDS.timber[2], 0] });
  box(site, 'timber', at, w, 0.16, 0.16, 0, eaveY - 0.12, fz - 0.1, { c: 0.012, grain: 'x', uvo: [BOARDS.timber[4], 0] });
  // side posts and the floor beam on the gable walls
  for (const sx of [-1, 1]) {
    for (const zz of [hd - 0.08, 0, -hd + 0.08]) post(sx * (hw - 0.06), 0.1, eaveY, zz, 0.14);
    box(site, 'timber', at, 0.14, 0.2, d - 0.1, sx * (hw - 0.05), G + 0.25, -0.05, { c: 0.012, grain: 'z', uvo: [BOARDS.timber[5], 0] });
  }

  // ground floor bays: entrance + lattice
  const doorW = s.kind === 'shop' ? Math.min(3.4, w - 1.4) : 1.7;
  const doorX = s.kind === 'shop' ? 0 : (rand() < 0.5 ? -1 : 1) * (hw - doorW / 2 - 0.5);
  const bays: [number, number][] = [];
  {
    const d0 = doorX - doorW / 2, d1 = doorX + doorW / 2;
    if (d0 - (-hw + 0.15) > 0.5) bays.push([-hw + 0.15, d0 - 0.075]);
    if (hw - 0.15 - d1 > 0.5) bays.push([d1 + 0.075, hw - 0.15]);
    post(d0 - 0.04, 0.1, G - 0.15, fz - 0.08, 0.13);
    post(d1 + 0.04, 0.1, G - 0.15, fz - 0.08, 0.13);
  }
  for (const [x0, x1] of bays) {
    // low sill, lattice of close-set slats, head rail
    box(site, 'timber', at, x1 - x0, 0.3, 0.12, (x0 + x1) / 2, 0.3, fz - 0.1, { c: 0.01, grain: 'x', uvo: [BOARDS.timber[1], 0] });
    box(site, 'timber', at, x1 - x0, 0.1, 0.1, (x0 + x1) / 2, 2.38, fz - 0.1, { c: 0.01, grain: 'x', uvo: [BOARDS.timber[3], 0] });
    koshi(site, at, x0, x1, 0.45, 2.33, fz - 0.08, rand, bengara);
    // board fascia between the lattice head and the beam
    box(site, 'cedar', at, x1 - x0, G - 2.45 - 0.15, 0.05, (x0 + x1) / 2, (2.43 + G - 0.18) / 2, fz - 0.14, { grain: 'y', uvo: [R(0, 2), 0] });
    // inuyarai: curved bamboo guards along the foot of the lattice
    if (rand() < 0.45 && s.kind !== 'shop') inuyarai(site, at, x0 + 0.1, x1 - 0.1, fz - 0.02);
  }
  entrance(site, at, s, doorX, doorW, fz, G, rand);

  // pent roof over the ground floor on bracket arms
  {
    const m = at(0, 0, fz - 0.1);
    roof(site, m, { ex: hw + 0.1, ez: 1.1, tx: hw + 0.1, tz: 0, y0: G + 0.12, rise: 0.42, sides: [0], gable: true, verge: 0.12, ridge: false, rafters: true, thick: 0.16, sweep: 0.3, seg: 0.7 });
    for (let k = 0; k <= 2; k++) {
      const x = -hw + 0.3 + (k * (w - 0.6)) / 2;
      box(site, 'timber', at, 0.1, 0.12, 1.0, x, G + 0.05, fz + 0.38, { c: 0.01, grain: 'z', uvo: [BOARDS.timber[6], 0] });
    }
  }

  // upper floor facade
  const uy0 = G + 0.35, uy1 = eaveY - 0.2;
  if (low) {
    // mushiko-mado: plastered slatted openings in a white wall
    const n = w > 7 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const cx = n === 1 ? 0 : (k ? 1 : -1) * w * 0.22;
      mushiko(site, at, cx, (uy0 + uy1) / 2 + 0.05, Math.min(2.2, w * 0.36), 0.75, fz - 0.05, white);
    }
  } else {
    // wide lattice window with shoji, board apron below
    const ww = Math.min(w - 1.2, 4.6);
    const wy0 = uy0 + 0.75, wy1 = uy1 - 0.25;
    box(site, 'cedar', at, ww + 0.4, wy0 - uy0 - 0.05, 0.04, 0, (uy0 + wy0) / 2, fz - 0.03, { grain: 'y', uvo: [R(0, 2), 0] });
    box(site, 'timber', at, ww + 0.2, 0.09, 0.14, 0, wy0, fz - 0.02, { c: 0.01, grain: 'x' });
    box(site, 'timber', at, ww + 0.2, 0.09, 0.14, 0, wy1, fz - 0.02, { c: 0.01, grain: 'x' });
    // vertical bars over lit shoji, as one filtered lattice panel (no sub-pixel bars to crawl)
    site.add('koshi', chamferBox(ww, wy1 - wy0, 0.04, 0, 'y'), at(0, (wy0 + wy1) / 2, fz - 0.05), { col: slatCol(bengara), v: [ww / Math.round(ww / 0.12), 0.36, 0.85, 0], uvo: [ww / 2, 0] });
    // sudare blind half-rolled on some
    if (rand() < 0.5) box(site, 'bamboo', at, ww * 0.9, (wy1 - wy0) * 0.55, 0.01, 0, wy1 - (wy1 - wy0) * 0.275, fz + 0.02, { col: [0.9, 0.85, 0.75] });
  }
  // udatsu wing walls at the party walls on some houses
  if (!low && rand() < 0.55) {
    for (const sx of [-1, 1]) {
      box(site, 'plaster', at, 0.28, H2 - 0.1, 0.9, sx * (hw - 0.14), uy0 + (H2 - 0.1) / 2, fz + 0.3, { c: 0.02, col: white, v: [0.2, grime[1], s.y + G, 0] });
      const m = at(sx * (hw - 0.14), 0, fz + 0.3);
      roof(site, m.clone().multiply(trs(0, 0, 0, Math.PI / 2)), { ex: 0.5, ez: 0.16, tx: 0.5, tz: 0, y0: uy1 - 0.05, rise: 0.22, gable: true, verge: 0.05, rafters: false, thick: 0.08, sweep: 0.2, seg: 0.5 });
    }
  }

  // main gable roof, eaves to the river and the lane behind
  {
    const pitch = low ? 0.5 : 0.46;
    const ov = 0.85;
    const rise = (hd + ov) * pitch;
    const m = at(0, 0, 0);
    roof(site, m, { ex: hw, ez: hd + ov, tx: hw, tz: 0, y0: eaveY, rise, gable: true, verge: 0.5, rafters: true, thick: 0.24, sweep: 0.35 });
    // gable walls under the roof (plaster), cedar where they meet the eave
    for (const sx of [-1, 1]) {
      const gm = at(sx * (hw - 0.02), 0, 0, sx * Math.PI / 2);
      site.add('plaster', gableTri(hd - 0.05, eaveY - 0.25, (hd - 0.05) * pitch + 0.2, 0.2), gm, { col: white, v: [0.1, grime[1], s.y + G, 0] });
    }
  }

  // riverside veranda on posts, reaching toward the embankment
  if (s.veranda && s.front && s.front > 2.8) veranda(site, at, w, fz, s.front - 1.1, rand);

  // lanterns and shop dressing
  if (s.kind === 'shop') shopFront(site, at, s, fz, G, rand);
  else if (rand() < 0.6) chochin(site, at(doorX + doorW / 2 + 0.35, G - 0.45, fz + 0.35), 0.2, 0.42, rand() < 0.5 ? COL.paperWarm : [0.55, 0.12, 0.06], 0.3);
}

/** koshi slat albedo, plain dark timber or bengara red-ochre */
export function slatCol(tint?: RGB): RGB {
  const c: RGB = [0.07, 0.048, 0.032];
  return tint ? [c[0] * tint[0], c[1] * tint[1], c[2] * tint[2]] : c;
}

/**
 * koshi: close-set vertical slats between x0..x1 over shoji. drawn as one filtered lattice panel so
 * the 3 cm slats never go sub-pixel and crawl as the boat passes; a real rail keeps some depth.
 */
export function koshi(site: Site, at: At, x0: number, x1: number, y0: number, y1: number, z: number, rand: () => number, col?: RGB) {
  const w = x1 - x0;
  const pitch = w / Math.max(1, Math.round(w / 0.07));
  site.add('koshi', chamferBox(w, y1 - y0, 0.045, 0, 'y'), at((x0 + x1) / 2, (y0 + y1) / 2, z), { col: slatCol(col), v: [pitch, 0.47, 0.34, 0], uvo: [w / 2, 0] });
  void rand;
  // a horizontal rail through the slats
  site.add('timber', chamferBox(w, 0.05, 0.035, 0.005, 'x'), at((x0 + x1) / 2, y1 - 0.4, z + 0.03), { col });
}

/** curved bamboo guards (inuyarai) along a wall foot: one curved slatted sheet and two rails */
export function inuyarai(site: Site, at: At, x0: number, x1: number, z: number) {
  const prof: number[][] = [];
  for (let k = 0; k <= 6; k++) {
    const t = k / 6;
    prof.push([0.12 + t * 0.85, Math.sin(t * Math.PI) * 0.34 * (1 - t * 0.35) + 0.02]);
  }
  const part: Part = { pos: [], nor: [], uv: [] };
  let v = 0;
  for (let k = 0; k < 6; k++) {
    const [y0, z0] = prof[k], [y1, z1] = prof[k + 1];
    const len = Math.hypot(y1 - y0, z1 - z0);
    const ny = -(z1 - z0) / len, nz = (y1 - y0) / len;
    for (const sgn of [1, -1]) {
      const quad = [[x0, y0, z0, v], [x1, y0, z0, v], [x1, y1, z1, v + len], [x0, y1, z1, v + len]];
      const order = sgn > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
      for (const i of order) {
        const q = quad[i];
        part.pos.push(q[0], q[1], q[2]);
        part.nor.push(0, ny * sgn, nz * sgn);
        part.uv.push(q[0] - x0, q[3]);
      }
    }
    v += len;
  }
  site.add('koshi', part, at(0, 0, z), { col: [0.2, 0.15, 0.085], v: [0.1, 0.42, 0.07, 0] });
  for (const t of [0.25, 0.6]) {
    const y = 0.12 + t * 0.85, zz = z + Math.sin(t * Math.PI) * 0.34 * (1 - t * 0.35) + 0.04;
    site.add('bamboo', cylinder(0.02, 0.02, x1 - x0, 6, false), at(x0, y, zz, 0, 0, -Math.PI / 2), { col: [0.6, 0.48, 0.3] }, true);
  }
}

function entrance(site: Site, at: At, s: HouseSpec, x: number, w: number, fz: number, G: number, rand: () => number) {
  // sliding lattice door, half open onto the dark doma
  box(site, 'dark', at, w - 0.1, G - 0.35, 0.02, x, (G - 0.35) / 2 + 0.1, fz - 0.38, { col: [0.02, 0.018, 0.016] });
  if (s.kind !== 'shop') {
    const dw = w / 2;
    const dx = x - w / 4 + (rand() < 0.5 ? 0.25 : 0);
    box(site, 'timber', at, dw, 2.1, 0.05, dx, 1.15, fz - 0.2, { c: 0.01, grain: 'y' });
    site.add('koshi', chamferBox(dw - 0.14, 1.3, 0.02, 0, 'y'), at(dx, 1.35, fz - 0.17), { col: slatCol(), v: [(dw - 0.14) / 6, 0.14, 0.8, 0], uvo: [(dw - 0.14) / 2 + (dw - 0.14) / 12, 0] });
  }
  // noren from a rod under the pent roof
  const nw = s.kind === 'shop' ? w - 0.2 : Math.min(1.5, w - 0.1);
  const strips = s.kind === 'shop' ? 5 : 3;
  const len = s.kind === 'shop' ? 1.05 : 0.95;
  const top = G - 0.28;
  site.add('dark', cylinder(0.015, 0.015, nw + 0.2, 6), at(x - nw / 2 - 0.1, top + 0.02, fz + 0.06, 0, 0, -Math.PI / 2), { col: [0.1, 0.08, 0.05] }, true);
  for (let i = 0; i < strips; i++) {
    const sw = nw / strips - 0.03;
    const sx = x - nw / 2 + (nw * (i + 0.5)) / strips;
    site.add('linen', drape(sw, len, i), at(sx, top, fz + 0.06), { col: [1, 1, 1] });
  }
  // a white crest across the middle strips
  site.add('dark', lathe([[0.001, 0], [0.19, 0], [0.19, 0.005], [0.001, 0.005]], 16, false), at(x, top - len * 0.45, fz + 0.075, 0, Math.PI / 2), { col: [0.66, 0.64, 0.58] }, true);
}

let _drapes = new Map<string, Part>();
/** a hanging cloth strip with a gentle wave, top edge at y = 0 */
function drape(w: number, len: number, seed: number): Part {
  const key = `${w.toFixed(2)}:${len}:${seed % 3}`;
  const c = _drapes.get(key);
  if (c) return c;
  const p: Part = { pos: [], nor: [], uv: [] };
  const nx = 4, ny = 6;
  const P = (i: number, j: number) => {
    const u = i / nx, v = j / ny;
    const zz = Math.sin(u * Math.PI * 2 + seed) * 0.015 * v + v * v * 0.04;
    return [(u - 0.5) * w, -v * len, zz];
  };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = P(i, j), b = P(i + 1, j), cc = P(i + 1, j + 1), d = P(i, j + 1);
    for (const q of [a, d, cc, a, cc, b]) {
      p.pos.push(q[0], q[1], q[2]);
      p.nor.push(0, 0.1, 1);
      p.uv.push(q[0], q[1]);
    }
  }
  _drapes.set(key, p);
  return p;
}

/** mushiko-mado: a plastered frame with thick rounded vertical bars */
function mushiko(site: Site, at: At, cx: number, cy: number, w: number, h: number, z: number, white: RGB) {
  site.add('dark', chamferBox(w, h, 0.02, 0), at(cx, cy, z - 0.12), { col: [0.03, 0.028, 0.025] });
  const n = Math.max(6, Math.round(w / 0.16));
  for (let i = 0; i <= n; i++) {
    const x = cx - w / 2 + (w * i) / n;
    site.add('plaster', chamferBox(0.075, h, 0.1, 0.03, 'y'), at(x, cy, z - 0.02), { col: white, v: [0.1, 0.5, 0, 0], uvo: [x, cy] });
  }
  site.add('plaster', chamferBox(w + 0.3, 0.1, 0.16, 0.03, 'x'), at(cx, cy + h / 2 + 0.05, z), { col: white, uvo: [cx, cy] });
  site.add('plaster', chamferBox(w + 0.3, 0.1, 0.18, 0.03, 'x'), at(cx, cy - h / 2 - 0.05, z), { col: white, uvo: [cx, cy] });
}

/** chochin paper lantern (hanging), bottom at y */
export function chochin(site: Site, m: Matrix4, r: number, h: number, col: RGB, glow: number) {
  const prof: number[][] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    prof.push([r * (0.55 + 0.45 * Math.sin(t * Math.PI)), t * h]);
  }
  site.add('paper', lathe(prof, 14, true, r), m, { col, v: [0, 0, 0, glow] }, true);
  site.add('dark', cylinder(r * 0.58, r * 0.58, 0.05, 12), m.clone().multiply(trs(0, h - 0.01, 0)), { col: [0.03, 0.025, 0.02] }, true);
  site.add('dark', cylinder(r * 0.58, r * 0.58, 0.04, 12), m.clone().multiply(trs(0, -0.03, 0)), { col: [0.03, 0.025, 0.02] }, true);
  site.add('dark', cylinder(0.008, 0.008, 0.3, 4), m.clone().multiply(trs(0, h + 0.03, 0)), { col: [0.05, 0.04, 0.03] }, true);
}

function veranda(site: Site, at: At, w: number, fz: number, len: number, rand: () => number) {
  const y = 0.55;
  const vw = w - 0.4;
  const n = Math.floor(len / 0.19);
  for (let i = 0; i < n; i++) {
    const z = fz + 0.1 + i * 0.19 + 0.09;
    site.add('deck', chamferBox(vw, 0.04, 0.17, 0.005, 'x'), at(rand() * 0.02, y, z), { uvo: [BOARDS.grey[i % 5], rand()], col: [0.95 + rand() * 0.15, 0.95, 0.95] });
  }
  for (const sx of [-1, 1]) {
    for (const k of [0.5, len - 0.1]) {
      box(site, 'timber', at, 0.12, y + 0.8, 0.12, sx * (vw / 2 - 0.08), (y + 0.8) / 2 - 0.1, fz + k, { c: 0.01, uvo: [BOARDS.timber[3], rand()] });
    }
    box(site, 'timber', at, 0.1, 0.12, len, sx * (vw / 2 - 0.08), y - 0.1, fz + len / 2, { c: 0.01, grain: 'z' });
    box(site, 'timber', at, 0.07, 0.07, len, sx * (vw / 2 - 0.08), y + 0.7, fz + len / 2, { c: 0.01, grain: 'z' });
  }
  box(site, 'timber', at, vw, 0.07, 0.07, 0, y + 0.7, fz + len - 0.1, { c: 0.01, grain: 'x' });
  box(site, 'timber', at, vw, 0.12, 0.1, 0, y - 0.1, fz + len - 0.1, { c: 0.01, grain: 'x' });
  // a low bench and a few cushions suggest people sit out here
  box(site, 'deck', at, vw * 0.6, 0.06, 0.4, 0, y + 0.36, fz + len - 0.45, { c: 0.01, grain: 'x', col: [1.3, 1.2, 1.1] }, true);
}

function shopFront(site: Site, at: At, s: HouseSpec, fz: number, G: number, rand: () => number) {
  // red and white lanterns under the pent roof
  const hw = s.w / 2;
  chochin(site, at(-hw + 0.7, G - 0.55, fz + 0.45), 0.22, 0.5, COL.paperRed, 0.35);
  chochin(site, at(hw - 0.7, G - 0.55, fz + 0.45), 0.22, 0.5, COL.paperRed, 0.35);
  // shogi bench with red felt and a parasol
  const bx = (rand() < 0.5 ? -1 : 1) * (hw - 1.3), bz = fz + 1.6;
  box(site, 'timber', at, 1.8, 0.06, 0.6, bx, 0.42, bz, { c: 0.01, grain: 'x' }, true);
  box(site, 'dark', at, 1.82, 0.02, 0.62, bx, 0.46, bz, { col: [0.36, 0.035, 0.03] }, true);
  for (const lx of [-0.8, 0.8]) for (const lz of [-0.25, 0.25]) box(site, 'timber', at, 0.05, 0.42, 0.05, bx + lx, 0.2, bz + lz, {}, true);
  const px = bx + (bx > 0 ? -1.4 : 1.4);
  site.add('dark', cylinder(0.02, 0.02, 2.4, 6), at(px, 0, bz + 0.2), { col: [0.2, 0.15, 0.08] }, true);
  const prof: number[][] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    prof.push([1.25 * (1 - t), 2.25 + Math.sin(t * Math.PI / 2) * 0.45]);
  }
  site.add('paint', lathe(prof, 20, true, 1), at(px, 0, bz + 0.2), { col: [0.42, 0.04, 0.025], v: [0, 0, 0, 0] });
  // barrels and baskets on display
  for (let i = 0; i < 3; i++) {
    const x = -hw + 0.8 + i * 0.7;
    site.prop(i === 1 ? 'basket' : 'bucket', at(x * (bx > 0 ? -1 : 1), 0.12, fz + 0.5 + rand() * 0.2, rand() * 6), true);
  }
  taru(site, at(bx > 0 ? -hw + 0.6 : hw - 0.6, 0.12, fz + 0.9), rand);
}

/** a straw-wrapped sake barrel (komodaru) with rope bands */
export function taru(site: Site, m: Matrix4, rand: () => number) {
  const prof = [[0.001, 0], [0.3, 0], [0.33, 0.1], [0.34, 0.3], [0.33, 0.5], [0.3, 0.6], [0.001, 0.6]];
  site.add('bamboo', lathe(prof, 16, true, 0.3), m, { col: [1.05, 1.0, 0.85] }, true);
  for (const y of [0.1, 0.3, 0.5]) {
    const r = y === 0.3 ? 0.345 : 0.335;
    site.add('rope', lathe([[r, y - 0.02], [r + 0.012, y], [r, y + 0.02]], 16, true), m, { col: [0.35, 0.28, 0.16] }, true);
  }
  site.add('timber', cylinder(0.3, 0.3, 0.02, 16), m.clone().multiply(trs(0, 0.6, 0)), { col: [1.3, 1.2, 1.0] }, true);
  void rand;
}

function kura(site: Site, at: At, s: HouseSpec, rand: () => number, grime: [number, number, number, number], white: RGB) {
  const R = (a: number, b: number) => a + (b - a) * rand();
  const { w, d } = s;
  const hw = w / 2, hd = d / 2;
  const H = 5.9;
  const gableFront = rand() < 0.6;
  // thick plastered body
  box(site, 'plaster', at, w, H, d, 0, H / 2 + 0.15, 0, { c: 0.04, col: white, v: [grime[0], grime[1], s.y + 0.3, 0], uvo: [R(0, 3), R(0, 3)] });
  // namako or board skirt on the lower walls
  const namakoSkirt = rand() < 0.6;
  const skirtH = namakoSkirt ? 1.35 : 1.6;
  for (const [sx, sz, lw, yaw] of [[0, hd + 0.02, w + 0.02, 0], [0, -hd - 0.02, w + 0.02, Math.PI], [hw + 0.02, 0, d + 0.02, Math.PI / 2], [-hw - 0.02, 0, d + 0.02, -Math.PI / 2]] as const) {
    if (namakoSkirt) site.add('namako', chamferBox(lw, skirtH, 0.03, 0, 'y'), at(sx, 0.15 + skirtH / 2, sz, yaw), { col: [1, 1, 1], uvo: [0, 0] });
    else site.add('cedar', chamferBox(lw, skirtH, 0.03, 0, 'y'), at(sx, 0.15 + skirtH / 2, sz, yaw), { uvo: [R(0, 2), 0] });
    site.add('plaster', chamferBox(lw + 0.04, 0.08, 0.07, 0.02, 'x'), at(sx, 0.15 + skirtH + 0.04, sz, yaw), { col: white, uvo: [0, 0] });
  }
  // hachimaki: stepped plaster band under the eaves
  for (let k = 0; k < 3; k++) {
    const o = 0.06 + k * 0.07;
    box(site, 'plaster', at, w + o * 2, 0.12, d + o * 2, 0, H + 0.15 - 0.3 + k * 0.12, 0, { c: 0.02, col: white, uvo: [0, 0] });
  }
  // heavy door with a hood on the river face, small shuttered windows above
  const face = gableFront ? 1 : 1;
  void face;
  box(site, 'dark', at, 1.4, 2.0, 0.06, 0, 1.15, hd + 0.02, { col: [0.02, 0.018, 0.015] });
  for (const sx of [-1, 1]) box(site, 'plaster', at, 0.72, 2.1, 0.22, sx * 1.05, 1.2, hd + 0.12, { c: 0.03, col: white, uvo: [0, 0] });
  box(site, 'timber', at, 1.5, 0.16, 0.2, 0, 2.3, hd + 0.08, { c: 0.01, grain: 'x' });
  roof(site, at(0, 0, hd + 0.05), { ex: 1.25, ez: 0.7, tx: 1.25, tz: 0, y0: 2.5, rise: 0.3, sides: [0], gable: true, verge: 0.1, ridge: false, rafters: false, thick: 0.12, sweep: 0.2, seg: 0.6 });
  for (const sx of w > 5.4 ? [-1, 1] : [0]) {
    const x = sx * w * 0.24;
    box(site, 'dark', at, 0.6, 0.6, 0.05, x, 4.3, hd + 0.02, { col: [0.02, 0.018, 0.015] });
    for (const dx of [-1, 1]) {
      box(site, 'plaster', at, 0.32, 0.64, 0.12, x + dx * 0.5, 4.3, hd + 0.2, { c: 0.02, col: white, yaw: dx * 0.9, uvo: [0, 0] });
    }
    box(site, 'plaster', at, 0.9, 0.08, 0.2, x, 4.66, hd + 0.08, { c: 0.02, col: white, uvo: [0, 0] });
  }
  // heavy gable roof; kura roofs are steeper and sit on a thick eave
  const pitch = 0.55;
  const ov = 0.55;
  if (gableFront) {
    // gable facing the river: ridge across the depth
    const m = at(0, 0, 0, Math.PI / 2);
    const rise = (hw + ov) * pitch;
    roof(site, m, { ex: hd, ez: hw + ov, tx: hd, tz: 0, y0: H + 0.15, rise, gable: true, verge: 0.4, rafters: false, thick: 0.34, sweep: 0.3 });
    for (const sz of [-1, 1]) site.add('plaster', gableTri(hw, H + 0.12, hw * pitch + 0.25, 0.3), at(0, 0, sz * (hd - 0.05), sz > 0 ? 0 : Math.PI), { col: white, v: [0.1, grime[1], s.y + 2, 0] });
  } else {
    const rise = (hd + ov) * pitch;
    roof(site, at(0, 0, 0), { ex: hw, ez: hd + ov, tx: hw, tz: 0, y0: H + 0.15, rise, gable: true, verge: 0.4, rafters: false, thick: 0.34, sweep: 0.3 });
    for (const sx of [-1, 1]) site.add('plaster', gableTri(hd, H + 0.12, hd * pitch + 0.25, 0.3), at(sx * (hw - 0.05), 0, 0, sx * Math.PI / 2), { col: white, v: [0.1, grime[1], s.y + 2, 0] });
  }
  void TIMBER;
}
