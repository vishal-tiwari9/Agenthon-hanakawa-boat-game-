// tileable value-noise texture for macro color variation and anti-tiling (one sampler for all
// uses). channels: r, g = independent fbm at two scales, b = cellular-ish blotches, a = fine grain.
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping, UnsignedByteType } from 'three/webgpu';

export function noiseData(size = 256, seed = 7) {
  const lattice = (p: number, s: number) => {
    const g = new Float32Array(p * p);
    let a = s >>> 0;
    for (let i = 0; i < g.length; i++) {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      g[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return g;
  };
  const vn = (g: Float32Array, p: number, x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const at = (i: number, j: number) => g[((j % p) + p) % p * p + (((i % p) + p) % p)];
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const fbm = (seedOff: number, base: number, oct: number, x: number, y: number) => {
    let s = 0, amp = 0.5, n = 0;
    for (let o = 0; o < oct; o++) {
      const p = base << o;
      const g = grids[seedOff + o] ?? (grids[seedOff + o] = lattice(p, seed * 131 + seedOff * 17 + o));
      s += amp * vn(g, p, (x / size) * p, (y / size) * p);
      n += amp;
      amp *= 0.5;
    }
    return s / n;
  };
  const grids: Float32Array[] = [];
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const k = (y * size + x) * 4;
    const r = fbm(0, 4, 5, x, y);
    const g = fbm(10, 8, 4, x, y);
    const b = Math.pow(Math.abs(fbm(20, 6, 3, x, y) * 2 - 1), 0.6);
    const a = fbm(30, 32, 3, x, y);
    out[k] = Math.round(r * 255);
    out[k + 1] = Math.round(g * 255);
    out[k + 2] = Math.round(b * 255);
    out[k + 3] = Math.round(a * 255);
  }
  return out;
}

export function noiseTexture(size = 256, seed = 7) {
  const tex = new DataTexture(noiseData(size, seed), size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
