// procedural textures generated once on the cpu: a tileable detail map (orange-peel normal,
// fine height, smudge mask) and the gauge faces.
import { CanvasTexture, DataTexture, LinearMipmapLinearFilter, LinearFilter, NoColorSpace, RGBAFormat, RepeatWrapping, SRGBColorSpace, UnsignedByteType } from 'three/webgpu';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** tileable value noise, quintic interpolation, `period` lattice cells across the tile */
function valueNoise(size: number, period: number, seed: number) {
  const r = rng(seed);
  const lat = new Float32Array(period * period).map(() => r());
  const out = new Float32Array(size * size);
  const q = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * period, fy = (y / size) * period;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = q(fx - x0), ty = q(fy - y0);
      const g = (i: number, j: number) => lat[((j + period) % period) * period + ((i + period) % period)];
      const a = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * tx;
      const b = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * tx;
      out[y * size + x] = a + (b - a) * ty;
    }
  return out;
}

/** rgba: orange-peel normal xy, fine height, low-frequency smudge */
export function makeDetailTexture(size = 256) {
  const h = new Float32Array(size * size);
  const oct: [number, number][] = [[32, 1], [64, 0.55], [16, 0.35], [128, 0.2]];
  oct.forEach(([p, a], i) => {
    const n = valueNoise(size, p, 101 + i * 17);
    for (let k = 0; k < h.length; k++) h[k] += n[k] * a;
  });
  const smudge = valueNoise(size, 4, 7);
  const sm2 = valueNoise(size, 8, 9);
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
  let hmin = Infinity, hmax = -Infinity;
  for (const v of h) { hmin = Math.min(hmin, v); hmax = Math.max(hmax, v); }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 2.2, dy = (at(x, y + 1) - at(x, y - 1)) * 2.2;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      data[i] = Math.round((-dx / l * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round(((at(x, y) - hmin) / (hmax - hmin)) * 255);
      data[i + 3] = Math.round(Math.min(1, Math.max(0, smudge[y * size + x] * 0.7 + sm2[y * size + x] * 0.3)) * 255);
    }
  const t = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = 8;
  t.colorSpace = NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** lantern print: 花川 (hanakawa) brushed vertically on the front and back, alpha = ink */
export function makeLanternTexture() {
  const W = 512, H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#000';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '700 118px "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif CJK JP", serif';
  for (const u of [0.25, 0.75]) {
    // lathe v runs bottom to top; the canvas y is flipped by the texture upload
    g.fillText('花', u * W, H * 0.37);
    g.fillText('川', u * W, H * 0.63);
  }
  // thin painted bands near the rims
  g.fillRect(0, H * 0.1, W, 5);
  g.fillRect(0, H * 0.9 - 5, W, 5);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
