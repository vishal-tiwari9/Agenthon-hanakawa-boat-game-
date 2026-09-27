// deliberate boulder placement: clusters along the banks (dense in the gorge and around the falls
// pool, sparse on meadow banks, none on the village embankments), stones in the clear shallows,
// big blocks at the gorge wall feet, and a few mossy boulders in the forest near the river.
// instances: [piece, x, y, z, qx, qy, qz, qw, scale, collide]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { cx, sample } from './grid';
import { Noise, rng, smooth } from './noise';
import { gorgeZ, lakeZ, villageZ, bankParams } from './valley';
import { pathPolylines, polyDist } from './masks';
import type { RiverField } from './river';
import { BRIDGES, DOCKS, RIVER_LENGTH, riverFrame } from '../../src/world/layout';
import { SITES } from '../../src/world/sites';

// the pieces used in the valley (a restrained library: rounded mossy river boulders and blocks)
const USE = ['rock_moss_set_01_0', 'rock_moss_set_01_1', 'rock_moss_set_01_3', 'rock_moss_set_01_5', 'rock_moss_set_02_0', 'rock_moss_set_02_2', 'rock_moss_set_02_4', 'rock_moss_set_02_6', 'boulder_01_0', 'namaqualand_boulder_05_0'];

export function placeRocks(h: Float32Array, res: number, shore: Float32Array, field: RiverField, noise: Noise) {
  const metaFile = join(import.meta.dirname, '../../public/assets/terrain/rocks/rocks.json');
  if (!existsSync(metaFile)) return null;
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  const pieces = USE.map((id) => meta.pieces.find((p: any) => p.id === id)).filter(Boolean);
  const r = rng(4242);
  const out: number[] = [];
  const paths = pathPolylines();
  const dockPts = DOCKS.map((d) => ({ f: riverFrame(d.s), side: d.side }));
  const bridgeS = BRIDGES.map((b) => b.s);
  const q = new Quaternion(), qa = new Quaternion(), up = new Vector3(0, 1, 0), nv = new Vector3();
  const H = (x: number, z: number) => sample(h, res, x, z);
  const S = (x: number, z: number) => sample(shore, res, x, z);
  const fieldAt = (x: number, z: number) => {
    const i = Math.max(0, Math.min(res - 1, Math.floor(x + 1024))), j = Math.max(0, Math.min(res - 1, Math.floor(z + 1024)));
    const k = j * res + i;
    return { s: field.s[k], lat: field.lat[k], half: field.half[k], curv: field.curv[k] };
  };
  const excluded = (x: number, z: number, rad: number) => {
    const f = fieldAt(x, z);
    if (Math.abs(f.lat) < 7.5 + rad && f.s > -30 && f.s < RIVER_LENGTH - 4 && H(x, z) < 0) return true;
    for (const b of bridgeS) if (Math.abs(f.s - b) < 12 + rad) return true;
    for (const d of dockPts) if (Math.hypot(x - d.f.x, z - d.f.z) < 26 && Math.sign(f.lat) === d.side) return true;
    for (const p of SITES) if (Math.hypot(x - p.x, z - p.z) < Math.max(p.hx, p.hz) + p.blend + rad) return true;
    for (const p of paths) if (polyDist(p.pts, x, z) < p.width + rad + 0.5) return true;
    return false;
  };
  const add = (x: number, z: number, size: number, sink: number, collideOk: boolean) => {
    if (excluded(x, z, size * 0.5)) return;
    const pc = Math.floor(r() * pieces.length);
    const piece = pieces[pc];
    const e = 1.5;
    const gx = H(x + e, z) - H(x - e, z), gz = H(x, z + e) - H(x, z - e);
    nv.set(-gx, 2 * e, -gz).normalize();
    // lean partly with the ground, plus a random rest tilt
    qa.setFromUnitVectors(up, nv.lerp(up, 0.45).normalize());
    q.setFromAxisAngle(up, r() * Math.PI * 2);
    const tilt = new Quaternion().setFromAxisAngle(new Vector3(r() - 0.5, 0, r() - 0.5).normalize(), (r() - 0.5) * 0.35);
    q.premultiply(tilt).premultiply(qa);
    const y = H(x, z) - sink * size * piece.dims[1];
    const top = y + size * piece.dims[1] * 0.78;
    const collide = collideOk && top > -1.1 && y < 1.8 && S(x, z) < 3 ? 1 : 0;
    out.push(USE.indexOf(piece.id), +x.toFixed(2), +y.toFixed(3), +z.toFixed(2), +q.x.toFixed(4), +q.y.toFixed(4), +q.z.toFixed(4), +q.w.toFixed(4), +size.toFixed(3), collide);
  };

  // banks: walk both edges of the river
  for (let s = -30; s < RIVER_LENGTH - 2; s += 1.6) {
    const f = riverFrame(s);
    for (const side of [-1, 1] as const) {
      const half = f.width / 2;
      const bx = f.x + f.nx * side * half, bz = f.z + f.nz * side * half;
      const b = bankParams(s, side, bx, bz, 0, noise);
      const gor = gorgeZ(s), lk = lakeZ(s);
      const head = smooth(RIVER_LENGTH - 60, RIVER_LENGTH - 15, s);
      const cascade = 1 - smooth(10, 30, Math.abs(s - 960));
      const cluster = smooth(0.0, 0.35, noise.fbm(bx / 28 + side * 13, bz / 28, 3));
      const base = (0.1 + 0.55 * gor + 0.75 * head + 0.6 * cascade * (side < 0 ? 1 : 0.3)) * (1 - 0.8 * lk) * (1 - b.vill);
      if (r() > base * (0.25 + 1.2 * cluster)) continue;
      const n = 1 + Math.floor(r() * (gor > 0.5 || head > 0.5 ? 4 : 2.5));
      for (let c = 0; c < n; c++) {
        const off = -3.5 + r() * 6 + (gor > 0.5 ? -1 : 0);
        const along = (r() - 0.5) * 3;
        const x = bx + f.nx * side * off + f.tx * along, z = bz + f.nz * side * off + f.tz * along;
        const big = gor > 0.5 || head > 0.5 ? 0.9 + r() * r() * 3.2 : 0.35 + r() * r() * 1.3;
        add(x, z, big, 0.12 + r() * 0.2, true);
      }
    }
  }
  // stones in the clear shallows (0.25-1.3 m), visible through the water
  for (let t = 0; t < 26000; t++) {
    const s = -30 + r() * (RIVER_LENGTH + 20);
    const f = riverFrame(s);
    const side = r() < 0.5 ? -1 : 1;
    const e = 1 + r() * 9;
    const x = f.x + f.nx * side * (f.width / 2 - e) + f.tx * (r() - 0.5) * 2, z = f.z + f.nz * side * (f.width / 2 - e) + f.tz * (r() - 0.5) * 2;
    const d = -H(x, z);
    if (d < 0.25 || d > 1.3) continue;
    const pat = smooth(0.05, 0.4, noise.fbm(x / 14 + 40, z / 14, 3));
    if (r() > 0.05 + 0.25 * pat) continue;
    if (villageZ(s, side) > 0.5 && e < 3) continue;
    add(x, z, 0.25 + r() * r() * 0.8, 0.2 + r() * 0.2, true);
  }
  // mossy boulders in the forest near the corridor
  for (let t = 0; t < 9000; t++) {
    const x = -1000 + r() * 2000, z = -1000 + r() * 2000;
    const sd = S(x, z);
    if (sd < 25 || sd > 60) {
      const f = fieldAt(x, z);
      if (f.s < -20) continue;
      if (sd < 25 || Math.abs(f.lat) - f.half > 220) continue;
    }
    const gx = H(x + 2, z) - H(x - 2, z), gz = H(x, z + 2) - H(x, z - 2);
    if (Math.hypot(gx, gz) / 4 > 0.9) continue;
    if (r() > 0.18) continue;
    add(x, z, 0.8 + r() * r() * 2.4, 0.25 + r() * 0.15, false);
  }
  void cx;
  return { pieces: USE, stride: 10, count: out.length / 10, instances: out };
}
