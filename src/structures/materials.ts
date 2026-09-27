// pbr materials for the hanakawa buildings (tsl only). poly haven sets are re-coloured toward
// physically plausible linear albedo targets and layered with per-part tint (aCol), world-space
// macro variation, ground grime and a waterline layer (wet band, algae, caustics). kawara tiles,
// namako walls, shoji paper and paper lanterns are procedural.
import { DoubleSide, MeshStandardNodeMaterial, type Texture } from 'three/webgpu';
import {
  attribute, clamp, float, luminance, mix, mx_noise_float, normalMap, positionWorld, normalWorld, smoothstep,
  texture, uv, vec2, vec3, vec4, fract, abs, min, max, sin, cos, step, floor, pow, hash, fwidth, TBNViewMatrix,
  normalize, cameraPosition, cameraViewMatrix, dot, positionLocal,
} from 'three/tsl';
import type { GameContext } from '../core/context';
import type { RGB } from './geom';
import { causticsNode } from '../water/caustics';
import { uTime } from '../core/uniforms';
import { FIRE_GAIN, FIRE_RGB, LAMP_GAIN, WINDOW_GAIN, WINDOW_RGB, flicker, lampColor, lampLevel, windowOn } from './night';

// tsl node graphs are loosely typed here; @types/three generics do not model mixed swizzles well
type Node = any;

const BASE = '/assets/structures/';

export interface TexSet {
  map: Texture;
  nor: Texture;
  arm: Texture;
  /** meters covered by one texture tile */
  size: number;
  /** linear average albedo of the diffuse map (measured offline) */
  avg: RGB;
}

// averages measured from the downloaded diffuse maps (64x64 box, linearised)
const SETS: Record<string, { res: string; size: number; avg: RGB }> = {
  japanese_cedar_planks: { res: '2k', size: 2.6, avg: [0.413, 0.121, 0.003] },
  weathered_planks: { res: '1k', size: 2.8, avg: [0.08, 0.057, 0.043] },
  wood_planks_grey: { res: '2k', size: 1.5, avg: [0.061, 0.058, 0.051] },
  painted_plaster_wall: { res: '2k', size: 2.6, avg: [0.407, 0.365, 0.35] },
  japanese_stone_wall: { res: '2k', size: 3.6, avg: [0.202, 0.187, 0.159] },
  rock_surface: { res: '1k', size: 1.6, avg: [0.158, 0.118, 0.083] },
  bamboo_wall: { res: '1k', size: 1.6, avg: [0.234, 0.146, 0.086] },
  rough_linen: { res: '1k', size: 0.8, avg: [0.284, 0.407, 0.613] },
};

/** board centers (meters, along u) for plank textures, so a sawn part samples a single board */
export const BOARDS = {
  grey: [0.144, 0.435, 0.726, 1.014, 1.33],
  timber: [0.322, 0.63, 0.94, 1.26, 1.57, 1.89, 2.2, 2.5],
};

async function loadSet(ctx: GameContext, id: string): Promise<TexSet> {
  const s = SETS[id];
  const dir = `${BASE}${id}/${id}_`;
  const [map, nor, arm] = await Promise.all([
    ctx.assets.texture(`${dir}diffuse_${s.res}.jpg`, { srgb: true }),
    ctx.assets.texture(`${dir}nor_gl_${s.res}.jpg`, { srgb: false }),
    ctx.assets.texture(`${dir}arm_${s.res}.jpg`, { srgb: false }),
  ]);
  return { map, nor, arm, size: s.size, avg: s.avg };
}

export interface SurfOpts {
  target: RGB;
  keep?: number;
  contrast?: number;
  normal?: number;
  rough?: [number, number];
  metal?: number;
  marine?: boolean;
  grime?: boolean;
  macro?: number;
  double?: boolean;
}

const aCol = attribute('aCol', 'vec3');
const aVar = attribute('aVar', 'vec4');
const lum = (c: RGB) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;

