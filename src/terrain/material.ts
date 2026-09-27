// terrain material: planar ground layers (forest floor, meadow soil, pebbles, gravel, mud, path)
// and triplanar rock (mossy boulders, dark layered walls) blended by baked masks, slope and each
// layer's own relief, with macro color variation, wet banks and caustics on the river bed.
import { MeshStandardNodeMaterial, type DataArrayTexture, type DataTexture } from 'three/webgpu';
import {
  abs, cameraViewMatrix, clamp, dot, float, int, max, mix as mixT, normalize, normalWorldGeometry, positionWorld, pow, smoothstep, sqrt, texture, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { causticsNode } from '../water/caustics';
import { uWet } from '../core/daycycle';
import { vegetationFieldNode, vegetationGroundAlbedo } from '../vegetation/palette';

type N = any;
const mix: any = mixT;

export const GROUND = ['forrest_ground_03', 'forest_leaves_02', 'leafy_grass', 'ganges_river_pebbles', 'river_small_rocks', 'brown_mud_rocks_01', 'dirt_floor'] as const;
export const ROCK = ['mossy_rock', 'dark_rock_02'] as const;
// meters per texture repeat
const GROUND_SCALE = [3.2, 3.6, 2.6, 2.1, 2.8, 3.0, 2.4];
const ROCK_SCALE = [5.5, 7.5];

/** layer order inside the shared arrays */
export const LAYERS = [...GROUND, ...ROCK];
export const ROCK_BASE = GROUND.length;
export const NOISE_LAYER = LAYERS.length;

export interface TerrainTextures {
  surface: DataTexture;
  /** layer 0: grass, pebbles, rock, trees. layer 1: sand, moss, path, wet */
  masks: DataArrayTexture;
  /** srgb albedo per layer */
  albedo: DataArrayTexture;
  /** normal.xy, roughness, ao per layer; the last layer is tileable noise */
  layerSurface: DataArrayTexture;
  size: number;
}

export const terrainTuning = {
  uWetDark: uniform(0.62),
  uVegGround: uniform(0.92),
  uBedDark: uniform(0.7),
  uRockBright: uniform(1.0),
};

export function createTerrainMaterial(t: TerrainTextures, position: N) {
  const m = new MeshStandardNodeMaterial();
  m.positionNode = position;
  const p: N = positionWorld;
  const wuv: N = p.xz.div(t.size).add(0.5);
  const surf: N = texture(t.surface, wuv);
  const nx: N = surf.r.mul(2).sub(1), nz: N = surf.g.mul(2).sub(1);
  const Ng: N = normalize(vec3(nx, sqrt(max(float(0.02), float(1).sub(nx.mul(nx)).sub(nz.mul(nz)))), nz));
  const sky: N = surf.b;
  const cvx: N = surf.a.mul(2).sub(1);
  const mA: N = texture(t.masks, wuv).depth(int(0)), mB: N = texture(t.masks, wuv).depth(int(1));
  const grass: N = mA.r, peb: N = mA.g, rockM: N = mA.b, trees: N = mA.a;
  const sand: N = mB.r, moss: N = mB.g, path: N = mB.b, wet: N = mB.a;
  // macro variation: three scales of tileable noise
  const noise = (uv: N): N => texture(t.layerSurface, uv).depth(int(NOISE_LAYER));
  const n1: N = noise(p.xz.div(173)), n2: N = noise(p.xz.div(41).add(0.37));
  const macro: N = n1.r.mul(0.6).add(n2.g.mul(0.4));
  const under: N = smoothstep(0.05, -0.25, p.y);

  // ---------- ground layers (planar, world xz) ----------
  const G = (i: number) => {
    const uv: N = p.xz.div(GROUND_SCALE[i]).add(vec2(i * 0.173, i * 0.311));
    const a: N = texture(t.albedo, uv).depth(int(i));
    const s: N = texture(t.layerSurface, uv).depth(int(i));
    return { a: a.rgb, n: vec2(s.r.mul(2).sub(1), s.g.mul(2).sub(1).negate()), r: s.b, ao: s.a };
  };
  const L = GROUND.map((_, i) => G(i));
  const land: N = float(1).sub(under);
  const forest: N = trees.mul(float(1).sub(grass.mul(0.8)));
  let w: N[] = [
    forest.mul(float(1).sub(moss.mul(0.75))).mul(land), // needles
    forest.mul(moss.mul(0.75)).add(moss.mul(0.25).mul(float(1).sub(trees))).mul(land), // mossy litter
    grass.add(land.mul(0.12)).mul(land), // meadow soil
    peb.mul(1.2), // pebbles
    under.mul(float(1).sub(peb)).mul(0.55).add(sand.mul(0.4).mul(under)), // bed gravel
    wet.mul(float(1).sub(peb)).mul(0.9).add(sand.mul(under).mul(0.5)), // mud and silt
    path.mul(3), // path
  ];
  // height-aware blending: each layer's own relief (ao) decides who wins at a transition
  const hb = w.map((wi, i) => wi.add(L[i].ao.mul(0.55)));
  let top: N = hb[0];
  for (let i = 1; i < hb.length; i++) top = max(top, hb[i]);
  w = hb.map((v, i) => max(v.sub(top.sub(0.32)), 0).mul(smoothstep(0.001, 0.05, w[i])));
  let wsum: N = float(0.0001);
  for (const wi of w) wsum = wsum.add(wi);
  let gA: N = vec3(0), gN: N = vec2(0), gR: N = float(0), gAO: N = float(0);
  for (let i = 0; i < L.length; i++) {
    const k: N = w[i].div(wsum);
    gA = gA.add(L[i].a.mul(k));
    gN = gN.add(L[i].n.mul(k));
    gR = gR.add(L[i].r.mul(k));
    gAO = gAO.add(L[i].ao.mul(k));
  }
  // ground normal: udn blend onto the terrain normal (tangent x = +x, tangent y = +v = +z)
  const gNw: N = normalize(vec3(Ng.x.add(gN.x), Ng.y, Ng.z.add(gN.y)));

  // ---------- rock (triplanar, strata along +y on the walls) ----------
  const bw: N = pow(abs(Ng), vec3(4));
  const bwn: N = bw.div(bw.x.add(bw.y).add(bw.z));
  const tri = (i: number) => {
    const sc = ROCK_SCALE[i];
    const ux: N = vec2(p.z, p.y).div(sc), uy: N = p.xz.div(sc).add(0.5), uz: N = vec2(p.x, p.y).div(sc).add(0.25);
    const li = int(ROCK_BASE + i);
    const ax: N = texture(t.albedo, ux).depth(li), ay: N = texture(t.albedo, uy).depth(li), az: N = texture(t.albedo, uz).depth(li);
    const sx: N = texture(t.layerSurface, ux).depth(li), sy: N = texture(t.layerSurface, uy).depth(li), sz: N = texture(t.layerSurface, uz).depth(li);
    const tn = (s: N) => vec2(s.r.mul(2).sub(1), s.g.mul(2).sub(1).negate());
    const tx: N = tn(sx), ty: N = tn(sy), tz: N = tn(sz);
    // udn per projection; tangent y is +v (the green channel is flipped because arrays upload top row first)
    const wx: N = vec3(Ng.x, tx.y.add(Ng.y), tx.x.add(Ng.z));
    const wy: N = vec3(ty.x.add(Ng.x), Ng.y, ty.y.add(Ng.z));
    const wz: N = vec3(tz.x.add(Ng.x), tz.y.add(Ng.y), Ng.z);
    const n: N = normalize(wx.mul(bwn.x).add(wy.mul(bwn.y)).add(wz.mul(bwn.z)));
    const a: N = ax.rgb.mul(bwn.x).add(ay.rgb.mul(bwn.y)).add(az.rgb.mul(bwn.z));
    const s: N = sx.mul(bwn.x).add(sy.mul(bwn.y)).add(sz.mul(bwn.z));
    return { a, n, r: s.b, ao: s.a };
  };
  const R0 = tri(0), R1 = tri(1);
  // dark layered rock on the steep walls, mossy rock on outcrops and gentler faces
  const wallness: N = smoothstep(0.62, 0.3, Ng.y).mul(float(1).sub(moss.mul(0.5)));
  const rA: N = mix(R0.a, R1.a.mul(1.25), wallness);
  const rN: N = normalize(mix(R0.n, R1.n, wallness));
  const rR: N = mix(R0.r, R1.r, wallness), rAO: N = mix(R0.ao, R1.ao, wallness);
  // moss creeps over upward faces of damp rock
  const mossOnRock: N = smoothstep(0.25, 0.75, moss.add(macro.mul(0.4)).sub(0.2)).mul(smoothstep(0.35, 0.8, rN.y));
  const rockA: N = mix(rA, vec3(0.09, 0.13, 0.04), mossOnRock.mul(0.75)).mul(terrainTuning.uRockBright);
  const steep: N = smoothstep(0.66, 0.46, Ng.y);
  let rw: N = clamp(max(rockM, steep), 0, 1);
  rw = smoothstep(0.35, 0.65, rw.add(rAO.sub(gAO).mul(0.35)));

  let alb: N = mix(gA, rockA, rw);
  const nW: N = normalize(mix(gNw, rN, rw));
  let rough: N = mix(gR, rR, rw);
  const occl: N = mix(gAO, rAO, rw);

  // macro color variation: dry/lush drift on ground, light/dark banding on rock
  alb = alb.mul(mix(float(0.86), float(1.12), macro));
  alb = mix(alb, alb.mul(vec3(1.06, 1.0, 0.86)), n1.b.mul(0.35).mul(float(1).sub(rw)));
  // edges and ridges are worn lighter, hollows darker
  alb = alb.mul(float(1).add(cvx.mul(0.35)));

  // under grass the ground takes the grass field's mean color (reads as the canopy from afar)
  const veg: N = vegetationFieldNode(p.xz) as N;
  const vegK: N = clamp(veg.r.mul(1.6), 0, 1).mul(terrainTuning.uVegGround).mul(float(1).sub(rw)).mul(land);
  alb = mix(alb, vegetationGroundAlbedo(p) as N, vegK);

  // wet banks: darker, glossier just above the waterline
  const wetK: N = max(max(smoothstep(0.45, 0.02, p.y).mul(land), wet.mul(0.6)), uWet.mul(0.7).mul(land)).mul(float(1).sub(rw.mul(0.3)));
  alb = mix(alb, alb.mul(terrainTuning.uWetDark), wetK);
  rough = mix(rough, rough.mul(0.35), wetK);
  // the river bed: saturated and darker (always wet), sunlit caustics in the shallows
  const bed: N = under;
  alb = mix(alb, alb.mul(vec3(0.62, 0.66, 0.6)).mul(terrainTuning.uBedDark.add(0.3)), bed);
  rough = mix(rough, float(0.55), bed);
  const caus: N = causticsNode(p, nW) as N;
  alb = alb.mul(float(1).add(caus.mul(bed)));

  m.colorNode = vec4((clamp as any)(alb, 0, 0.85), 1);
  m.normalNode = normalize(cameraViewMatrix.mul(vec4(nW, 0)).xyz);
  m.roughnessNode = clamp(rough, 0.05, 1);
  m.metalnessNode = float(0);
  m.aoNode = mix(float(1), occl, 0.75).mul(pow(clamp(sky, 0, 1), float(1.15)));
  void dot;
  return m;
}

/** boulders and rock meshes: the terrain's rock layers in world-space triplanar, moss on top faces */
export function createRockMaterial(t: TerrainTextures) {
  const m = new MeshStandardNodeMaterial();
  const p: N = positionWorld;
  const Ng: N = normalize(normalWorldGeometry);
  const wuv: N = p.xz.div(t.size).add(0.5);
  const mB: N = texture(t.masks, wuv).depth(int(1));
  const noise = (uv: N): N => texture(t.layerSurface, uv).depth(int(NOISE_LAYER));
  const n1: N = noise(p.xz.div(23)), n2: N = noise(p.xz.div(3.1).add(vec2(p.y.mul(0.21), 0)));
  const bw: N = pow(abs(Ng), vec3(4));
  const bwn: N = bw.div(bw.x.add(bw.y).add(bw.z));
  const li = int(ROCK_BASE);
  const sc = 2.4;
  const ux: N = vec2(p.z, p.y).div(sc), uy: N = p.xz.div(sc).add(0.5), uz: N = vec2(p.x, p.y).div(sc).add(0.25);
  const ax: N = texture(t.albedo, ux).depth(li), ay: N = texture(t.albedo, uy).depth(li), az: N = texture(t.albedo, uz).depth(li);
  const sx: N = texture(t.layerSurface, ux).depth(li), sy: N = texture(t.layerSurface, uy).depth(li), sz: N = texture(t.layerSurface, uz).depth(li);
  const tn = (s: N) => vec2(s.r.mul(2).sub(1), s.g.mul(2).sub(1).negate());
  const tx: N = tn(sx), ty: N = tn(sy), tz: N = tn(sz);
  const wx: N = vec3(Ng.x, tx.y.add(Ng.y), tx.x.add(Ng.z));
  const wy: N = vec3(ty.x.add(Ng.x), Ng.y, ty.y.add(Ng.z));
  const wz: N = vec3(tz.x.add(Ng.x), tz.y.add(Ng.y), Ng.z);
  const nW: N = normalize(wx.mul(bwn.x).add(wy.mul(bwn.y)).add(wz.mul(bwn.z)));
  let alb: N = ax.rgb.mul(bwn.x).add(ay.rgb.mul(bwn.y)).add(az.rgb.mul(bwn.z));
  const srf: N = sx.mul(bwn.x).add(sy.mul(bwn.y)).add(sz.mul(bwn.z));
  let rough: N = srf.b;
  // per-boulder tone drift, moss on the upward faces where the ground is damp
  alb = alb.mul(mix(float(0.82), float(1.15), n1.r)).mul(terrainTuning.uRockBright);
  const mossK: N = smoothstep(0.2, 0.7, mB.g.mul(0.8).add(n2.r.mul(0.5)).add(0.15)).mul(smoothstep(0.35, 0.85, nW.y)).mul(smoothstep(0.1, 0.6, p.y));
  alb = mix(alb, mix(vec3(0.07, 0.11, 0.03), vec3(0.16, 0.2, 0.06), n2.g), mossK.mul(0.85));
  rough = mix(rough, float(0.9), mossK);
  // wet at the waterline, dark and saturated below it
  const wetK: N = smoothstep(0.55, 0.0, p.y);
  alb = mix(alb, alb.mul(0.55), wetK);
  rough = mix(rough, rough.mul(0.3), wetK.mul(smoothstep(-0.3, 0.1, p.y)));
  const under: N = smoothstep(0.02, -0.25, p.y);
  alb = mix(alb, alb.mul(vec3(0.6, 0.66, 0.6)), under);
  alb = alb.mul(float(1).add((causticsNode(p, nW) as N).mul(under)));
  m.colorNode = vec4((clamp as any)(alb, 0, 0.85), 1);
  m.normalNode = normalize(cameraViewMatrix.mul(vec4(nW, 0)).xyz);
  m.roughnessNode = clamp(rough, 0.05, 1);
  m.metalnessNode = float(0);
  m.aoNode = mix(float(1), srf.a, 0.8);
  return m;
}
