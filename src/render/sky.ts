// photographed sky. the poly haven puresky hdri is decoded on the cpu, rotated so its sun sits at
// SUN's azimuth, its own sun capped (an analytic disc at the exact SUN direction replaces it) and
// graded toward the brief's azure. the same data feeds the background, the ibl environment and the
// horizon lut used by the haze, so sky, fill light and aerial perspective always agree.
import {
  ClampToEdgeWrapping, DataTexture, DataUtils, EquirectangularReflectionMapping, HalfFloatType, LinearFilter,
  LinearSRGBColorSpace, RepeatWrapping, RGBAFormat, Vector3, type Node,
} from 'three/webgpu';
import {
  Fn, If, dot, exp, float, floor, fract, max, min, mix, normalWorldGeometry, normalize, sin, smoothstep, sqrt, step, texture, uniform,
  vec2, vec3, vec4,
} from 'three/tsl';
import { uMoonDir } from '../core/daycycle';
import { TUNE } from './config';

export interface SkyData {
  background: DataTexture;
  /** ibl for scene.environment (chroma reduced to realistic skylight) */
  environment: DataTexture;
  /** same sky at full color, equirect: use with pmremTexture() for mirror-like sky reflections */
  reflection: DataTexture;
  /** 256x1 haze color by azimuth (u = equirect u), graded, same units as the background */
  horizon: DataTexture;
  /** the same ring as 64 colors (u = i / 64), for shaders that must not spend a texture slot */
  horizonRing: Vector3[];
  horizonAvg: [number, number, number];
  zenithAvg: [number, number, number];
  /** startup diagnostics: persistent prepared-sky cache, not the browser's HDR download cache */
  cache?: 'hit' | 'miss';
  prepareMs?: number;
  cacheWrite?: Promise<void>;
}

const LUMA = [0.2126, 0.7152, 0.0722];
const TWO_PI = Math.PI * 2;

/** minimal radiance .hdr (rgbe) reader: returns the raw rgbe bytes, row 0 = top of the image */
function readRGBE(buf: ArrayBuffer): { width: number; height: number; rgbe: Uint8Array } {
  const bytes = new Uint8Array(buf);
  let pos = 0;
  const line = () => {
    let s = '';
    while (pos < bytes.length && bytes[pos] !== 10) s += String.fromCharCode(bytes[pos++]);
    pos++;
    return s;
  };
  if (!line().startsWith('#?')) throw new Error('sky: not a radiance hdr');
  for (;;) {
    const l = line();
    if (l === '') break;
    if (l.startsWith('FORMAT') && !l.includes('32-bit_rle_rgbe')) throw new Error('sky: unsupported hdr format ' + l);
  }
  const m = /-Y (\d+) \+X (\d+)/.exec(line());
  if (!m) throw new Error('sky: unsupported hdr orientation');
  const height = +m[1], width = +m[2];
  const rgbe = new Uint8Array(width * height * 4);
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    if (bytes[pos] !== 2 || bytes[pos + 1] !== 2 || ((bytes[pos + 2] << 8) | bytes[pos + 3]) !== width) {
      // flat (non rle) scanline
      rgbe.set(bytes.subarray(pos, pos + width * 4), y * width * 4);
      pos += width * 4;
      continue;
    }
    pos += 4;
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < width) {
        let n = bytes[pos++];
        if (n > 128) {
          n -= 128;
          const v = bytes[pos++];
          for (let k = 0; k < n; k++) scan[(x++) * 4 + c] = v;
        } else {
          for (let k = 0; k < n; k++) scan[(x++) * 4 + c] = bytes[pos++];
        }
      }
    }
    rgbe.set(scan, y * width * 4);
  }
  return { width, height, rgbe };
}

type F16 = { length: number; [i: number]: number };
const F16Ctor: (new (n: number) => F16 & { buffer: ArrayBuffer }) | undefined = (globalThis as any).Float16Array;

/** half-float storage that is fast where Float16Array exists and correct everywhere */
function halfStore(n: number) {
  if (F16Ctor) {
    const f = new F16Ctor(n);
    return { set: (i: number, v: number) => { f[i] = v; }, get: (i: number) => f[i], bits: new Uint16Array(f.buffer) };
  }
  const u = new Uint16Array(n);
  return { set: (i: number, v: number) => { u[i] = DataUtils.toHalfFloat(Math.min(v, 65504)); }, get: (i: number) => DataUtils.fromHalfFloat(u[i]), bits: u };
}

