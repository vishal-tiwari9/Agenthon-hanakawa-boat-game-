// procedural grass: instanced tufts of curved geometric blades (no alpha cards, so no sorting,
// no overdraw from transparent texels, no alpha shimmer). each blade is a quadratic bezier built
// in the vertex shader from per-instance tuft data, bent by the shared wind field.
// three tuft kinds share one draw: lawn turf, tall tussocks (some blades flower into silky
// chigaya-like plumes or tan seed spikes) and clover carpets (the blades become leaflets).
// lods never pop: every vertex also knows where it would sit on the coarser lods' polyline and
// morphs there across a band before the tile swaps geometry (the tile's nearest point decides the
// lod, so every instance in a coarser tile is already fully morphed).
// at distance tufts thin out by rank while the survivors widen, keeping coverage constant, and the
// color converges to the tuft's mean so far grass reads as a calm field instead of noise.
import { BufferAttribute, BufferGeometry, DoubleSide } from 'three/webgpu';
import {
  Fn, abs, attribute, cameraPosition, cameraViewMatrix, ceil, clamp, cos, cross, dot, faceDirection, float, floor, fract,
  inverseSqrt, length, max, min, mix, normalLocal, normalize, positionGeometry, select, sin, smoothstep, sqrt, uniform,
  varyingProperty, vec2, vec3, vec4,
} from 'three/tsl';
import { uTime, uWindStrength } from '../core/uniforms';
import { FoliageMaterial } from './foliage';
import { windAt } from './wind';
import { GRASS, grassCanopyMean } from './palette';
import { hash1, vnoise } from './noise';
import type { VegetationField, HeightFn } from './field';
import { sortByRank, type TileData } from './tiles';

/** distance model shared by cpu tile selection and the vertex shader */
export const grassDist = {
  full: uniform(22),
  end: uniform(110),
  pow: uniform(0.7),
  pixelAngle: uniform(0.00107),
  bladeWidth: uniform(0.017),
};

/** tile lod switch distances (m); vertices morph to the coarser shape over the band below each */
export const GRASS_LOD = [22, 52];
const LOD_BAND = [8, 16];

export function densityAtCPU(d: number) {
  const full = grassDist.full.value as number, end = grassDist.end.value as number, p = grassDist.pow.value as number;
  const base = d <= full ? 1 : Math.pow(full / d, p);
  const t = Math.min(1, Math.max(0, (d - end * 0.78) / (end * 0.22)));
  return base * (1 - t * t * (3 - 2 * t));
}

const densityAt = (d: any) => {
  const base = min(float(1), grassDist.full.div(max(d, 0.001))).pow(grassDist.pow);
  return base.mul(float(1).sub(smoothstep(grassDist.end.mul(0.78), grassDist.end, d)));
};

/**
 * tuft geometry: `blades` curved strips with `segs` segments each (last segment is a tip triangle).
 * position = (u across -0.5..0.5, k/segs along 0..1, 0); aBlade = (root x, root z in unit disc, width yaw, seed).
 * the along coordinate is the node's fraction of the blade's segment count, so lods with 4, 2 and 1
 * segments share nodes (0, .5 and 1 exist in every lod) and a vertex can find its coarser position.
 */
