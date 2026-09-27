// hanakawa valley bake: river spline (src/world/layout.ts) -> heightfield, river bed, masks,
// current, sky visibility. run: npx tsx tools/bake/index.ts [--preview]   (deterministic)
//
// channels written to public/world/ (grid convention in src/world/worldData.ts; lowercase files):
//   height     2048 u16  terrain / river bed height in meters, [-16, 320], 1 m cells. water surface y = 0
//   shore      2048 u8   signed distance to the waterline in meters, + inland, - in the water, clamped +-64
//   waveScale  1024 u8   0..1 local wave amplitude (calm: ~0.3 river, ~0.55 lake middle, fading in shallows)
//   flowX/Z    1024 u8   downstream surface current in m/s, [-1.5, 1.5] (0.2-0.6 channel, ~0 lake and banks)
//   sand       1024 u8   0..1 sand and silt: pools, the lake bed, sandy patches on bars
//   pebbles    1024 u8   0..1 pebbles and gravel: shallow margins, point-bar beaches, bed stones
//   grass      1024 u8   0..1 grass cover: floodplain meadows, banks, clearings (not under dense forest)
//   rock       1024 u8   0..1 exposed rock: gorge walls, the falls, steep ground, outcrops, bed rock
//   cliff      1024 u8   0..1 near-vertical faces (subset of rock)
//   moss       1024 u8   0..1 moss on rock and damp ground (gorge, north faces, near water, hollows)
//   path       1024 u8   0..1 footpaths (towpath, shrine, pagoda, lake shore, mill)
//   wet        1024 u8   0..1 waterline band on the banks
//   trees      1024 u8   0..1 conifer forest density: dense on valley walls, thinning to banks, clearings
//   cherry     1024 u8   0..1 cherry tree zones: village, shrine, pagoda, teahouse, mill, scattered on banks
//   bamboo     1024 u8   0..1 bamboo groves: the gorge slopes and two groves downstream
//   reeds      1024 u8   0..1 reeds: lake margins, slow shallow edges on inner bends, the weir pool
//   flowers    1024 u8   0..1 wildflower patches in meadows
//   shrubs     1024 u8   0..1 shrubs: forest edges, around outcrops, gullies
//   ao         1024 u8   0..1 baked sky visibility (1 = open sky), the dependable ambient baseline
// world.json `extra.terrain`: bake report, cascade / falls / abutment heights, rock instances.
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Noise, clamp01, smooth } from './noise';
import { SIZE, cx, sample, edt, blur } from './grid';
import { buildRiverField } from './river';
import { erode } from './shape';
import { compose, hardness, strata, applyCascade, applyFallsLip, applySites, applyBridges, applyDocks, applyNavigable, ABUTMENT_Y, CASCADE, FALLS } from './valley';
import { buildMasks, MASKS, pathPolylines, polyDist } from './masks';
import { writePng } from './png';
import { placeRocks } from './rocks';
import { DOCKS, BRIDGES, RIVER_LENGTH, WORLD_SIZE, riverFrame, bankPoint, SPAWN } from '../../src/world/layout';

const OUT = join(import.meta.dirname, '../../public/world');
const SHOTS = join(import.meta.dirname, '../../shots/terrain');
const RES = 2048;
const HMIN = -16, HMAX = 320;
const argv = new Set(process.argv.slice(2));
const t0 = performance.now();
const lap = (label: string) => console.log(`  ${label.padEnd(24)} ${((performance.now() - t0) / 1000).toFixed(1)}s`);
if (WORLD_SIZE !== SIZE) throw new Error('world size mismatch');

const noise = new Noise(2024);
console.log('hanakawa bake', RES, 'x', RES);
const field = buildRiverField(RES);
lap('river field');
let h = compose(field, noise);
lap('compose');
erode(h, RES, hardness(field, h, noise), 450000, 77, 6, 2.5, 80);
lap('hydraulic erosion');
// round far-field divides (medial-axis creases between distant reaches); the corridor stays sharp
{
  const b = blur(h, RES, 9);
  for (let k = 0; k < h.length; k++) {
    const w = smooth(140, 320, field.q[k]);
    if (w > 0) h[k] += (b[k] - h[k]) * w * 0.85;
  }
}
h = strata(h, field, noise);
applyCascade(h, RES, noise);
applyFallsLip(h, RES, noise);
// paths: level across, slightly sunken
{
  const src = h.slice();
  for (const p of pathPolylines()) {
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (const [x, z] of p.pts) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    for (let j = Math.max(0, Math.floor(z0 + 1014)); j <= Math.min(RES - 1, Math.ceil(z1 + 1034)); j++)
      for (let i = Math.max(0, Math.floor(x0 + 1014)); i <= Math.min(RES - 1, Math.ceil(x1 + 1034)); i++) {
        const k = j * RES + i;
        if (src[k] < 0.3) continue;
        const x = cx(i, RES), z = cx(j, RES);
        const d = polyDist(p.pts, x, z);
        if (d > p.width + 2) continue;
        let a = 0;
        for (let o = 0; o < 8; o++) a += sample(src, RES, x + Math.cos(o * 0.785) * 1.5, z + Math.sin(o * 0.785) * 1.5);
        const w = 1 - Math.min(1, Math.max(0, (d - p.width * 0.5) / 2));
        h[k] += (a / 8 - 0.06 - h[k]) * w * 0.8;
      }
  }
}
applySites(h, RES);
applyBridges(h, field);
applyDocks(h, RES);
applyNavigable(h, field);
for (let k = 0; k < h.length; k++) h[k] = Math.min(HMAX, Math.max(HMIN, h[k]));
lap('features');