function makeTexture(bits: Uint16Array, w: number, h: number, wrapS = RepeatWrapping) {
  const t = new DataTexture(bits, w, h, RGBAFormat, HalfFloatType);
  t.colorSpace = LinearSRGBColorSpace;
  t.mapping = EquirectangularReflectionMapping;
  t.minFilter = t.magFilter = LinearFilter;
  t.generateMipmaps = false;
  t.wrapS = wrapS;
  t.wrapT = ClampToEdgeWrapping;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

export async function loadSky(buffer: ArrayBuffer, sunDir: Vector3): Promise<SkyData> {
  const start = performance.now();
  let cache: Cache | null = null;
  let key = '';
  try {
    if ('caches' in globalThis && typeof location !== 'undefined') {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
      const source = Array.from(digest, v => v.toString(16).padStart(2, '0')).join('');
      const settings = JSON.stringify({ version: 1, source, sun: sunDir.toArray(), sky: TUNE.sky, env: TUNE.env });
      const signature = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(settings)));
      key = location.origin + '/__hanakawa-cache/sky/' + Array.from(signature, v => v.toString(16).padStart(2, '0')).join('');
      cache = await caches.open('hanakawa-prepared-sky-v1');
      const saved = await cache.match(key);
      if (saved?.body) {
        const raw = await new Response(saved.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
        const sky = unpackSky(raw);
        sky.cache = 'hit';
        sky.prepareMs = performance.now() - start;
        return sky;
      }
    }
  } catch (e) {
    console.info('[render] prepared sky cache unavailable; decoding original sky');
  }
  const sky = prepareSky(buffer, sunDir);
  sky.cache = 'miss';
  sky.prepareMs = performance.now() - start;
  if (cache && key) {
    // compression and persistence are optional background work, never part of the loading gate
    sky.cacheWrite = new Promise<void>(resolve => setTimeout(resolve, 0)).then(async () => {
      const blob = packSky(sky);
      await cache!.put(key, new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))));
      // keep one current grade rather than accumulating large HDR variants in browser storage
      for (const old of await cache!.keys()) if (old.url !== key) await cache!.delete(old);
    }).catch(() => {});
  }
  return sky;
}

