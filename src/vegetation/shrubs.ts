// coastal shrubs: low wind-clipped mounds (think lentisk, myrtle, sea buckthorn) built from leaf cards
// of the same photographed atlas as the trees. the mound is low and clipped on the windward side
// and swept toward the north-east; leaves are lit with the mound's spherical normal so the shrub
// reads as one soft volume. far lods are prefixes of the same card list (lower ranks) with larger
// cards; each card's size morphs with its distance to the player (uViewPos, so shadows agree): the
// cards a coarser lod drops shrink away while the ones it keeps grow, and the tile swap is invisible.
import { BufferAttribute, BufferGeometry, DoubleSide, type Texture } from 'three/webgpu';
import {
  Fn, attribute, cameraViewMatrix, cos, faceDirection, float, fract, length, mix, normalLocal, normalize, positionGeometry, select, sin,
  smoothstep, uniform, uv, varyingProperty, vec2, vec3, vec4,
} from 'three/tsl';
import { uTime, uWindStrength } from '../core/uniforms';
import { FoliageMaterial, leafAlbedo } from './foliage';
import { windAt } from './wind';
import { PREVAILING, type HeightFn, type VegetationField } from './field';
import { uViewPos } from './forest';
import { hash1 } from './noise';
import type { TileData } from './tiles';

/** leaf rectangles in the shared atlas, image space (y down): x0, y0, x1, y1. stem at y1 */
export const LEAF_RECTS: [number, number, number, number][] = [
  [0.0166, 0.0205, 0.1455, 0.5107],
  [0.165, 0.0205, 0.3369, 0.3916],
  [0.6943, 0.0205, 0.8154, 0.4141],
  [0.3613, 0.0313, 0.4824, 0.3613],
  [0.5176, 0.0498, 0.6494, 0.3623],
  [0.2168, 0.5771, 0.3545, 1.0],
  [0.4229, 0.6025, 0.5615, 1.0],
  [0.0176, 0.6299, 0.1816, 1.0],
];

/** cards in the full shrub, and how many of them (lowest ranks) each lod keeps, with their leaf length */
export const SHRUB_LODS = [
  { cards: 1100, leaf: 0.13 },
  { cards: 300, leaf: 0.24 },
  { cards: 90, leaf: 0.42 },
];
/** tile lod switch distances (m); cards morph over the band below each */
export const SHRUB_LOD = [40, 120];
const SHRUB_BAND = [12, 30];

/**
 * unit shrub (radius ~1, base at y = 0, downwind = +x), the first `cards` cards of the full list.
 * attributes: position (leaf base), aOff (corner offset per unit leaf length), normal (card),
 * uv (atlas, image space), aSph (xyz spherical normal, w depth 0 inner .. 1 outer), aRank (card index / total)
 */
export function buildShrubGeometry(cards: number, seed = 5) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const total = SHRUB_LODS[0].cards;
  const P: number[] = [], O: number[] = [], N: number[] = [], U: number[] = [], S: number[] = [], K: number[] = [], I: number[] = [];
  for (let i = 0; i < cards; i++) {
    // point in an upper-heavy shell
    let dx = 0, dy = 0, dz = 0, l = 2;
    while (l > 1 || l < 0.05) { dx = rnd() * 2 - 1; dy = rnd() * 2 - 1; dz = rnd() * 2 - 1; l = Math.hypot(dx, dy, dz); }
    dx /= l; dy /= l; dz /= l;
    if (dy < -0.25) dy = -dy * 0.5;
    const r = 0.55 + 0.45 * Math.sqrt(rnd());
    let x = dx * r, y = dy * r * 0.7 + 0.3, z = dz * r;
    // wind clipping: compressed and lower on the windward (-x) side, swept downwind with height
    if (x < 0) { x *= 0.72; y *= 1 - 0.28 * Math.min(1, -x * 1.4); }
    else x *= 1.12;
    x += 0.22 * y;
    if (y < 0.03) y = 0.03 + rnd() * 0.08;
    const cx = 0.06, cy = 0.32;
    let nx = x - cx, ny = (y - cy) * 1.2, nz = z;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const depth = Math.min(1, Math.max(0, (r - 0.55) / 0.45));
    // card normal: outward tilted randomly
    let cnx = nx + (rnd() - 0.5) * 1.2, cny = ny + (rnd() - 0.2) * 0.9, cnz = nz + (rnd() - 0.5) * 1.2;
    const cl = Math.hypot(cnx, cny, cnz) || 1;
    cnx /= cl; cny /= cl; cnz /= cl;
    // leaf axis: perpendicular to the card normal, tip biased outward and up
    let tx = nx + (rnd() - 0.5) * 1.6, ty = ny + 0.6 + (rnd() - 0.5), tz = nz + (rnd() - 0.5) * 1.6;
    const tdot = tx * cnx + ty * cny + tz * cnz;
    tx -= cnx * tdot; ty -= cny * tdot; tz -= cnz * tdot;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    const bx = cny * tz - cnz * ty, by = cnz * tx - cnx * tz, bz = cnx * ty - cny * tx;
    const rect = LEAF_RECTS[Math.floor(rnd() * LEAF_RECTS.length)];
    const aspect = (rect[2] - rect[0]) / (rect[3] - rect[1]);
    const L = 0.75 + 0.5 * rnd(), W = L * aspect;
    const base = P.length / 3;
    // corners: (u, v) image space; stem (y1) at the leaf base, tip (y0) outward along t
    const corners: [number, number, number, number][] = [
      [-0.5, -0.5, rect[0], rect[3]], [0.5, -0.5, rect[2], rect[3]], [0.5, 0.5, rect[2], rect[1]], [-0.5, 0.5, rect[0], rect[1]],
    ];
    for (const [a, b, u, v] of corners) {
      P.push(x, y, z);
      O.push(bx * a * W + tx * (b + 0.5) * L, by * a * W + ty * (b + 0.5) * L, bz * a * W + tz * (b + 0.5) * L);
      N.push(cnx, cny, cnz);
      U.push(u, v);
      S.push(nx, ny, nz, depth);
      K.push((i + 0.5) / total);
    }
    I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(P), 3));
  g.setAttribute('aOff', new BufferAttribute(new Float32Array(O), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(N), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(U), 2));
  g.setAttribute('aSph', new BufferAttribute(new Float32Array(S), 4));
  g.setAttribute('aRank', new BufferAttribute(new Float32Array(K), 1));
  g.setIndex(new BufferAttribute(new Uint32Array(I), 1));
  return g;
}