/** wet band / algae / caustics for anything standing in the river */
function marine(albedo: Node, rough: Node, withCaustics: boolean): { albedo: Node; rough: Node } {
  const p = positionWorld;
  const y = p.y;
  const n1 = mx_noise_float(p.mul(vec3(0.7, 1.6, 0.7)));
  const n2 = mx_noise_float(p.mul(vec3(3.1, 5.0, 3.1)));
  const wet = float(1).sub(smoothstep(0.02, n1.mul(0.12).add(0.35), y));
  const band = float(1).sub(smoothstep(-0.25, n1.mul(0.08).add(0.1), y));
  const patch = clamp(n2.mul(0.9).add(0.6), 0, 1);
  const deep = float(1).sub(smoothstep(-2.0, -0.5, y));
  const algae = band.mul(patch).mul(mix(float(0.9), float(0.55), deep));
  const weed = mix(vec3(0.03, 0.04, 0.018), vec3(0.045, 0.06, 0.03), deep);
  let a: Node = albedo.mul(mix(float(1), float(0.5), wet));
  a = mix(a, weed, algae);
  if (withCaustics) {
    const c: Node = causticsNode(positionWorld, normalWorld);
    a = a.mul(float(1).add(c));
  }
  const r = mix(mix(rough, float(0.22), wet), float(0.6), algae);
  return { albedo: a, rough: r };
}

export function surface(ctx: GameContext, set: TexSet, o: SurfOpts): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  const uvS = uv().div(set.size);
  const tex = texture(set.map, uvS).rgb;
  const arm = texture(set.arm, uvS);
  const avgL = lum(set.avg);
  const tgt = vec3(...o.target);
  const ratio = pow(max(luminance(tex).div(avgL), 0.02), float(o.contrast ?? 1));
  let albedo: Node = mix(tgt.mul(ratio), tex.mul(lum(o.target) / avgL), float(o.keep ?? 0.25));
  albedo = albedo.mul(aCol);
  const macro = o.macro ?? 0.12;
  if (macro > 0) {
    const mn = mx_noise_float(positionWorld.mul(0.23)).mul(0.6).add(mx_noise_float(positionWorld.mul(1.1)).mul(0.4));
    albedo = albedo.mul(mn.mul(macro).add(1));
  }
  const [r0, r1] = o.rough ?? [0.15, 0.85];
  let rough: Node = clamp(arm.g.mul(r1).add(r0), 0.04, 1);
  if (o.grime) {
    const p = positionWorld;
    const baseY = aVar.z;
    const gn = mx_noise_float(p.mul(vec3(1.7, 0.9, 1.7)));
    const splash = float(1).sub(smoothstep(baseY, baseY.add(gn.mul(0.15).add(0.45)), p.y)).mul(aVar.x);
    const streak = smoothstep(0.3, 0.85, mx_noise_float(vec3(p.x.mul(5.5), p.y.mul(0.3), p.z.mul(5.5)))).mul(0.08).mul(aVar.x);
    albedo = albedo.mul(float(1).sub(splash.mul(0.3)).sub(streak));
    albedo = mix(albedo, vec3(0.16, 0.14, 0.1), splash.mul(0.2));
  }
  if (o.marine) {
    const mm = marine(albedo, rough, ctx.quality.caustics);
    albedo = mm.albedo;
    rough = mm.rough;
  }
  m.colorNode = albedo;
  m.roughnessNode = rough;
  m.metalnessNode = float(o.metal ?? 0);
  m.aoNode = mix(float(1), arm.r, 0.8);
  m.normalNode = normalMap(texture(set.nor, uvS), vec2(o.normal ?? 1));
  if (o.double) m.side = DoubleSide;
  return m;
}

/** painted or lacquered timber: grain relief from a plank set, colour from aCol, worn where aVar.w > 0 */
export function paintedWood(ctx: GameContext, set: TexSet, gloss = 0.45): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  const uvS = uv().div(set.size);
  const tex = texture(set.map, uvS).rgb;
  const arm = texture(set.arm, uvS);
  const lr = clamp(luminance(tex).div(lum(set.avg)), 0.3, 2.2);
  const paint = aCol.mul(lr.sub(1).mul(0.1).add(1)).mul(mx_noise_float(positionWorld.mul(0.9)).mul(0.08).add(1));
  const chipN = mx_noise_float(positionWorld.mul(7.5)).add(mx_noise_float(positionWorld.mul(23)).mul(0.35));
  const chip = smoothstep(0.7, 0.76, chipN.mul(0.5).add(0.5).add(aVar.w.mul(0.16)).sub(0.14)).mul(step(0.001, aVar.w));
  const wood = tex.mul(1.2).mul(vec3(0.5, 0.42, 0.36));
  m.colorNode = mix(paint, wood, chip);
  m.roughnessNode = mix(clamp(arm.g.mul(0.3).add(gloss), 0.2, 0.95), float(0.85), chip);
  m.metalnessNode = float(0);
  m.normalNode = normalMap(texture(set.nor, uvS), vec2(mix(float(0.3), float(1), chip)));
  void ctx;
  return m;
}

