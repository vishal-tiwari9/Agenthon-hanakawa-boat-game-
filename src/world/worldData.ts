import { unGrad16, unpackGzip } from '../core/compression';
// baked world data loader. the bake (tools/bake/) writes public/world/world.json plus one binary
// per channel. every channel is a square grid covering [-size/2, size/2] in x and z,
// row-major with row index along +z (row 0 = north edge, z = -size/2), column along +x.
// cpu sampling is bilinear; gpu access goes through channelNode() which returns a decoded float.
import { ClampToEdgeWrapping, DataTexture, FloatType, HalfFloatType, LinearFilter, RedFormat, UnsignedByteType, DataUtils } from 'three/webgpu';
import { float, texture, vec2 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { AssetLoader } from '../core/assets';

export type ChannelFormat = 'u8' | 'u16' | 'f32';

export interface ChannelMeta {
  file: string;
  compressedFile?: string;
  res: number;
  format: ChannelFormat;
  /** decoded = min + normalized * (max - min); ignored for f32 */
  min: number;
  max: number;
  /** gpu upload: 'half' (R16F, decoded meters) or 'unorm' (R8, decode in shader). default by format */
  gpu?: 'half' | 'unorm' | 'float';
  /** compressed file only: 'grad16' = u16 residuals of a left + up - upleft predictor, split into lo/hi byte planes */
  filter?: 'grad16';
}

export interface WorldMeta {
  version: number;
  size: number;
  seaLevel: number;
  channels: Record<string, ChannelMeta>;
  /** free-form extra data written by the bake (e.g. dock surface heights) */
  extra?: Record<string, unknown>;
}

export interface Channel {
  meta: ChannelMeta;
  res: number;
  /** decoded values, float32 */
  data: Float32Array;
  tex?: DataTexture;
}

export class WorldData {
  meta!: WorldMeta;
  size = 2048;
  half = 1024;
  channels = new Map<string, Channel>();

  async load(assets: AssetLoader, base = '/world/') {
    this.meta = await assets.json<WorldMeta>(base + 'world.json?v=' + Date.now());
    this.size = this.meta.size;
    this.half = this.size / 2;
    await Promise.all(
      Object.entries(this.meta.channels).map(async ([name, meta]) => {
        const suffix = '?v=' + this.meta.version;
        let buf: ArrayBuffer;
        if (meta.compressedFile && typeof DecompressionStream !== 'undefined') {
          try {
            const packed = await assets.binary(base + meta.compressedFile + suffix);
            buf = await unpackGzip(packed);
            if (meta.filter === 'grad16') buf = unGrad16(buf, meta.res);
          } catch {
            buf = await assets.binary(base + meta.file + suffix);
          }
        } else {
          buf = await assets.binary(base + meta.file + suffix);
        }
        this.channels.set(name, { meta, res: meta.res, data: decode(buf, meta) });
      }),
    );
  }

  has(name: string) {
    return this.channels.has(name);
  }

  /** bilinear sample of a decoded channel at world (x, z); clamps at the edges */
  sample(name: string, x: number, z: number): number {
    const ch = this.channels.get(name);
    if (!ch) return 0;
    const n = ch.res;
    const fx = ((x + this.half) / this.size) * n - 0.5;
    const fz = ((z + this.half) / this.size) * n - 0.5;
    let x0 = Math.floor(fx), z0 = Math.floor(fz);
    const tx = fx - x0, tz = fz - z0;
    let x1 = x0 + 1, z1 = z0 + 1;
    x0 = x0 < 0 ? 0 : x0 >= n ? n - 1 : x0;
    x1 = x1 < 0 ? 0 : x1 >= n ? n - 1 : x1;
    z0 = z0 < 0 ? 0 : z0 >= n ? n - 1 : z0;
    z1 = z1 < 0 ? 0 : z1 >= n ? n - 1 : z1;
    const d = ch.data;
    const a = d[z0 * n + x0], b = d[z0 * n + x1], c = d[z1 * n + x0], e = d[z1 * n + x1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (e - c) * tx) * tz;
  }

  heightAt(x: number, z: number) {
    return this.sample('height', x, z);
  }

  /** water depth below sea level at (x, z); negative on land */
  depthAt(x: number, z: number) {
    return this.meta.seaLevel - this.heightAt(x, z);
  }

  normalAt(x: number, z: number, out = { x: 0, y: 1, z: 0 }, e = 1) {
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const nx = -hx, ny = 2 * e, nz = -hz;
    const l = Math.hypot(nx, ny, nz) || 1;
    out.x = nx / l;
    out.y = ny / l;
    out.z = nz / l;
    return out;
  }

  /** gpu texture of a channel (lazily created). R16F for height-like data, R8 for masks. */
  texture(name: string): DataTexture {
    const ch = this.channels.get(name);
    if (!ch) throw new Error(`world channel "${name}" missing`);
    if (!ch.tex) ch.tex = makeTexture(ch);
    return ch.tex;
  }

  /** tsl node: decoded channel value at a world-space xz node */
  channelNode(name: string, xz: Node): Node {
    const ch = this.channels.get(name)!;
    const tex = this.texture(name);
    const uv = vec2(xz as any).div(this.size).add(0.5);
    const raw = texture(tex, uv).r;
    const mode = gpuMode(ch.meta);
    if (mode === 'unorm') return float(ch.meta.min).add(raw.mul(ch.meta.max - ch.meta.min));
    return raw;
  }
}

function gpuMode(m: ChannelMeta) {
  return m.gpu ?? (m.format === 'u8' ? 'unorm' : 'half');
}

function decode(buf: ArrayBuffer, m: ChannelMeta): Float32Array {
  const n = m.res * m.res;
  const out = new Float32Array(n);
  if (m.format === 'f32') {
    out.set(new Float32Array(buf, 0, n));
  } else if (m.format === 'u16') {
    const src = new Uint16Array(buf, 0, n);
    const k = (m.max - m.min) / 65535;
    for (let i = 0; i < n; i++) out[i] = m.min + src[i] * k;
  } else {
    const src = new Uint8Array(buf, 0, n);
    const k = (m.max - m.min) / 255;
    for (let i = 0; i < n; i++) out[i] = m.min + src[i] * k;
  }
  return out;
}

function makeTexture(ch: Channel): DataTexture {
  const n = ch.res;
  const mode = gpuMode(ch.meta);
  let tex: DataTexture;
  if (mode === 'unorm') {
    const k = 255 / (ch.meta.max - ch.meta.min || 1);
    const u8 = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) u8[i] = Math.max(0, Math.min(255, Math.round((ch.data[i] - ch.meta.min) * k)));
    tex = new DataTexture(u8, n, n, RedFormat, UnsignedByteType);
  } else if (mode === 'float') {
    tex = new DataTexture(ch.data, n, n, RedFormat, FloatType);
  } else {
    const h = new Uint16Array(n * n);
    for (let i = 0; i < n * n; i++) h[i] = DataUtils.toHalfFloat(ch.data[i]);
    tex = new DataTexture(h, n, n, RedFormat, HalfFloatType);
  }
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}