const shore = (() => {
  const land = new Uint8Array(RES * RES), water = new Uint8Array(RES * RES);
  for (let k = 0; k < land.length; k++) { land[k] = h[k] > 0 ? 1 : 0; water[k] = 1 - land[k]; }
  const toLand = edt(land, RES).dist, toWater = edt(water, RES).dist;
  const out = new Float32Array(RES * RES);
  for (let k = 0; k < out.length; k++) out[k] = land[k] ? Math.max(0.1, toWater[k] - 0.5) : -Math.max(0.1, toLand[k] - 0.5);
  return out;
})();
lap('shore distance');
const masks = buildMasks(h, RES, shore, field, noise, 1024);
lap('masks + sky visibility');
const rocks = placeRocks(h, RES, shore, field, noise);
lap(`rocks (${rocks ? rocks.count : 'no rock assets'})`);

// ---------- validation ----------
const report: Record<string, unknown> = {};
{
  const depth = (x: number, z: number) => -sample(h, RES, x, z);
  const docks: Record<string, unknown> = {};
  for (const d of DOCKS) {
    const a = (d.headingDeg * Math.PI) / 180, fx = Math.sin(a), fz = -Math.cos(a);
    let minD = 1e9;
    for (let s = -3; s <= 3; s += 0.5) for (let t = -0.8; t <= 0.8; t += 0.4) minD = Math.min(minD, depth(d.moorX + fx * s - fz * t, d.moorZ + fz * s + fx * t));
    docks[d.id] = { atMoor: +depth(d.moorX, d.moorZ).toFixed(2), minUnderHull: +minD.toFixed(2), required: d.minDepth };
    if (minD < d.minDepth) console.warn(`  !! dock ${d.id}: ${minD.toFixed(2)} < ${d.minDepth}`);
  }
  report.docks = docks;
  let navMin = 1e9, navAt = 0;
  for (let s = -25; s < RIVER_LENGTH - 8; s += 2) {
    const f = riverFrame(s);
    for (const o of [-6, -3, 0, 3, 6]) {
      const dd = depth(f.x + f.nx * o, f.z + f.nz * o);
      if (dd < navMin) { navMin = dd; navAt = s; }
    }
  }
  report.navigable = { minDepth12m: +navMin.toFixed(2), at: navAt };
  const bridges: Record<string, unknown> = {};
  for (const b of BRIDGES) {
    const f = riverFrame(b.s);
    let mn = 1e9;
    for (let o = -f.width / 2 + 2; o <= f.width / 2 - 2; o += 1) mn = Math.min(mn, depth(f.x + f.nx * o, f.z + f.nz * o));
    const l = bankPoint(b.s, -1, 6), r = bankPoint(b.s, 1, 6);
    bridges[b.id] = { minDepthEdgeToEdge: +mn.toFixed(2), abutmentY: ABUTMENT_Y[b.id], leftGround: +sample(h, RES, l.x, l.z).toFixed(2), rightGround: +sample(h, RES, r.x, r.z).toFixed(2) };
  }
  report.bridges = bridges;
  // reachability from the spawn at the boat's draft
  const R = 1024;
  const toC = (v: number) => Math.max(0, Math.min(R - 1, Math.floor((v + 1024) / 2)));
  const seen = new Uint8Array(R * R);
  const ok = (k: number) => -sample(h, RES, cx(k % R, R), cx((k / R) | 0, R)) >= 1.2;
  const st = [toC(SPAWN.z) * R + toC(SPAWN.x)];
  if (ok(st[0])) {
    seen[st[0]] = 1;
    while (st.length) {
      const k = st.pop()!;
      const i = k % R, j = (k / R) | 0;
      for (const kk of [k + 1, k - 1, k + R, k - R]) if (kk >= 0 && kk < R * R && !seen[kk] && Math.abs((kk % R) - i) <= 1 && Math.abs(((kk / R) | 0) - j) <= 1 && ok(kk)) { seen[kk] = 1; st.push(kk); }
    }
  }
  const reach: Record<string, boolean> = {};
  for (const d of DOCKS) reach[d.id] = !!seen[toC(d.moorZ) * R + toC(d.moorX)];
  const fe = riverFrame(RIVER_LENGTH - 12);
  reach.falls = !!seen[toC(fe.z) * R + toC(fe.x)];
  report.reachable = reach;
  for (const [k, v] of Object.entries(reach)) if (!v) console.warn(`  !! not reachable at 1.2 m: ${k}`);
  const cb = bankPoint(CASCADE.s, CASCADE.side, CASCADE.step + 2);
  report.cascade = { lipX: +cb.x.toFixed(1), lipZ: +cb.z.toFixed(1), lipY: +sample(h, RES, cb.x, cb.z).toFixed(2) };
  const fl = riverFrame(RIVER_LENGTH);
  const lip = { x: fl.x + fl.tx * 19, z: fl.z + fl.tz * 19 };
  report.falls = { lipX: +lip.x.toFixed(1), lipZ: +lip.z.toFixed(1), lipY: +sample(h, RES, lip.x, lip.z).toFixed(2), top: FALLS.top };
}
lap('validation');