function prepareSky(buffer: ArrayBuffer, sunDir: Vector3): SkyData {
  const { width: W, height: H, rgbe } = readRGBE(buffer);
  const scale = new Float32Array(256);
  for (let e = 1; e < 256; e++) scale[e] = Math.pow(2, e - 128) / 255;

  // locate the photographed sun (brightest texel in the upper hemisphere)
  let best = -1, bi = 0;
  for (let i = 0, n = W * (H >> 1); i < n; i++) {
    const o = i * 4, s = scale[rgbe[o + 3]];
    const L = (LUMA[0] * rgbe[o] + LUMA[1] * rgbe[o + 1] + LUMA[2] * rgbe[o + 2]) * s;
    if (L > best) { best = L; bi = i; }
  }
  const sx = bi % W, sy = Math.floor(bi / W);
  const uSun = (sx + 0.5) / W;
  const uTarget = Math.atan2(sunDir.z, sunDir.x) / TWO_PI + 0.5;
  const shift = Math.round((uSun - uTarget) * W);
  // the hdri sun after rotation, as a direction (for capping)
  const elS = (0.5 - (sy + 0.5) / H) * Math.PI, thS = (uTarget - 0.5) * TWO_PI;
  const hs = [Math.cos(elS) * Math.cos(thS), Math.sin(elS), Math.cos(elS) * Math.sin(thS)];
  const capCos = Math.cos((6 * Math.PI) / 180);
  const capRows = Math.ceil((6 / 180) * H);

  const { sunCap, gain } = TUNE.sky;

  // pass 1: decode, rotate, cap the photographed sun. row 0 = bottom (flipY false)
  const bg = halfStore(W * H * 4);
  const cosRow = new Float32Array(H), sinRow = new Float32Array(H);
  for (let y = 0; y < H; y++) { const el = (0.5 - (y + 0.5) / H) * Math.PI; cosRow[y] = Math.cos(el); sinRow[y] = Math.sin(el); }
  for (let y = 0; y < H; y++) {
    const dst = (H - 1 - y) * W * 4;
    const nearSunRow = Math.abs(y - sy) <= capRows;
    for (let x = 0; x < W; x++) {
      let xs = x + shift;
      xs = ((xs % W) + W) % W;
      const o = (y * W + xs) * 4, s = scale[rgbe[o + 3]] * gain;
      let r = rgbe[o] * s, g = rgbe[o + 1] * s, b = rgbe[o + 2] * s;
      if (nearSunRow) {
        const th = ((x + 0.5) / W - 0.5) * TWO_PI;
        const d = cosRow[y] * Math.cos(th) * hs[0] + sinRow[y] * hs[1] + cosRow[y] * Math.sin(th) * hs[2];
        if (d > capCos) {
          // cap the disc and neutralise the lens fringe (orange/pink rings) around it
          let L = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
          if (L > sunCap) { const k = sunCap / L; r *= k; g *= k; b *= k; L = sunCap; }
          const w = smooth(2, 10, L);
          r += (L - r) * w; g += (L - g) * w; b += (L - b) * w;
        }
      }
      const p = dst + x * 4;
      bg.set(p, r); bg.set(p + 1, g); bg.set(p + 2, b); bg.set(p + 3, 1);
    }
  }

  // the photographed clear sky (hazy, greyish near the horizon) is swapped for the brief's azure
  // gradient while its clouds are kept: estimate the photo's clear-sky color S on a coarse grid
  // from the bluest texels, treat each texel's blue-red excess relative to S as its clear-sky
  // fraction, and add that fraction of (target - S). clouds (neutral) stay photographic.
  const clear = clearSkyGrid(bg, W, H);
  const target = TUNE.sky;
  const tmp = [0, 0, 0], tgt = [0, 0, 0];
  const glowInner = (7 * Math.PI) / 180, glowOuter = (16 * Math.PI) / 180;
  const glowRows = Math.ceil((17 / 180) * H);
  for (let row = H >> 1; row < H; row++) {
    const elDeg = ((row + 0.5) / H - 0.5) * 180;
    const elT = 1 - Math.exp(-Math.max(0, elDeg) / target.gradientDeg);
    // clouds melt into the haze in the last few degrees above the horizon
    const cloudKeep = smooth(0.6, 5, elDeg);
    const bar = clear.bandAvg(elDeg);
    const barL = LUMA[0] * bar[0] + LUMA[1] * bar[1] + LUMA[2] * bar[2];
    for (let k = 0; k < 3; k++) tgt[k] = target.horizon[k] + (target.zenith[k] - target.horizon[k]) * elT;
    const srcRow = H - 1 - row;
    const nearSun = Math.abs(srcRow - sy) <= glowRows;
    for (let x = 0; x < W; x++) {
      const p = (row * W + x) * 4;
      const r = bg.get(p), g = bg.get(p + 1), b = bg.get(p + 2);
      // keep the photo untouched in the bright glow around its own sun
      let photo = 1;
      if (nearSun) {
        const th = ((x + 0.5) / W - 0.5) * TWO_PI;
        const d = cosRow[srcRow] * Math.cos(th) * hs[0] + sinRow[srcRow] * hs[1] + cosRow[srcRow] * Math.sin(th) * hs[2];
        photo = smooth(glowInner, glowOuter, Math.acos(Math.min(1, d)));
        if (photo <= 0) continue;
      }
      clear.sample(x / W, elDeg, tmp);
      const sL = LUMA[0] * tmp[0] + LUMA[1] * tmp[1] + LUMA[2] * tmp[2];
      // azimuthal brightness of the photo (brighter toward the sun), whitening where it brightens
      const f = Math.min(1.8, Math.max(0.78, Math.sqrt(sL / Math.max(barL, 1e-4))));
      const white = Math.min(0.6, Math.max(0, (f - 1) * 0.45));
      let ar = tgt[0] * f, ag = tgt[1] * f, ab = tgt[2] * f;
      const aL = LUMA[0] * ar + LUMA[1] * ag + LUMA[2] * ab;
      ar += (aL - ar) * white; ag += (aL - ag) * white; ab += (aL - ab) * white;
      const skyFrac = Math.min(1, Math.max(0, (b - r) / Math.max(tmp[2] - tmp[0], 0.03)));
      const keep = (1 - (1 - skyFrac) * cloudKeep) * photo; // 1 = fully replaced by the target sky
      let fr = Math.max(0, r + keep * (ar - tmp[0]));
      let fg = Math.max(0, g + keep * (ag - tmp[1]));
      let fb = Math.max(0, b + keep * (ab - tmp[2]));
      // distant clouds in the photo carry a dusty peach cast; pull cloud texels toward neutral
      const cloud = (1 - skyFrac) * photo * 0.55;
      const fL = LUMA[0] * fr + LUMA[1] * fg + LUMA[2] * fb;
      fr += (fL * 0.985 - fr) * cloud; fg += (fL * 0.995 - fg) * cloud; fb += (fL * 1.03 - fb) * cloud;
      bg.set(p, fr); bg.set(p + 1, fg); bg.set(p + 2, fb);
    }
  }

  // horizon lut: average of the band 0.5..3 deg above the horizon, per azimuth bin
  const BINS = 256;
  const horizonF = new Float32Array(BINS * 4);
  const r0 = Math.floor(H / 2 + (0.5 / 180) * H), r1 = Math.ceil(H / 2 + (3 / 180) * H); // bottom-up rows
  const per = W / BINS;
  const avg = [0, 0, 0];
  for (let bIdx = 0; bIdx < BINS; bIdx++) {
    let rr = 0, gg = 0, bb = 0, n = 0;
    for (let y = r0; y <= r1; y++) for (let x = Math.floor(bIdx * per); x < Math.floor((bIdx + 1) * per); x++) {
      const p = (y * W + x) * 4;
      rr += bg.get(p); gg += bg.get(p + 1); bb += bg.get(p + 2); n++;
    }
    horizonF[bIdx * 4] = rr / n; horizonF[bIdx * 4 + 1] = gg / n; horizonF[bIdx * 4 + 2] = bb / n; horizonF[bIdx * 4 + 3] = 1;
    avg[0] += rr / n / BINS; avg[1] += gg / n / BINS; avg[2] += bb / n / BINS;
  }
  // soften the lut around the ring so single clouds on the horizon do not print into the haze
  const soft = new Float32Array(BINS * 4);
  for (let i = 0; i < BINS; i++) for (let k = 0; k < 3; k++) {
    let s = 0, w = 0;
    for (let j = -6; j <= 6; j++) { const wj = Math.exp(-(j * j) / 18); s += horizonF[(((i + j) % BINS + BINS) % BINS) * 4 + k] * wj; w += wj; }
    soft[i * 4 + k] = s / w;
  }
  const horizonBits = new Uint16Array(BINS * 4);
  for (let i = 0; i < BINS; i++) for (let k = 0; k < 4; k++) horizonBits[i * 4 + k] = DataUtils.toHalfFloat(k === 3 ? 1 : soft[i * 4 + k]);
  const horizon = new DataTexture(horizonBits, BINS, 1, RGBAFormat, HalfFloatType);
  horizon.colorSpace = LinearSRGBColorSpace;
  horizon.minFilter = horizon.magFilter = LinearFilter;
  horizon.wrapS = RepeatWrapping;
  horizon.wrapT = ClampToEdgeWrapping;
  horizon.generateMipmaps = false;
  horizon.needsUpdate = true;
  const RING = 64, step = BINS / RING;
  const horizonRing: Vector3[] = [];
  for (let i = 0; i < RING; i++) {
    const v = new Vector3();
    for (let j = 0; j < step; j++) { const b = (i * step + j) * 4; v.x += soft[b] / step; v.y += soft[b + 1] / step; v.z += soft[b + 2] / step; }
    horizonRing.push(v);
  }

  // environment: 4x box-downsampled, the lower hemisphere replaced by a mixed sea/land ground.
  // two versions: `reflection` keeps the sky's full color (for mirror-like sky reflections);
  // `environment` (the scene's ibl) has its chroma reduced to real skylight: the azure grade is a
  // look for the visible sky, but as irradiance it would turn every shadow blue.
  const EW = W >> 2, EH = H >> 2;
  const env = halfStore(EW * EH * 4);
  const refl = halfStore(EW * EH * 4);
  const envSat = TUNE.env.saturation;
  const ground = TUNE.sky.ground;
  const zen = [0, 0, 0];
  let zn = 0;
  for (let y = 0; y < EH; y++) {
    const el = ((y + 0.5) / EH - 0.5) * 180; // bottom-up
    const t = smooth(0, -8, el);
    for (let x = 0; x < EW; x++) {
      let rr = 0, gg = 0, bb = 0;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
        const p = ((y * 4 + j) * W + x * 4 + i) * 4;
        rr += bg.get(p); gg += bg.get(p + 1); bb += bg.get(p + 2);
      }
      rr /= 16; gg /= 16; bb /= 16;
      if (el < 0) {
        const hb = Math.min(BINS - 1, Math.floor((x / EW) * BINS)) * 4;
        const hr = soft[hb], hg = soft[hb + 1], hbv = soft[hb + 2];
        rr = hr + (ground[0] - hr) * t; gg = hg + (ground[1] - hg) * t; bb = hbv + (ground[2] - hbv) * t;
      }
      if (el > 60) { zen[0] += rr; zen[1] += gg; zen[2] += bb; zn++; }
      const p = (y * EW + x) * 4;
      refl.set(p, rr); refl.set(p + 1, gg); refl.set(p + 2, bb); refl.set(p + 3, 1);
      const L = LUMA[0] * rr + LUMA[1] * gg + LUMA[2] * bb;
      env.set(p, L + (rr - L) * envSat); env.set(p + 1, L + (gg - L) * envSat); env.set(p + 2, L + (bb - L) * envSat); env.set(p + 3, 1);
    }
  }

  return {
    background: makeTexture(bg.bits, W, H),
    environment: makeTexture(env.bits, EW, EH),
    reflection: makeTexture(refl.bits, EW, EH),
    horizon,
    horizonRing,
    horizonAvg: [avg[0], avg[1], avg[2]],
    zenithAvg: [zen[0] / zn, zen[1] / zn, zen[2] / zn],
  };
}

