// pbr materials for bridges and river works (tsl only). poly haven sets are remapped to physically
// plausible linear albedo targets carried per part in aTint, then weathered: vermilion lacquer fades
// on sun-facing faces, streaks under horizontals and chips at the chamfers down to black undercoat;
// timber silvers; stone takes moss and lichen on its tops. everything near the river gets one shared
// waterline treatment: damp splash zone, algae band, silt below, caustics under water.
import { DoubleSide, MeshStandardNodeMaterial, type Texture } from 'three/webgpu';
import {
  abs, attribute, clamp, dot, float, fract, luminance, max, mix, mx_noise_float, normalMap, normalWorld,
  positionWorld, smoothstep, texture, uv, vec2, vec3,
} from 'three/tsl';
import type { GameContext } from '../core/context';
import { uSunDir } from '../core/uniforms';
import { causticsNode } from '../water/caustics';
import { LAMP_GAIN, flicker, lampColor, lampLevel } from '../structures/night';

// tsl graphs are loosely typed here; @types/three generics do not model mixed swizzles well
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const BASE = '/assets/bridges/';

interface TexSet {
  map: Texture;
  nor: Texture;
  arm: Texture;
  /** meters per texture tile */
  size: number;
  /** linear luminance of the diffuse average (measured offline, 64x64 box, linearised) */
  avgL: number;
}

async function loadSet(ctx: GameContext, id: string, res: string, size: number, avgL: number): Promise<TexSet> {
  const dir = `${BASE}${id}/${id}_`;
  const [map, nor, arm] = await Promise.all([
    ctx.assets.texture(`${dir}diffuse_${res}.jpg`, { srgb: true }),
    ctx.assets.texture(`${dir}nor_gl_${res}.jpg`, { srgb: false }),
    ctx.assets.texture(`${dir}arm_${res}.jpg`, { srgb: false }),
  ]);
  return { map, nor, arm, size, avgL };
}

const aTint = attribute('aTint', 'vec3');
const aVar = attribute('aVar', 'vec4');

/** damp splash zone, algae at the waterline, silt film below, caustics under water */
function waterline(albedo: Node, rough: Node, caustics: boolean): { albedo: Node; rough: Node } {
  const p = positionWorld;
  const y = p.y;
  const n = mx_noise_float(p.mul(vec3(0.8, 2.2, 0.8)));
  const wet = float(1).sub(smoothstep(0.02, n.mul(0.14).add(0.36), y));
  const band = smoothstep(-0.75, -0.1, y).mul(float(1).sub(smoothstep(0.0, n.mul(0.07).add(0.14), y)));
  const deep = float(1).sub(smoothstep(-1.4, -0.35, y));
  const patch = clamp(n.mul(0.8).add(0.75), 0, 1);
  let a: Node = albedo.mul(mix(float(1), float(0.5), wet));
  a = mix(a, vec3(0.03, 0.045, 0.016), clamp(band.mul(0.85).add(deep.mul(0.45)), 0, 1).mul(patch));
  // thin dark tide line where the surface ripples wet the wood / stone
  const line = smoothstep(0.03, 0.09, y).mul(float(1).sub(smoothstep(0.1, 0.2, y)));
  a = a.mul(float(1).sub(line.mul(0.25)));
  if (caustics) a = a.mul(float(1).add(causticsNode(positionWorld, normalWorld) as Node));
  const r = mix(mix(rough, float(0.22), wet.mul(float(1).sub(deep))), float(0.6), band.mul(patch).mul(0.6));
  return { albedo: a, rough: r };
}

/** world-space macro brightness variation, breaks texture repetition on long runs */
function macro(amount: number): Node {
  const m = mx_noise_float(positionWorld.mul(0.21).add(aVar.y.mul(3.1)));
  return m.mul(amount).add(1);
}

export interface BridgeMats {
  lacquer: MeshStandardNodeMaterial;
  timber: MeshStandardNodeMaterial;
  stone: MeshStandardNodeMaterial;
  /** null until the covered bridge needs it */
  roof: MeshStandardNodeMaterial | null;
  bronze: MeshStandardNodeMaterial;
  paper: MeshStandardNodeMaterial;
  plain: MeshStandardNodeMaterial;
}

