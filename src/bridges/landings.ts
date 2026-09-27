// landings at every DOCKS entry: a timber deck on posts reaching ~3.3 m out from the bank, a fender
// line the moored hull lies against, two mooring posts, stone steps up to the bank, a lantern.
// the moored hull center (moorX, moorZ) sits 4.2 m out, so its side (beam 1.6) meets the fenders.
import { Matrix4, Vector3 } from 'three/webgpu';
import type { GameContext } from '../core/context';
import { bankPoint, riverFrame, type Dock } from '../world/layout';
import { box, cyl, lathe, rng } from './geom';
import { C, groundAt, hashId, jitter } from './parts';
import { bambooLantern, postLantern } from './lanterns';
import { Site } from './site';
import type { LandingInfo, LanternInfo } from './types';

/** landing frame: origin at the water's edge, x out over the water, z along the bank (side * upstream) */
export function landingFrame(s: number, side: -1 | 1, offset = 0) {
  const f = riverFrame(s);
  const p = bankPoint(s, side, offset);
  const X = new Vector3(-side * f.nx, 0, -side * f.nz);
  const Z = new Vector3().crossVectors(X, new Vector3(0, 1, 0));
  return new Matrix4().makeBasis(X, new Vector3(0, 1, 0), Z).setPosition(p.x, 0, p.z);
}

