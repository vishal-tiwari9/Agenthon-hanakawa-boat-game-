// wildflowers in spring drifts: white harujion fleabane, pink renge (chinese milk vetch) carpets,
// tall yellow nanohana (rapeseed), white clover heads and dandelions. one procedural geometry (stem,
// petal ring, center) is morphed per species in the vertex shader, so a tile of mixed flowers is a
// single draw. stems bend in the shared wind like grass blades.
// lod without pops: past ~14 m the petals fold into the center while it widens to a disc of petal
// colour; the far lod is only that stem and disc, so the tile swap at 20 m changes nothing visible.
import { BufferAttribute, BufferGeometry, DoubleSide } from 'three/webgpu';
import {
  Fn, attribute, cameraPosition, cameraViewMatrix, cos, cross, dot, faceDirection, float, fract, length, max, min, mix,
  normalLocal, normalize, positionGeometry, select, sin, smoothstep, sqrt, uniform, varyingProperty, vec2, vec3, vec4,
} from 'three/tsl';
import { uSunDir, uTime, uWindStrength } from '../core/uniforms';
import { FoliageMaterial } from './foliage';
import { windAt } from './wind';
import { FLOWER, GRASS } from './palette';
import { hash1 } from './noise';
import { flowerSpecies, type VegetationField, type HeightFn } from './field';
import { sortByRank, type TileData } from './tiles';

export const flowerDist = {
  full: uniform(14),
  end: uniform(70),
  pixelAngle: uniform(0.00107),
};

/** tile lod switch (m); petals fold away over the band below it */
export const FLOWER_LOD = 20;
const FOLD_BAND = 7;

export function flowerDensityCPU(d: number) {
  const full = flowerDist.full.value as number, end = flowerDist.end.value as number;
  const base = d <= full ? 1 : Math.pow(full / d, 0.9);
  const t = Math.min(1, Math.max(0, (d - end * 0.65) / (end * 0.35)));
  return base * (1 - t * t * (3 - 2 * t));
}

const PETALS = 10;

/**
 * parts (aPart.x): 0 stem, 1 petal, 2 center.
 * position: stem (u, v, 0); petal (index, s along, t across); center (ring angle, radius01, 0).
 * the far lod (petals = false) keeps only the stem and a coarser center disc.
 */
