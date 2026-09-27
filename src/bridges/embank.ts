// ishigaki embankments along the village waterfront: battered, coursed granite walls with a concave
// (sori) face, long coping stones, gangi water steps down into the river and small timber landing
// platforms at their feet. built in world space along the bank line, chunked for culling.
import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import type { GameContext } from '../core/context';
import { bankPoint, forwardToHeading, riverFrame } from '../world/layout';
import { cyl, hex, rng, type V3 } from './geom';
import { C, hashId, jitter } from './parts';
import { Site } from './site';
import type { PlatformInfo } from './types';

export interface WallRun {
  id: string;
  side: -1 | 1;
  s0: number;
  s1: number;
  /** along-river ranges left open (landing stairs, bridge abutments) */
  gaps: [number, number][];
  /** water steps: start s (steps descend toward +s) and whether a timber platform sits at the foot */
  gangi: { s: number; platform: boolean }[];
  /** override the wall top (else sampled from the ground behind the wall) */
  top?: number;
}

const YB = -1.55;
const BATTER = 0.72;

/** builds into `shared` when given (one merged site for the whole waterfront), else ~45 m chunk sites */
export function buildWall(ctx: GameContext, run: WallRun, shared?: Site) {
  const R = rng(hashId(run.id));
  const side = run.side;
  // wall top from the ground behind it, smoothed along the bank
  const topRaw = (s: number) => {
    let acc = 0;
    for (const ds of [-2, -1, 0, 1, 2]) {
      const p = bankPoint(s + ds, side, 2.6);
      acc += ctx.world.heightAt(p.x, p.z);
    }
    return Math.min(3.0, Math.max(0.8, acc / 5));
  };
  // tabulated every 10 cm and interpolated: the smoothed top is queried several times per stone
  const T0 = run.s0 - 4, TD = 0.1, TN = Math.ceil((run.s1 - run.s0 + 8) / TD) + 2;
  const table = new Float32Array(TN);
  for (let i = 0; i < TN; i++) table[i] = topRaw(T0 + i * TD);
  const topAt = (s: number) => {
    const f = Math.max(0, Math.min(TN - 1.001, (s - T0) / TD));
    const i = Math.floor(f), t = f - i;
    return table[i] + (table[i + 1] - table[i]) * t;
  };
  const yt = (s: number) => run.top ?? topAt(s);
  /** face offset from the water's edge (negative = out over the water) at height y */
  const off = (s: number, y: number) => {
    const t = Math.max(0, Math.min(1, (yt(s) - y) / (yt(s) - YB)));
    return -BATTER * Math.pow(t, 1.55);
  };
  const W = (s: number, o: number, y: number): V3 => {
    const p = bankPoint(s, side, o);
    return [p.x, y, p.z];
  };
  /** cut [a, b] around the gaps */
  const pieces = (a: number, b: number): [number, number][] => {
    let out: [number, number][] = [[a, b]];
    for (const [g0, g1] of run.gaps) {
      const next: [number, number][] = [];
      for (const [p, q] of out) {
        if (q <= g0 || p >= g1) next.push([p, q]);
        else {
          if (p < g0 - 0.12) next.push([p, g0]);
          if (q > g1 + 0.12) next.push([g1, q]);
        }
      }
      out = next;
    }
    return out;
  };

  // chunks of ~45 m, each its own site for culling
  const sites: Site[] = shared ? [shared] : [];
  const nC = shared ? 1 : Math.max(1, Math.round((run.s1 - run.s0) / 45));
  const chunkOf = (s: number) => Math.min(nC - 1, Math.max(0, Math.floor(((s - run.s0) / (run.s1 - run.s0)) * nC)));
  for (let i = 0; i < nC && !shared; i++) {
    const site = new Site(`${run.id}-${i}`, new Matrix4());
    const sm = run.s0 + ((i + 0.5) * (run.s1 - run.s0)) / nC;
    const c = bankPoint(sm, side, 0);
    site.center.set(c.x, 1, c.z);
    site.far = 650;
    site.detailFar = 140;
    sites.push(site);
  }

  // ---- coursed wall stones ----
  let y = YB, row = 0;
  const yMax = Math.max(yt(run.s0), yt((run.s0 + run.s1) / 2), yt(run.s1));
  while (y < yMax - 0.3) {
    const under = y < -0.45;
    const h = under ? 0.55 + R() * 0.2 : 0.27 + R() * 0.16;
    const ya = y, yc = y + h;
    let s = run.s0 - (row % 2 ? R() * 0.5 : 0);
    while (s < run.s1) {
      const len = under ? 0.9 + R() * 0.6 : 0.42 + R() * 0.55;
      const a0 = Math.max(run.s0, s), b0 = Math.min(run.s1, s + len);
      s += len;
      if (b0 - a0 < 0.1) continue;
      for (const [a, b] of pieces(a0, b0)) {
        const ta = Math.min(yc, yt(a) - 0.27), tb = Math.min(yc, yt(b) - 0.27);
        if (ta < ya + 0.08 || tb < ya + 0.08) continue;
        const bulge = 0.015 + R() * 0.05;
        const tilt = (R() - 0.5) * 0.03;
        const g = sites[chunkOf((a + b) / 2)].g('stone');
        g.part({ tint: jitter(C.granite, R, 0.16, 0.1), seed: R(), moss: under ? 0.6 : 0.2 + R() * 0.4, grain: 1 });
        const fa0 = off(a, ya) - bulge - tilt, fa1 = off(a, ta) - bulge + tilt;
        const fb0 = off(b, ya) - bulge - tilt, fb1 = off(b, tb) - bulge + tilt;
        hex(g, [
          W(a, fa0, ya), W(b, fb0, ya), W(a, fa1, ta), W(b, fb1, tb),
          W(a, fa0 + 0.55, ya), W(b, fb0 + 0.55, ya), W(a, fa1 + 0.55, ta), W(b, fb1 + 0.55, tb),
        ], under ? 0 : 0.04, (1 << 5) | (1 << 2));
      }
    }
    y = yc;
    row++;
  }
  // ---- coping (kasa-ishi) ----
  {
    let s = run.s0;
    while (s < run.s1 - 0.05) {
      const len = Math.min(run.s1 - s, 0.85 + R() * 0.6);
      const a0 = s, b0 = s + len;
      s = b0;
      for (const [a, b] of pieces(a0, b0)) {
        const g = sites[chunkOf((a + b) / 2)].g('stone');
        g.part({ tint: jitter(C.granite, R, 0.12, 0.08), seed: R(), moss: 0.35, grain: 0 });
        const y0 = Math.min(yt(a), yt(b)) - 0.29;
        const fa = -0.06 - R() * 0.02, fb = -0.06 - R() * 0.02;
        hex(g, [
          W(a, fa, y0), W(b, fb, y0), W(a, fa, yt(a) + 0.03), W(b, fb, yt(b) + 0.03),
          W(a, 0.8, y0), W(b, 0.8, y0), W(a, 0.8, yt(a) + 0.03), W(b, 0.8, yt(b) + 0.03),
        ], 0.04, 1 << 2);
      }
    }
  }

  // ---- colliders: the wall face at the waterline ----
  const up = new Vector3(0, 1, 0);
  for (let s = run.s0; s < run.s1 - 0.5; s += 4) {
    const s1 = Math.min(run.s1, s + 4);
    for (const [a, b] of pieces(s, s1)) {
      if (b - a < 0.6) continue;
      const m = (a + b) / 2;
      const face = off(m, 0) - 0.02;
      const pa = bankPoint(a, side, face + 0.5), pb = bankPoint(b, side, face + 0.5);
      const top = yt(m) + 0.3;
      const dir = new Vector3(pb.x - pa.x, 0, pb.z - pa.z);
      const len = dir.length();
      dir.normalize();
      const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(dir, up, new Vector3().crossVectors(dir, up)));
      sites[chunkOf(m)].boxWorld(new Vector3((pa.x + pb.x) / 2, (YB - 0.3 + top) / 2, (pa.z + pb.z) / 2), new Vector3(len / 2, (top - YB + 0.3) / 2, 0.5), q, 0.25);
    }
  }

  // ---- gangi water steps and landing platforms ----
  const platforms: PlatformInfo[] = [];
  for (const [gi, st] of run.gangi.entries()) {
    const g = sites[chunkOf(st.s)].g('stone');
    const rise = 0.19, go = 0.34;
    const floor = st.platform ? 0.42 : -0.75;
    const n = Math.max(2, Math.ceil((yt(st.s) - floor) / rise));
    const r = (yt(st.s) - floor) / n;
    let sEnd = st.s;
    for (let k = 0; k < n; k++) {
      const a = st.s + k * go, b = a + go;
      const top = yt(st.s) - (k + 1) * r;
      sEnd = b;
      g.part({ tint: jitter(C.granite, R, 0.12, 0.08), seed: R(), moss: top < 0.3 ? 0.8 : 0.3, grain: 2 });
      hex(g, [
        W(a, -1.4, YB), W(b, -1.4, YB), W(a, -1.4, top), W(b, -1.4, top),
        W(a, 0.1, YB), W(b, 0.1, YB), W(a, 0.1, top), W(b, 0.1, top),
      ], 0.035, 1 << 2);
    }
    // outer cheek stones along the flight's water side
    const pa = bankPoint(st.s, side, -0.7), pb = bankPoint(sEnd, side, -0.7);
    const dir = new Vector3(pb.x - pa.x, 0, pb.z - pa.z);
    const len = dir.length();
    dir.normalize();
    const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(dir, up, new Vector3().crossVectors(dir, up)));
    sites[chunkOf(st.s)].boxWorld(new Vector3((pa.x + pb.x) / 2, -0.6, (pa.z + pb.z) / 2), new Vector3(len / 2 + 0.1, 1.1, 0.8), q, 0.3);
    if (st.platform) {
      const site = sites[chunkOf(sEnd + 2)];
      const gt = site.g('timber');
      const a = sEnd - 0.05, b = sEnd + 4.6;
      const yD = floor;
      const o0 = off(a, 0) + 0.05, o1 = -2.6;
      // posts
      for (const s of [a + 0.3, (a + b) / 2, b - 0.3]) {
        for (const o of [o0 - 0.3, o1 + 0.2]) {
          const p = bankPoint(s, side, o);
          gt.part({ tint: jitter(C.pile, R, 0.12), wear: 0.25, seed: R(), grain: 1 });
          cyl(gt, p.x, p.z, -1.6, yD - 0.2, 0.1, 0.095, 10, 2);
        }
      }
      // bearers across, boards along the bank
      for (const s of [a + 0.3, (a + b) / 2, b - 0.3]) {
        gt.part({ tint: jitter(C.pile, R, 0.1), wear: 0.3, seed: R(), grain: 0 });
        hex(gt, [
          W(s - 0.08, o1, yD - 0.22), W(s + 0.08, o1, yD - 0.22), W(s - 0.08, o1, yD - 0.05), W(s + 0.08, o1, yD - 0.05),
          W(s - 0.08, o0, yD - 0.22), W(s + 0.08, o0, yD - 0.22), W(s - 0.08, o0, yD - 0.05), W(s + 0.08, o0, yD - 0.05),
        ], 0.012);
      }
      for (let o = o1; o < o0 - 0.1; o += 0.225) {
        const ob = Math.min(o0, o + 0.21);
        gt.part({ tint: jitter(C.deck, R, 0.16, 0.1), wear: 0.5 + R() * 0.3, seed: R(), grain: 0, moss: 0.2 });
        hex(gt, [
          W(a, o, yD - 0.055), W(b, o, yD - 0.055), W(a, o, yD), W(b, o, yD),
          W(a, ob, yD - 0.055), W(b, ob, yD - 0.055), W(a, ob, yD), W(b, ob, yD),
        ], 0.01);
      }
      const c = bankPoint((a + b) / 2, side, (o0 + o1) / 2);
      const f = riverFrame((a + b) / 2);
      platforms.push({ id: `${run.id}-p${gi}`, x: c.x, z: c.z, y: yD, headingDeg: forwardToHeading(f.tx, f.tz) });
      const qa = bankPoint(a, side, (o0 + o1) / 2), qb = bankPoint(b, side, (o0 + o1) / 2);
      const d2 = new Vector3(qb.x - qa.x, 0, qb.z - qa.z);
      const l2 = d2.length();
      d2.normalize();
      const q2 = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(d2, up, new Vector3().crossVectors(d2, up)));
      site.boxWorld(new Vector3(c.x, (yD - 2) / 2, c.z), new Vector3(l2 / 2, (yD + 2) / 2, Math.abs(o0 - o1) / 2 + 0.05), q2, 0.2);
    }
  }
  return { sites, platforms, top: yt, face: (s: number) => off(s, 0) };
}