export function buildLanding(ctx: GameContext, d: Dock, o: { embanked?: boolean; wallTop?: number; wallFace?: number; hero?: boolean } = {}) {
  const site = new Site('landing-' + d.id, landingFrame(d.s, d.side));
  site.far = 700;
  site.detailFar = 160;
  const R = rng(hashId('landing-' + d.id));
  const y = d.deckY;
  const xOut = 3.3;
  const xIn = o.embanked ? (o.wallFace ?? 0.25) + 0.03 : -1.4;
  const zH = 4.6;
  const gt = site.g('timber');
  const gs = site.g('stone');
  const bank = o.embanked ? (o.wallTop ?? 1.2) : Math.max(groundAt(ctx, site, -2.6, 0), groundAt(ctx, site, -2.6, 0.8), groundAt(ctx, site, -2.6, -0.8));

  // posts and bearers
  const rows = [xIn + 0.3, (xIn + 0.3 + 3.15) / 2, 3.15];
  for (const x of rows) {
    for (const z of [-4.25, -1.42, 1.42, 4.25]) {
      const bed = Math.min(groundAt(ctx, site, x, z) - 0.45, y - 1.0);
      gt.part({ tint: jitter(C.pile, R, 0.14), wear: 0.2 + R() * 0.2, seed: R(), grain: 1 });
      cyl(gt, x, z, bed, y - 0.26, 0.12, 0.115, 10, 2);
    }
    gt.part({ tint: jitter(C.pile, R, 0.1), wear: 0.3, seed: R(), grain: 2 });
    box(gt, x, y - 0.16, 0, 0.16, 0.2, zH * 2 - 0.1, 0.015);
  }
  // deck boards running out from the bank
  for (let z = -zH + 0.115; z < zH; z += 0.232) {
    gt.part({ tint: jitter(C.deck, R, 0.16, 0.1), wear: 0.4 + R() * 0.4, seed: R(), grain: 0, moss: 0.15 });
    const dx = (R() - 0.5) * 0.04;
    box(gt, (xIn + xOut) / 2 + dx, y - 0.03, z, xOut - xIn, 0.06, 0.215, 0.01);
  }
  // fender line: waling and vertical rubbing strips the hull lies against
  gt.part({ tint: jitter(C.pile, R, 0.1), wear: 0.4, seed: R(), grain: 2 });
  box(gt, xOut + 0.04, y - 0.2, 0, 0.14, 0.24, zH * 2 + 0.1, 0.015);
  for (let z = -zH + 0.4; z <= zH - 0.3; z += 1.15) {
    gt.part({ tint: jitter(C.pile, R, 0.12), wear: 0.6, seed: R(), grain: 1 });
    box(gt, xOut + 0.14, (y - 0.4) / 2, z, 0.08, y + 0.4, 0.13, 0.012);
  }
  // mooring posts, bow (upstream) and stern
  const bowZ = 3.45 * d.side, sternZ = -3.45 * d.side;
  const gp = site.g('plain');
  const tops: Vector3[] = [];
  for (const z of [bowZ, sternZ]) {
    const x = 3.0;
    gt.part({ tint: jitter(C.pile, R, 0.1), wear: 0.5, seed: R(), grain: 1 });
    cyl(gt, x, z, Math.min(groundAt(ctx, site, x, z) - 0.5, -1), y + 0.6, 0.14, 0.13, 12, 0);
    lathe(gt, x, z, [[0.13, y + 0.6], [0.125, y + 0.64], [0.1, y + 0.68], [0.05, y + 0.705], [0, y + 0.71]], 12);
    gp.part({ tint: jitter(C.rope, R, 0.08), wear: 0.95, seed: R() });
    lathe(gp, x, z, [[0.14, y + 0.3], [0.165, y + 0.32], [0.17, y + 0.36], [0.165, y + 0.4], [0.14, y + 0.42]], 12);
    tops.push(site.world(x, y + 0.66, z));
  }
  // steps up to the bank
  let ashore = site.world(xIn, y, 0);
  const lift = bank - y;
  if (lift > 0.12) {
    const n = Math.max(1, Math.round(lift / 0.18));
    const rise = lift / n;
    for (let k = 1; k <= n; k++) {
      const x1 = xIn - (k - 1) * 0.34, x0 = x1 - 0.34;
      const top = y + k * rise;
      const bot = Math.min(groundAt(ctx, site, (x0 + x1) / 2, 0), y) - (o.embanked ? 1.9 : 0.4);
      gs.part({ tint: jitter(C.granite, R, 0.12, 0.06), seed: R(), moss: 0.35, grain: 2 });
      box(gs, (x0 + x1) / 2, (top + bot) / 2, 0, 0.36, top - bot, 2.3, 0.03);
      ashore = site.world(x0, top, 0);
    }
    // cheek walls where the steps cut through the embankment
    if (o.embanked) {
      const xb = xIn - n * 0.34 - 0.1;
      for (const sz of [-1, 1]) {
        let yy = -1.6;
        while (yy < bank - 0.05) {
          const h = Math.min(0.42, bank + 0.02 - yy);
          let x = xb;
          while (x < xIn + 0.05) {
            const len = Math.min(xIn + 0.05 - x, 0.5 + R() * 0.5);
            gs.part({ tint: jitter(C.granite, R, 0.14, 0.08), seed: R(), moss: 0.4, grain: 1 });
            box(gs, x + len / 2, yy + h / 2, sz * 1.42, len, h, 0.5, 0.035);
            x += len;
          }
          yy += h;
        }
      }
    }
  }
  // lantern: the hero landing gets ref1's bamboo pole leaning over the water
  let lantern: LanternInfo;
  if (o.hero) lantern = bambooLantern(site, 3.05, y, 4.42 * d.side, [0.86, 0.5 * d.side], R);
  else lantern = postLantern(site, xIn + 0.25, y, -4.3 * d.side, [1, 0], R);

  site.box((xIn + xOut + 0.2) / 2, (y - 2.2) / 2, 0, (xOut + 0.2 - xIn) / 2, (y + 2.2) / 2, zH + 0.05, 0.2);

  const e0 = site.world(xOut + 0.18, y, -zH), e1 = site.world(xOut + 0.18, y, zH);
  const info: LandingInfo = {
    id: d.id, name: d.name, moorX: d.moorX, moorZ: d.moorZ, headingDeg: d.headingDeg, deckY: y,
    bow: [tops[0].x, tops[0].y, tops[0].z], stern: [tops[1].x, tops[1].y, tops[1].z],
    edge: [[e0.x, e0.z], [e1.x, e1.z]],
    ashore: [ashore.x, ashore.y, ashore.z],
  };
  return { site, info, lantern, gap: [d.s - 1.75, d.s + 1.75] as [number, number] };
}
