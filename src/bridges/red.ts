// the vermilion bridge (ref1's hero): a gently arched lacquered timber deck on dark pile bents, with a
// four-rail koran railing, bronze giboshi on the main posts and cut-granite abutments.
import type { GameContext } from '../core/context';
import { riverFrame, type Bridge } from '../world/layout';
import { beam, box, frameMatrix, hex, rng, sweep, type V3 } from './geom';
import { C, giboshi, groundAt, hashId, jitter, masonry, padHeight, pileBent, railing } from './parts';
import { Site } from './site';
import type { BridgeInfo } from './types';

export function buildRed(ctx: GameContext, b: Bridge): { site: Site; info: BridgeInfo } {
  const f = riverFrame(b.s);
  const site = new Site(b.id, frameMatrix(f.x, 0, f.z, f.nx, f.nz, f.tx, f.tz));
  site.far = 1100;
  site.detailFar = 320;
  const R = rng(hashId(b.id));
  const hw = f.width / 2;
  const half = b.deckWidth / 2;
  const xE = hw + 3.2;
  const pad = padHeight(ctx, b.id);
  const gEnd = (sg: number) => {
    const g = Math.max(groundAt(ctx, site, sg * xE, 0), groundAt(ctx, site, sg * xE, 1.2), groundAt(ctx, site, sg * xE, -1.2));
    return Math.min(3.5, Math.max(0.3, pad !== null ? Math.max(pad, g) : g));
  };
  const gL = gEnd(-1), gR = gEnd(1);
  const boardT = 0.07, girderH = 0.4;
  const yC = b.clearance + boardT + girderH;
  /** deck top along the span */
  const top = (x: number) => {
    const yE = (x < 0 ? gL : gR) + 0.14;
    const t = Math.min(1, Math.abs(x) / xE);
    return yC - (yC - yE) * Math.pow(t, 1.8);
  };
  const under = (x: number) => top(x) - boardT - girderH;

  // ---- deck boards across the span ----
  {
    const g = site.g('timber');
    const w = 0.27, gap = 0.012;
    for (let x = -xE + 0.05; x < xE - w; x += w + gap) {
      const xa = x, xb = x + w;
      g.part({ tint: jitter(C.deck, R, 0.16, 0.1), wear: 0.35 + R() * 0.45, seed: R(), grain: 2 });
      const ta = top(xa), tb = top(xb);
      const zz = half + 0.02 + (R() - 0.5) * 0.02;
      const c: V3[] = [
        [xa, ta - boardT, -zz], [xb, tb - boardT, -zz], [xa, ta, -zz], [xb, tb, -zz],
        [xa, ta - boardT, zz], [xb, tb - boardT, zz], [xa, ta, zz], [xb, tb, zz],
      ];
      // boards are sawn straight: tilt them to the local slope rather than bending
      hex(g, c, 0.012);
    }
  }

  // ---- girders, fascia and cross ties (lacquered) ----
  const path = (dy: number, z: number, x0 = -xE, x1 = xE, step = 0.45) => {
    const n = Math.max(2, Math.ceil((x1 - x0) / step));
    const p: V3[] = [];
    for (let k = 0; k <= n; k++) {
      const x = x0 + ((x1 - x0) * k) / n;
      p.push([x, top(x) + dy, z]);
    }
    return p;
  };
  {
    const g = site.g('lacquer');
    for (const z of [-1.15, -0.38, 0.38, 1.15]) {
      g.part({ tint: jitter(C.vermilion, R, 0.06), wear: 0.45, seed: R(), grain: 0 });
      sweep(g, path(-boardT - girderH / 2, z, -xE + 0.2, xE - 0.2), [0, 0, 1], 0.22, girderH);
    }
    // fascia boards over the girder ends, the thick red band under the railing
    for (const sz of [-1, 1]) {
      g.part({ tint: jitter(C.vermilion, R, 0.04), wear: 0.25, seed: R(), grain: 0 });
      sweep(g, path(-0.2, sz * (half + 0.055), -xE + 0.02, xE - 0.02, 0.3), [0, 0, 1], 0.08, 0.5);
      // drip moulding along the fascia foot
      g.part({ tint: jitter(C.vermilion, R, 0.04), wear: 0.4, seed: R(), grain: 0 });
      sweep(g, path(-0.46, sz * (half + 0.085), -xE + 0.02, xE - 0.02, 0.3), [0, 0, 1], 0.07, 0.05);
    }
  }

  // ---- pile bents ----
  const bentX = [7, 14, 20].flatMap((x) => [-x, x]).filter((x) => Math.abs(x) < hw - 1.4).sort((a, b) => a - b);
  const zs = [-1.3, 0, 1.3];
  for (const [i, x] of bentX.entries()) {
    const yu = under(x);
    const { yCapBot } = pileBent(ctx, site, x, zs, yu, { seed: R() * 1e9, braceSide: i % 2 ? 1 : -1 });
    // cross tie under the girders at every bent is the cap itself; knee braces into the spans
    if (Math.abs(x) <= 14.5) {
      const g = site.g('timber');
      for (const z of [-1.3, 1.3]) {
        for (const d of [-1, 1]) {
          const xa = x + d * 0.2, xb = x + d * 1.7;
          g.part({ tint: jitter(C.pile, R, 0.1), wear: 0.25, seed: R() });
          beam(g, [xa, yCapBot - 0.95, z], [xb, under(xb) + 0.02, z], 0.12, 0.16, 0.012, [0, 0, 1]);
        }
      }
    }
    site.box(x, 0.2, 0, 0.32, 2.4, 1.72, 0.25);
  }
  // secondary cross ties between bents (visible from the boat under the deck)
  {
    const g = site.g('lacquer');
    const ties: number[] = [];
    for (let i = 0; i < bentX.length - 1; i++) {
      const a = bentX[i], c = bentX[i + 1];
      const n = Math.round((c - a) / 3.4);
      for (let k = 1; k < n; k++) ties.push(a + ((c - a) * k) / n);
    }
    for (const x of ties) {
      g.part({ tint: jitter(C.vermilion, R, 0.06), wear: 0.5, seed: R(), grain: 2 });
      box(g, x, under(x) - 0.09, 0, 0.16, 0.18, half * 2 - 0.1, 0.012);
    }
  }

  // ---- stone abutments, with timber walings tying the last bent to them ----
  for (const sg of [-1, 1]) {
    const xa = sg * (hw - 0.9), xb = sg * (xE + 0.4);
    const [lo, hi] = sg < 0 ? [xb, xa] : [xa, xb];
    masonry(site, lo, hi, -2.0, 2.0, -1.8, (x) => under(x) + 0.02, { seed: R() * 1e9, splitZ: true, moss: 0.45 });
    site.box((xa + xb) / 2, 0.3, 0, Math.abs(xb - xa) / 2, 2.2, 2.05, 0.3);
    const outer = bentX.length ? (sg < 0 ? bentX[0] : bentX[bentX.length - 1]) : sg * (hw - 3);
    const g = site.g('timber');
    for (const y of [0.55, 1.25]) {
      for (const z of [-1.3, 1.3]) {
        g.part({ tint: jitter(C.pile, R, 0.12), wear: 0.3, seed: R(), grain: 0 });
        box(g, (outer + xa) / 2, y, z + Math.sign(z) * 0.22, Math.abs(xa - outer) + 0.5, 0.2, 0.12, 0.015);
      }
    }
    // the gap between the last bent and the abutment is closed for the boat
    site.box((outer + xa) / 2, 0.3, 0, Math.abs(xa - outer) / 2 + 0.2, 2.0, 1.65, 0.25);
    // threshold slab where the deck meets the path
    const gs = site.g('stone');
    gs.part({ tint: jitter(C.granite, R, 0.1), seed: R(), moss: 0.2 });
    box(gs, sg * (xE + 0.75), top(sg * xE) - 0.12, 0, 0.7, 0.24, half * 2 + 0.3, 0.03);
  }

  // ---- railings with giboshi on the main posts ----
  const mains = [-xE + 0.3, ...bentX.filter((x) => Math.abs(x) < 8), xE - 0.3];
  for (const sz of [-1, 1]) {
    const tops = railing(site, top, -xE + 0.3, xE - 0.3, sz * (half - 0.06), mains, { mat: 'lacquer', tint: C.vermilion, seed: R() * 1e9 });
    for (const t of tops) giboshi(site, t[0], t[1], t[2], 1.15);
  }

  const a = site.world(-xE, top(-xE), 0), c = site.world(xE, top(xE), 0);
  const info: BridgeInfo = {
    id: b.id, name: b.name, type: b.type, s: b.s,
    a: [a.x, a.y, a.z], b: [c.x, c.y, c.z],
    deckY: top(0), clearance: under(0), deckWidth: b.deckWidth,
    piers: bentX.map((x) => { const p = site.world(x, 0, 0); return [p.x, p.z]; }),
    channel: channelInfo(site, bentX, under, hw),
  };
  return { site, info };
}

/** the navigable gaps between piers with their minimum clear height */
export function channelInfo(site: Site, piers: number[], under: (x: number) => number, hw: number) {
  const edges = [-hw, ...piers, hw];
  const out: { a: [number, number]; b: [number, number]; clearance: number }[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const x0 = edges[i] + 0.3, x1 = edges[i + 1] - 0.3;
    if (x1 - x0 < 2.5) continue;
    let m = Infinity;
    for (let k = 0; k <= 8; k++) m = Math.min(m, under(x0 + ((x1 - x0) * k) / 8));
    const p0 = site.world(x0, 0, 0), p1 = site.world(x1, 0, 0);
    out.push({ a: [p0.x, p0.z], b: [p1.x, p1.z], clearance: +m.toFixed(2) });
  }
  return out;
}