// ---------- write ----------
function quant(data: Float32Array, min: number, max: number, bits: 8 | 16) {
  const n = data.length, mx = bits === 8 ? 255 : 65535;
  const out = bits === 8 ? new Uint8Array(n) : new Uint16Array(n);
  for (let k = 0; k < n; k++) out[k] = Math.round(clamp01((data[k] - min) / (max - min)) * mx);
  return Buffer.from(out.buffer);
}
function fnv(buf: Buffer, hsh: number) {
  for (let i = 0; i < buf.length; i += 5) hsh = Math.imul(hsh ^ buf[i], 16777619);
  return hsh >>> 0;
}
mkdirSync(OUT, { recursive: true });
const channels: Record<string, { file: string; compressedFile: string; res: number; format: string; min: number; max: number; filter?: 'grad16' }> = {};
/** u16 grids: residuals of a left + up - upleft predictor as lo/hi byte planes (gzips ~2.4x smaller); see unGrad16 */
const grad16 = (buf: Uint8Array, res: number) => {
  const a = new Uint16Array(buf.buffer, buf.byteOffset, res * res);
  const n = res * res;
  const out = new Uint8Array(n * 2);
  for (let y = 0, i = 0; y < res; y++) {
    for (let x = 0; x < res; x++, i++) {
      const l = x > 0 ? a[i - 1] : 0, u = y > 0 ? a[i - res] : 0, ul = x > 0 && y > 0 ? a[i - res - 1] : 0;
      const d = (a[i] - l - u + ul) & 0xffff;
      out[i] = d & 0xff;
      out[n + i] = d >> 8;
    }
  }
  return out;
};
let digest = 2166136261;
const written = new Set<string>(['world.json']);
const put = (name: string, data: Float32Array, res: number, min: number, max: number, bits: 8 | 16) => {
  const file = name.toLowerCase() + '.bin';
  const buf = quant(data, min, max, bits);
  const packed = bits === 16 ? name.toLowerCase() + '.g16.gz' : file + '.gz';
  writeFileSync(join(OUT, file), buf);
  writeFileSync(join(OUT, packed), gzipSync(bits === 16 ? grad16(buf, res) : buf, { level: 9 }));
  written.add(file);
  written.add(packed);
  digest = fnv(buf, digest);
  channels[name] = { file, compressedFile: packed, res, format: bits === 16 ? 'u16' : 'u8', min, max, ...(bits === 16 ? { filter: 'grad16' as const } : {}) };
};
put('height', h, RES, HMIN, HMAX, 16);
put('shore', shore, RES, -64, 64, 8);
for (const n of MASKS) {
  const flow = n === 'flowX' || n === 'flowZ';
  put(n, masks[n], 1024, flow ? -1.5 : 0, flow ? 1.5 : 1, 8);
}
if (rocks) writeFileSync(join(OUT, 'rocks.json'), JSON.stringify(rocks));
// stale files from older bakes
for (const f of readdirSync(OUT)) if (!written.has(f) && f !== 'rocks.json' && (f.endsWith('.bin') || f.endsWith('.json'))) unlinkSync(join(OUT, f));
writeFileSync(join(OUT, 'world.json'), JSON.stringify({
  version: digest,
  size: SIZE,
  seaLevel: 0,
  channels,
  extra: { terrain: { report, abutments: ABUTMENT_Y, cascade: CASCADE, falls: FALLS, rocks: rocks ? 'rocks.json' : null } },
}, null, 2));
console.log('report', JSON.stringify(report));
lap('write');