export function createShrubMaterial(leafTex: Texture) {
  const aRoot = attribute('aRoot', 'vec4') as any;
  const aSize = attribute('aSize', 'vec4') as any;
  const aSph = attribute('aSph', 'vec4') as any;
  const aOff = attribute('aOff', 'vec3') as any;
  const aRank = attribute('aRank', 'float') as any;
  const vSph = varyingProperty('vec3', 'vShSph') as any;
  const vInfo = varyingProperty('vec2', 'vShInfo') as any; // depth, tint seed
  const vCard = varyingProperty('vec3', 'vShCard') as any;

  const m = new FoliageMaterial({ side: DoubleSide, alphaTest: 0.5 });
  m.name = 'shrubs';
  const rot = (v: any, c: any, s: any) => vec3(v.x.mul(c).sub(v.z.mul(s)), v.y, v.x.mul(s).add(v.z.mul(c)));

  const place = (shadow: boolean) => Fn(() => {
    const root = aRoot.xyz, yaw = aRoot.w;
    const sx = aSize.x, sy = aSize.y, seed = aSize.z;
    const c = cos(yaw), s = sin(yaw);
    // card size for this distance: lod0 size, morphing to lod1's (kept cards grow, the rest shrink
    // away), then to lod2's. uViewPos is the player camera in every pass, so shadows morph alike
    const dist = length((uViewPos as any).sub(root));
    const m1 = smoothstep(SHRUB_LOD[0] - SHRUB_BAND[0], SHRUB_LOD[0], dist);
    const m2 = smoothstep(SHRUB_LOD[1] - SHRUB_BAND[1], SHRUB_LOD[1], dist);
    const r1 = SHRUB_LODS[1].cards / SHRUB_LODS[0].cards, r2 = SHRUB_LODS[2].cards / SHRUB_LODS[0].cards;
    const s1 = select(aRank.lessThan(r1), float(SHRUB_LODS[1].leaf), float(0));
    const s2 = select(aRank.lessThan(r2), float(SHRUB_LODS[2].leaf), float(0));
    // shrubs grow in before the draw distance; shadows shrink away before the tiles stop casting
    const keep = float(1).sub(smoothstep(shrubDist.end.mul(0.82), shrubDist.end, dist))
      .mul(shadow ? float(1).sub(smoothstep(SHRUB_SHADOW - 14, SHRUB_SHADOW - 2, dist)) : float(1));
    const leaf = mix(mix(float(SHRUB_LODS[0].leaf), s1, m1), s2, m2).mul(keep);
    const p = (positionGeometry as any).add(aOff.mul(leaf));
    const local = vec3(p.x.mul(sx), p.y.mul(sy), p.z.mul(sx));
    const wp = root.add(rot(local, c, s));
    const w = windAt(root.xz) as any;
    const h = p.y.clamp(0, 1.3);
    const bend = h.mul(h);
    const sway = w.z.mul(0.35).add(w.w.mul(sin(uTime.mul(1.3).add(seed.mul(6.28)).add(root.x.mul(0.2)))).mul(0.5));
    const fl: any = sin(uTime.mul(fract(seed.mul(7.1)).mul(3).add(6)).add(p.x.mul(9)).add(p.z.mul(7))).mul(w.w.mul(0.012).add(0.004)).mul(uWindStrength.add(0.2));
    const off = vec3(w.x, 0, w.y).mul(sway.mul(sy).mul(0.05).mul(bend)).add(vec3(fl, fl.mul(0.7), fl.negate()).mul(h));
    const card = rot(normalLocal, c, s);
    normalLocal.assign(card);
    vCard.assign(card);
    vSph.assign(rot(aSph.xyz, c, s));
    vInfo.assign(vec2(aSph.w, seed));
    return wp.add(off);
  })();
  m.positionNode = place(false);
  m.castShadowPositionNode = place(true);

  const seed = vInfo.y;
  // per-shrub tint: some darker and bluer (lentisk), some fresher and yellower
  const tint = mix(vec3(0.72, 0.86, 0.66), vec3(1.02, 1.08, 0.78), seed);
  const albedo = leafAlbedo(leafTex, uv(), tint) as any;
  const shade = vInfo.x.mul(0.5).add(0.5);
  m.colorNode = vec4(albedo.rgb.mul(shade), albedo.a);
  const nWorld: any = normalize(mix(vCard.mul(faceDirection), vSph, 0.7) as any);
  m.normalNode = normalize((cameraViewMatrix as any).mul(vec4(nWorld, float(0))).xyz);
  m.roughnessNode = float(0.66);
  m.aoNode = vInfo.x.mul(0.55).add(0.45);
  m.translucencyNode = float(0.4);
  m.translucencyTint = vec3(1.0, 1.1, 0.55);
  return m;
}