/**
 * kawara: smoked grey clay roof tiles in rows running down the slope. uv is in meters with u across
 * the slope (along the eave) and v up the slope. relief is analytic (roll-and-pan profile, course
 * steps) and fades to the average normal once rows get smaller than a pixel.
 */
export function kawara(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  const P = 0.27, C = 0.235;
  const u = uv().x, v = uv().y;
  const xr = u.div(P), yc = v.div(C);
  const x = fract(xr), y = fract(yc);
  // the pattern fades per axis once a roll or a course spans fewer than ~8 pixels (foreshortened
  // courses go first on grazing roofs), and it fades toward its own average so tone and gloss never
  // change with distance: no crawl while moving, no visible swap as a roof comes closer
  const fx = float(1).sub(smoothstep(0.1, 0.3, fwidth(xr)));
  const fy = float(1).sub(smoothstep(0.1, 0.3, fwidth(yc)));
  const fxy = fx.mul(fy);
  // roll at x = 0, wide pan between: h in 0..1
  const s = abs(sin(x.mul(Math.PI)));
  const h = float(1).sub(pow(s, float(1.4)));
  const dhdx = pow(s, float(0.4)).mul(cos(x.mul(Math.PI))).mul(-1.4 * Math.PI).mul(sin(x.mul(Math.PI)).sign());
  // course step: each tile's lower edge laps over the one below
  const lap = smoothstep(0.0, 0.1, y);
  const dhdy = float(1).sub(lap).mul(3.5);
  const nts = normalize(vec3(dhdx.mul(fx).mul(0.35).negate(), dhdy.mul(fy).mul(0.6).negate(), 1));
  m.normalNode = (TBNViewMatrix as Node).mul(nts).normalize();
  const id = floor(xr).add(floor(yc).mul(57.0));
  const r = hash(id);
  const r2 = hash(id.add(13.1));
  let col: Node = vec3(0.058, 0.064, 0.074).mul(mix(float(0.995), r.mul(0.35).add(0.82), fxy));
  // a few lighter, weathered tiles and a warm dusty cast in the pans
  col = mix(col, vec3(0.1, 0.1, 0.1), step(0.93, r2).mul(0.7).mul(fxy));
  const cavity = mix(float(0.8), h.mul(0.35).add(0.65), fx);
  const lapAO = mix(float(0.98), lap.mul(0.35).add(0.65), fy);
  col = col.mul(cavity).mul(lapAO).mul(aCol);
  const lich = smoothstep(0.62, 0.8, mx_noise_float(positionWorld.mul(0.9)).mul(0.5).add(0.5)).mul(0.35);
  col = mix(col, vec3(0.1, 0.105, 0.085), lich);
  m.colorNode = col;
  m.roughnessNode = mix(float(0.59), mix(float(0.42), float(0.72), float(1).sub(h)), fx).add(lich.mul(0.2));
  m.metalnessNode = float(0.08);
  return m;
}

/** namako-kabe: black square tiles set diagonally with raised white plaster joints (kura walls) */
export function namako(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  const T = 0.2;
  const q = vec2(uv().x.add(uv().y), uv().x.sub(uv().y)).div(T * Math.SQRT2);
  const g = fract(q);
  const dx = min(g.x, float(1).sub(g.x)), dy = min(g.y, float(1).sub(g.y));
  const d = min(dx, dy);
  const joint = float(1).sub(smoothstep(0.06, 0.1, d));
  const fw = fwidth(q.x);
  const fade = float(1).sub(smoothstep(0.2, 0.6, fw));
  // rounded bead profile across the joint
  const sx = step(dy, dx);
  const gdir = mix(vec2(0, float(0.5).sub(g.y).sign()), vec2(float(0.5).sub(g.x).sign(), 0), sx);
  const slope = float(1).sub(smoothstep(0.02, 0.1, d)).mul(joint).mul(fade).mul(2.2);
  const tiltUV = vec2(gdir.x.add(gdir.y), gdir.x.sub(gdir.y)).mul(slope).mul(-1);
  m.normalNode = (TBNViewMatrix as Node).mul(normalize(vec3(tiltUV.x, tiltUV.y, 1))).normalize();
  const id = hash(floor(q.x).add(floor(q.y).mul(31)));
  const tile = vec3(0.028, 0.03, 0.034).mul(id.mul(0.4).add(0.8));
  const plasterC = vec3(0.66, 0.64, 0.57);
  m.colorNode = mix(tile, plasterC, joint.mul(fade).add(float(1).sub(fade).mul(0.22))).mul(aCol);
  m.roughnessNode = mix(float(0.35), float(0.8), joint);
  m.metalnessNode = float(0);
  return m;
}

