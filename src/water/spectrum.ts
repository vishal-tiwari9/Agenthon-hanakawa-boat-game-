// pure js helpers for the procedural water textures: seeded random, 2d fft, a tileable ocean
// height field from a wind-sea spectrum, tileable value/cellular noise. no dom, no three.

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number) {
  const u = Math.max(1e-9, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// in-place radix-2 fft of one line (stride access), sign = +1 for inverse
function fftLine(re: Float64Array, im: Float64Array, off: number, stride: number, n: number, sign: number) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = off + i * stride, b = off + j * stride;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = off + (i + k) * stride, b = off + (i + k + len / 2) * stride;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

export function ifft2(re: Float64Array, im: Float64Array, n: number) {
  for (let r = 0; r < n; r++) fftLine(re, im, r * n, 1, n, 1);
  for (let c = 0; c < n; c++) fftLine(re, im, c, n, n, 1);
}

export interface OceanField {
  n: number;
  h: Float32Array;
  /** slopes dh/dx, dh/dz in "per tile" units */
  sx: Float32Array;
  sz: Float32Array;
}

/**
 * tileable wind-sea height field (pierson-moskowitz shaped spectrum over integer wave numbers,
 * so it wraps exactly). peak/cut are in cycles per tile. windAngle in radians (texture space).
 */
export function oceanField(n: number, seed: number, peak: number, cut: number, windAngle = 0, spread = 2, iso = 0.2): OceanField {
  const r = rng(seed);
  const hr = new Float64Array(n * n), hi = new Float64Array(n * n);
  const xr = new Float64Array(n * n), xi = new Float64Array(n * n);
  const zr = new Float64Array(n * n), zi = new Float64Array(n * n);
  const wx = Math.cos(windAngle), wz = Math.sin(windAngle);
  for (let q = 0; q < n; q++) {
    const kz = q < n / 2 ? q : q - n;
    for (let m = 0; m < n; m++) {
      const kx = m < n / 2 ? m : m - n;
      const i = q * n + m;
      const k = Math.hypot(kx, kz);
      const g1 = gauss(r), g2 = gauss(r);
      if (k < 1.5 || k > n / 2 - 2) continue;
      const c = (kx * wx + kz * wz) / k;
      const dir = iso + (1 - iso) * Math.pow(Math.abs(c), spread) * (c < 0 ? 0.35 : 1);
      const p = (Math.exp(-1.25 * (peak / k) ** 2) / k ** 4) * dir * Math.exp(-((k / cut) ** 2));
      const a = Math.sqrt(p / 2);
      hr[i] = g1 * a;
      hi[i] = g2 * a;
      // i * k * H
      const tx = 2 * Math.PI * kx, tz = 2 * Math.PI * kz;
      xr[i] = -tx * hi[i];
      xi[i] = tx * hr[i];
      zr[i] = -tz * hi[i];
      zi[i] = tz * hr[i];
    }
  }
  ifft2(hr, hi, n);
  ifft2(xr, xi, n);
  ifft2(zr, zi, n);
  const h = new Float32Array(n * n), sx = new Float32Array(n * n), sz = new Float32Array(n * n);
  let ss = 0;
  for (let i = 0; i < n * n; i++) ss += xr[i] * xr[i] + zr[i] * zr[i];
  const k = 1 / Math.sqrt(ss / (2 * n * n) || 1);
  for (let i = 0; i < n * n; i++) {
    h[i] = hr[i] * k;
    sx[i] = xr[i] * k;
    sz[i] = zr[i] * k;
  }
  return { n, h, sx, sz };
}

function hash2(x: number, y: number, s: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** tileable value noise with `cells` lattice cells per tile, u/v in [0,1) */
export function valueNoise(u: number, v: number, cells: number, seed: number) {
  const x = u * cells, y = v * cells;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const w = (a: number) => ((a % cells) + cells) % cells;
  const a = hash2(w(x0), w(y0), seed), b = hash2(w(x0 + 1), w(y0), seed);
  const c = hash2(w(x0), w(y0 + 1), seed), d = hash2(w(x0 + 1), w(y0 + 1), seed);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

export function fbm(u: number, v: number, cells: number, octaves: number, seed: number) {
  let s = 0, amp = 0.5, tot = 0;
  for (let o = 0; o < octaves; o++) {
    s += valueNoise(u, v, cells << o, seed + o * 17) * amp;
    tot += amp;
    amp *= 0.5;
  }
  return s / tot;
}

/** tileable cellular noise: returns [f1, f2] distances in cell units */
export function worley(u: number, v: number, cells: number, seed: number, out: number[]) {
  const x = u * cells, y = v * cells;
  const cx = Math.floor(x), cy = Math.floor(y);
  let f1 = 9, f2 = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j;
      const wx = ((gx % cells) + cells) % cells, wy = ((gy % cells) + cells) % cells;
      const px = gx + hash2(wx, wy, seed), py = gy + hash2(wx, wy, seed + 101);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
  }
  out[0] = f1;
  out[1] = f2;
  return out;
}

/** remap values to their rank so the result is uniformly distributed in [0,1] */
export function equalize(a: Float32Array) {
  const idx = new Uint32Array(a.length);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  const s = Array.from(idx).sort((x, y) => a[x] - a[y]);
  const out = new Float32Array(a.length);
  for (let r = 0; r < s.length; r++) out[s[r]] = r / (s.length - 1);
  return out;
}

/** box-filtered mip chain of a square multi-channel float image (channels interleaved) */
export function mipChain(data: Float32Array, n: number, ch: number) {
  const levels: { data: Float32Array; size: number }[] = [{ data, size: n }];
  let cur = data, size = n;
  while (size > 1) {
    const h = size >> 1;
    const next = new Float32Array(h * h * ch);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        for (let c = 0; c < ch; c++) {
          const a = cur[((2 * y) * size + 2 * x) * ch + c], b = cur[((2 * y) * size + 2 * x + 1) * ch + c];
          const d = cur[((2 * y + 1) * size + 2 * x) * ch + c], e = cur[((2 * y + 1) * size + 2 * x + 1) * ch + c];
          next[(y * h + x) * ch + c] = (a + b + d + e) * 0.25;
        }
      }
    }
    levels.push({ data: next, size: h });
    cur = next;
    size = h;
  }
  return levels;
}