// ---------- previews ----------
if (argv.has('--preview')) {
  mkdirSync(SHOTS, { recursive: true });
  const box = (s0: number, s1: number, pad: number) => {
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (let s = s0; s <= s1; s += 5) { const f = riverFrame(s); x0 = Math.min(x0, f.x); z0 = Math.min(z0, f.z); x1 = Math.max(x1, f.x); z1 = Math.max(z1, f.z); }
    const c = [(x0 + x1) / 2, (z0 + z1) / 2], r = Math.max(x1 - x0, z1 - z0) / 2 + pad;
    return [c[0] - r, c[1] - r, c[0] + r, c[1] + r] as const;
  };
  preview(join(SHOTS, 'bake-map.png'), -1024, -1024, 1024, 1024, 1024);
  preview(join(SHOTS, 'bake-village.png'), ...box(40, 480, 70), 800);
  preview(join(SHOTS, 'bake-gorge.png'), ...box(800, 1200, 60), 800);
  preview(join(SHOTS, 'bake-lake.png'), ...box(1480, 1900, 60), 800);
  preview(join(SHOTS, 'bake-falls.png'), ...box(1930, RIVER_LENGTH, 70), 700);
  lap('previews');
}

function preview(file: string, x0: number, z0: number, x1: number, z1: number, W: number) {
  const Hh = Math.round((W * (z1 - z0)) / (x1 - x0));
  const rgb = new Uint8Array(W * Hh * 3);
  const az = (118 * Math.PI) / 180, el = (36 * Math.PI) / 180;
  const sun = { x: Math.sin(az) * Math.cos(el), y: Math.sin(el), z: -Math.cos(az) * Math.cos(el) };
  const mr = 1024, px = (x1 - x0) / W;
  const M = masks;
  const mix3 = (a: number[], b: number[], t: number) => a.map((q, i) => q + (b[i] - q) * clamp01(t));
  for (let y = 0; y < Hh; y++) {
    const z = z0 + (y + 0.5) * px;
    for (let xx = 0; xx < W; xx++) {
      const x = x0 + (xx + 0.5) * px;
      const e = Math.max(0.5, px);
      const v = sample(h, RES, x, z);
      const gx = (sample(h, RES, x + e, z) - sample(h, RES, x - e, z)) / (2 * e);
      const gz = (sample(h, RES, x, z + e) - sample(h, RES, x, z - e)) / (2 * e);
      const l = Math.hypot(gx, 1, gz);
      const lit = Math.max(0, (-gx * sun.x + sun.y - gz * sun.z) / l);
      const ao = sample(M.ao, mr, x, z);
      const S = (n: keyof typeof M) => sample(M[n], mr, x, z);
      let c: number[];
      if (v < 0) {
        const t = clamp01(-v / 6);
        c = mix3([0.55, 0.7, 0.55], [0.1, 0.3, 0.32], Math.sqrt(t));
        c = mix3(c, [0.6, 0.58, 0.5], S('pebbles') * (1 - t) * 0.6);
        c = c.map((q) => q * (0.8 + 0.25 * lit));
      } else {
        c = [0.45, 0.4, 0.3];
        c = mix3(c, [0.42, 0.56, 0.24], S('grass'));
        c = mix3(c, [0.62, 0.6, 0.55], S('pebbles'));
        c = mix3(c, [0.55, 0.53, 0.5], S('rock'));
        c = mix3(c, [0.3, 0.42, 0.2], S('moss') * S('rock'));
        c = mix3(c, [0.12, 0.24, 0.1], S('trees') * 0.85);
        c = mix3(c, [0.86, 0.6, 0.7], S('cherry') * 0.7);
        c = mix3(c, [0.4, 0.55, 0.25], S('bamboo') * 0.7);
        c = mix3(c, [0.62, 0.6, 0.4], S('reeds') * 0.7);
        c = mix3(c, [0.65, 0.5, 0.35], S('path'));
        c = c.map((q) => q * (0.35 + 0.8 * lit) * (0.55 + 0.45 * ao));
      }
      const o = (y * W + xx) * 3;
      for (let q = 0; q < 3; q++) rgb[o + q] = Math.min(255, Math.max(0, c[q] * 255));
    }
  }
  const mark = (x: number, z: number, col: number[]) => {
    const u = Math.round((x - x0) / px), w = Math.round((z - z0) / px);
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      const U = u + a, V = w + b;
      if (U < 0 || V < 0 || U >= W || V >= Hh) continue;
      const o = (V * W + U) * 3;
      rgb[o] = col[0]; rgb[o + 1] = col[1]; rgb[o + 2] = col[2];
    }
  };
  for (const d of DOCKS) mark(d.moorX, d.moorZ, [255, 40, 40]);
  for (const b of BRIDGES) { const f = riverFrame(b.s); mark(f.x, f.z, [255, 230, 0]); }
  writePng(file, W, Hh, rgb);
  console.log('  preview', file);
}