/** shoji paper behind lattices: warm paper with a kumiko grid; aCol tints the paper */
export function shoji(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  const g = fract(uv().div(vec2(0.3, 0.36)));
  const bar = max(step(g.x, 0.05), step(g.y, 0.045));
  const fade = float(1).sub(smoothstep(0.1, 0.35, max(fwidth(uv().x.div(0.3)), fwidth(uv().y.div(0.36)))));
  const paper = aCol.mul(mx_noise_float(positionWorld.mul(4)).mul(0.04).add(0.97));
  // far away the kumiko fades to its average cover, not to bare paper
  const cover = mix(float(0.084), bar.mul(0.9), fade);
  m.colorNode = mix(paper, vec3(0.2, 0.15, 0.1), cover);
  m.roughnessNode = float(0.92);
  m.metalnessNode = float(0);
  // paper glows faintly with light passing through from the far side; at night some rooms are lit
  // (aVar.w = per-panel hash, see Site.add)
  const lit = vec3(...WINDOW_RGB).mul(windowOn(aVar.w).mul(WINDOW_GAIN)).mul(float(1).sub(cover));
  m.emissiveNode = paper.mul(0.04).mul(float(1).sub(bar.mul(fade))).add(lit);
  return m;
}

/** candle-warm light seen through lantern paper (multiplies the paper colour) */
export const GLOW_TINT: RGB = [1.0, 0.8, 0.52];
/** aVar.w glow values authored before the lanterns were lit are scaled by this */
export const GLOW_GAIN = 4.2;

/**
 * chochin paper lanterns: ribbed paper lit from inside. aVar = [flicker phase, night lamp 0..1, 0,
 * day glow strength]; Site.add fills the phase and marks every day-glowing lantern as a night lamp
 */
export function lanternPaper(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  // the 3 cm ribs fade to their average once they get smaller than a few pixels (no crawl)
  const rib = mix(float(0.2), smoothstep(0.75, 0.95, abs(sin(uv().y.mul(Math.PI / 0.028)))), float(1).sub(smoothstep(0.15, 0.4, fwidth(uv().y.div(0.028)))));
  const paper = aCol.mul(float(1).sub(rib.mul(0.35)));
  m.colorNode = paper;
  m.roughnessNode = float(0.85);
  m.metalnessNode = float(0);
  const ribK = float(1).sub(rib.mul(0.6));
  const night = lampColor(paper).mul(aVar.y.mul(lampLevel).mul(flicker(aVar.x)).mul(LAMP_GAIN));
  m.emissiveNode = paper.mul(vec3(...GLOW_TINT)).mul(aVar.w.mul(GLOW_GAIN)).add(night).mul(ribK);
  m.side = DoubleSide;
  return m;
}

/**
 * koshi and other slatted screens as a box-filtered stripe pattern instead of sub-pixel slats, so
 * lattices stay calm while the camera moves. u (meters) runs across the slats. aCol = slat albedo,
 * aVar = [pitch m, slat fraction, gap brightness 0..1, 0]. the gap reads as paper or shade behind.
 */
