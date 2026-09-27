// deterministic noise for the bake. no Math.random anywhere: every value derives from integer hashes.

export function hash2(x: number, y: number, seed = 0) {
  let h = (x * 374761393 + y * 668265263 + seed * 144665) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** small seeded prng (mulberry32) for placement decisions */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// gradient noise on a permutation table
export class Noise {
  private perm = new Uint8Array(512);
  private gx = new Float32Array(256);
  private gy = new Float32Array(256);

  constructor(seed: number) {
    const r = rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    for (let i = 0; i < 256; i++) {
      const a = r() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }

  /** gradient noise, roughly [-1, 1] */
  n2(x: number, y: number) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const P = this.perm, GX = this.gx, GY = this.gy;
    const a = P[P[X] + Y], b = P[P[X + 1] + Y], c = P[P[X] + Y + 1], d = P[P[X + 1] + Y + 1];
    const va = GX[a] * xf + GY[a] * yf;
    const vb = GX[b] * (xf - 1) + GY[b] * yf;
    const vc = GX[c] * xf + GY[c] * (yf - 1);
    const vd = GX[d] * (xf - 1) + GY[d] * (yf - 1);
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    return 1.41 * (va + (vb - va) * u + (vc - va) * v + (va - vb - vc + vd) * u * v);
  }

  fbm(x: number, y: number, oct = 5, lac = 2.03, gain = 0.5) {
    let s = 0, a = 1, f = 1, n = 0;
    for (let i = 0; i < oct; i++) {
      s += a * this.n2(x * f + i * 17.3, y * f - i * 9.1);
      n += a;
      f *= lac;
      a *= gain;
    }
    return s / n;
  }

  /** ridged multifractal in [0, 1]: sharp crests, used for joints and rocky relief */
  ridged(x: number, y: number, oct = 4, lac = 2.1, gain = 0.5) {
    let s = 0, a = 1, f = 1, n = 0, w = 1;
    for (let i = 0; i < oct; i++) {
      let v = 1 - Math.abs(this.n2(x * f + i * 31.7, y * f + i * 11.3));
      v *= v;
      s += a * v * w;
      w = Math.min(1, v * 1.5);
      n += a;
      f *= lac;
      a *= gain;
    }
    return s / n;
  }
}

export const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** polynomial smooth max */
export function smax(a: number, b: number, k: number) {
  const h = clamp01(0.5 + (0.5 * (a - b)) / k);
  return b + (a - b) * h + k * h * (1 - h);
}
export function smin(a: number, b: number, k: number) {
  return -smax(-a, -b, k);
}
