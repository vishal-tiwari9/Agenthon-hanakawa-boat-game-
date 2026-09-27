// the heron footbridge: weathered planks on two stringers, straight spans between light timber bents,
// rising gently to a wide center span over the channel, one simple handrail.
import type { GameContext } from '../core/context';
import { riverFrame, type Bridge } from '../world/layout';
import { beam, box, frameMatrix, hex, rng, rod, cyl, type V3 } from './geom';
import { C, groundAt, hashId, jitter, padHeight, pileBent } from './parts';
import { Site } from './site';
import { channelInfo } from './red';
import type { BridgeInfo } from './types';

export function buildPlank(ctx: GameContext, b: Bridge): { site: Site; info: BridgeInfo } {
  const f = riverFrame(b.s);
  const site = new Site(b.id, frameMatrix(f.x, 0, f.z, f.nx, f.nz, f.tx, f.tz));
  site.far = 800;
  site.detailFar = 200;
  const R = rng(hashId(b.id));
  const hw = f.width / 2;
  const half = b.deckWidth / 2;
  const pad = padHeight(ctx, b.id);
  const xE = hw + 2.4;
  const gEnd = (sg: number) => {
    const g = groundAt(ctx, site, sg * xE, 0);
    return Math.min(3, Math.max(0.3, pad !== null ? Math.max(pad, g) : g));
  };
  const gL = gEnd(-1), gR = gEnd(1);
  const plankT = 0.05, strH = 0.18, capH = 0.16;
  const depth = plankT + strH + capH;
  const c0 = 5;
  // parabola through the center bents (clearance) and the bank ends
  const yCtr = b.clearance + depth;
  const prof = (x: number) => {
    const yE = (x < 0 ? gL : gR) + 0.08;
    const k = (yCtr - yE) / (xE * xE - c0 * c0);
    return Math.abs(x) <= c0 ? yCtr : yCtr - k * (x * x - c0 * c0);
  };
  const bents = [c0, 10.5, 15.5].flatMap((x) => [-x, x]).filter((x) => Math.abs(x) < hw - 1.0).sort((a, c) => a - c);
  const sup = [-xE, ...bents, xE];
  const ys = sup.map(prof);
  /** deck top: straight between supports */
  const top = (x: number) => {
    for (let i = 0; i < sup.length - 1; i++) {
      if (x <= sup[i + 1]) {
        const t = (x - sup[i]) / (sup[i + 1] - sup[i]);
        return ys[i] + (ys[i + 1] - ys[i]) * Math.max(0, Math.min(1, t));
      }
    }
    return ys[ys.length - 1];
  };
  const under = (x: number) => top(x) - depth;

  const gt = site.g('timber');
  for (const [i, x] of bents.entries()) {
    pileBent(ctx, site, x, [-0.62, 0.62], top(x) - plankT - strH, {
      seed: R() * 1e9, r: 0.11, capH, capW: 0.16, capLen: 1.75, lean: 0.07, braceSide: i % 2 ? 1 : -1, nukiDrop: 0.9,
      tint: [0.075, 0.058, 0.044],
    });
    site.box(x, 0.3, 0, 0.2, 2.2, 0.82, 0.16);
  }
  // sleepers where the stringers land on the banks
  for (const sg of [-1, 1]) {
    gt.part({ tint: jitter(C.pile, R, 0.1), wear: 0.4, seed: R(), grain: 2, moss: 0.6 });
    box(gt, sg * (xE - 0.2), top(sg * xE) - plankT - strH - 0.1, 0, 0.3, 0.22, 1.9, 0.02);
  }
  // stringers, one straight member per span
  for (const z of [-0.5, 0.5]) {
    for (let i = 0; i < sup.length - 1; i++) {
      const xa = sup[i] + (i === 0 ? 0.05 : -0.08), xb = sup[i + 1] + (i === sup.length - 2 ? -0.05 : 0.08);
      gt.part({ tint: jitter([0.07, 0.054, 0.04], R, 0.12), wear: 0.35, seed: R(), grain: 0, moss: 0.3 });
      beam(gt, [xa, top(xa) - plankT - strH / 2, z], [xb, top(xb) - plankT - strH / 2, z], strH, 0.12, 0.012, [0, 0, 1]);
    }
  }
  // planks: uneven widths, small gaps, a few newer replacements
  for (let x = -xE + 0.05; x < xE - 0.2;) {
    const w = 0.17 + R() * 0.08;
    const xa = x, xb = x + w;
    x = xb + 0.012 + R() * 0.025;
    const fresh = R() < 0.06;
    const tint = fresh ? jitter([0.2, 0.15, 0.1], R, 0.1) : jitter([0.115, 0.1, 0.082], R, 0.2, 0.1);
    gt.part({ tint, wear: fresh ? 0.05 : 0.5 + R() * 0.4, seed: R(), grain: 2, moss: fresh ? 0 : 0.25 });
    const dz = (R() - 0.5) * 0.06, sk = (R() - 0.5) * 0.03, dy = (R() - 0.5) * 0.012;
    const ta = top(xa) + dy, tb = top(xb) + dy;
    const za = -half - 0.04 + dz, zb = half + 0.04 + dz;
    const c: V3[] = [
      [xa - sk, ta - plankT, za], [xb - sk, tb - plankT, za], [xa - sk, ta, za], [xb - sk, tb, za],
      [xa + sk, ta - plankT, zb], [xb + sk, tb - plankT, zb], [xa + sk, ta, zb], [xb + sk, tb, zb],
    ];
    hex(gt, c, 0.01);
  }
  // one handrail on the upstream side: posts at bents and mid-span, a round top rail and a knee rail
  {
    const z = -(half - 0.02);
    const px: number[] = [];
    for (let i = 0; i < sup.length - 1; i++) {
      const a = sup[i] + (i === 0 ? 0.4 : 0), c = sup[i + 1] - (i === sup.length - 2 ? 0.4 : 0);
      const n = Math.max(1, Math.round((c - a) / 2.6));
      for (let k = 0; k < n; k++) px.push(a + ((c - a) * k) / n);
    }
    px.push(sup[sup.length - 1] - 0.4);
    const gd = site.g('timber', true);
    for (const x of px) {
      gt.part({ tint: jitter([0.08, 0.062, 0.046], R, 0.1), wear: 0.5, seed: R() });
      box(gt, x, top(x) + 0.42, z - 0.07, 0.08, 1.02, 0.08, 0.01);
    }
    for (let i = 0; i < px.length - 1; i++) {
      const a = px[i], c = px[i + 1];
      gt.part({ tint: jitter([0.1, 0.08, 0.06], R, 0.1), wear: 0.6, seed: R(), grain: 0 });
      rod(gt, [a, top(a) + 0.9, z - 0.07], [c, top(c) + 0.9, z - 0.07], 0.035, 8);
      gd.part({ tint: jitter([0.1, 0.08, 0.06], R, 0.1), wear: 0.6, seed: R(), grain: 0 });
      rod(gd, [a, top(a) + 0.45, z - 0.07], [c, top(c) + 0.45, z - 0.07], 0.025, 6);
    }
  }
  // a heron's perch: one old stake standing proud of the water beside the bridge
  {
    gt.part({ tint: jitter(C.pile, R, 0.1), wear: 0.4, seed: R() });
    cyl(gt, 8.2, 3.2, Math.min(groundAt(ctx, site, 8.2, 3.2) - 0.4, -0.8), 1.1, 0.1, 0.085, 10, 2);
  }

  const a = site.world(-xE, top(-xE), 0), c = site.world(xE, top(xE), 0);
  const info: BridgeInfo = {
    id: b.id, name: b.name, type: b.type, s: b.s,
    a: [a.x, a.y, a.z], b: [c.x, c.y, c.z],
    deckY: top(0), clearance: +under(0).toFixed(2), deckWidth: b.deckWidth,
    piers: bents.map((x) => { const p = site.world(x, 0, 0); return [p.x, p.z] as [number, number]; }),
    channel: channelInfo(site, bents, under, hw),
  };
  return { site, info };
}