export function koshiLattice(set: TexSet): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  const pitch = max(aVar.x, float(0.02));
  const duty = clamp(aVar.y, 0.05, 0.95);
  const x = uv().x.div(pitch);
  const w = max(fwidth(x), float(1e-4));
  // integral of the slat pulse train: floor(t) * duty + min(fract(t), duty)
  const P = (t: Node) => floor(t).mul(duty).add(min(fract(t), duty));
  const cov = clamp(P(x.add(w.mul(0.5))).sub(P(x.sub(w.mul(0.5)))).div(w), 0, 1);
  const fade = float(1).sub(smoothstep(0.35, 0.9, w));
  const grain = texture(set.map, vec2(uv().x.div(set.size).mul(0.35), uv().y.div(set.size))).rgb;
  const gr = clamp(luminance(grain).div(lum(set.avg)), 0.55, 1.6);
  const slat = aCol.mul(gr.sub(1).mul(0.5).add(1));
  // paper behind the lattice, dimmer toward the slat edges (contact shade)
  const t = fract(x).div(duty);
  const inSlat = step(fract(x), duty);
  const edge = smoothstep(0.0, 0.35, fract(x).sub(duty).div(float(1).sub(duty))).mul(float(1).sub(inSlat));
  const shade = mix(float(1), edge.mul(0.45).add(0.55), fade);
  const gap = vec3(0.62, 0.56, 0.44).mul(aVar.z).mul(shade);
  m.colorNode = mix(gap, slat, cov);
  // rounded slats: tilt the normal across each slat, fading out with the pattern
  const tilt = t.sub(0.5).mul(1.6).mul(inSlat).mul(fade);
  m.normalNode = (TBNViewMatrix as Node).mul(normalize(vec3(tilt, 0, 1))).normalize();
  m.roughnessNode = mix(float(0.9), float(0.6), cov);
  m.metalnessNode = float(0);
  // at night lit rooms glow through the gaps where there is paper behind (aVar.z) and the per-panel
  // hash in aVar.w switches the room on (Site.add fills it)
  const paperBehind = smoothstep(0.1, 0.3, aVar.z);
  const lit = vec3(...WINDOW_RGB).mul(windowOn(aVar.w).mul(paperBehind).mul(WINDOW_GAIN)).mul(shade);
  m.emissiveNode = gap.mul(0.05).add(lit).mul(float(1).sub(cov));
  return m;
}

/** clipped hedges, moss, tea rows: aCol leaf colour broken up by two scales of world noise */
export function foliage(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  const p = positionWorld;
  const n1 = mx_noise_float(p.mul(1.3)), n2 = mx_noise_float(p.mul(5.5)), n3 = mx_noise_float(p.mul(17));
  const leafy = n1.mul(0.16).add(n2.mul(0.14)).add(n3.mul(0.1)).add(1);
  // sun-bleached tops, darker undersides
  const up = normalWorld.y.mul(0.22).add(0.86);
  m.colorNode = aCol.mul(leafy).mul(up).mul(vec3(1, 1.02, 0.9).mul(smoothstep(-0.3, 0.6, n2).mul(0.1).add(0.95)));
  // lumpy leaf mass: bend the shading normal with a smooth world-space field
  const bend = vec3(mx_noise_float(p.mul(2.1).add(3.1)), mx_noise_float(p.mul(2.1).add(7.7)).mul(0.5), mx_noise_float(p.mul(2.1).add(11.3))).mul(0.55);
  m.normalNode = cameraViewMatrix.mul(vec4(normalize(normalWorld.add(bend)), 0)).xyz.normalize();
  m.roughnessNode = float(0.82);
  m.metalnessNode = float(0);
  return m;
}

/** flooded paddy and garden pond: still water over mud, mirroring the sky; aCol tints the bed,
 *  aVar.x > 0 plants young rice in rows (spring) */
export function stillWater(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  const p = positionWorld;
  // rows of seedlings a hand apart, each tuft nudged off the grid; the pattern hands over to its
  // average tint while a tuft is still several pixels wide, so it never reads as a dot matrix
  const g = vec2(p.x, p.z).div(0.3);
  const id = floor(g);
  const jit = vec2(hash(id.x.add(id.y.mul(71))), hash(id.y.add(id.x.mul(37)).add(5.3))).sub(0.5).mul(0.35);
  const d = fract(g).sub(0.5).sub(jit).length();
  const fade = float(1).sub(smoothstep(0.12, 0.35, fwidth(g.x)));
  const tuft = mix(float(0.08), smoothstep(0.13, 0.07, d), fade).mul(step(0.01, aVar.x));
  const bed = aCol.mul(mx_noise_float(p.mul(0.4)).mul(0.25).add(1));
  m.colorNode = mix(bed, vec3(0.05, 0.13, 0.025), tuft);
  m.roughnessNode = mix(float(0.05), float(0.8), tuft);
  m.metalnessNode = float(0);
  // a faint breeze ruffle so the sky reflection is alive but never sparkles
  const r = vec3(mx_noise_float(vec3(p.x.mul(0.6), uTime.mul(0.25), p.z.mul(0.6))), 0, mx_noise_float(vec3(p.z.mul(0.6), uTime.mul(0.25).add(4), p.x.mul(0.6)))).mul(0.035);
  m.normalNode = cameraViewMatrix.mul(vec4(normalize(vec3(0, 1, 0).add(r)), 0)).xyz.normalize();
  return m;
}

