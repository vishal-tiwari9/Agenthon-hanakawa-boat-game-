// caustics hook (owner: water). pure tsl, importable by any material without water being initialised.
// returns an additive light factor (>= 0) for a submerged, sunlit surface at worldPos (river bed and
// clear shallows: strongest in the first 2-3 m, gone by ~7 m).
// callers multiply it into their direct sun contribution / albedo; 0 above water.
//
// the pattern is real: sunlight refracted through a tileable fft wind-sea surface and splatted onto a
// plane at the focusing depth (photon density), generated once on first use. two independently
// scrolling copies are combined with min() so the network moves and re-forms like real caustics.
// the lookup is projected along the refracted sun ray, so walls and piles get correctly slanted light.
// note: the water module applies absorption along the sun path itself, so callers must not tint.
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping, UnsignedByteType, NoColorSpace } from 'three/webgpu';
import { Fn, clamp, dot, float, max, min, normalize, smoothstep, texture, uniform, vec2, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { uSunDir, uTime } from '../core/uniforms';
import { mipChain, oceanField } from './spectrum';

/** 1 when caustics are enabled by the quality preset, 0 otherwise (the water module drives it) */
export const uCausticsEnabled = uniform(1);
/** overall strength, tunable at runtime */
export const uCausticsStrength = uniform(1);

const N = 256;
let tex: DataTexture | null = null;

function causticChannel(seed: number) {
  const f = oceanField(N, seed, 5, N * 0.22, 0.4, 1, 0.5);
  // laplacian of h (texel units) from the slopes, to pick a displacement scale that just focuses
  const lap = new Float32Array(N * N);
  const w = (i: number) => (i + N) % N;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      lap[y * N + x] = (f.sx[y * N + w(x + 1)] - f.sx[y * N + w(x - 1)] + f.sz[w(y + 1) * N + x] - f.sz[w(y - 1) * N + x]) * 0.5;
    }
  }
  const sorted = Float32Array.from(lap).sort();
  const p = Math.max(Math.abs(sorted[Math.floor(sorted.length * 0.03)]), Math.abs(sorted[Math.floor(sorted.length * 0.97)]));
  const s = 1.05 / (p || 1);
  const acc = new Float32Array(N * N);
  const sub = 3;
  const sample = (arr: Float32Array, x: number, y: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
    const a = arr[w(y0) * N + w(x0)], b = arr[w(y0) * N + w(x0 + 1)], c = arr[w(y0 + 1) * N + w(x0)], d = arr[w(y0 + 1) * N + w(x0 + 1)];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  };
  for (let y = 0; y < N * sub; y++) {
    for (let x = 0; x < N * sub; x++) {
      const px = x / sub, py = y / sub;
      const qx = px - s * sample(f.sx, px, py), qy = py - s * sample(f.sz, px, py);
      const x0 = Math.floor(qx), y0 = Math.floor(qy), tx = qx - x0, ty = qy - y0;
      acc[w(y0) * N + w(x0)] += (1 - tx) * (1 - ty);
      acc[w(y0) * N + w(x0 + 1)] += tx * (1 - ty);
      acc[w(y0 + 1) * N + w(x0)] += (1 - tx) * ty;
      acc[w(y0 + 1) * N + w(x0 + 1)] += tx * ty;
    }
  }
  // soften by one texel so the minified pattern stays clean, then normalize to mean 1
  const out = new Float32Array(N * N);
  let mean = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let v = acc[y * N + x] * 4;
      v += (acc[y * N + w(x + 1)] + acc[y * N + w(x - 1)] + acc[w(y + 1) * N + x] + acc[w(y - 1) * N + x]) * 2;
      v += acc[w(y + 1) * N + w(x + 1)] + acc[w(y + 1) * N + w(x - 1)] + acc[w(y - 1) * N + w(x + 1)] + acc[w(y - 1) * N + w(x - 1)];
      out[y * N + x] = v;
      mean += v;
    }
  }
  mean /= N * N;
  for (let i = 0; i < out.length; i++) out[i] /= mean;
  return out;
}

/** the shared caustic pattern texture (r, g = two independent patterns, value/3 = intensity) */
export function causticTexture(): DataTexture {
  if (tex) return tex;
  const a = causticChannel(11), b = causticChannel(29);
  const data = new Float32Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = a[i] / 3;
    data[i * 4 + 1] = b[i] / 3;
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 1;
  }
  const levels = mipChain(data, N, 4).map((l) => {
    const u8 = new Uint8Array(l.data.length);
    for (let i = 0; i < u8.length; i++) u8[i] = Math.round(Math.min(1, Math.max(0, l.data[i])) * 255);
    return { data: u8, width: l.size, height: l.size };
  });
  tex = new DataTexture(levels[0].data, N, N, RGBAFormat, UnsignedByteType);
  tex.mipmaps = levels as any;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = 4;
  tex.colorSpace = NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const ETA = 1 / 1.333;

export function causticsNode(worldPos: Node, worldNormal?: Node): Node {
  const t = causticTexture();
  return Fn(() => {
    const p = vec3(worldPos as any);
    const depth = float(0).sub(p.y).toVar();
    // refracted sun ray (pointing down into the water)
    const l = normalize(uSunDir);
    const ly = max(l.y, 0.05);
    const sinT = max(float(1).sub(ly.mul(ly)), 0).sqrt().mul(ETA);
    const cosT = float(1).sub(sinT.mul(sinT)).sqrt();
    const hx = vec2(l.x, l.z).div(max(vec2(l.x, l.z).length(), 1e-4));
    // surface entry point of the ray that reaches p
    const entry = p.xz.add(hx.mul(sinT.div(cosT)).mul(max(depth, 0)));
    const lod = clamp(depth.sub(0.7).mul(0.45), 0, 3.5);
    const uv1 = entry.mul(1 / 1.9).add(vec2(uTime.mul(0.035), uTime.mul(0.022)));
    const r2 = vec2(entry.x.mul(0.8).sub(entry.y.mul(0.6)), entry.x.mul(0.6).add(entry.y.mul(0.8)));
    const uv2 = r2.mul(1 / 1.45).sub(vec2(uTime.mul(0.028), uTime.mul(-0.031)));
    const c1 = texture(t, uv1, lod).r.mul(3);
    const c2 = texture(t, uv2, lod).g.mul(3);
    const c = max(min(c1, c2).sub(0.28), 0).mul(1.25);
    const fade = smoothstep(0.03, 0.35, depth).mul(float(1).sub(smoothstep(3, 7, depth)));
    let facing: any = float(1);
    if (worldNormal) facing = max(dot(vec3(worldNormal as any), l), 0).mul(1.15).min(1);
    const sunUp = smoothstep(0.02, 0.25, l.y);
    return c.mul(fade).mul(facing).mul(sunUp).mul(uCausticsEnabled).mul(uCausticsStrength);
  })();
}
