// the spectacles bridge (megane-bashi): two segmental granite arches whose centers sit just below the
// water so each arch and its reflection close into a ring. voussoir barrels, coursed ashlar faces cut
// around the rings, cutwaters on the central pier, parapets with coping, a paved humped deck.
import { Matrix4 } from 'three/webgpu';
import type { GameContext } from '../core/context';
import { riverFrame, type Bridge } from '../world/layout';
import { box, frameMatrix, hex, rng, slab, type Geo, type V3 } from './geom';
import { C, groundAt, hashId, jitter, padHeight } from './parts';
import { Site } from './site';
import type { BridgeInfo } from './types';

export function buildStone(ctx: GameContext, b: Bridge): { site: Site; info: BridgeInfo } {
  const f = riverFrame(b.s);
  const frame = frameMatrix(f.x, 0, f.z, f.nx, f.nz, f.tx, f.tz);
  const site = new Site(b.id, frame);
  site.far = 1100;
  site.detailFar = 300;
  const R0 = rng(hashId(b.id));
  const hw = f.width / 2;
  const pad = padHeight(ctx, b.id);
  const xE = hw + 5;
  const gEnd = (sg: number) => {
    const g = groundAt(ctx, site, sg * xE, 0);
    return Math.min(3.5, Math.max(0.3, pad !== null ? Math.max(pad, g) : g));
  };
  const gL = gEnd(-1), gR = gEnd(1);

  // arch geometry: centers below the water so the arch plus its reflection reads as a ring
  const pierHalf = 1.3, chord = Math.min(5.6, (hw - pierHalf - 3.2) / 1.0);
  const d = 1.0;
  const Ri = Math.hypot(chord, d);
  const ring = 0.62;
  const Re = Ri + ring;
  const arches = [-1, 1].map((sg) => sg * (pierHalf + chord));
  const cy = -d;
  const zH = b.deckWidth / 2 + 0.3;
  const yBot = -1.7;
  const fill = 0.34;

  const ext = (x: number) => {
    let e = -Infinity;
    for (const cx of arches) {
      const dx = x - cx;
      if (Math.abs(dx) < Re) e = Math.max(e, cy + Math.sqrt(Re * Re - dx * dx));
    }
    return e;
  };
  const intr = (x: number) => {
    let e = -Infinity;
    for (const cx of arches) {
      const dx = x - cx;
      if (Math.abs(dx) < Ri) e = Math.max(e, cy + Math.sqrt(Ri * Ri - dx * dx));
    }
    return e;
  };
  // humped deck: cosine shape, raised until it clears every extrados by the fill depth
  const shape = (x: number) => Math.pow(Math.cos((Math.PI / 2) * Math.min(1, Math.abs(x) / xE)), 0.85);
  let yT = 0;
  for (let x = -xE + 0.5; x <= xE - 0.5; x += 0.25) {
    const yE = x < 0 ? gL : gR;
    const need = ext(x) + fill;
    const s = shape(x);
    if (s > 0.05) yT = Math.max(yT, yE + (need - yE) / s);
  }
  const deck = (x: number) => {
    const yE = (x < 0 ? gL : gR) + 0.06;
    return yE + (yT - yE) * shape(x);
  };

  // ---- voussoir barrels ----
  const gs = site.g('stone');
  for (const [ai, cx] of arches.entries()) {
    const th0 = Math.asin(Math.max(-1, Math.min(1, (yBot - cy) / Ri)));
    const span = Math.PI - 2 * th0;
    let n = Math.round((Ri * span) / 0.43);
    if (n % 2 === 0) n++;
    for (let k = 0; k < n; k++) {
      const a0 = th0 + (span * k) / n, a1 = th0 + (span * (k + 1)) / n;
      const key = k === (n - 1) / 2;
      const ro = key ? Re + 0.1 : Re;
      // staggered joints along the barrel
      const cuts = [-zH];
      let z = -zH + (k % 2 ? 0.55 + R0() * 0.3 : 0.95 + R0() * 0.3);
      while (z < zH - 0.45) { cuts.push(z); z += 0.85 + R0() * 0.5; }
      cuts.push(zH);
      for (let j = 0; j < cuts.length - 1; j++) {
        const za = cuts[j] - (j === 0 ? 0.03 + (key ? 0.04 : 0) : 0), zb = cuts[j + 1] + (j === cuts.length - 2 ? 0.03 + (key ? 0.04 : 0) : 0);
        const P = (a: number, r: number, zz: number): V3 => [cx + Math.cos(a) * r, cy + Math.sin(a) * r, zz];
        gs.part({ tint: jitter(C.granite, R0, 0.13, 0.08), seed: R0(), moss: 0.25 + R0() * 0.3, grain: 2 });
        const face = j === 0 || j === cuts.length - 2;
        // skip the hidden back (outer radius) face on interior barrel stones
        const skip = face ? 0 : (1 << 3);
        hex(gs, [
          P(a0, Ri, za), P(a1, Ri, za), P(a0, ro, za), P(a1, ro, za),
          P(a0, Ri, zb), P(a1, Ri, zb), P(a0, ro, zb), P(a1, ro, zb),
        ], 0.035, skip);
      }
    }
    void ai;
  }

  // ---- ashlar faces, cut around the rings and under the deck line ----
  const faceMats = [
    frame.clone().multiply(new Matrix4().makeTranslation(0, 0, zH)),
    frame.clone().multiply(new Matrix4().makeTranslation(0, 0, -zH)).multiply(new Matrix4().makeRotationY(Math.PI)),
  ];
  for (const [fi, fm] of faceMats.entries()) {
    const R = rng(hashId(b.id) + fi * 7919);
    gs.at(fm);
    const mirror = fi === 1 ? -1 : 1;
    let y = yBot, row = 0;
    const yMax = yT + 0.1;
    while (y < yMax) {
      const h = 0.36 + R() * 0.16;
      const y0 = y, y1 = y + h;
      let x = -xE - (row % 2 ? 0.2 + R() * 0.4 : 0);
      while (x < xE) {
        const len = 0.6 + R() * 0.7 + (Math.abs(x) > hw ? 0.3 : 0);
        const x0 = Math.max(-xE, x), x1 = Math.min(xE, x + len);
        x += len;
        if (x1 - x0 < 0.15) continue;
        // sample validity: the block exists where top > bottom (+ a sliver margin)
        const bot = (xx: number) => Math.max(y0, ext(xx));
        const topf = (xx: number) => Math.min(y1, deck(xx));
        const N = Math.max(2, Math.ceil((x1 - x0) / 0.08));
        const runs: [number, number][] = [];
        let start = -1;
        for (let k = 0; k <= N; k++) {
          const xx = x0 + ((x1 - x0) * k) / N;
          const ok = topf(xx) - bot(xx) > 0.07;
          if (ok && start < 0) start = xx;
          if ((!ok || k === N) && start >= 0) {
            const end = ok ? xx : x0 + ((x1 - x0) * (k - 1)) / N;
            if (end - start > 0.12) runs.push([start, end]);
            start = -1;
          }
        }
        for (const [a, c] of runs) {
          const curved = ext(a) > y0 || ext(c) > y0 || ext((a + c) / 2) > y0 || deck(a) < y1 || deck(c) < y1;
          const m = curved ? Math.max(2, Math.ceil((c - a) / 0.14)) : 1;
          const poly: [number, number][] = [];
          for (let k = 0; k <= m; k++) { const xx = a + ((c - a) * k) / m; poly.push([xx * mirror, bot(xx)]); }
          for (let k = m; k >= 0; k--) { const xx = a + ((c - a) * k) / m; poly.push([xx * mirror, topf(xx)]); }
          gs.part({ tint: jitter(C.granite, R, 0.15, 0.08), seed: R(), moss: 0.15 + R() * 0.35, grain: 1 });
          slab(gs, poly, R() * 0.022, 0.4, 0.03);
        }
      }
      y = y1;
      row++;
    }
  }
  gs.at(frame);

  // ---- cutwaters on the pier, both sides ----
  for (const sz of [-1, 1]) {
    const R = rng(hashId(b.id) + 31 + sz);
    let y = yBot, row = 0;
    const capY = 1.55;
    while (y < capY - 0.05) {
      const h = Math.min(0.45, capY - y);
      const y0 = y, y1 = y + h;
      gs.part({ tint: jitter(C.granite, R, 0.14, 0.08), seed: R(), moss: 0.4, grain: 1 });
      const zr = sz * zH, zm = sz * (zH + 0.65), zn = sz * (zH + 1.35);
      const w = pierHalf - 0.05;
      const split = row % 2 ? -0.2 : 0.25;
      hexOrdered(gs, [[-w, y0, zr], [split, y0, zr], [-w, y1, zr], [split, y1, zr], [-w, y0, zm], [split, y0, zm], [-w, y1, zm], [split, y1, zm]]);
      gs.part({ tint: jitter(C.granite, R, 0.14, 0.08), seed: R(), moss: 0.4, grain: 1 });
      hexOrdered(gs, [[split, y0, zr], [w, y0, zr], [split, y1, zr], [w, y1, zr], [split, y0, zm], [w, y0, zm], [split, y1, zm], [w, y1, zm]]);
      gs.part({ tint: jitter(C.granite, R, 0.14, 0.08), seed: R(), moss: 0.45, grain: 1 });
      hexOrdered(gs, [[-w, y0, zm], [w, y0, zm], [-w, y1, zm], [w, y1, zm], [-0.1, y0, zn], [0.1, y0, zn], [-0.1, y1, zn], [0.1, y1, zn]]);
      y = y1;
      row++;
    }
    // sloped capstone shedding water off the nose
    const zr = sz * zH, zn = sz * (zH + 1.4);
    const w = pierHalf + 0.03;
    // the pier lies between the arches, where ext() has no finite value
    const top = Math.max(capY + 0.18, Math.min(deck(0) - 0.05, 2.6));
    gs.part({ tint: jitter(C.granite, R, 0.1), seed: R(), moss: 0.7, grain: 2 });
    hexOrdered(gs, [[-w, capY, zr], [w, capY, zr], [-w, top, zr], [w, top, zr], [-0.12, capY, zn], [0.12, capY, zn], [-0.12, capY + 0.18, zn], [0.12, capY + 0.18, zn]]);
  }

  // ---- parapets with coping, and the paved deck ----
  {
    const R = rng(hashId(b.id) + 99);
    for (const sz of [-1, 1]) {
      let x = -xE + 0.2;
      const zo = sz * (zH + 0.035), zi = sz * (zH - 0.3);
      const [za, zb] = sz < 0 ? [zo, zi] : [zi, zo];
      while (x < xE - 0.25) {
        const len = Math.min(xE - 0.2 - x, 1.1 + R() * 0.5);
        const xa = x, xb = x + len;
        x = xb;
        gs.part({ tint: jitter(C.granite, R, 0.12, 0.06), seed: R(), moss: 0.25, grain: 1 });
        const ya = deck(xa), yb = deck(xb);
        hex(gs, [[xa, ya - 0.1, za], [xb, yb - 0.1, za], [xa, ya + 0.62, za], [xb, yb + 0.62, za], [xa, ya - 0.1, zb], [xb, yb - 0.1, zb], [xa, ya + 0.62, zb], [xb, yb + 0.62, zb]], 0.03);
      }
      x = -xE + 0.1;
      const zo2 = sz * (zH + 0.08), zi2 = sz * (zH - 0.36);
      const [zc, zd] = sz < 0 ? [zo2, zi2] : [zi2, zo2];
      let first = true;
      while (x < xE - 0.15) {
        const len = Math.min(xE - 0.1 - x, (first ? 0.6 : 0.9) + R() * 0.6);
        first = false;
        const xa = x, xb = x + len;
        x = xb;
        gs.part({ tint: jitter(C.granite, R, 0.1, 0.06), seed: R(), moss: 0.5, grain: 0 });
        const ya = deck(xa) + 0.62, yb = deck(xb) + 0.62;
        hex(gs, [[xa, ya, zc], [xb, yb, zc], [xa, ya + 0.15, zc], [xb, yb + 0.15, zc], [xa, ya, zd], [xb, yb, zd], [xa, ya + 0.15, zd], [xb, yb + 0.15, zd]], 0.035);
      }
      // end posts
      for (const sx of [-1, 1]) {
        const xp = sx * (xE - 0.05);
        gs.part({ tint: jitter(C.granite, R, 0.1), seed: R(), moss: 0.3 });
        box(gs, xp, deck(xp) + 0.45, sz * (zH - 0.12), 0.46, 1.0, 0.5, 0.04);
      }
    }
    // paving: two slabs across, staggered
    const w = zH - 0.3;
    let x = -xE + 0.3, row = 0;
    while (x < xE - 0.3) {
      const len = Math.min(xE - 0.3 - x, 0.55 + R() * 0.25);
      const xa = x, xb = x + len;
      x = xb;
      const split = (row % 2 ? -0.35 : 0.3) + (R() - 0.5) * 0.3;
      for (const [za, zb] of [[-w, split], [split, w]]) {
        gs.part({ tint: jitter([0.2, 0.19, 0.175], R, 0.12, 0.06), seed: R(), moss: 0.08, grain: 2 });
        const ya = deck(xa) + 0.03, yb = deck(xb) + 0.03;
        hex(gs, [[xa, ya - 0.18, za], [xb, yb - 0.18, za], [xa, ya, za], [xb, yb, za], [xa, ya - 0.18, zb], [xb, yb - 0.18, zb], [xa, ya, zb], [xb, yb, zb]], 0.02, 1 << 2);
      }
      row++;
    }
  }

  // ---- colliders: pier with its cutwaters, the solid abutments (a little cushion toward the arch) ----
  site.box(0, 0.1, 0, pierHalf + 0.45, 2.3, zH + 1.3, 0.7);
  for (const sg of [-1, 1]) {
    const x0 = sg * (arches[sg < 0 ? 0 : 1] * sg + chord - 0.45);
    const x1 = sg * (hw + 3);
    site.box((x0 + x1) / 2, 0.1, 0, Math.abs(x1 - x0) / 2, 2.3, zH + 0.3, 0.4);
  }

  const a = site.world(-xE, deck(-xE), 0), c = site.world(xE, deck(xE), 0);
  const channel = arches.map((cx) => {
    const x0 = cx - chord * 0.6, x1 = cx + chord * 0.6;
    const p0 = site.world(x0, 0, 0), p1 = site.world(x1, 0, 0);
    return { a: [p0.x, p0.z] as [number, number], b: [p1.x, p1.z] as [number, number], clearance: +Math.min(intr(x0), intr(x1)).toFixed(2) };
  });
  const info: BridgeInfo = {
    id: b.id, name: b.name, type: b.type, s: b.s,
    a: [a.x, a.y, a.z], b: [c.x, c.y, c.z],
    deckY: deck(0), clearance: +(Ri - d).toFixed(2), deckWidth: b.deckWidth,
    piers: [(() => { const p = site.world(0, 0, 0); return [p.x, p.z] as [number, number]; })()],
    channel,
  };
  return { site, info };
}

/** hexahedron from corners given in x + 2y + 4z order, chamfered like the rest of the masonry */
function hexOrdered(g: Geo, c: V3[]) {
  hex(g, c, 0.035);
}