/** raked gravel (karesansui): pale granite grit in parallel furrows along local u */
export function rakedGravel(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  const x = uv().x.div(0.11);
  const fade = float(1).sub(smoothstep(0.25, 0.7, fwidth(x)));
  const ridge = sin(x.mul(Math.PI * 2));
  const grit = mx_noise_float(positionWorld.mul(23)).mul(0.08).add(mx_noise_float(positionWorld.mul(3)).mul(0.05)).add(1);
  m.colorNode = aCol.mul(grit).mul(ridge.mul(0.08).mul(fade).add(1));
  m.normalNode = (TBNViewMatrix as Node).mul(normalize(vec3(cos(x.mul(Math.PI * 2)).mul(0.45).mul(fade), 0, 1))).normalize();
  m.roughnessNode = float(0.9);
  m.metalnessNode = float(0);
  return m;
}

/** cast bronze with verdigris in the hollows (sorin finial, lantern caps, fittings) */
export function bronze(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  const n = mx_noise_float(positionWorld.mul(3.2)).mul(0.5).add(0.5).add(mx_noise_float(positionWorld.mul(11)).mul(0.15));
  const verd = smoothstep(0.52, 0.68, n.add(normalWorld.y.mul(-0.15)));
  m.colorNode = mix(vec3(0.33, 0.22, 0.11).mul(aCol), vec3(0.11, 0.26, 0.21), verd);
  m.metalnessNode = mix(float(0.85), float(0.05), verd);
  m.roughnessNode = mix(float(0.38), float(0.75), verd);
  return m;
}

/** twisted rope: helical lay stripes, soft fibres (aCol colour) */
export function rope(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  const lay = sin(uv().y.mul(62).add(uv().x.mul(6.283 * 3))).mul(0.5).add(0.5);
  m.colorNode = aCol.mul(lay.mul(0.35).add(0.72));
  m.roughnessNode = float(0.92);
  m.metalnessNode = float(0);
  return m;
}

/** plain material driven by aCol (glass, emissive lamps, cloth accents) */
export function flat(rough: number, metal = 0, emissive?: Node): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.colorNode = aCol;
  m.roughnessNode = float(rough);
  m.metalnessNode = float(metal);
  if (emissive) m.emissiveNode = emissive;
  return m;
}

export interface Materials {
  sets: Record<string, TexSet>;
  cedar: MeshStandardNodeMaterial;
  timber: MeshStandardNodeMaterial;
  deck: MeshStandardNodeMaterial;
  plaster: MeshStandardNodeMaterial;
  stone: MeshStandardNodeMaterial;
  dressed: MeshStandardNodeMaterial;
  bamboo: MeshStandardNodeMaterial;
  linen: MeshStandardNodeMaterial;
  kawara: MeshStandardNodeMaterial;
  namako: MeshStandardNodeMaterial;
  shoji: MeshStandardNodeMaterial;
  paint: MeshStandardNodeMaterial;
  lacquer: MeshStandardNodeMaterial;
  paper: MeshStandardNodeMaterial;
  bronze: MeshStandardNodeMaterial;
  rope: MeshStandardNodeMaterial;
  hull: MeshStandardNodeMaterial;
  dark: MeshStandardNodeMaterial;
  koshi: MeshStandardNodeMaterial;
  foliage: MeshStandardNodeMaterial;
  water: MeshStandardNodeMaterial;
  gravel: MeshStandardNodeMaterial;
  /** plain aCol colour for small painted and dyed things */
  plain: MeshStandardNodeMaterial;
}