/** the shingle roof only the covered bridge uses: its textures load when that bridge is built */
export async function createRoofMaterial(ctx: GameContext) {
  const shingle = await loadSet(ctx, 'grey_roof_01', '1k', 4.0, 0.0973);
  const roof = new MeshStandardNodeMaterial();
  const uvS = uv().div(shingle.size);
  const tex = texture(shingle.map, uvS).rgb;
  const arm = texture(shingle.arm, uvS);
  const ratio = clamp(luminance(tex).div(shingle.avgL), 0.2, 2.4);
  let a: Node = aTint.mul(ratio);
  a = a.mul(macro(0.18));
  const mN = mx_noise_float(positionWorld.mul(0.9));
  const moss = smoothstep(0.25, 0.7, mN).mul(0.55).mul(aVar.z);
  a = mix(a, vec3(0.05, 0.068, 0.024), moss);
  roof.colorNode = a;
  roof.roughnessNode = clamp(arm.g.mul(0.3).add(0.62), 0.5, 0.98);
  roof.metalnessNode = float(0);
  roof.aoNode = arm.r;
  roof.normalNode = normalMap(texture(shingle.nor, uvS), vec2(1.2));
  return roof;
}

/** every bridge material but the shingle roof, which starts null (see createRoofMaterial) */
export async function createMaterials(ctx: GameContext): Promise<BridgeMats> {
  const [wood, rock] = await Promise.all([
    loadSet(ctx, 'rough_wood', '2k', 0.62, 0.1273),
    loadSet(ctx, 'rock_boulder_dry', '2k', 1.6, 0.3432),
  ]);
  const caustics = ctx.quality.caustics;

  // ---- vermilion lacquer over a black undercoat on timber ----
  const lacquer = new MeshStandardNodeMaterial();
  {
    const uvS = uv().div(wood.size);
    const tex = texture(wood.map, uvS).rgb;
    const arm = texture(wood.arm, uvS);
    const grain = clamp(luminance(tex).div(wood.avgL), 0.45, 1.8);
    const p = positionWorld;
    const up = normalWorld.y;
    const seed = aVar.y.mul(19.7);
    const streakN = mx_noise_float(vec3(p.x.mul(2.3), p.y.mul(0.42), p.z.mul(2.3)).add(seed));
    const chipN = mx_noise_float(p.mul(8.5).add(seed)).mul(0.65).add(mx_noise_float(p.mul(27)).mul(0.35));
    let col: Node = aTint.mul(grain.sub(1).mul(0.14).add(1));
    // sun fade: tops go chalky and orange
    const fade = clamp(smoothstep(0.3, 0.95, up).mul(0.75).add(streakN.mul(0.12)), 0, 1);
    col = mix(col, vec3(0.6, 0.2, 0.1), fade.mul(0.12));
    // grime running down vertical faces, heavier low on each member
    const side = float(1).sub(abs(up));
    const streak = smoothstep(0.05, 0.75, streakN).mul(side).mul(0.06);
    col = col.mul(float(1).sub(streak));
    // clean, well-kept lacquer: no chipping to black undercoat or bare timber (it read as dirt)
    const chip = float(0), bare = float(0);
    void chipN;
    lacquer.colorNode = col;
    lacquer.roughnessNode = clamp(
      mix(arm.g.mul(0.12).add(0.3), float(0.62), fade.mul(0.55)).add(streak.mul(0.5)).add(chip.mul(0.25)).add(bare.mul(0.2)),
      0.2, 0.95,
    );
    lacquer.metalnessNode = float(0);
    lacquer.normalNode = normalMap(texture(wood.nor, uvS), vec2(mix(float(0.22), float(1), max(chip, bare))));
  }

  // ---- weathered timber: tint is the target albedo, aVar.x silvers it, aVar.z grows moss on tops ----
  const timber = new MeshStandardNodeMaterial();
  {
    const uvS = uv().div(wood.size);
    const tex = texture(wood.map, uvS).rgb;
    const arm = texture(wood.arm, uvS);
    const lum = luminance(tex);
    const ratio = clamp(lum.div(wood.avgL), 0.15, 2.6).pow(1.15);
    let a: Node = mix(aTint.mul(ratio), tex.mul(luminance(aTint).div(wood.avgL)), 0.2);
    const grey = vec3(luminance(a).mul(1.25)).mul(vec3(1.0, 0.98, 0.94));
    a = mix(a, grey, aVar.x.mul(0.7));
    a = a.mul(macro(0.14));
    // moss / lichen on up-facing, long-exposed timber
    const up = smoothstep(0.45, 0.95, normalWorld.y);
    const mossN = mx_noise_float(positionWorld.mul(1.7).add(aVar.y.mul(9)));
    const moss = smoothstep(0.1, 0.55, mossN.add(aVar.z.mul(0.7)).sub(0.45)).mul(up).mul(aVar.z);
    a = mix(a, vec3(0.05, 0.07, 0.022), moss);
    let r: Node = clamp(arm.g.mul(0.3).add(0.62), 0.45, 0.98);
    const w = waterline(a, r, caustics);
    timber.colorNode = w.albedo;
    timber.roughnessNode = w.rough;
    timber.metalnessNode = float(0);
    timber.aoNode = mix(float(1), arm.r, 0.9);
    timber.normalNode = normalMap(texture(wood.nor, uvS), vec2(1.1));
  }

  // ---- cut granite ----
  const stone = new MeshStandardNodeMaterial();
  {
    const uvS = uv().div(rock.size);
    const tex = texture(rock.map, uvS).rgb;
    const arm = texture(rock.arm, uvS);
    const ratio = clamp(luminance(tex).div(rock.avgL), 0.2, 2.2).pow(1.05);
    let a: Node = mix(aTint.mul(ratio), tex.mul(luminance(aTint).div(rock.avgL)), 0.18);
    a = a.mul(macro(0.16));
    const up = normalWorld.y;
    const mN = mx_noise_float(positionWorld.mul(1.35).add(aVar.y.mul(7)));
    // moss: tops and joints (chamfers) of stones, strongest in damp spots near the river
    const damp = float(1).sub(smoothstep(0.4, 2.2, positionWorld.y));
    const where = max(smoothstep(0.35, 0.9, up), aVar.w.mul(0.55)).mul(aVar.z.add(damp.mul(0.35)));
    const moss = smoothstep(0.0, 0.45, mN.add(0.2).mul(where)).mul(smoothstep(-0.25, 0.1, positionWorld.y));
    a = mix(a, mix(vec3(0.045, 0.065, 0.02), vec3(0.08, 0.095, 0.035), mN.mul(0.5).add(0.5)), moss);
    // pale lichen rosettes on dry faces
    const lichen = smoothstep(0.62, 0.7, mx_noise_float(positionWorld.mul(4.1))).mul(float(1).sub(damp)).mul(0.5);
    a = mix(a, vec3(0.42, 0.42, 0.36), lichen);
    const r: Node = mix(clamp(arm.g.mul(0.35).add(0.55), 0.4, 0.98), float(0.9), moss);
    const w = waterline(a, r, caustics);
    stone.colorNode = w.albedo;
    stone.roughnessNode = w.rough;
    stone.metalnessNode = float(0);
    stone.aoNode = mix(float(1), arm.r, 0.9);
    stone.normalNode = normalMap(texture(rock.nor, uvS), vec2(mix(float(1.25), float(0.5), moss)));
  }

  // ---- old bronze (giboshi finials): dark metal with verdigris running down ----
  const bronze = new MeshStandardNodeMaterial();
  {
    const p = positionWorld;
    const n = mx_noise_float(vec3(p.x.mul(9), p.y.mul(3), p.z.mul(9)));
    const pat = smoothstep(0.0, 0.5, n.add(normalWorld.y.mul(0.25)));
    bronze.colorNode = mix(vec3(0.42, 0.27, 0.12), vec3(0.15, 0.3, 0.24), pat);
    bronze.metalnessNode = mix(float(0.95), float(0.05), pat);
    bronze.roughnessNode = mix(float(0.36), float(0.72), pat);
  }

  // ---- washi paper lantern: bamboo ribs from uv.v, sunlight glowing through the far side ----
  const paper = new MeshStandardNodeMaterial();
  {
    const rib = smoothstep(0.35, 0.5, abs(fract(uv().y.mul(26)).sub(0.5)));
    const base = vec3(0.82, 0.78, 0.68).mul(aTint);
    paper.colorNode = base.mul(float(1).sub(rib.mul(0.35)));
    paper.roughnessNode = float(0.88);
    paper.metalnessNode = float(0);
    const back = max(dot(normalWorld, uSunDir).negate(), 0);
    // lit from inside at night, each lantern flickering on its own part seed (aVar.y)
    const night = lampColor(base).mul(lampLevel.mul(flicker(aVar.y)).mul(LAMP_GAIN));
    paper.emissiveNode = base.mul(back.mul(0.5).add(0.12)).add(night).mul(float(1).sub(rib.mul(0.6)));
    paper.side = DoubleSide;
  }

  // ---- plain: colour from aTint, roughness from aVar.x, metalness from aVar.z (rims, iron, rope) ----
  const plain = new MeshStandardNodeMaterial();
  plain.colorNode = aTint;
  plain.roughnessNode = aVar.x;
  plain.metalnessNode = aVar.z;

  return { lacquer, timber, stone, roof: null, bronze, paper, plain };
}