/** coarse estimate of the photo's cloud-free sky color over the upper hemisphere */
function clearSkyGrid(bg: { get(i: number): number }, W: number, H: number) {
  const AZ = 64, EL = 30; // 5.6 x 3 deg cells
  const sum = new Float32Array(AZ * EL * 3), cnt = new Float32Array(AZ * EL), maxB = new Float32Array(AZ * EL);
  const cell = (x: number, row: number) => {
    const el = ((row + 0.5) / H - 0.5) * 180;
    const ei = Math.min(EL - 1, Math.max(0, Math.floor((el / 90) * EL)));
    const ai = Math.min(AZ - 1, Math.floor((x / W) * AZ));
    return ei * AZ + ai;
  };
  const blue = (r: number, b: number) => (b - r) / (b + 1e-3);
  for (let row = H >> 1; row < H; row += 2) for (let x = 0; x < W; x += 2) {
    const p = (row * W + x) * 4, c = cell(x, row);
    maxB[c] = Math.max(maxB[c], blue(bg.get(p), bg.get(p + 2)));
  }
  for (let row = H >> 1; row < H; row += 2) for (let x = 0; x < W; x += 2) {
    const p = (row * W + x) * 4, c = cell(x, row);
    const r = bg.get(p), g = bg.get(p + 1), b = bg.get(p + 2);
    if (blue(r, b) < maxB[c] * 0.8 || maxB[c] < 0.25) continue;
    sum[c * 3] += r; sum[c * 3 + 1] += g; sum[c * 3 + 2] += b; cnt[c]++;
  }
  let grid = new Float32Array(AZ * EL * 3);
  const known = new Uint8Array(AZ * EL);
  for (let c = 0; c < AZ * EL; c++) if (cnt[c] > 8) { for (let k = 0; k < 3; k++) grid[c * 3 + k] = sum[c * 3 + k] / cnt[c]; known[c] = 1; }
  // fill fully clouded cells from their neighbours, then smooth
  for (let it = 0; it < 40; it++) {
    let missing = 0;
    const next = grid.slice();
    for (let e = 0; e < EL; e++) for (let a = 0; a < AZ; a++) {
      const c = e * AZ + a;
      if (known[c]) continue;
      let s0 = 0, s1 = 0, s2 = 0, n = 0;
      for (const [de, da] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const ee = e + de; if (ee < 0 || ee >= EL) continue;
        const nc = ee * AZ + ((a + da + AZ) % AZ);
        if (!known[nc]) continue;
        s0 += grid[nc * 3]; s1 += grid[nc * 3 + 1]; s2 += grid[nc * 3 + 2]; n++;
      }
      if (n) { next[c * 3] = s0 / n; next[c * 3 + 1] = s1 / n; next[c * 3 + 2] = s2 / n; known[c] = 2; } else missing++;
    }
    grid = next;
    for (let c = 0; c < AZ * EL; c++) if (known[c] === 2) known[c] = 1;
    if (!missing) break;
  }
  for (let it = 0; it < 3; it++) {
    const next = grid.slice();
    for (let e = 0; e < EL; e++) for (let a = 0; a < AZ; a++) for (let k = 0; k < 3; k++) {
      let s = 0, n = 0;
      for (let de = -1; de <= 1; de++) for (let da = -1; da <= 1; da++) {
        const ee = e + de; if (ee < 0 || ee >= EL) continue;
        s += grid[(ee * AZ + ((a + da + AZ) % AZ)) * 3 + k]; n++;
      }
      next[(e * AZ + a) * 3 + k] = s / n;
    }
    grid = next;
  }
  const band = new Float32Array(EL * 3);
  for (let e = 0; e < EL; e++) for (let a = 0; a < AZ; a++) for (let k = 0; k < 3; k++) band[e * 3 + k] += grid[(e * AZ + a) * 3 + k] / AZ;
  const at = (el: number) => Math.min(EL - 1, Math.max(0, (el / 90) * EL - 0.5));
  return {
    sample(u: number, el: number, out: number[]) {
      const fe = at(el), e0 = Math.floor(fe), e1 = Math.min(EL - 1, e0 + 1), te = fe - e0;
      const fa = u * AZ - 0.5, a0 = Math.floor(fa), ta = fa - a0;
      const A0 = (a0 + AZ) % AZ, A1 = (a0 + 1 + AZ) % AZ;
      for (let k = 0; k < 3; k++) {
        const v00 = grid[(e0 * AZ + A0) * 3 + k], v01 = grid[(e0 * AZ + A1) * 3 + k];
        const v10 = grid[(e1 * AZ + A0) * 3 + k], v11 = grid[(e1 * AZ + A1) * 3 + k];
        out[k] = (v00 + (v01 - v00) * ta) * (1 - te) + (v10 + (v11 - v10) * ta) * te;
      }
      return out;
    },
    bandAvg(el: number) {
      const fe = at(el), e0 = Math.floor(fe), e1 = Math.min(EL - 1, e0 + 1), te = fe - e0;
      return [0, 1, 2].map((k) => band[e0 * 3 + k] + (band[e1 * 3 + k] - band[e0 * 3 + k]) * te);
    },
  };
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** equirect u for a world direction, matching three's equirectUV */
export const azimuthU = Fn(([dir]: [Node]) => {
  const d = dir as any;
  return d.z.atan(d.x).mul(1 / TWO_PI).add(0.5);
});

type U = ReturnType<typeof uniform>;

/** time of day and weather over the photographed sky (driven by daylight.ts). with `active` 0 the
 *  shader skips all of it and the sky is exactly the authored morning */
export interface SkyWeather {
  active: U;
  /** day sky: saturation, then a multiplier (dims toward dusk, greys under cloud) */
  sat: U;
  mul: U;
  /** additive gradient, horizon and zenith: overcast grey, storm slate, the night sky */
  addH: U;
  addZ: U;
  /** dusk / dawn glow hugging the horizon: toward the sun, and all around */
  glowSun: U;
  glowSky: U;
  /** mie halo around the (moving) sun disc */
  halo: U;
  /** 0..1 flattens the photographed sun (it stays at SUN) once the real sun has moved away */
  photoDim: U;
  /** multiplier on the photo's clouds (their undersides catch the low sun pink at dawn and dusk) */
  cloudTint: U;
  stars: U;
  moon: U;
  /** 0..1 how much of the photo's cloud structure a lightning flash lights */
  flash: U;
  /** angular size of one pixel (radians): keeps stars and the moon's edge antialiased */
  pixel: U;
}

export interface SkyNodes {
  node: Node;
  /** 1 = draw the analytic sun disc (the water reflection pass may want it off) */
  sunDisc: U;
  sunDir: U;
  /** radiance of the analytic sun disc (linear rgb) */
  sunColor: U;
  weather: SkyWeather;
  /** the same time-of-day / weather grade for another sky lookup (e.g. an env-map fallback), no stars */
  gradeSky: (color: Node, dir: Node) => Node;
  /** the dreamy sky grade (see TUNE.dream) */
  grade: {
    blush: ReturnType<typeof uniform>;
    blushDeg: ReturnType<typeof uniform>;
    zenithSat: ReturnType<typeof uniform>;
    cloudShade: ReturnType<typeof uniform>;
    cloudLit: ReturnType<typeof uniform>;
  };
}

/** background node: graded hdri + analytic sun disc, below the horizon the haze color */
export function createSkyNode(
  sky: SkyData, sunDir: Vector3, horizonColor: (dir: Node) => Node, skyMist?: (color: Node, dir: Node) => Node,
  airTint?: (dir: Node) => Node,
): SkyNodes {
  const bgTex = texture(sky.background);
  const uSunDir = uniform(sunDir.clone());
  const uSunDisc = uniform(1);
  const D = TUNE.dream;
  const grade = {
    blush: uniform(new Vector3(...D.blush)),
    blushDeg: uniform(D.blushDeg),
    zenithSat: uniform(D.zenithSat),
    cloudShade: uniform(new Vector3(...D.cloudShade)),
    cloudLit: uniform(new Vector3(...D.cloudLit)),
  };
  const sc = TUNE.sun.color;
  const uSunColor = uniform(new Vector3(sc[0], sc[1], sc[2]).multiplyScalar(TUNE.sun.discRadiance));
  const cosOuter = Math.cos((0.3 * Math.PI) / 180), cosInner = Math.cos((0.24 * Math.PI) / 180);
  const W: SkyWeather = {
    active: uniform(0),
    sat: uniform(1),
    mul: uniform(new Vector3(1, 1, 1)),
    addH: uniform(new Vector3()),
    addZ: uniform(new Vector3()),
    glowSun: uniform(new Vector3()),
    glowSky: uniform(new Vector3()),
    halo: uniform(new Vector3()),
    photoDim: uniform(0),
    cloudTint: uniform(new Vector3(1, 1, 1)),
    stars: uniform(0),
    moon: uniform(0),
    flash: uniform(new Vector3()),
    pixel: uniform(0.001),
  };
  // the photographed sun sits where SUN was when the sky was prepared
  const photoSun = vec3(sunDir.x, sunDir.y, sunDir.z);
  const v3 = (u: U) => vec3(u as any);

  /** dreamy grade. clouds are the texels with little blue excess above the horizon band: their shaded
   *  side is lifted toward lavender-white, the sunlit side warmed toward cream, so no cloud reads grey */
  const dreamSky = (raw: any, dir: any) => {
    const L = dot(raw, vec3(0.2126, 0.7152, 0.0722));
    const blueness = raw.b.sub(raw.r).div(raw.b.add(0.02));
    const cloud = smoothstep(0.42, 0.12, blueness).mul(smoothstep(0.02, 0.1, dir.y));
    const cloudTint = mix(vec3(grade.cloudShade as any), vec3(grade.cloudLit as any), smoothstep(0.7, 2.5, L));
    const graded = (mix(raw, raw.mul(cloudTint), cloud) as any).toVar();
    // richer azure toward the zenith
    const gL = dot(graded, vec3(0.2126, 0.7152, 0.0722));
    graded.assign(mix(vec3(gL), graded, float(1).add(grade.zenithSat.sub(1).mul(smoothstep(0.12, 0.7, dir.y)))));
    // the air's colour over the horizon band (matches the haze on the ridges), and a low blush
    const up = max(dir.y, float(0));
    if (airTint) graded.mulAssign(mix(vec3(1), airTint(dir) as any, exp(up.div(-0.2))));
    graded.mulAssign(mix(vec3(1), vec3(grade.blush as any), exp(up.div(grade.blushDeg.mul(Math.PI / 180)).negate())));
    return max(graded, vec3(0));
  };

  /** photo clouds: little blue excess above the horizon band (they hide stars, catch the flash) */
  const cloudMask = (raw: any, dir: any) => smoothstep(0.42, 0.12, raw.b.sub(raw.r).div(raw.b.add(0.02))).mul(smoothstep(0.0, 0.08, dir.y));

  /** the shared part of the grade: saturation, dimming, gradient, dusk glow, flash. mirrored on the
   *  cpu for the haze ring (daylight.ts), so ridges keep fading into the sky behind them */
  const gradeCore = (c: any, dir: any, clouds: any) => {
    const up = max(dir.y, float(0));
    const L = dot(c, vec3(0.2126, 0.7152, 0.0722));
    const elT = float(1).sub(exp(up.div(-0.28)));
    const cs = dot(dir, uSunDir as any);
    const toward = cs.mul(0.5).add(0.5).clamp(0, 1);
    const band = exp(up.div(-0.12));
    const glow = v3(W.glowSun).mul(toward.mul(toward).mul(toward)).add(v3(W.glowSky)).mul(band);
    const flash = v3(W.flash).mul(float(0.45).add(clouds.mul(0.55))).mul(float(0.6).add(elT.mul(0.4)));
    return (mix(vec3(L), c, W.sat as any) as any).mul(v3(W.mul)).add(mix(v3(W.addH), v3(W.addZ), elT)).add(glow).add(flash);
  };

  const hash33 = (p: any): any => {
    const p3 = (fract(p.mul(vec3(0.1031, 0.103, 0.0973))) as any).toVar();
    p3.addAssign(dot(p3, p3.yxz.add(33.33)));
    return fract(p3.xxy.add(p3.yxx).mul(p3.zyx));
  };

  /** fixed stars: one candidate per cell of a 3d grid over the sphere, drawn as a gaussian at least a
   *  pixel wide (flux kept constant), and only when it sits well inside its cell so none is clipped */
  const STAR_N = 150;
  const starField = (dir: any) => {
    const p = dir.mul(STAR_N);
    const cell = floor(p) as any;
    const h = hash33(cell), h2 = hash33(cell.add(19.19));
    const q = normalize(cell.add(h.mul(0.5).add(0.25))) as any;
    const qc = q.mul(STAR_N).sub(cell);
    const inside = step(0.25, min(qc.x, min(qc.y, qc.z))).mul(step(max(qc.x, max(qc.y, qc.z)), 0.75));
    const d = dir.sub(q).length().mul(STAR_N);
    const sig = max((W.pixel as any).mul(STAR_N * 1.05), float(0.06));
    const core = exp(d.div(sig).pow(2).negate()).mul(float(0.06).div(sig).pow(2));
    const mag = h2.y.pow(9).mul(7).add(h2.y.mul(0.12));
    const tint = mix(vec3(0.72, 0.84, 1.12), vec3(1.12, 0.96, 0.8), h2.z);
    return tint.mul(step(0.7, h2.x).mul(inside).mul(mag).mul(core));
  };

  /** the moon: a pale disc with soft maria and a two-part glow */
  const moonDisc = (dir: any) => {
    const m = uMoonDir as any;
    const cm = dot(dir, m).clamp(-1, 1);
    const ang = sqrt(max(float(2).sub(cm.mul(2)), float(0)));
    const R = 0.013;
    const edge = max(W.pixel as any, float(1e-4));
    const disc = smoothstep(edge.add(R), edge.negate().add(R), ang);
    const t = dir.sub(m.mul(cm)).mul(1 / R);
    const maria = float(0.82).add(sin(t.x.mul(2.3).add(t.y.mul(1.7))).mul(sin(t.z.mul(2.9).sub(t.x.mul(1.1)))).mul(0.12));
    const limb = float(1).sub(ang.div(R).clamp(0, 1).pow(2).mul(0.25));
    const glow = exp(ang.div(-0.05)).mul(0.05).add(exp(ang.div(-0.014)).mul(0.22));
    return vec3(0.93, 0.95, 1.0).mul(disc.mul(maria).mul(limb).mul(1.9)).add(vec3(0.42, 0.52, 0.82).mul(glow));
  };

  /** the full weather / night grade of the visible sky (above the horizon) */
  const weatherSky = (c: any, raw: any, dir: any) => {
    const clouds = cloudMask(raw, dir);
    // the photographed sun, flattened once the analytic one has left it
    const near0 = smoothstep(Math.cos((14 * Math.PI) / 180), Math.cos((3 * Math.PI) / 180), dot(dir, photoSun)).mul(W.photoDim as any);
    const Lr = dot(c, vec3(0.2126, 0.7152, 0.0722));
    const c0 = c.mul(mix(float(1), min(float(1), float(0.95).div(max(Lr, float(1e-3)))), near0)).mul(mix(vec3(1), v3(W.cloudTint), clouds));
    const out = gradeCore(c0, dir, clouds).toVar();
    const cs = dot(dir, uSunDir as any);
    const up = max(dir.y, float(0));
    out.addAssign(v3(W.halo).mul(exp(cs.sub(1).mul(260)).add(exp(cs.sub(1).mul(14)).mul(0.12))));
    const clear = float(1).sub(clouds);
    out.addAssign((starField(dir) as any).mul(W.stars).mul(clear).mul(smoothstep(0.015, 0.2, up)));
    out.addAssign((moonDisc(dir) as any).mul(W.moon).mul(float(1).sub(clouds.mul(0.75))));
    return max(out, vec3(0));
  };

  const node = Fn(() => {
    const dir = normalize(normalWorldGeometry).toVar();
    const uv = vec2(azimuthU(dir), dir.y.clamp(-1, 1).asin().mul(1 / Math.PI).add(0.5));
    const raw = bgTex.sample(uv).rgb.toVar();
    const sky = (D.enabled ? dreamSky(raw, dir) : raw).toVar();
    // time of day and weather: a uniform branch, skipped entirely in the authored look
    If((W.active as any).greaterThan(0.5), () => {
      sky.assign(weatherSky(sky, raw, dir));
    });
    // the photographed lower hemisphere is a synthetic ground; fade to the haze color instead
    const below = smoothstep(0.003, -0.003, dir.y);
    const col = (mix(sky as any, horizonColor(dir) as any, below) as any).toVar();
    const cosA = dot(dir, uSunDir as any);
    const disc = smoothstep(cosOuter, cosInner, cosA);
    // cheap limb darkening across the disc
    const limb = float(0.55).add(float(0.45).mul(smoothstep(cosOuter, 1.0, cosA).sqrt()));
    col.addAssign(vec3(uSunColor as any).mul(disc.mul(limb)).mul(uSunDisc).mul(float(1).sub(below)));
    const out = skyMist ? (skyMist(col, dir) as any) : col;
    return vec4(max(out, vec3(0)), 1);
  })();
  const gradeSky = Fn(([color, dir]: [Node, Node]) => {
    const d = normalize(dir as any);
    const graded = gradeCore(color as any, d, float(0.5));
    return mix(color as any, max(graded, vec3(0)), (W.active as any).greaterThan(0.5).select(float(1), float(0)));
  });
  return { node, sunDisc: uSunDisc, sunDir: uSunDir, sunColor: uSunColor, weather: W, gradeSky: (c, d) => gradeSky(c, d), grade };
}

const SKY_TEXTURES = ['background', 'environment', 'reflection', 'horizon'] as const;

function packSky(sky: SkyData): Blob {
  const meta = {
    textures: SKY_TEXTURES.map(k => ({ width: sky[k].image.width, height: sky[k].image.height })),
    horizonRing: sky.horizonRing.map(v => v.toArray()),
    horizonAvg: sky.horizonAvg,
    zenithAvg: sky.zenithAvg,
  };
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const header = new Uint8Array(Math.ceil((json.length + 4) / 8) * 8);
  new DataView(header.buffer).setUint32(0, json.length, true);
  header.set(json, 4);
  return new Blob([header, ...SKY_TEXTURES.map(k => sky[k].image.data as Uint16Array<ArrayBuffer>)]);
}

function unpackSky(buffer: ArrayBuffer): SkyData {
  const size = new DataView(buffer).getUint32(0, true);
  if (size > 65536 || size + 4 > buffer.byteLength) throw new Error('invalid prepared sky header');
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, size)));
  const textures: Partial<Record<typeof SKY_TEXTURES[number], DataTexture>> = {};
  let offset = Math.ceil((size + 4) / 8) * 8;
  for (const [i, key] of SKY_TEXTURES.entries()) {
    const { width, height } = meta.textures[i];
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error('invalid prepared sky dimensions');
    const count = width * height * 4;
    if (offset + count * 2 > buffer.byteLength) throw new Error('truncated prepared sky');
    textures[key] = makeTexture(new Uint16Array(buffer, offset, count), width, height);
    offset += count * 2;
  }
  return {
    ...textures as Pick<SkyData, typeof SKY_TEXTURES[number]>,
    horizonRing: meta.horizonRing.map((v: number[]) => new Vector3(v[0], v[1], v[2])),
    horizonAvg: meta.horizonAvg,
    zenithAvg: meta.zenithAvg,
  };
}