export async function createMaterials(ctx: GameContext): Promise<Materials> {
  const ids = Object.keys(SETS);
  const loaded = await Promise.all(ids.map((id) => loadSet(ctx, id)));
  const sets: Record<string, TexSet> = {};
  ids.forEach((id, i) => (sets[id] = loaded[i]));

  // weathered cedar board siding, near black-brown with silvered grain
  const cedar = surface(ctx, sets.japanese_cedar_planks, { target: [0.052, 0.034, 0.022], keep: 0.08, contrast: 1.35, normal: 1.1, rough: [0.5, 0.35], macro: 0.14 });
  // posts, beams, lattice: dark timber with a little more warmth
  const timber = surface(ctx, sets.weathered_planks, { target: [0.06, 0.04, 0.026], keep: 0.3, contrast: 1.15, normal: 1.0, rough: [0.45, 0.4], marine: true, macro: 0.1 });
  // verandas and decks: foot-worn grey-brown boards
  const deck = surface(ctx, sets.wood_planks_grey, { target: [0.12, 0.1, 0.08], keep: 0.35, contrast: 1.2, normal: 1.0, rough: [0.4, 0.45], marine: true, macro: 0.1 });
  // lime plaster, warm white #ece6d8, dirtier near the ground
  const plaster = surface(ctx, sets.painted_plaster_wall, { target: [0.7, 0.66, 0.56], keep: 0.08, contrast: 0.7, normal: 0.6, rough: [0.5, 0.45], grime: true, macro: 0.06 });
  // rough granite masonry for terraces and plinths
  const stone = surface(ctx, sets.japanese_stone_wall, { target: [0.27, 0.265, 0.25], keep: 0.35, contrast: 1.15, normal: 1.2, rough: [0.35, 0.6], marine: true, macro: 0.16 });
  // dressed granite: lanterns, steps, bases
  const dressed = surface(ctx, sets.rock_surface, { target: [0.36, 0.355, 0.34], keep: 0.12, contrast: 0.9, normal: 0.8, rough: [0.4, 0.5], marine: true, macro: 0.14 });
  const bamboo = surface(ctx, sets.bamboo_wall, { target: [0.3, 0.24, 0.13], keep: 0.5, contrast: 1.05, normal: 1.0, rough: [0.35, 0.4], macro: 0.1, double: true });
  // indigo-dyed linen for noren
  const linen = surface(ctx, sets.rough_linen, { target: [0.022, 0.034, 0.075], keep: 0.1, contrast: 0.9, normal: 0.6, rough: [0.7, 0.25], macro: 0.05, double: true });
  const paint = paintedWood(ctx, sets.wood_planks_grey, 0.5);
  // vermilion lacquer is glossier and more even than house paint
  const lacquer = paintedWood(ctx, sets.wood_planks_grey, 0.3);
  const hull = surface(ctx, sets.wood_planks_grey, { target: [0.11, 0.085, 0.06], keep: 0.4, contrast: 1.2, normal: 1.0, rough: [0.4, 0.45], macro: 0.08, double: true });
  // dark openings; aVar.y > 0 marks a stone lantern firebox that burns at night (aVar.x = phase)
  const dark = flat(0.6, 0, vec3(...FIRE_RGB).mul(aVar.y.mul(lampLevel).mul(flicker(aVar.x)).mul(FIRE_GAIN)));
  const plain = flat(0.75);
  plain.side = DoubleSide;
  return {
    sets, cedar, timber, deck, plaster, stone, dressed, bamboo, linen, paint, lacquer, hull, dark, plain,
    kawara: kawara(), namako: namako(), shoji: shoji(), paper: lanternPaper(), bronze: bronze(), rope: rope(),
    koshi: koshiLattice(sets.weathered_planks), foliage: foliage(), water: stillWater(), gravel: rakedGravel(),
  };
}

export const COL = {
  vermilion: [0.5, 0.058, 0.026] as RGB,
  lacquerBlack: [0.018, 0.017, 0.016] as RGB,
  white: [1, 1, 1] as RGB,
  paperWarm: [0.78, 0.72, 0.6] as RGB,
  paperRed: [0.5, 0.06, 0.03] as RGB,
  ochre: [0.52, 0.34, 0.1] as RGB,
  straw: [0.42, 0.33, 0.17] as RGB,
};

void cameraPosition; void dot; void positionLocal;