export const SHRUB_STRIDE = 8;
export const SHRUB_ATTRIBS = [
  { name: 'aRoot', size: 4, offset: 0 },
  { name: 'aSize', size: 4, offset: 4 },
];

export interface ShrubGenOptions {
  field: VegetationField;
  heightAt: HeightFn;
  tileSize: number;
  /** candidate spacing (m); acceptance scales with the field */
  spacing: number;
  accept: number;
  excluded?: (x: number, z: number, r: number) => boolean;
}

const DOWNWIND_YAW = Math.atan2(PREVAILING.z, PREVAILING.x);

export function generateShrubTile(o: ShrubGenOptions, tx: number, tz: number): TileData | null {
  const f = o.field;
  const T = o.tileSize, sp = o.spacing;
  const n = Math.round(T / sp);
  const out: number[] = [];
  let minY = 1e9, maxY = -1e9;
  const push = (x: number, z: number, size: number, seed: number) => {
    if (o.excluded && o.excluded(x, z, size)) return;
    const y = o.heightAt(x, z);
    if (y < 1.2) return;
    const sy = size * (0.55 + 0.35 * hash1(seed, 21));
    // local +x must point downwind: yaw rotates local x onto the prevailing direction, with scatter
    const yaw = DOWNWIND_YAW + (hash1(seed, 22) - 0.5) * 0.7;
    out.push(x, y - 0.1 * sy, z, yaw, size, sy, hash1(seed, 23), 0);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const gx = tx * n + i, gz = tz * n + j;
      const seed = (gx * 73856093) ^ (gz * 19349663);
      const x = (gx + hash1(seed, 1)) * sp, z = (gz + hash1(seed, 2)) * sp;
      const suit = f.sample(f.shrub, x, z);
      if (suit < 0.03 || hash1(seed, 3) >= suit * o.accept) continue;
      const size = 0.7 + 0.75 * hash1(seed, 4) * (0.6 + 0.4 * suit);
      push(x, z, size, seed);
      // shrubs grow in small groups
      const extra = Math.floor(hash1(seed, 5) * 3.2 * suit + 0.3);
      for (let k = 0; k < extra; k++) {
        const a = hash1(seed, 6 + k) * Math.PI * 2, r = size * (1.1 + 1.3 * hash1(seed, 9 + k));
        const x2 = x + Math.cos(a) * r, z2 = z + Math.sin(a) * r;
        if (f.sample(f.shrub, x2, z2) < 0.02) continue;
        push(x2, z2, size * (0.5 + 0.35 * hash1(seed, 12 + k)), seed + 101 * (k + 1));
      }
    }
  }
  const count = out.length / SHRUB_STRIDE;
  if (!count) return { data: new Float32Array(0), ranks: new Float32Array(0), count: 0, minY: 0, maxY: 0 };
  return { data: new Float32Array(out), ranks: new Float32Array(count), count, minY, maxY };
}

export const shrubDist = { end: uniform(380) };
/** tiles nearer than this (m) cast; each shrub's shadow shrinks away over the 12 m before it */
export const SHRUB_SHADOW = 60;
