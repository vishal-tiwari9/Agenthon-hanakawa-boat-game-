// parts shared by several bridges and landings: palette, ground sampling, pile bents, railings,
// bronze finials and coursed masonry.
import { Vector3 } from 'three/webgpu';
import type { GameContext } from '../core/context';
import { beam, box, cyl, hex, lathe, rng, sweep, type V3 } from './geom';
import type { Site } from './site';

// linear albedo targets
export const C = {
  vermilion: [0.56, 0.062, 0.028] as V3,
  pile: [0.05, 0.036, 0.026] as V3,
  deck: [0.12, 0.098, 0.076] as V3,
  timber: [0.085, 0.064, 0.046] as V3,
  cedar: [0.1, 0.066, 0.045] as V3,
  granite: [0.25, 0.24, 0.22] as V3,
  roof: [0.062, 0.066, 0.073] as V3,
  black: [0.018, 0.017, 0.016] as V3,
  rope: [0.3, 0.25, 0.17] as V3,
  bamboo: [0.3, 0.26, 0.14] as V3,
};

export function jitter(c: V3, r: () => number, amt = 0.12, hue = 0.04): V3 {
  const k = 1 + (r() - 0.5) * 2 * amt;
  return [c[0] * k * (1 + (r() - 0.5) * hue), c[1] * k, c[2] * k * (1 + (r() - 0.5) * hue)];
}