export function buildTuftGeometry(blades: number, segs: number, seed = 7) {
  const pos: number[] = [], blade: number[] = [], nrm: number[] = [], idx: number[] = [];
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let b = 0; b < blades; b++) {
    const rr = Math.sqrt(rnd()) * (b === 0 ? 0.2 : 1);
    const ang = rnd() * Math.PI * 2;
    const ox = Math.cos(ang) * rr, oz = Math.sin(ang) * rr;
    // blades face outward: their width runs tangentially, with some scatter
    const facing = ang + Math.PI / 2 + (rnd() - 0.5) * 1.1;
    const bs = rnd();
    const start = pos.length / 3;
    for (let k = 0; k < segs; k++) {
      for (const u of [-0.5, 0.5]) {
        pos.push(u, k / segs, 0);
        blade.push(ox, oz, facing, bs);
        nrm.push(0, 1, 0);
      }
    }
    pos.push(0, 1, 0);
    blade.push(ox, oz, facing, bs);
    nrm.push(0, 1, 0);
    for (let k = 0; k < segs - 1; k++) {
      const a = start + k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const last = start + (segs - 1) * 2;
    idx.push(last, last + 1, last + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('aBlade', new BufferAttribute(new Float32Array(blade), 4));
  g.setIndex(new BufferAttribute(new Uint16Array(idx), 1));
  return g;
}

export function createGrassMaterial() {
  const aRoot = attribute('aRoot', 'vec4') as any;
  const aShape = attribute('aShape', 'vec4') as any;
  const aTint = attribute('aTint', 'vec4') as any;
  const aBlade = attribute('aBlade', 'vec4') as any;

  const vN = varyingProperty('vec3', 'vGrassN') as any;
  const vUp = varyingProperty('vec3', 'vGrassUp') as any;
  const vData = varyingProperty('vec4', 'vGrassData') as any; // v, dry, lush, far
  const vRnd = varyingProperty('vec3', 'vGrassRnd') as any; // r1, r3, gust
  const vKind = varyingProperty('vec4', 'vGrassKind') as any; // clover, seed head, u, head tint

  const m = new FoliageMaterial({ side: DoubleSide });
  m.name = 'grass';

  m.positionNode = Fn(() => {
    const root = aRoot.xyz;
    const yaw = aRoot.w;
    const Hs = aShape.x, lean0 = aShape.y, rank = aShape.z, iseed = aShape.w;
    const clover = Hs.lessThan(0);
    const H0 = abs(Hs);
    const tnx = aTint.z, tnz = aTint.w;
    const tn = vec3(tnx, sqrt(max(float(0.05), float(1).sub(tnx.mul(tnx)).sub(tnz.mul(tnz)))), tnz);
    const u = (positionGeometry as any).x, kf = (positionGeometry as any).y;
    const bseed = aBlade.w;

    const dist = length(cameraPosition.sub(root));
    const D = densityAt(dist);
    const grow = D.sub(rank).div(max(D.mul(0.3), 0.015)).clamp(0, 1);
    const widen = clamp(inverseSqrt(max(D, 0.05)), 1, 2.2);

    const r1 = fract(bseed.mul(13.71).add(iseed.mul(7.31)));
    const r2 = fract(bseed.mul(29.13).add(iseed.mul(3.93)));
    const r3 = fract(bseed.mul(5.37).add(iseed.mul(17.11)));
    const r4 = fract(bseed.mul(47.9).add(iseed.mul(11.3)));
    // flowering culms: a few blades of the tall tussocks
    const head = select(clover, float(0), smoothstep(0.3, 0.45, H0).mul(r4.lessThan(0.1).select(float(1), float(0))));

    const cy = cos(yaw), sy = sin(yaw);
    const radius = select(clover, H0.mul(0.9).add(0.07), H0.mul(0.18).add(0.03));
    const off = vec2(aBlade.x.mul(cy).sub(aBlade.y.mul(sy)), aBlade.x.mul(sy).add(aBlade.y.mul(cy))).mul(radius);
    const offLen = length(vec2(aBlade.x, aBlade.y));
    const facing = aBlade.z.add(yaw);
    const outward = normalize(off.add(vec2(cos(facing.add(1.57)), sin(facing.add(1.57))).mul(0.002)));

    // far tufts settle toward the ground instead of standing as isolated sprigs
    const settle = float(1).sub(smoothstep(grassDist.end.mul(0.3), grassDist.end, dist).mul(0.6));
    const bhBlade = H0.mul(r1.mul(0.5).add(0.5)).mul(float(1).sub(offLen.mul(0.3))).mul(head.mul(0.3).add(1));
    const bh = select(clover, H0.mul(r1.mul(0.5).add(0.6)), bhBlade).mul(grow).mul(settle);
    // root on the local terrain plane, sunk a little so it never floats
    const rootB = root.add(vec3(off.x, off.x.mul(tn.x).add(off.y.mul(tn.z)).div(tn.y).negate().sub(0.03), off.y));

    // wind: steady lean + traveling gusts + per-blade flutter
    const w = windAt(root.xz) as any;
    const wdir = vec2(w.x, w.y);
    const bend = w.z.mul(r2.mul(0.45).add(0.55)).mul(H0.mul(1.2).add(0.45).min(1.25)).mul(select(clover, float(0.15), float(1)));
    const phase = root.x.add(root.z).mul(0.37).add(r1.mul(6.283));
    const flutter = sin(uTime.mul(r3.mul(2.3).add(3.1)).add(phase)).mul(w.w.mul(0.12).add(0.035)).mul(uWindStrength);
    const perp = vec2(wdir.y.negate(), wdir.x);
    const natural = lean0.mul(r2.mul(0.65).add(0.35)).mul(float(1).sub(head.mul(0.6)));
    let tipH = outward.mul(natural).add(wdir.mul(bend)).add(perp.mul(flutter)) as any;
    const tl = length(tipH);
    tipH = tipH.mul(min(float(1), float(0.9).div(max(tl, 0.0001))));
    const tipY = sqrt(max(float(0.02), float(1).sub(dot(tipH, tipH))));

    const p0 = rootB;
    const p2b = p0.add(vec3(tipH.x, tipY, tipH.y).mul(bh));
    const p1b = p0.add(vec3(tipH.x.mul(0.18), tipY.mul(0.25).add(0.5), tipH.y.mul(0.18)).mul(bh));
    // clover: the petiole rises, then the leaflet spreads almost flat
    const leafLen = r2.mul(0.022).add(0.03).mul(grow);
    const lw = outward.add(wdir.mul(w.z.mul(0.12)));
    const p1c = p0.add(vec3(0, bh, 0));
    const p2c = p1c.add(vec3(lw.x, r3.mul(0.35).add(0.05), lw.y).mul(leafLen));
    const p1 = select(clover, p1c, p1b), p2 = select(clover, p2c, p2b);

    const side0 = select(clover, vec3(outward.y.negate(), 0, outward.x), vec3(cos(facing), 0, sin(facing)));
    const pixMin = dist.mul(grassDist.pixelAngle).mul(0.9);
    const Wb = max(grassDist.bladeWidth.mul(r3.mul(0.5).add(0.75)).mul(widen), pixMin).mul(grow.mul(0.5).add(0.5));
    const W = select(clover, r3.mul(0.012).add(0.022).mul(grow), Wb);

    // blade shape at a node fraction x (0..1 along the blade)
    const shape = (x: any) => {
      const vv = x.pow(0.9);
      const blade = float(1).sub(vv.pow(1.6)).mul(smoothstep(-0.25, 0.2, vv));
      const plume = mix(float(0.3), float(1.7), smoothstep(0.58, 0.8, vv)).mul(float(1).sub(vv.pow(8)));
      const leaflet = mix(float(0.12), float(1), smoothstep(0.4, 0.6, vv)).mul(float(1).sub(vv.pow(10)));
      return { v: vv, prof: select(clover, leaflet, mix(blade, plume, head)) };
    };
    const bez = (vv: any) => mix(mix(p0, p1, vv), mix(p1, p2, vv), vv);
    const own = shape(kf);
    const v = own.v;
    const T = normalize(mix(p1.sub(p0), p2.sub(p1), v).add(vec3(0, 0.0001, 0)));
    const side = normalize(side0.sub(T.mul(dot(side0, T))));
    const at = (x: any) => { const sh = shape(x); return bez(sh.v).add(side.mul(u.mul(W).mul(sh.prof))); };
    // morph targets: the same vertex on the 2-segment and 1-segment polylines
    const k2 = kf.mul(2);
    const pos4 = at(kf);
    const pos2 = mix(at(floor(k2).mul(0.5)), at(ceil(k2).mul(0.5)), fract(k2));
    const pos1 = mix(at(float(0)), at(float(1)), kf);
    const m1 = smoothstep(GRASS_LOD[0] - LOD_BAND[0], GRASS_LOD[0], dist);
    const m2 = smoothstep(GRASS_LOD[1] - LOD_BAND[1], GRASS_LOD[1], dist);
    const pos = mix(mix(pos4, pos2, m1), pos1, m2);

    const N = normalize(cross(side, T));
    const Nr = normalize(N.add(side.mul(u.mul(select(clover, float(0.5), float(1.6))))));
    normalLocal.assign(Nr);
    vN.assign(Nr);
    vUp.assign(tn);
    const far = smoothstep(grassDist.end.mul(0.2), grassDist.end.mul(0.85), dist);
    vData.assign(vec4(v, aTint.x, aTint.y, far));
    vRnd.assign(vec3(r1, r3, w.w.mul(uWindStrength.min(1))));
    vKind.assign(vec4(select(clover, float(1), float(0)), head, u, fract(iseed.mul(5.13))));
    return pos;
  })();

  // albedo: deep blue-green roots, fresh mid blade, warm tips (straw where dry)
  const v = vData.x, dry = vData.y, lush = vData.z, far = vData.w;
  const r1 = vRnd.x, r3 = vRnd.y, gust = vRnd.z;
  const isClover = vKind.x, head = vKind.y, ku = vKind.z, headTint = vKind.w;
  const fresh = vec3(...GRASS.fresh), lushC = vec3(...GRASS.lush), straw = vec3(...GRASS.straw), tipC = vec3(...GRASS.tip);
  let base = mix(fresh, lushC, lush.mul(0.8)) as any;
  base = base.mul(vec3(r1.mul(0.22).add(0.89), r3.mul(0.12).add(0.94), r1.mul(0.18).add(0.91)));
  const rootC = base.mul(vec3(0.5, 0.7, 0.78));
  const tip = mix(mix(base, tipC, 0.6), straw, dry.mul(0.8));
  let col = mix(rootC, base, smoothstep(0.0, 0.42, v)) as any;
  col = mix(col, tip, smoothstep(0.42, 1.0, v).mul(dry.mul(0.5).add(0.5)));
  // a few whole dead blades, more where it is dry
  const dead = smoothstep(0.0, 0.02, dry.mul(0.2).add(0.012).sub(r3.mul(r1)));
  col = mix(col, straw.mul(0.85), dead.mul(0.85));
  // flowering culms: silky silver-pink plumes (chigaya) or warm tan spikes
  const plume = mix(vec3(0.44, 0.4, 0.38), vec3(0.4, 0.3, 0.18), smoothstep(0.55, 0.75, headTint));
  col = mix(col, mix(tip, plume, smoothstep(0.6, 0.78, v).mul(0.85)), head);
  // clover leaflets: cool green with the pale chevron across the middle
  const chevron = smoothstep(0.66, 0.74, v).mul(smoothstep(0.86, 0.78, v)).mul(smoothstep(0.42, 0.2, abs(ku)));
  const cloverC = mix(vec3(...GRASS.clover).mul(r1.mul(0.3).add(0.85)), vec3(0.14, 0.23, 0.1), chevron.mul(0.55));
  col = mix(col, cloverC, isClover);
  // gusts flatten the blades and show their paler, glossier sides: bright waves travel downwind
  col = col.mul(gust.mul(smoothstep(0.25, 1.0, v)).mul(0.2).add(1));
  // far tufts converge to the canopy mean, the same color vegetationGroundAlbedo() gives the ground
  // (palette.ts), so thinned-out distant grass dissolves into the field instead of speckling
  const canopy = grassCanopyMean(dry, lush) as any;
  m.colorNode = mix(col, canopy, far.pow(0.8).mul(0.92));

  const nWorld: any = normalize(mix(vN.mul(faceDirection), vUp, far.mul(0.36).add(0.6).min(1)) as any);
  m.normalNode = normalize((cameraViewMatrix as any).mul(vec4(nWorld, float(0))).xyz);
  m.roughnessNode = float(0.55).add(far.mul(0.38)).add(dry.mul(0.1)).sub(isClover.mul(0.12)).add(head.mul(0.12)).min(1);
  m.aoNode = mix(smoothstep(0.0, 0.6, v).mul(0.5).add(0.5), float(0.8), isClover);
  // back-light glow (plumes glow most); fades with distance so far tufts do not sparkle
  m.translucencyNode = v.mul(0.55).add(0.35).mul(float(1).sub(dead.mul(0.6))).add(head.mul(smoothstep(0.6, 0.8, v)).mul(0.6))
    .mul(float(1).sub(isClover.mul(0.6))).mul(float(1).sub(far.mul(0.85)));
  m.translucencyTint = vec3(0.95, 1.0, 0.62);
  return m;
}

export interface GrassGenOptions {
  field: VegetationField;
  heightAt: HeightFn;
  tileSize: number;
  /** clumps per square meter at full density */
  maxDensity: number;
  excluded?: (x: number, z: number) => boolean;
}

export const GRASS_STRIDE = 12;
export const GRASS_ATTRIBS = [
  { name: 'aRoot', size: 4, offset: 0 },
  { name: 'aShape', size: 4, offset: 4 },
  { name: 'aTint', size: 4, offset: 8 },
];

/** generate the grass tufts of one tile: iterate field texels, stratified candidates per texel */
export function generateGrassTile(o: GrassGenOptions, tx: number, tz: number, need: number): TileData | null {
  const f = o.field;
  const cell = f.cell, res = f.res, half = f.half;
  const T = o.tileSize;
  const n = Math.max(1, Math.ceil(Math.sqrt(o.maxDensity * cell * cell)));
  const sub = cell / n;
  const i0 = Math.floor((tx * T + half) / cell), j0 = Math.floor((tz * T + half) / cell);
  const cells = Math.round(T / cell);
  const cap = cells * cells * n * n;
  const buf = new Float32Array(cap * GRASS_STRIDE);
  const ranks = new Float32Array(cap);
  // candidate acceptance keeps the expected density at maxDensity * field density
  const accept = (o.maxDensity * sub * sub);
  let count = 0, minY = 1e9, maxY = -1e9;
  const D = f.density;
  for (let j = j0; j < j0 + cells; j++) {
    if (j < 0 || j >= res - 1) continue;
    for (let i = i0; i < i0 + cells; i++) {
      if (i < 0 || i >= res - 1) continue;
      const k = j * res + i;
      if (Math.max(D[k], D[k + 1], D[k + res], D[k + res + 1], D[k - 1] || 0, D[k - res] || 0) < 0.004) continue;
      const cx0 = -half + i * cell, cz0 = -half + j * cell;
      for (let b = 0; b < n; b++) {
        for (let a = 0; a < n; a++) {
          const seed = (k * n + b) * n + a;
          const rank = hash1(seed, 1);
          if (rank >= need) continue;
          const x = cx0 + (a + hash1(seed, 2)) * sub;
          const z = cz0 + (b + hash1(seed, 3)) * sub;
          let dens = f.sample(D, x, z);
          if (dens <= 0.002) continue;
          // tussock-scale clustering
          const tuft = vnoise(x / 1.7, z / 1.7, 5);
          const tuft2 = tuft * tuft;
          dens *= 0.7 + 0.6 * tuft;
          if (hash1(seed, 4) >= dens * accept) continue;
          if (o.excluded && o.excluded(x, z)) continue;
          const y = o.heightAt(x, z);
          if (y < 0.5) continue;
          const tall = f.sample(f.tall, x, z);
          const dry = Math.min(1, Math.max(0, f.sample(f.dry, x, z) + (hash1(seed, 5) - 0.5) * 0.25));
          const lush = Math.min(1, Math.max(0, f.sample(f.lush, x, z) + (hash1(seed, 6) - 0.5) * 0.2));
          // three populations: clover carpets on lush low lawns, short turf, taller tussocks
          const kind = hash1(seed, 11);
          const cloverP = (0.1 + 0.26 * lush * (1 - tall)) * (0.6 + 0.8 * vnoise(x / 3.3, z / 3.3, 6)) * (1 - dry * 0.7);
          const clover = kind < cloverP;
          const turf = !clover && kind < cloverP + 0.52;
          // tussocks: where the tuft noise peaks, clumps are both denser and taller
          let h = Math.min(1.1, (0.1 + 0.68 * Math.pow(tall, 1.2)) * (0.7 + 0.6 * hash1(seed, 7)) * (0.55 + 1.1 * tuft2));
          if (turf) h = 0.06 + h * 0.34;
          // clover carries its (low) height negative: the shader turns its blades into leaflets
          if (clover) h = -(0.03 + 0.05 * hash1(seed, 7));
          const lean = (turf ? 0.35 : 0.22) + 0.32 * hash1(seed, 8) + dry * 0.12;
          const p = count * GRASS_STRIDE;
          buf[p] = x; buf[p + 1] = y; buf[p + 2] = z; buf[p + 3] = hash1(seed, 9) * Math.PI * 2;
          buf[p + 4] = h; buf[p + 5] = lean; buf[p + 6] = rank; buf[p + 7] = hash1(seed, 10);
          buf[p + 8] = dry; buf[p + 9] = lush; buf[p + 10] = f.sample(f.nx, x, z); buf[p + 11] = f.sample(f.nz, x, z);
          ranks[count] = rank;
          count++;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }
  if (count === 0) return { data: new Float32Array(0), ranks: new Float32Array(0), count: 0, minY: 0, maxY: 0 };
  const sorted = sortByRank(buf, ranks, count, GRASS_STRIDE);
  return { data: sorted.data, ranks: sorted.ranks, count, minY, maxY };
}
