// the old weir at the downstream end: a heavy timber crest sill a few cm under the water line, sheet
// boarding on its upstream face, a stone apron in timber cribs falling away downstream, a ragged row
// of old stakes at the apron foot, and short ishigaki wing walls on both banks.
import type { GameContext } from '../core/context';
import { LANDMARKS, riverFrame } from '../world/layout';
import { beam, box, cyl, frameMatrix, hex, rng } from './geom';
import { C, groundAt, hashId, jitter } from './parts';
import { Site } from './site';
import type { WeirInfo } from './types';

export function buildWeir(ctx: GameContext) {
  const lm = LANDMARKS.find((l) => l.kind === 'weir');
  const sW = lm ? lm.s : 8;
  const f = riverFrame(sW);
  // z points downstream in the site frame
  const site = new Site('weir', frameMatrix(f.x, 0, f.z, f.nx, f.nz, f.tx, f.tz));
  site.far = 700;
  site.detailFar = 180;
  const R = rng(hashId('weir'));
  const hw = f.width / 2 + 1.4;
  const crestY = -0.06;
  const gt = site.g('timber');
  const gs = site.g('stone');

  // crest sill and the boarded upstream face
  gt.part({ tint: jitter(C.pile, R, 0.08), wear: 0.3, seed: R(), grain: 0, moss: 0.5 });
  box(gt, 0, crestY - 0.17, 0, hw * 2, 0.34, 0.42, 0.03);
  for (let x = -hw; x < hw; x += 0.3) {
    gt.part({ tint: jitter(C.pile, R, 0.14), wear: 0.2, seed: R(), grain: 1 });
    const yb = Math.min(groundAt(ctx, site, x + 0.15, -0.3) - 0.3, -0.8);
    box(gt, x + 0.15, (yb + crestY - 0.1) / 2, -0.26, 0.29, crestY - 0.1 - yb, 0.08, 0);
  }

  // stone apron in timber cribs, falling ~1.3 m over 5.5 m
  const apronL = 5.6, footY = -1.35;
  const ap = (z: number) => crestY - 0.08 - (crestY - 0.08 - footY) * Math.pow(Math.max(0, z - 0.25) / (apronL - 0.25), 1.25);
  let z = 0.25, row = 0;
  while (z < apronL - 0.05) {
    const d = Math.min(apronL - z, 0.5 + R() * 0.25);
    const za = z, zb = z + d;
    let x = -hw - (row % 2 ? R() * 0.4 : 0);
    while (x < hw) {
      const len = 0.55 + R() * 0.4;
      const xa = Math.max(-hw, x), xb = Math.min(hw, x + len);
      x += len;
      if (xb - xa < 0.15) continue;
      const bump = (R() - 0.3) * 0.06;
      const ta = ap(za) + bump, tb = ap(zb) + bump;
      gs.part({ tint: jitter([0.2, 0.19, 0.17], R, 0.18, 0.1), seed: R(), moss: 0.9, grain: 2 });
      hex(gs, [
        [xa, ta - 0.45, za], [xb, ta - 0.45, za], [xa, ta, za], [xb, ta, za],
        [xa, tb - 0.45, zb], [xb, tb - 0.45, zb], [xa, tb, zb], [xb, tb, zb],
      ], 0.05, 1 << 2);
    }
    z = zb;
    row++;
  }
  for (let x = -hw + 0.6; x < hw; x += 2.4) {
    gt.part({ tint: jitter(C.pile, R, 0.1), wear: 0.3, seed: R(), moss: 0.6 });
    beam(gt, [x, ap(0.3) + 0.06, 0.25], [x, ap(apronL - 0.1) + 0.06, apronL - 0.1], 0.2, 0.18, 0.02, [1, 0, 0]);
  }
  gt.part({ tint: jitter(C.pile, R, 0.1), wear: 0.3, seed: R(), moss: 0.6, grain: 0 });
  box(gt, 0, footY + 0.02, apronL + 0.1, hw * 2, 0.26, 0.26, 0.02);
  // old stakes at the foot, some standing proud of the water
  for (let x = -hw + 0.3; x < hw; x += 0.7 + R() * 0.5) {
    const top = R() < 0.35 ? 0.05 + R() * 0.35 : footY + 0.4 + R() * 0.6;
    gt.part({ tint: jitter(C.pile, R, 0.15), wear: 0.5, seed: R(), grain: 1 });
    cyl(gt, x, apronL + 0.35 + (R() - 0.5) * 0.15, footY - 0.8, top, 0.09 + R() * 0.03, 0.075, 8, 2);
  }
  // the boat stops against the crest
  site.box(0, -0.45, 0, hw, 0.95, 0.5, 0.25);

  const c0 = site.world(-hw + 0.8, crestY, 0.21), c1 = site.world(hw - 0.8, crestY, 0.21);
  const info: WeirInfo = {
    crest: [[c0.x, c0.y, c0.z], [c1.x, c1.y, c1.z]],
    downstream: [-f.tx, -f.tz],
    apronLength: apronL,
    apronFootY: footY,
  };
  return { site, info, s: sW };
}