export function hashId(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const _v = new Vector3();
/** terrain height at a site-local point */
export function groundAt(ctx: GameContext, site: Site, x: number, z: number) {
  _v.set(x, 0, z).applyMatrix4(site.frame);
  return ctx.world.heightAt(_v.x, _v.z);
}

/** abutment pad height the bake flattened for a bridge, if it published one */
export function padHeight(ctx: GameContext, id: string): number | null {
  const ab = (ctx.world.meta?.extra as any)?.terrain?.abutments;
  const v = ab?.[id];
  return typeof v === 'number' ? v : null;
}

/**
 * a pile bent across a deck: round piles at the given z, a cap beam under the girders, a through
 * tie (nuki) and x-bracing when there is room above the water.
 */
export function pileBent(ctx: GameContext, site: Site, x: number, zs: number[], yCapTop: number, o: {
  r?: number; capLen?: number; capH?: number; capW?: number; seed: number; brace?: boolean; lean?: number; braceSide?: number; tint?: V3; nukiDrop?: number;
}) {
  const R = rng(o.seed);
  const g = site.g('timber');
  const r = o.r ?? 0.16;
  const capH = o.capH ?? 0.3, capW = o.capW ?? 0.28;
  const tint = o.tint ?? C.pile;
  const capLen = o.capLen ?? Math.max(...zs.map(Math.abs)) * 2 + 0.9;
  const yCapBot = yCapTop - capH;
  const zMax = Math.max(...zs.map(Math.abs));
  for (const z of zs) {
    g.part({ tint: jitter(tint, R, 0.15), wear: 0.15 + R() * 0.2, seed: R(), grain: 1 });
    const bed = Math.min(groundAt(ctx, site, x, z) - 0.5, -0.6);
    const zb = z === 0 ? 0 : z + Math.sign(z) * (o.lean ?? 0.14);
    cyl(g, x, zb, bed, yCapBot + 0.02, r * 1.04, r * 0.97, 12, 0, [0, z - zb]);
  }
  g.part({ tint: jitter(tint, R, 0.1), wear: 0.2, seed: R(), grain: 2 });
  box(g, x, yCapBot + capH / 2, 0, capW, capH, capLen, 0.02);
  const yN = yCapBot - (o.nukiDrop ?? 1.15);
  if (yN > 0.75) {
    g.part({ tint: jitter(tint, R, 0.1), wear: 0.25, seed: R(), grain: 2 });
    box(g, x, yN, 0, Math.min(0.13, r * 0.8), Math.min(0.24, capH * 0.8), zMax * 2 + 0.7, 0.015);
    if (o.brace !== false && yN - 0.45 > 0.7 && zMax > 0.5) {
      const bx = x + (o.braceSide ?? 1) * (r + 0.05);
      const bw = Math.min(0.09, r * 0.6), bh = Math.min(0.17, r * 1.1);
      g.part({ tint: jitter(tint, R, 0.1), wear: 0.2, seed: R() });
      beam(g, [bx, yN - 0.1, -zMax], [bx, 0.4, zMax], bw, bh, 0.012, [1, 0, 0]);
      g.part({ tint: jitter(tint, R, 0.1), wear: 0.2, seed: R() });
      beam(g, [bx, yN - 0.1, zMax], [bx, 0.4, -zMax], bw, bh, 0.012, [1, 0, 0]);
    }
  }
  return { yCapBot, yN };
}

/** bronze onion finial (giboshi) with a collar, sitting on a post top at (x, y, z) */
export function giboshi(site: Site, x: number, y: number, z: number, s = 1) {
  const g = site.g('bronze', true);
  g.part({ seed: Math.random() });
  const P: [number, number][] = [
    [0.1, 0], [0.105, 0.012], [0.105, 0.03], [0.085, 0.036], [0.078, 0.06], [0.086, 0.066], [0.086, 0.078],
    [0.07, 0.086], [0.085, 0.11], [0.108, 0.15], [0.112, 0.18], [0.1, 0.22], [0.072, 0.26], [0.04, 0.3], [0.018, 0.335],
    [0.012, 0.36], [0.02, 0.372], [0.012, 0.39], [0.0, 0.405],
  ];
  lathe(g, x, z, P.map(([r, h]) => [r * s, y + h * s]), 18);
}

/**
 * railing along a curved deck edge: posts (regular and main), and continuous rails swept along the
 * deck profile. top(x) is the deck top; z is the rail line. returns main post tops for finials.
 */
export function railing(site: Site, top: (x: number) => number, x0: number, x1: number, z: number, mains: number[], o: {
  mat: 'lacquer' | 'timber'; tint: V3; seed: number; height?: number; spacing?: number; rails?: [number, number, number][]; post?: number; main?: number;
}) {
  const R = rng(o.seed);
  const H = o.height ?? 1.02;
  const ps = o.post ?? 0.11, pm = o.main ?? 0.18;
  const g = site.g(o.mat);
  const gd = site.g(o.mat, true);
  const ms = [...new Set(mains.map((m) => +m.toFixed(3)))].sort((a, b) => a - b);
  const posts: number[] = [];
  for (let i = 0; i < ms.length - 1; i++) {
    const a = ms[i], b = ms[i + 1];
    const n = Math.max(1, Math.round((b - a) / (o.spacing ?? 1.85)));
    for (let k = 1; k < n; k++) posts.push(a + ((b - a) * k) / n);
  }
  for (const x of posts) {
    gd.part({ tint: jitter(o.tint, R, 0.06), wear: R() * 0.5, seed: R() });
    const y0 = top(x) - 0.02;
    box(gd, x, y0 + H / 2 + 0.03, z, ps, H + 0.06, ps, 0.012);
  }
  const tops: V3[] = [];
  for (const x of ms) {
    g.part({ tint: jitter(o.tint, R, 0.05), wear: 0.3 + R() * 0.5, seed: R() });
    const y0 = top(x) - 0.02;
    const h = H + 0.16;
    box(g, x, y0 + h / 2, z, pm, h, pm, 0.018);
    // collar band under the finial
    g.part({ tint: [0.02, 0.018, 0.016], wear: 0.8, seed: R() });
    box(g, x, y0 + h + 0.02, z, pm + 0.03, 0.04, pm + 0.03, 0.008);
    tops.push([x, y0 + h + 0.04, z]);
  }
  const rails = o.rails ?? [[0.13, 0.09, 0.11], [0.43, 0.065, 0.07], [0.68, 0.065, 0.07], [H - 0.06, 0.1, 0.085]];
  for (let i = 0; i < ms.length - 1; i++) {
    const a = ms[i] + pm / 2, b = ms[i + 1] - pm / 2;
    const n = Math.max(2, Math.ceil((b - a) / 0.5));
    for (const [h, w, t] of rails) {
      const path: V3[] = [];
      for (let k = 0; k <= n; k++) {
        const x = a + ((b - a) * k) / n;
        path.push([x, top(x) + h, z]);
      }
      // the top rail belongs to the silhouette; the rest is near detail
      const tg = h > H - 0.2 || h < 0.2 ? g : gd;
      tg.part({ tint: jitter(o.tint, R, 0.05), wear: 0.2 + R() * 0.4, seed: R(), grain: 0 });
      sweep(tg, path, [0, 0, 1], w, t, true);
    }
  }
  return tops;
}

/**
 * coursed granite filling a prism: x0..x1 along the site x, z0..z1 across, from yb up to top(x).
 * faces listed in `show` get split into blocks; hidden faces are skipped to save triangles.
 */
export function masonry(site: Site, x0: number, x1: number, z0: number, z1: number, yb: number, top: (x: number) => number, o: {
  seed: number; course?: [number, number]; len?: [number, number]; tint?: V3; moss?: number; ch?: number; splitZ?: boolean;
}) {
  const R = rng(o.seed);
  const g = site.g('stone');
  const [c0, c1] = o.course ?? [0.34, 0.5];
  const [l0, l1] = o.len ?? [0.55, 1.15];
  const ch = o.ch ?? 0.035;
  const tmax = Math.max(top(x0), top(x1), top((x0 + x1) / 2));
  let y = yb;
  let row = 0;
  while (y < tmax - 0.02) {
    const h = c0 + R() * (c1 - c0);
    const ya = y, yc = y + h;
    let x = x0 - (row % 2 ? R() * 0.4 : 0);
    while (x < x1 - 0.01) {
      let len = l0 + R() * (l1 - l0);
      if (x1 - (x + len) < 0.35) len = x1 - x;
      const xa = Math.max(x0, x), xb = Math.min(x1, x + len);
      x += len;
      const ta = Math.min(yc, top(xa)), tb = Math.min(yc, top(xb));
      if (ta <= ya + 0.05 && tb <= ya + 0.05) continue;
      const tA = Math.max(ta, ya + 0.05), tB = Math.max(tb, ya + 0.05);
      const zsplit: number[] = [z0];
      if (o.splitZ) {
        let zz = z0 + (row % 2 ? 0.35 + R() * 0.4 : 0.7 + R() * 0.5);
        while (zz < z1 - 0.4) { zsplit.push(zz); zz += 0.7 + R() * 0.6; }
      }
      zsplit.push(z1);
      for (let k = 0; k < zsplit.length - 1; k++) {
        const za = zsplit[k], zb = zsplit[k + 1];
        const pr = (R() - 0.5) * 0.03;
        g.part({ tint: jitter(o.tint ?? C.granite, R, 0.14, 0.08), seed: R(), moss: (o.moss ?? 0.3) * R(), grain: 1 });
        hex(g, [
          [xa, ya, za - pr], [xb, ya, za - pr], [xa, tA, za - pr], [xb, tB, za - pr],
          [xa, ya, zb + pr], [xb, ya, zb + pr], [xa, tA, zb + pr], [xb, tB, zb + pr],
        ], ch);
      }
    }
    y = yc;
    row++;
  }
}
