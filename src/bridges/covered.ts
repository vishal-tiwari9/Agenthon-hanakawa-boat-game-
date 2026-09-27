// the gorge covered bridge: a timber house-bridge (yakata-bashi) high over the gorge, carried on
// corbelled cantilever beams (hanegi) that step out from granite abutments on each rim, with boarded
// walls, an open window band and a shingled gable roof.
import type { GameContext } from '../core/context';
import { riverFrame, type Bridge } from '../world/layout';
import { beam, box, frameMatrix, hex, rng, type Geo, type V3 } from './geom';
import { C, groundAt, hashId, jitter, masonry, padHeight } from './parts';
import { Site } from './site';
import type { BridgeInfo } from './types';

export function buildCovered(ctx: GameContext, b: Bridge): { site: Site; info: BridgeInfo } {
  const f = riverFrame(b.s);
  const site = new Site(b.id, frameMatrix(f.x, 0, f.z, f.nx, f.nz, f.tx, f.tz));
  site.far = 1000;
  site.detailFar = 240;
  const R = rng(hashId(b.id));
  const hw = f.width / 2;
  const pad = padHeight(ctx, b.id);
  const rim = (sg: number) => {
    const g = Math.max(groundAt(ctx, site, sg * (hw + 3), 0), groundAt(ctx, site, sg * (hw + 5), 0));
    return pad !== null ? pad : g;
  };
  const gMin = Math.min(rim(-1), rim(1));
  const yD = Math.max(b.clearance + 0.9, gMin + 0.7);
  const L = hw + 2.6;
  const half = b.deckWidth / 2;
  const zw = half + 0.05;
  const gt = site.g('timber');
  const gd = site.g('timber', true);

  // ---- abutments on each rim: granite from the cliff (or the water) up to the girders ----
  const girderTop = yD - 0.08, girderH = 0.5;
  const yBear = girderTop - girderH;
  for (const sg of [-1, 1]) {
    const xa = sg * (hw - 0.7), xb = sg * (hw + 3.2);
    const [lo, hi] = sg < 0 ? [xb, xa] : [xa, xb];
    const face = groundAt(ctx, site, sg * (hw - 0.7), 0);
    const yb = Math.max(-1.8, Math.min(yBear - 2.5, face - 0.6));
    masonry(site, lo, hi, -2.2, 2.2, yb, () => yBear, { seed: R() * 1e9, splitZ: true, moss: 0.6, course: [0.38, 0.55], len: [0.7, 1.3] });
    if (yb < 0.5) site.box((xa + xb) / 2, 0.2, 0, Math.abs(xb - xa) / 2, 2.2, 2.3, 0.3);
    // corbelled cantilevers: the top tier reaches furthest
    for (let k = 0; k < 3; k++) {
      const yTop = yBear - k * 0.32;
      const reach = (3 - k) * 1.35;
      for (const z of [-1.3, 1.3]) {
        gt.part({ tint: jitter(C.pile, R, 0.12), wear: 0.3, seed: R(), grain: 0 });
        const x0 = sg * (hw + 2.4), x1 = sg * (hw - 0.7 - reach);
        box(gt, (x0 + x1) / 2, yTop - 0.15, z, Math.abs(x1 - x0), 0.3, 0.3, 0.02);
      }
      // tier cross beams tie the pair together at the tip
      gt.part({ tint: jitter(C.pile, R, 0.12), wear: 0.3, seed: R(), grain: 2 });
      box(gt, sg * (hw - 0.7 - reach + 0.25), yTop - 0.15, 0, 0.24, 0.26, 3.1, 0.02);
    }
    // stone steps from the rim up to the floor
    const n = Math.max(0, Math.round((yD - rim(sg)) / 0.2));
    const gs = site.g('stone');
    for (let k = 0; k < n; k++) {
      const x0 = sg * (L + 0.1 + k * 0.34), x1 = sg * (L + 0.1 + (k + 1) * 0.34);
      const yt = yD - ((k + 1) * (yD - rim(sg))) / (n + 1);
      gs.part({ tint: jitter(C.granite, R, 0.12), seed: R(), moss: 0.3 });
      box(gs, (x0 + x1) / 2, (yt + rim(sg) - 0.5) / 2, 0, 0.34, yt - rim(sg) + 0.5, 2.8, 0.03);
    }
  }

  // ---- girders, floor ----
  for (const z of [-1.3, 1.3]) {
    gt.part({ tint: jitter(C.timber, R, 0.1), wear: 0.35, seed: R(), grain: 0 });
    box(gt, 0, girderTop - girderH / 2, z, L * 2, girderH, 0.32, 0.025);
  }
  for (const z of [-0.45, 0.45]) {
    gt.part({ tint: jitter(C.timber, R, 0.1), wear: 0.3, seed: R(), grain: 0 });
    box(gt, 0, girderTop - 0.15, z, L * 2 - 0.4, 0.3, 0.2, 0.02);
  }
  {
    const n = 13;
    for (let i = 0; i < n; i++) {
      const z = -half + (i + 0.5) * (b.deckWidth / n);
      let x = -L;
      while (x < L - 0.3) {
        const len = Math.min(L - x, 2.8 + R() * 1.6);
        gt.part({ tint: jitter(C.deck, R, 0.14, 0.08), wear: 0.3 + R() * 0.3, seed: R(), grain: 0 });
        box(gt, x + len / 2, yD - 0.03, z, len - 0.01, 0.06, b.deckWidth / n - 0.012, 0.008);
        x += len;
      }
    }
  }

  // ---- walls: posts, sill, mid rail, head beam, boarded lower wall and transom, open window band ----
  const H = 2.5;
  const nP = Math.round((2 * L) / 1.9);
  const posts: number[] = [];
  for (let i = 0; i <= nP; i++) posts.push(-L + 0.1 + ((2 * L - 0.2) * i) / nP);
  for (const sz of [-1, 1]) {
    const z = sz * zw;
    for (const x of posts) {
      gt.part({ tint: jitter(C.cedar, R, 0.1), wear: 0.3, seed: R(), grain: 1 });
      box(gt, x, yD + H / 2, z, 0.16, H, 0.16, 0.015);
    }
    for (const [y, h, w] of [[0.07, 0.14, 0.2], [0.95, 0.12, 0.13], [1.92, 0.1, 0.12], [H - 0.02, 0.24, 0.22]] as [number, number, number][]) {
      gt.part({ tint: jitter(C.cedar, R, 0.1), wear: 0.35, seed: R(), grain: 0 });
      box(gt, 0, yD + y, z + sz * 0.02, L * 2, h, w, 0.015);
    }
    // outer skirt over the girder ends
    gt.part({ tint: jitter(C.timber, R, 0.08), wear: 0.4, seed: R(), grain: 0 });
    box(gt, 0, yD - 0.3, sz * (half + 0.17), L * 2 + 0.1, 0.55, 0.05, 0.01);
    // vertical boards with battens, lower wall and transom
    for (let x = -L + 0.1; x < L - 0.1; x += 0.24) {
      const tint = jitter(C.cedar, R, 0.16, 0.08);
      gd.part({ tint, wear: 0.4 + R() * 0.3, seed: R(), grain: 1 });
      box(gd, x + 0.12, yD + 0.5, z + sz * 0.1, 0.235, 0.86, 0.03, 0);
      gd.part({ tint, wear: 0.4 + R() * 0.3, seed: R(), grain: 1 });
      box(gd, x + 0.12, yD + 2.2, z + sz * 0.1, 0.235, 0.52, 0.03, 0);
    }
    for (let x = -L + 0.1; x < L - 0.1; x += 0.72) {
      gd.part({ tint: jitter(C.cedar, R, 0.12), wear: 0.4, seed: R(), grain: 1 });
      box(gd, x, yD + 1.43, z + sz * 0.02, 0.05, 0.95, 0.05, 0);
    }
  }
  // tie beams across the house, one per post pair
  for (const x of posts.filter((_, i) => i % 2 === 0)) {
    gt.part({ tint: jitter(C.cedar, R, 0.1), wear: 0.3, seed: R(), grain: 2 });
    box(gt, x, yD + H + 0.08, 0, 0.16, 0.2, zw * 2 + 0.3, 0.015);
  }

  // ---- gable roof: shingles on a timber deck, rafter tails, ridge, gable boards ----
  const pitch = Math.tan((28 * Math.PI) / 180);
  const eave = zw + 0.95;
  const yPlate = yD + H + 0.12;
  const roofY = (z: number) => yPlate + 0.12 + (zw - Math.abs(z)) * pitch;
  const RL = L + 0.9;
  const gr = site.g('roof');
  for (const sz of [-1, 1]) {
    const za = 0, zb = sz * eave;
    const ya = roofY(za), yb = roofY(zb);
    const c = (x: number, z: number, y: number): V3 => [x, y, z];
    gr.part({ tint: jitter(C.roof, R, 0.06), seed: R(), moss: 0.7, grain: 2 });
    hexSlab(gr, [c(-RL, za, ya + 0.14), c(RL, za, ya + 0.14), c(-RL, zb, yb + 0.14), c(RL, zb, yb + 0.14)], 0.07);
    gt.part({ tint: jitter(C.timber, R, 0.08), wear: 0.2, seed: R(), grain: 0 });
    hexSlab(gt, [c(-RL, za, ya + 0.07), c(RL, za, ya + 0.07), c(-RL, zb, yb + 0.07), c(RL, zb, yb + 0.07)], 0.06);
    // rafters
    for (let x = -RL + 0.2; x < RL; x += 0.55) {
      gd.part({ tint: jitter(C.timber, R, 0.1), wear: 0.3, seed: R() });
      beam(gd, [x, roofY(0) - 0.02, 0], [x, roofY(sz * (eave - 0.05)) - 0.02, sz * (eave - 0.05)], 0.07, 0.1, 0.008, [1, 0, 0]);
    }
    // fascia board along the eave
    gt.part({ tint: jitter(C.timber, R, 0.08), wear: 0.4, seed: R(), grain: 0 });
    box(gt, 0, yb + 0.02, zb, RL * 2, 0.16, 0.05, 0.01);
  }
  gr.part({ tint: jitter(C.roof, R, 0.05), seed: R(), moss: 0.3, grain: 0 });
  box(gr, 0, roofY(0) + 0.24, 0, RL * 2 + 0.1, 0.16, 0.34, 0.03);
  for (const sx of [-1, 1]) {
    const x = sx * (L - 0.02);
    const pts: V3[] = [[x, yPlate, -zw], [x, yPlate, zw], [x, roofY(0), 0]];
    gt.part({ tint: jitter(C.cedar, R, 0.1), wear: 0.4, seed: R(), grain: 1 });
    gt.face(sx > 0 ? pts.slice().reverse() : pts);
    gt.face((sx > 0 ? pts : pts.slice().reverse()).map((p) => [p[0] - sx * 0.03, p[1], p[2]] as V3));
    // barge boards
    for (const sz of [-1, 1]) {
      gt.part({ tint: jitter(C.timber, R, 0.08), wear: 0.4, seed: R() });
      beam(gt, [sx * (RL + 0.02), roofY(0) + 0.16, 0], [sx * (RL + 0.02), roofY(sz * eave) + 0.1, sz * eave], 0.05, 0.2, 0.01, [1, 0, 0]);
    }
  }

  const a = site.world(-L, yD, 0), c = site.world(L, yD, 0);
  const pier: [number, number][] = [];
  const p0 = site.world(-(hw - 0.7 - 4.05), 0, 0), p1 = site.world(hw - 0.7 - 4.05, 0, 0);
  const info: BridgeInfo = {
    id: b.id, name: b.name, type: b.type, s: b.s,
    a: [a.x, a.y, a.z], b: [c.x, c.y, c.z],
    deckY: yD, clearance: +(yBear - 0.9).toFixed(2), deckWidth: b.deckWidth,
    piers: pier,
    channel: [{ a: [p0.x, p0.z], b: [p1.x, p1.z], clearance: +(yBear - 0.9).toFixed(2) }],
  };
  return { site, info };
}

/** a thin slab under four top corners (x0z0, x1z0, x0z1, x1z1), thickness t straight down */
function hexSlab(g: Geo, top: V3[], t: number) {
  const [a, b, c, d] = top;
  hex(g, [
    [a[0], a[1] - t, a[2]], [b[0], b[1] - t, b[2]], a, b,
    [c[0], c[1] - t, c[2]], [d[0], d[1] - t, d[2]], c, d,
  ], 0.012);
}