export function buildFlowerGeometry(stemSegs = 3, petals = true) {
  const pos: number[] = [], part: number[] = [], nrm: number[] = [], idx: number[] = [];
  const add = (p: number, x: number, y: number, z: number) => {
    pos.push(x, y, z);
    part.push(p, 0, 0, 0);
    nrm.push(0, 1, 0);
    return pos.length / 3 - 1;
  };
  const s0 = pos.length / 3;
  for (let k = 0; k <= stemSegs; k++) for (const u of [-0.5, 0.5]) add(0, u, k / stemSegs, 0);
  for (let k = 0; k < stemSegs; k++) { const a = s0 + k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  if (petals) {
    // petals: base, two shoulders, two tip corners
    for (let i = 0; i < PETALS; i++) {
      const b = add(1, i, 0, 0);
      const l1 = add(1, i, 0.45, -0.5), r1 = add(1, i, 0.45, 0.5);
      const l2 = add(1, i, 1, -0.3), r2 = add(1, i, 1, 0.3);
      idx.push(b, r1, l1, l1, r1, r2, l1, r2, l2);
    }
  }
  // center dome: apex + ring
  const ring = petals ? 8 : 6;
  const c0 = add(2, 0, 0, 0);
  for (let i = 0; i < ring; i++) add(2, (i / ring) * Math.PI * 2, 1, 0);
  for (let i = 0; i < ring; i++) idx.push(c0, c0 + 1 + ((i + 1) % ring), c0 + 1 + i);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('aPart', new BufferAttribute(new Float32Array(part), 4));
  g.setIndex(new BufferAttribute(new Uint16Array(idx), 1));
  return g;
}

/** per-species value: 0 fleabane, 1 renge, 2 nanohana, 3 clover, 4 dandelion */
const bySpecies = (sp: any, v: [number, number, number, number, number]) =>
  select(sp.lessThan(0.5), float(v[0]), select(sp.lessThan(1.5), float(v[1]), select(sp.lessThan(2.5), float(v[2]), select(sp.lessThan(3.5), float(v[3]), float(v[4])))));
const bySpecies3 = (sp: any, v: [number, number, number][]) =>
  select(sp.lessThan(0.5), vec3(...v[0]), select(sp.lessThan(1.5), vec3(...v[1]), select(sp.lessThan(2.5), vec3(...v[2]), select(sp.lessThan(3.5), vec3(...v[3]), vec3(...v[4])))));

export function createFlowerMaterial() {
  const aRoot = attribute('aRoot', 'vec4') as any;
  const aFlower = attribute('aFlower', 'vec4') as any;
  const aPart = attribute('aPart', 'vec4') as any;
  const vN = varyingProperty('vec3', 'vFlN') as any;
  const vCol = varyingProperty('vec3', 'vFlCol') as any;
  const vInfo = varyingProperty('vec3', 'vFlInfo') as any; // translucency, roughness, far

  const m = new FoliageMaterial({ side: DoubleSide });
  m.name = 'flowers';

  const stemC = vec3(GRASS.fresh[0] * 0.75, GRASS.fresh[1] * 0.85, GRASS.fresh[2]);
  const petalCols: [number, number, number][] = [FLOWER.white, FLOWER.renge, FLOWER.nanohana, FLOWER.clover, FLOWER.dandelion];
  const centerCols: [number, number, number][] = [FLOWER.center, [0.7, 0.42, 0.52], [0.66, 0.44, 0.03], [0.6, 0.52, 0.4], [0.72, 0.38, 0.02]];

  m.positionNode = Fn(() => {
    const root = aRoot.xyz, yaw = aRoot.w;
    const species = aFlower.x, H0 = aFlower.y, rank = aFlower.z, seed = aFlower.w;
    const part = aPart.x;
    const gp = positionGeometry as any;

    const dist = length(cameraPosition.sub(root));
    const full = flowerDist.full, end = flowerDist.end;
    const D = min(float(1), full.div(max(dist, 0.001))).pow(0.9).mul(float(1).sub(smoothstep(end.mul(0.65), end, dist)));
    const grow = D.sub(rank).div(max(D.mul(0.3), 0.02)).clamp(0, 1);
    const fold = smoothstep(FLOWER_LOD - FOLD_BAND, FLOWER_LOD, dist);

    const r1 = fract(seed.mul(17.3)), r2 = fract(seed.mul(41.7)), r3 = fract(seed.mul(7.9));

    // stem as a bezier bent by wind, like a grass blade
    const w = windAt(root.xz) as any;
    const wdir = vec2(w.x, w.y);
    const lean = vec2(cos(yaw), sin(yaw)).mul(r2.mul(0.2).add(0.05));
    const bob = sin(uTime.mul(r3.mul(1.8).add(2.2)).add(r1.mul(6.28)).add(root.x.mul(0.3))).mul(w.w.mul(0.12).add(0.04)).mul(uWindStrength);
    let tipH = lean.add(wdir.mul(w.z.mul(0.9))).add(vec2(wdir.y.negate(), wdir.x).mul(bob)) as any;
    tipH = tipH.mul(min(float(1), float(0.85).div(max(length(tipH), 0.0001))));
    const tipY = sqrt(max(float(0.05), float(1).sub(dot(tipH, tipH))));
    const H = H0.mul(grow);
    const p0 = root.sub(vec3(0, 0.02, 0));
    const p1 = p0.add(vec3(tipH.x.mul(0.15), tipY.mul(0.3).add(0.45), tipH.y.mul(0.15)).mul(H));
    const p2 = p0.add(vec3(tipH.x, tipY, tipH.y).mul(H));
    const T2 = normalize(p2.sub(p1));

    // head frame: faces up and a little toward the sun, following the stem
    const up = normalize(T2.add(vec3(0, 0.9, 0)).add(uSunDir.mul(0.25)));
    const right = normalize(cross(up, vec3(0.31, 0.0, 0.95)));
    const fwd = cross(right, up);

    const pixMin = dist.mul(flowerDist.pixelAngle);
    const R0 = bySpecies(species, [0.024, 0.017, 0.034, 0.014, 0.022]).mul(r1.mul(0.35).add(0.8));
    const R = max(R0, pixMin.mul(1.3)).mul(grow);
    const cup = bySpecies(species, [0.1, 0.6, 0.55, 1.2, 0.18]);
    const pw = bySpecies(species, [0.14, 0.55, 0.8, 0.4, 0.26]);
    const cr = bySpecies(species, [0.3, 0.28, 0.32, 0.5, 0.2]);
    const dome = bySpecies(species, [0.35, 0.7, 0.8, 1.1, 0.3]);

    const out = vec3(0).toVar();
    const nrm = vec3(0, 1, 0).toVar();
    const col = stemC.toVar();
    const info = vec3(0.3, 0.6, 0).toVar();

    // stem
    const v = gp.y;
    const sa = mix(p0, p1, v), sb = mix(p1, p2, v);
    const Bs = mix(sa, sb, v);
    const Ts: any = normalize(mix(p1.sub(p0), p2.sub(p1), v) as any);
    const sideS = normalize(cross(Ts, vec3(0.7, 0, 0.7)));
    const stemW = max(float(0.0042), pixMin.mul(1.1)).mul(grow).mul(select(species.greaterThan(1.5).and(species.lessThan(2.5)), float(1.5), float(1)));
    const stemPos = Bs.add(sideS.mul(gp.x.mul(stemW)));

    // petal i on a ring; nanohana instead scatters its ten petals as small florets over a dome, so
    // the head reads as a raceme of little yellow flowers
    const pi = gp.x;
    const ang = pi.mul(6.2832 / PETALS).add(yaw.mul(3.0));
    const dir = right.mul(cos(ang)).add(fwd.mul(sin(ang)));
    const tang = right.mul(sin(ang).negate()).add(fwd.mul(cos(ang)));
    const s = gp.y, t = gp.z;
    const nano = species.greaterThan(1.5).and(species.lessThan(2.5));
    const petalLen = R.mul(float(1).sub(fold));
    const ringPos = p2.add(dir.mul(s.mul(petalLen).mul(float(1).sub(cup.mul(0.35))))).add(up.mul(cup.mul(s).mul(s).mul(petalLen)))
      .add(tang.mul(t.mul(pw).mul(petalLen)));
    const ringN = normalize(up.sub(dir.mul(cup.mul(s).mul(1.2))));
    // floret k: golden-angle spiral over the upper dome, a small square petal facing outward
    const ga = pi.mul(2.39996).add(yaw);
    const el = pi.add(0.5).div(PETALS).mul(1.25);
    const fd = normalize(up.mul(cos(el)).add(right.mul(cos(ga).mul(sin(el)))).add(fwd.mul(sin(ga).mul(sin(el)))));
    const ft = normalize(cross(fd, right.add(fwd.mul(0.3))));
    const fb = cross(fd, ft);
    const fl = petalLen.mul(0.5);
    const floretPos = p2.add(fd.mul(R.mul(0.62).mul(float(1).sub(fold)))).add(ft.mul(s.sub(0.5).mul(fl))).add(fb.mul(t.mul(fl).mul(1.3)));
    const petalPos = select(nano, floretPos, ringPos);
    const petalN = select(nano, fd, ringN);

    // center dome; folds out to a disc of petal colour at distance
    const ca = gp.x, cr01 = gp.y;
    const cdir = right.mul(cos(ca)).add(fwd.mul(sin(ca)));
    const cR = R.mul(mix(cr, float(0.82), fold));
    const cDome = mix(dome, float(0.25), fold);
    const centerPos = p2.add(cdir.mul(cr01.mul(cR))).add(up.mul(float(1).sub(cr01).mul(cR).mul(cDome).add(cR.mul(0.08))));
    const centerN = normalize(up.add(cdir.mul(cr01.mul(0.8))));

    const petalBase = bySpecies3(species, petalCols).mul(r2.mul(0.16).add(0.9));
    // renge and fleabane petals pale toward the base
    const pale = select(species.lessThan(1.5), float(0.45), float(0.12));
    const petalCol = mix(mix(petalBase, vec3(0.8, 0.78, 0.74), pale), petalBase, smoothstep(0.1, 0.8, s));
    const centerCol = mix(bySpecies3(species, centerCols), petalBase.mul(0.92), fold.mul(float(1).sub(cr01.mul(0.3))));

    const isStem = part.lessThan(0.5), isPetal = part.greaterThan(0.5).and(part.lessThan(1.5));
    out.assign(select(isStem, stemPos, select(isPetal, petalPos, centerPos)));
    nrm.assign(select(isStem, normalize(cross(sideS, Ts)), select(isPetal, petalN, centerN)));
    col.assign(select(isStem, stemC, select(isPetal, petalCol, centerCol)));
    const far = smoothstep(end.mul(0.3), end, dist);
    info.assign(vec3(select(isStem, float(0.35), float(0.9)), select(species.greaterThan(1.5).and(isPetal), float(0.35), float(0.6)), far));
    normalLocal.assign(nrm);
    vN.assign(nrm);
    vCol.assign(col);
    vInfo.assign(info);
    return out;
  })();

  m.colorNode = vCol;
  const nW: any = normalize(mix(vN.mul(faceDirection), vec3(0, 1, 0), vInfo.z.mul(0.4).add(0.25)) as any);
  m.normalNode = normalize((cameraViewMatrix as any).mul(vec4(nW, float(0))).xyz);
  m.roughnessNode = vInfo.y;
  m.translucencyNode = vInfo.x;
  m.translucencyTint = vec3(1, 0.95, 0.85);
  return m;
}

export const FLOWER_STRIDE = 8;
export const FLOWER_ATTRIBS = [
  { name: 'aRoot', size: 4, offset: 0 },
  { name: 'aFlower', size: 4, offset: 4 },
];

export interface FlowerGenOptions {
  field: VegetationField;
  heightAt: HeightFn;
  tileSize: number;
  /** flowers per square meter inside a full-strength patch */
  maxDensity: number;
  excluded?: (x: number, z: number) => boolean;
}

export function generateFlowerTile(o: FlowerGenOptions, tx: number, tz: number, need: number): TileData | null {
  const f = o.field;
  const cell = f.cell, res = f.res, half = f.half;
  const T = o.tileSize;
  const n = Math.max(1, Math.ceil(Math.sqrt(o.maxDensity * cell * cell)));
  const sub = cell / n;
  const accept = o.maxDensity * sub * sub;
  const i0 = Math.floor((tx * T + half) / cell), j0 = Math.floor((tz * T + half) / cell);
  const cells = Math.round(T / cell);
  const out: number[] = [];
  const ranks: number[] = [];
  let minY = 1e9, maxY = -1e9;
  const F = f.flower;
  for (let j = j0; j < j0 + cells; j++) {
    if (j < 1 || j >= res - 1) continue;
    for (let i = i0; i < i0 + cells; i++) {
      if (i < 1 || i >= res - 1) continue;
      const k = j * res + i;
      if (Math.max(F[k], F[k + 1], F[k + res], F[k + res + 1], F[k - 1], F[k - res]) < 0.01) continue;
      const cx0 = -half + i * cell, cz0 = -half + j * cell;
      for (let b = 0; b < n; b++) {
        for (let a = 0; a < n; a++) {
          const seed = ((k * n + b) * n + a) ^ 0x5bd1e995;
          const rank = hash1(seed, 1);
          if (rank >= need) continue;
          const x = cx0 + (a + hash1(seed, 2)) * sub, z = cz0 + (b + hash1(seed, 3)) * sub;
          const fl = f.sample(F, x, z);
          if (hash1(seed, 4) >= fl * accept) continue;
          if (o.excluded && o.excluded(x, z)) continue;
          const y = o.heightAt(x, z);
          if (y < 0.6) continue;
          // species drifts (shared with the far bloom colour in field.ts)
          const dry = f.sample(f.dry, x, z), lush = f.sample(f.lush, x, z);
          const shore = f.world.has('shore') ? f.world.sample('shore', x, z) : 20;
          const sp = flowerSpecies(x, z, dry, lush, shore, hash1(seed, 5));
          // heads just clear the surrounding grass; nanohana stands well above it, renge and clover sit low
          const tall = f.sample(f.tall, x, z);
          const grassH = 0.1 + 0.68 * Math.pow(tall, 1.2);
          const baseH = sp === 0 ? 0.16 + grassH * 0.9 : sp === 1 ? 0.07 + grassH * 0.45 : sp === 2 ? 0.36 + grassH * 0.85 : sp === 3 ? 0.06 + grassH * 0.2 : 0.06 + grassH * 0.35;
          const h = baseH * (0.8 + 0.4 * hash1(seed, 7));
          out.push(x, y, z, hash1(seed, 8) * Math.PI * 2, sp, h, rank, hash1(seed, 9));
          ranks.push(rank);
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }
  const count = ranks.length;
  if (!count) return { data: new Float32Array(0), ranks: new Float32Array(0), count: 0, minY: 0, maxY: 0 };
  const sorted = sortByRank(new Float32Array(out), new Float32Array(ranks), count, FLOWER_STRIDE);
  return { data: sorted.data, ranks: sorted.ranks, count, minY, maxY };
}
