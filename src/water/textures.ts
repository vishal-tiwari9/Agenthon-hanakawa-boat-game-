// procedural, tileable water textures generated once at startup (nothing downloaded):
//  ripple: fft wind-sea slopes with lean moments (sx, sz, sx^2, sz^2) so mip filtering yields
//          the unresolved slope variance, which widens the sun lobe instead of letting it sparkle.
//  foam:   r = lacy foam threshold (cell walls + fbm, histogram equalized so coverage == density),
//          g = broad fbm for patch/gust variation, b = medium fbm for breakup.
import { ClampToEdgeWrapping, DataTexture, DataUtils, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping, UnsignedByteType, NoColorSpace } from 'three/webgpu';
import type { WorldData } from '../world/worldData';
import { equalize, fbm, mipChain, oceanField, worley } from './spectrum';

function finish(tex: DataTexture, anisotropy = 8) {
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = anisotropy;
  tex.colorSpace = NoColorSpace;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

export function createRippleTexture(n = 256, seed = 7): DataTexture {
  const f = oceanField(n, seed, 3.2, n * 0.3, 0, 2, 0.22);
  const data = new Float32Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    data[i * 4] = f.sx[i];
    data[i * 4 + 1] = f.sz[i];
    data[i * 4 + 2] = f.sx[i] * f.sx[i];
    data[i * 4 + 3] = f.sz[i] * f.sz[i];
  }
  const levels = mipChain(data, n, 4).map((l) => {
    const h = new Uint16Array(l.data.length);
    for (let i = 0; i < h.length; i++) h[i] = DataUtils.toHalfFloat(l.data[i]);
    return { data: h, width: l.size, height: l.size };
  });
  const tex = new DataTexture(levels[0].data, n, n, RGBAFormat, HalfFloatType);
  tex.mipmaps = levels as any;
  return finish(tex, 16);
}

export function createFoamTexture(n = 256, seed = 3): DataTexture {
  const lace = new Float32Array(n * n), broad = new Float32Array(n * n), mid = new Float32Array(n * n);
  const w1 = [0, 0], w2 = [0, 0];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n, v = (y + 0.5) / n;
      worley(u, v, 9, seed, w1);
      worley(u, v, 23, seed + 5, w2);
      const walls = Math.min(1, (w1[1] - w1[0]) * 2.4);
      const fine = Math.min(1, (w2[1] - w2[0]) * 2.2);
      const cloud = fbm(u, v, 4, 5, seed + 9);
      lace[y * n + x] = walls * 0.5 + fine * 0.28 + cloud * 0.42;
      broad[y * n + x] = fbm(u, v, 3, 4, seed + 31);
      mid[y * n + x] = fbm(u, v, 8, 3, seed + 57);
    }
  }
  const a = equalize(lace), b = equalize(broad), c = equalize(mid);
  const data = new Float32Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    data[i * 4] = a[i];
    data[i * 4 + 1] = b[i];
    data[i * 4 + 2] = c[i];
    data[i * 4 + 3] = 1;
  }
  const levels = mipChain(data, n, 4).map((l) => {
    const u8 = new Uint8Array(l.data.length);
    for (let i = 0; i < u8.length; i++) u8[i] = Math.round(Math.min(1, Math.max(0, l.data[i])) * 255);
    return { data: u8, width: l.size, height: l.size };
  });
  const tex = new DataTexture(levels[0].data, n, n, RGBAFormat, UnsignedByteType);
  tex.mipmaps = levels as any;
  return finish(tex, 8);
}

/**
 * the four world channels the water reads, packed into one rgba half-float texture so the shader stays
 * under the per-stage sampled texture limit: r = height, g = flowX, b = flowZ, a = waveScale.
 * the grid matches the waveScale channel (same texel centres), so gpu bilinear agrees with the cpu.
 */
export function createWorldPack(world: WorldData): DataTexture {
  const ws = world.channels.get('waveScale');
  const n = ws ? ws.res : 1024;
  const size = world.size, half = size / 2;
  const has = (c: string) => world.has(c);
  const h = new Uint16Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    const z = -half + ((j + 0.5) * size) / n;
    for (let i = 0; i < n; i++) {
      const x = -half + ((i + 0.5) * size) / n;
      const k = (j * n + i) * 4;
      h[k] = DataUtils.toHalfFloat(has('height') ? world.sample('height', x, z) : -3);
      h[k + 1] = DataUtils.toHalfFloat(has('flowX') ? world.sample('flowX', x, z) : 0);
      h[k + 2] = DataUtils.toHalfFloat(has('flowZ') ? world.sample('flowZ', x, z) : 0);
      h[k + 3] = DataUtils.toHalfFloat(ws ? ws.data[j * n + i] : 1);
    }
  }
  const tex = new DataTexture(h, n, n, RGBAFormat, HalfFloatType);
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = NoColorSpace;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}
