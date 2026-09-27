// square world grids for the bake: row j along +z (row 0 = north edge), column i along +x,
// texel centers at (i + 0.5) * size / res - size / 2. same convention as src/world/worldData.ts.

export const SIZE = 2048;
export const HALF = SIZE / 2;

export const cx = (i: number, res: number) => -HALF + ((i + 0.5) * SIZE) / res;
export const toI = (x: number, res: number) => ((x + HALF) * res) / SIZE - 0.5;

export function sample(data: Float32Array, res: number, x: number, z: number) {
  const fx = toI(x, res), fz = toI(z, res);
  let x0 = Math.floor(fx), z0 = Math.floor(fz);
  const tx = fx - x0, tz = fz - z0;
  let x1 = x0 + 1, z1 = z0 + 1;
  const m = res - 1;
  x0 = x0 < 0 ? 0 : x0 > m ? m : x0;
  x1 = x1 < 0 ? 0 : x1 > m ? m : x1;
  z0 = z0 < 0 ? 0 : z0 > m ? m : z0;
  z1 = z1 < 0 ? 0 : z1 > m ? m : z1;
  const a = data[z0 * res + x0], b = data[z0 * res + x1], c = data[z1 * res + x0], d = data[z1 * res + x1];
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

/** 1d squared distance transform (felzenszwalb) with argmin tracking */
function dt1(f: Float32Array, n: number, d: Float32Array, arg: Int32Array, v: Int32Array, zb: Float32Array) {
  let k = 0;
  v[0] = 0;
  zb[0] = -1e20;
  zb[1] = 1e20;
  for (let q = 1; q < n; q++) {
    if (f[q] >= 1e19) continue;
    if (f[v[k]] >= 1e19) { v[k] = q; continue; }
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= zb[k]) {
      k--;
      if (k < 0) break;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    if (k < 0) { k = 0; v[0] = q; zb[0] = -1e20; zb[1] = 1e20; continue; }
    k++;
    v[k] = q;
    zb[k] = s;
    zb[k + 1] = 1e20;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (zb[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = f[v[k]] >= 1e19 ? 1e20 : dq * dq + f[v[k]];
    arg[q] = v[k];
  }
}

/**
 * exact euclidean distance (in cells) to the nearest site, plus the site's flat index.
 * sites: Uint8Array with 1 at site cells.
 */
export function edt(sites: Uint8Array, res: number) {
  const n = res;
  const col = new Float32Array(n * n);
  const rowOf = new Int32Array(n * n);
  const f = new Float32Array(n), d = new Float32Array(n), zb = new Float32Array(n + 1);
  const arg = new Int32Array(n), v = new Int32Array(n);
  // columns
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) f[j] = sites[j * n + i] ? 0 : 1e20;
    dt1(f, n, d, arg, v, zb);
    for (let j = 0; j < n; j++) {
      col[j * n + i] = d[j];
      rowOf[j * n + i] = arg[j];
    }
  }
  const dist = new Float32Array(n * n);
  const near = new Int32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) f[i] = col[j * n + i];
    dt1(f, n, d, arg, v, zb);
    for (let i = 0; i < n; i++) {
      dist[j * n + i] = Math.sqrt(d[i]);
      const q = arg[i];
      near[j * n + i] = rowOf[j * n + q] * n + q;
    }
  }
  return { dist, near };
}

/** separable box blur, iterated 3x for a near gaussian. radius in cells */
export function blur(src: Float32Array, res: number, radius: number, iterations = 3) {
  if (radius < 1) return src.slice();
  const r = Math.round(radius);
  let a = src.slice();
  let b = new Float32Array(src.length);
  const w = 1 / (2 * r + 1);
  for (let it = 0; it < iterations; it++) {
    for (let j = 0; j < res; j++) {
      const row = j * res;
      let s = 0;
      for (let k = -r; k <= r; k++) s += a[row + Math.min(res - 1, Math.max(0, k))];
      for (let i = 0; i < res; i++) {
        b[row + i] = s * w;
        const add = Math.min(res - 1, i + r + 1), sub = Math.max(0, i - r);
        s += a[row + add] - a[row + sub];
      }
    }
    for (let i = 0; i < res; i++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += b[Math.min(res - 1, Math.max(0, k)) * res + i];
      for (let j = 0; j < res; j++) {
        a[j * res + i] = s * w;
        const add = Math.min(res - 1, j + r + 1), sub = Math.max(0, j - r);
        s += b[add * res + i] - b[sub * res + i];
      }
    }
  }
  return a;
}

/** box downsample by an integer factor */
export function downsample(src: Float32Array, res: number, f: number) {
  const r2 = res / f;
  const out = new Float32Array(r2 * r2);
  const k = 1 / (f * f);
  for (let j = 0; j < r2; j++)
    for (let i = 0; i < r2; i++) {
      let s = 0;
      for (let b = 0; b < f; b++) for (let a = 0; a < f; a++) s += src[(j * f + b) * res + i * f + a];
      out[j * r2 + i] = s * k;
    }
  return out;
}

/** max downsample by an integer factor */
export function downsampleMax(src: Float32Array, res: number, f: number) {
  const r2 = res / f;
  const out = new Float32Array(r2 * r2);
  for (let j = 0; j < r2; j++)
    for (let i = 0; i < r2; i++) {
      let s = -1e9;
      for (let b = 0; b < f; b++) for (let a = 0; a < f; a++) s = Math.max(s, src[(j * f + b) * res + i * f + a]);
      out[j * r2 + i] = s;
    }
  return out;
}

/** bilinear upsample to a finer resolution */
export function resample(src: Float32Array, res: number, res2: number) {
  const out = new Float32Array(res2 * res2);
  for (let j = 0; j < res2; j++) {
    const z = cx(j, res2);
    for (let i = 0; i < res2; i++) out[j * res2 + i] = sample(src, res, cx(i, res2), z);
  }
  return out;
}
