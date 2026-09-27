// quick placeholder river-valley bake (lead-owned) so every module can work against the new world
// while the terrain owner builds the real bake in tools/bake. run: npx tsx tools/bake-stub-river.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nearestRiver, riverFrame, RIVER_LENGTH, WORLD_SIZE, HARBOR } from '../src/world/layout';
import { SITES } from '../src/world/sites';

const OUT = join(import.meta.dirname, '../public/world');
const RES = 1024, SIZE = WORLD_SIZE, CELL = SIZE / RES;
const HMIN = -64, HMAX = 192;

function hash(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
function fbm(x: number, y: number, oct = 5) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f); f *= 2.03; a *= 0.5; }
  return s;
}
const sm = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const N = RES * RES;
const height = new Float32Array(N), shore = new Float32Array(N), flowX = new Float32Array(N), flowZ = new Float32Array(N);
const sand = new Float32Array(N), grass = new Float32Array(N), rock = new Float32Array(N), trees = new Float32Array(N), flowers = new Float32Array(N), waveScale = new Float32Array(N);

for (let j = 0; j < RES; j++) {
  for (let i = 0; i < RES; i++) {
    const k = j * RES + i;
    const x = -SIZE / 2 + (i + 0.5) * CELL, z = -SIZE / 2 + (j + 0.5) * CELL;
    const r = nearestRiver(x, z);
    const f = riverFrame(r.s);
    const half = f.width / 2;
    // beyond the river ends the channel closes: add the along-river overshoot to the bank distance
    const along = (x - f.x) * f.tx + (z - f.z) * f.tz;
    const over = r.s <= 0.5 ? Math.max(0, -along) : r.s >= RIVER_LENGTH - 0.5 ? Math.max(0, along) : 0;
    const d = Math.hypot(Math.max(0, Math.abs(r.lateral) - half), over) - (Math.abs(r.lateral) <= half && over === 0 ? half - Math.abs(r.lateral) : 0);
    const gorge = sm(780, 860, r.s) * (1 - sm(1150, 1230, r.s));
    const lake = sm(1480, 1580, r.s) * (1 - sm(1860, 1920, r.s));
    const village = 1 - sm(330, 420, r.s);
    let h: number;
    if (d < 0) {
      const t = Math.min(1, -d / half);
      const maxD = 2.6 + 2.4 * lake + 0.8 * gorge;
      h = -maxD * Math.pow(t, 0.55) - 0.25 * fbm(x * 0.08, z * 0.08, 3);
    } else {
      const n = fbm(x * 0.004, z * 0.004, 5), n2 = fbm(x * 0.02 + 7, z * 0.02 - 3, 4);
      const floodW = 18 + 40 * (1 - gorge) * (0.5 + n) + 50 * village + 40 * lake;
      const hillH = 90 + 110 * n;
      const rise = sm(floodW * (1 - gorge * 0.9), floodW * (1 - gorge * 0.9) + 220 - 150 * gorge, d);
      h = 0.5 + 1.2 * sm(0, 8, d) + hillH * Math.pow(rise, 1.35) + 6 * (n2 - 0.5) * sm(10, 60, d);
      if (village > 0) h = h * (1 - village * (1 - sm(40, 90, d))) + 1.2 * village * (1 - sm(40, 90, d));
    }
    for (const st of SITES) {
      const yaw = (st.yawDeg * Math.PI) / 180, dx = x - st.x, dz = z - st.z;
      const lx = Math.abs(dx * Math.cos(yaw) - dz * Math.sin(yaw)) - st.hx, lz = Math.abs(dx * Math.sin(yaw) + dz * Math.cos(yaw)) - st.hz;
      const w = 1 - sm(0, st.blend, Math.max(lx, lz, 0));
      if (d > 0) h = h * (1 - w) + st.y * w;
    }
    height[k] = h;
    shore[k] = Math.max(-64, Math.min(64, d));
    if (d < 0) {
      const t = Math.abs(r.lateral) / half;
      const speed = (0.55 * 36) / f.width * (1 - t * t) * (1 - 0.8 * lake);
      flowX[k] = -f.tx * speed;
      flowZ[k] = -f.tz * speed;
      waveScale[k] = sm(0, 6, -d) * (0.6 + 0.4 * lake);
    }
    const hx = height[k] - (i > 0 ? height[k - 1] : height[k]), hz = height[k] - (j > 0 ? height[k - RES] : height[k]);
    const slope = Math.hypot(hx, hz) / CELL;
    rock[k] = sm(0.7, 1.2, slope) + 0.6 * gorge * sm(0, 4, d) * (1 - sm(20, 40, d));
    sand[k] = d > -3 && d < 2.5 ? 1 - sm(1, 2.5, d) : d <= -3 ? 1 : 0;
    grass[k] = d > 1 ? (1 - Math.min(1, rock[k])) * sm(1, 4, d) : 0;
    trees[k] = d > 25 ? sm(25, 70, d) * (1 - Math.min(1, rock[k] * 0.7)) : 0;
    flowers[k] = grass[k] * sm(0.55, 0.75, fbm(x * 0.03, z * 0.03, 3)) * (1 - trees[k]);
  }
}

function quant(data: Float32Array, min: number, max: number, bits: 8 | 16) {
  const m = bits === 8 ? 255 : 65535;
  const out = bits === 8 ? new Uint8Array(data.length) : new Uint16Array(data.length);
  for (let k = 0; k < data.length; k++) out[k] = Math.round(Math.min(1, Math.max(0, (data[k] - min) / (max - min))) * m);
  return Buffer.from(out.buffer);
}
mkdirSync(OUT, { recursive: true });
const ch: Record<string, unknown> = {};
const put = (name: string, data: Float32Array, min: number, max: number, bits: 8 | 16 = 8) => {
  // lowercase file names: macos is case-insensitive but vite's static server is not
  const file = `${name.toLowerCase()}.bin`;
  writeFileSync(join(OUT, file), quant(data, min, max, bits));
  ch[name] = { file, res: RES, format: bits === 8 ? 'u8' : 'u16', min, max };
};
put('height', height, HMIN, HMAX, 16);
put('shore', shore, -64, 64);
put('waveScale', waveScale, 0, 1);
put('flowX', flowX, -1.5, 1.5);
put('flowZ', flowZ, -1.5, 1.5);
put('sand', sand, 0, 1);
put('grass', grass, 0, 1);
put('rock', rock.map((v) => Math.min(1, v)), 0, 1);
put('trees', trees, 0, 1);
put('flowers', flowers, 0, 1);
writeFileSync(join(OUT, 'world.json'), JSON.stringify({ version: Date.now(), size: SIZE, seaLevel: 0, channels: ch, extra: { stub: true, quay: HARBOR } }, null, 2));
console.log('stub river bake written', RES, 'x', RES);
