// shared wind field for all vegetation. driven by uWindDir / uWindStrength (the same wind the
// water ripples and flags read). gusts are a tileable noise texture scrolled downwind, so bright
// waves of bending grass travel across the headlands.
import { DataTexture, LinearFilter, RepeatWrapping, RGBAFormat, UnsignedByteType } from 'three/webgpu';
import { Fn, cos, float, sin, smoothstep, texture, uniform, vec2, vec4 } from 'three/tsl';
import { uTime, uWindDir, uWindStrength } from '../core/uniforms';

const N = 128;

function periodicNoise(period: number, seed: number) {
  const lat = new Float32Array(period * period);
  let s = seed * 9301 + 49297;
  for (let i = 0; i < lat.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    lat[i] = s / 0x7fffffff;
  }
  const out = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const fx = (i / N) * period, fy = (j / N) * period;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const u = tx * tx * (3 - 2 * tx), v = ty * ty * (3 - 2 * ty);
      const g = (a: number, b: number) => lat[(((b % period) + period) % period) * period + (((a % period) + period) % period)];
      const a = g(x0, y0), b = g(x0 + 1, y0), c = g(x0, y0 + 1), d = g(x0 + 1, y0 + 1);
      out[j * N + i] = (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
    }
  }
  return out;
}

function makeGustTexture() {
  const o1 = periodicNoise(4, 1), o2 = periodicNoise(8, 2), o3 = periodicNoise(16, 3), o4 = periodicNoise(32, 4);
  const data = new Uint8Array(N * N * 4);
  for (let k = 0; k < N * N; k++) {
    const lo = (o1[k] * 0.55 + o2[k] * 0.3 + o3[k] * 0.15);
    const hi = (o3[k] * 0.6 + o4[k] * 0.4);
    data[k * 4] = Math.round(lo * 255);
    data[k * 4 + 1] = Math.round(hi * 255);
    data[k * 4 + 2] = Math.round(o2[k] * 255);
    data[k * 4 + 3] = 255;
  }
  const t = new DataTexture(data, N, N, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export const gustTexture = makeGustTexture();

/** meters covered by one repeat of the broad gust pattern */
export const uGustScale = uniform(150);

/**
 * wind at a world xz position. returns vec4(dirX, dirZ, lean, gust):
 * dir is the local (slightly meandering) downwind direction, lean is the steady bend 0..~1,
 * gust is 0..1 traveling gust intensity. vertex-stage safe (explicit lod).
 */
export const windAt = Fn(([xz]: [any]) => {
  const strength = uWindStrength.clamp(0, 1.5);
  const speed = float(3.0).add(strength.mul(6.0));
  const scroll = vec2(uWindDir).mul(uTime.mul(speed));
  const p = vec2(xz).sub(scroll);
  const broad = texture(gustTexture, p.div(uGustScale)).level(float(0));
  const fine = texture(gustTexture, p.div(41.0).add(vec2(0.37, 0.61))).level(float(0));
  const g = broad.r.mul(0.75).add(fine.g.mul(0.35));
  const gust = smoothstep(0.42, 0.78, g);
  // the direction meanders a little with the broad field
  const ang = broad.b.sub(0.5).mul(0.7);
  const ca = cos(ang), sa = sin(ang);
  const d = vec2(uWindDir);
  const dir = vec2(d.x.mul(ca).sub(d.y.mul(sa)), d.x.mul(sa).add(d.y.mul(ca)));
  const lean = strength.mul(float(0.3).add(gust.mul(0.85)));
  return vec4(dir.x, dir.y, lean, gust);
});
