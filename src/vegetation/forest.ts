// the forest: tens of thousands of trees on the valley walls from the baked `trees` / `cherry`
// channels. near trees are instanced meshes in two lods; everything farther is a baked
// hemi-octahedral impostor (one quad per tree, all trees of a variant in a single draw that culls
// and culls itself in the vertex stage). each tree has exactly one representation, chosen from the
// player camera (uViewPos), never from `cameraPosition`: in the shadow pass that is the shadow
// camera, which moved with the view and made tree shadows flicker, swap shape and vanish. impostor
// cards face the viewer in the colour passes and the sun in the shadow pass.
// transitions never pop: impostor cards blend the three nearest atlas frames (no frame snapping),
// and inside distance bands lod0/lod1 and mesh/impostor crossfade. meshes shrink whole leaf cards
// away in a fixed per-card order (object space, so it holds still in every pass) while the impostor
// grows in from its dense core by alpha; fades come from uViewPos distances, never screen dither.
// species: japanese cedar / fir (three shapes), broadleaf, cherry in full bloom, japanese maple.
import {
  BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, Frustum, Group, InstancedBufferGeometry, InstancedInterleavedBuffer, InterleavedBufferAttribute,
  Matrix4, Mesh, MeshStandardNodeMaterial, Sphere, Vector3, type Material, type Object3D, type Texture,
} from 'three/webgpu';
import {
  Fn, abs, attribute, cameraPosition, cameraViewMatrix, clamp, cos, cross, dFdx, dFdy, dot, faceDirection, float, floor, fract,
  length, log2, max, mix, normalLocal, normalMap, normalize, positionGeometry, positionLocal, select, sin, smoothstep, texture, uniform, uv,
  varyingProperty, vec2, vec3, vec4,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameContext } from '../core/context';
import { uSunDir, uTime, uWindStrength } from '../core/uniforms';
import { BRIDGES, DOCKS, bankPoint, nearestRiver, riverFrame } from '../world/layout';
import { SITES } from '../world/sites';
import { FoliageMaterial } from './foliage';
import { windAt } from './wind';
import { bakeImpostor, captureMaterials, exportImpostor, loadImpostor, impostorUpNode, type AtlasRecord, type CapturePart, type ImpostorAtlas } from './impostor';
import { hash2 } from './noise';
import { footprintDistance, type HeightFn } from './field';
import { hidesFacade, viewStats } from './townView';

type N = any;

export interface SpeciesDef {
  id: string;
  asset: string;
  /** gltf node names to use as separate variants; empty = the whole scene is one variant */
  nodes: string[];
  leafAtlas: Texture | null;
  leafTint: [number, number, number];
  barkTint: [number, number, number];
  /** grow leaf cards around their centers (blossom crowns are fuller than leaf crowns) */
  cardScale: number;
  translucency: number;
  frames: number;
  framePx: number;
  /** variant index of the first node (several assets can share one species id) */
  variantOffset?: number;
}

interface Part {
  geometry: BufferGeometry;
  kind: 'bark' | 'leaf';
  src: any;
  /** merged bark: the material of the vertices with aBarkSel = 1 */
  src2?: any;
}

/**
 * the parts one lod draws: leaves as they are, all bark merged into one mesh (a trunk and a branch
 * texture are picked per vertex), so a visible tree variant costs two draws per pass instead of three
 */
function drawParts(parts: Part[]): Part[] {
  const bark = parts.filter((p) => p.kind === 'bark');
  if (bark.length < 2) return parts;
  const keys: any[] = [];
  const keyOf = (p: Part) => keys.find((k) => k.map === p.src.map && k.normalMap === p.src.normalMap) ?? null;
  for (const p of bark) if (!keyOf(p)) keys.push(p.src);
  if (keys.length > 2 || bark.some((p) => !p.geometry.index || !p.geometry.getAttribute('uv') || !p.geometry.getAttribute('normal'))) return parts;
  const geoms = bark.map((p) => {
    const g = new BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) g.setAttribute(name, p.geometry.getAttribute(name));
    g.setIndex(p.geometry.index);
    const n = p.geometry.getAttribute('position').count;
    g.setAttribute('aBarkSel', new BufferAttribute(new Float32Array(n).fill(keys.indexOf(keyOf(p))), 1));
    return g;
  });
  const merged = mergeGeometries(geoms);
  if (!merged) return parts;
  return [...parts.filter((p) => p.kind !== 'bark'), { geometry: merged, kind: 'bark', src: keys[0], src2: keys[1] }];
}

interface Variant {
  species: SpeciesDef;
  index: number;
  lod: Part[][];
  height: number;
  center: Vector3;
  radius: number;
  crown: Vector3;
  crownR: number;
  atlas: ImpostorAtlas | null;
  /** all instances: x, y, z, yaw, scale, seed, 0, 0 */
  all: Float32Array;
  count: number;
  /** near lod instance buffers */
  near: { buf: InstancedInterleavedBuffer; data: Float32Array; geoms: InstancedBufferGeometry[]; meshes: Mesh[]; n: number }[];
  imp: { geom: InstancedBufferGeometry; mesh: Mesh } | null;
}

export const STRIDE = 8;

/** lod distances (m), set from quality */
export const forestDist = {
  lod0: uniform(28),
  near: uniform(70),
  /** mesh -> impostor crossfade runs over [near - band, near] */
  band: uniform(14),
  /** lod0 -> lod1 crossfade runs over lod0 +- lodBand */
  lodBand: uniform(5),
  /** impostor cards stop casting beyond this distance from the player (the shadow cascades end here) */
  shadowFar: uniform(290),
};

/** the player camera's world position, set once per frame; all lod and visibility decisions use it */
export const uViewPos = uniform(new Vector3());

const rotY = (v: N, c: N, s: N) => vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)));

/** per-tree colour drift, applied identically to meshes and impostors so the swap cannot show */
const SPECIES_TINT: Record<string, [[number, number, number], [number, number, number]]> = {
  // cedar: cool blue-green in shade to warm sunlit olive
  cedar: [[0.84, 0.95, 0.93], [1.06, 1.07, 0.86]],
  // broadleaf: fresh spring greens, some nearly lime-gold
  broadleaf: [[0.94, 1.06, 0.82], [1.16, 1.14, 0.7]],
  cherry: [[1.1, 1.0, 1.05], [1.17, 1.07, 1.1]],
  maple: [[0.98, 0.86, 0.84], [1.1, 1.02, 0.86]],
};

export function treeTint(species: string, seed: N): N {
  const [a, b] = SPECIES_TINT[species] ?? [[0.92, 0.96, 0.92], [1.06, 1.04, 1.0]];
  const t = fract((seed as N).mul(13.7));
  const lum = fract((seed as N).mul(7.31)).mul(0.12).add(0.94);
  return mix(vec3(...a), vec3(...b), t).mul(lum);
}

/** stable hash of an object-space point to [0, 1) */
export function hash13(p: N): N {
  const q = fract((p as N).mul(0.1031)) as N;
  const r = q.add(dot(q, q.zyx.add(31.32))) as N;
  return fract(r.x.add(r.y).mul(r.z));
}

/** leaf alpha with mip compensation (keeps far crowns full instead of eroding to sparkles) */
function leafTex(map: Texture, uvNode: N, tint: N) {
  const t = texture(map, uvNode) as N;
  const d = max(length(dFdx(uvNode)), length(dFdy(uvNode))).mul(1024);
  const lod = log2(max(d, 1));
  return vec4(t.rgb.mul(tint), t.a.mul(lod.mul(0.3).add(1)));
}

/** per-tree placement transform (instance attrs) + wind sway, returning world position */
function placeNode(v: Variant, lodIndex: number, leaf: boolean, out: { dist: N; sph?: N; depth?: N; n?: N; seed?: N }) {
  const aA = attribute('aTreeA', 'vec4') as N;
  const aB = attribute('aTreeB', 'vec4') as N;
  const vDist = varyingProperty('float', `vTrDist${lodIndex}`) as N;
  const vSph = varyingProperty('vec3', `vTrSph${lodIndex}`) as N;
  const vDepth = varyingProperty('float', `vTrDepth${lodIndex}`) as N;
  const vN = varyingProperty('vec3', `vTrN${lodIndex}`) as N;
  const vSeed = varyingProperty('float', `vTrSeed${lodIndex}`) as N;
  const crown = uniform(v.crown.clone());
  const crownR = v.crownR, height = v.height;
  const cardScale = v.species.cardScale;
  const node = Fn(() => {
    const root = aA.xyz, yaw = aA.w, scale = aB.x, seed = aB.y, fade = aB.z;
    let p = positionLocal as N;
    if (leaf) {
      // crossfade: cards shrink away in a fixed per-card order; lod1 uses the complementary order so
      // the crown keeps its coverage while the two lods trade places
      const cc = attribute('_center', 'vec3') as N;
      let h = hash13(cc.mul(7.0)) as N;
      if (lodIndex === 1) h = float(1).sub(h);
      const k = fade.mul(1.12).sub(h).div(0.12).clamp(0, 1);
      p = cc.add(p.sub(cc).mul(k.mul(cardScale)));
    }
    const c = cos(yaw), s = sin(yaw);
    let wp = root.add(rotY(p.mul(scale), c, s)) as N;
    // sway: whole crown leans with the steady wind and rocks with passing gusts
    const w = windAt(root.xz) as N;
    const h01 = p.y.div(height).clamp(0, 1.2);
    const bend = h01.mul(h01);
    const phase = root.x.mul(0.11).add(root.z.mul(0.07)).add(seed.mul(6.28));
    const sway = w.z.mul(0.45).add(w.w.mul(sin(uTime.mul(0.7).add(phase))).mul(0.55));
    wp = wp.add(vec3(w.x, 0, w.y).mul(sway.mul(scale).mul(height).mul(0.018).mul(bend)));
    if (leaf) {
      const fl: N = sin(uTime.mul(fract(seed.mul(9.1)).mul(3).add(5)).add(p.x.mul(7)).add(p.z.mul(5))).mul(w.w.mul(0.025).add(0.008)).mul(uWindStrength.add(0.2)).mul(bend);
      wp = wp.add(vec3(fl, (fl as N).mul(0.5), (fl as N).negate()));
      const d = p.sub(crown);
      vSph.assign(rotY(normalize(d.add(vec3(0, 0.001, 0))), c, s));
      vDepth.assign(smoothstep(0.15, 1.0, length(d).div(crownR)));
    } else {
      // bark swaps at the middle of a band (exactly one lod at a time, so no z-fighting)
      const on = lodIndex === 0 ? fade.greaterThanEqual(0.5) : fade.greaterThan(0.5);
      wp = on.select(wp, root);
    }
    const n = rotY(normalLocal, c, s);
    normalLocal.assign(n);
    vN.assign(n);
    vSeed.assign(seed);
    vDist.assign(length((uViewPos as N).sub(root.add(vec3(0, height * 0.5, 0).mul(scale)))));
    return wp;
  })();
  out.dist = vDist;
  out.sph = vSph;
  out.depth = vDepth;
  out.n = vN;
  out.seed = vSeed;
  return node;
}

function barkMaterial(v: Variant, part: Part, lod: number): Material {
  const m = new MeshStandardNodeMaterial();
  const src = part.src;
  m.name = `${v.species.id}-bark`;
  m.map = src.map ?? null;
  // both lods keep the normal map, so the swap is geometric only
  m.normalMap = src.normalMap ?? null;
  if (src.normalScale) m.normalScale.copy(src.normalScale);
  const src2 = part.src2;
  if (src2?.map && src.map) {
    // merged trunk + branches: each vertex keeps its own texture
    const sel = (attribute('aBarkSel', 'float') as N).greaterThan(0.5);
    const tint = vec3(...v.species.barkTint);
    m.colorNode = vec4((select(sel, texture(src2.map, uv()), texture(src.map, uv())) as N).rgb.mul(tint), 1);
    m.map = null;
    if (src.normalMap && src2.normalMap) {
      m.normalNode = normalMap(select(sel, texture(src2.normalMap, uv()), texture(src.normalMap, uv())) as N, uniform(m.normalScale.clone()) as N);
      m.normalMap = null;
    }
  }
  m.roughness = 0.95;
  m.metalness = 0;
  m.color.setRGB(...v.species.barkTint);
  m.side = DoubleSide;
  const o: N = {};
  m.positionNode = placeNode(v, lod, false, o);
  return m;
}

function leafMaterial(v: Variant, part: Part, lod: number): Material {
  const m = new FoliageMaterial({ side: DoubleSide, alphaTest: v.species.id === 'cedar' ? 0.3 : 0.5 });
  m.name = `${v.species.id}-leaves`;
  const o: N = {};
  m.positionNode = placeNode(v, lod, true, o);
  const tex = (v.species.leafAtlas ?? part.src.map) as Texture;
  const albedo = leafTex(tex, uv(), vec3(...v.species.leafTint)) as N;
  const shade = o.depth.mul(0.5).add(0.5);
  const tint = treeTint(v.species.id, o.seed);
  m.colorNode = vec4(albedo.rgb.mul(shade).mul(tint), albedo.a);
  const nW: N = normalize(mix(o.n.mul(faceDirection), o.sph, 0.6) as N);
  m.normalNode = normalize((cameraViewMatrix as N).mul(vec4(nW, float(0))).xyz);
  m.roughnessNode = float(0.65);
  m.aoNode = o.depth.mul(0.5).add(0.5);
  m.translucencyNode = float(v.species.translucency);
  m.translucencyTint = vec3(1.0, 1.08, 0.6);
  return m;
}

/** capture materials in tree-local space (no instance transform, no wind) */
function captureParts(v: Variant, parts: Part[]): CapturePart[] {
  return parts.map((part) => {
    if (part.kind === 'bark') {
      const map = part.src.map as Texture | null;
      const col = map ? (texture(map, uv()) as N).rgb.mul(vec3(...v.species.barkTint)) : vec3(...v.species.barkTint).mul(0.3);
      const mats = captureMaterials({ albedo: vec4(col, 1), normal: (normalLocal as N).mul(faceDirection) });
      return { geometry: part.geometry, ...mats };
    }
    let pos: N;
    const cs = v.species.cardScale;
    if (cs !== 1) {
      pos = Fn(() => {
        const c = attribute('_center', 'vec3') as N;
        return c.add((positionLocal as N).sub(c).mul(cs));
      })();
    }
    const crown = vec3(v.crown.x, v.crown.y, v.crown.z);
    const d = (positionLocal as N).sub(crown);
    const depth = smoothstep(0.15, 1.0, length(d).div(v.crownR));
    const tex = (v.species.leafAtlas ?? part.src.map) as Texture;
    const t = leafTex(tex, uv(), vec3(...v.species.leafTint)) as N;
    const albedo = vec4(t.rgb.mul(depth.mul(0.5).add(0.5)), t.a.clamp(0, 1));
    const nrm = normalize(mix((normalLocal as N).mul(faceDirection), normalize(d.add(vec3(0, 0.001, 0))), 0.6) as N);
    // needles are subpixel in an atlas frame; accumulate their coverage instead of cutting it away
    const mats = captureMaterials({ position: pos, albedo, normal: nrm, coverage: true });
    return { geometry: part.geometry, ...mats };
  });
}

function impostorMaterial(v: Variant): Material {
  const at = v.atlas!;
  const F = at.frames;
  const aA = attribute('aTreeA', 'vec4') as N;
  const aB = attribute('aTreeB', 'vec4') as N;
  // three blended atlas frames: local card uv (xy) and frame cell (zw)
  const vF0 = varyingProperty('vec4', 'vImpF0') as N;
  const vF1 = varyingProperty('vec4', 'vImpF1') as N;
  const vF2 = varyingProperty('vec4', 'vImpF2') as N;
  const vW = varyingProperty('vec4', 'vImpW') as N; // frame weights, fade-in
  const vRot = varyingProperty('vec3', 'vImpRot') as N; // cos yaw, sin yaw, seed
  const center = vec3(at.center.x, at.center.y, at.center.z);
  const R = at.radius;
  const m = new FoliageMaterial({ side: DoubleSide, alphaTest: 0.5 });
  m.name = `${v.species.id}-impostor`;
  /** capture frame for a grid cell: local card uv of the card point q (unit, card plane) seen along d */
  const frame = (cell: N, q: N, d: N) => {
    const cc = clamp(cell, 0, F - 1) as N;
    const uc = cc.add(0.5).div(F).mul(2).sub(1) as N;
    const dx = uc.x.add(uc.y).mul(0.5), dz = uc.x.sub(uc.y).mul(0.5);
    const Dk = normalize(vec3(dx, float(1).sub(abs(dx)).sub(abs(dz)), dz)) as N;
    const rk = normalize(cross(impostorUpNode(Dk), Dk)) as N;
    const uk = cross(Dk, rk) as N;
    // follow the view ray through the card point onto the frame's capture plane
    const t = dot(q, Dk).div(max(dot(d, Dk), 0.25));
    const qp = q.sub(d.mul(t)) as N;
    return vec4(dot(qp, rk), dot(qp, uk), cc.x, cc.y);
  };
  const card = (toSun: boolean) => Fn(() => {
    const root = aA.xyz, yaw = aA.w, scale = aB.x, seed = aB.y;
    const c = cos(yaw), s = sin(yaw);
    const cw = root.add(rotY(center.mul(scale), c, s));
    // visibility: same point as the cpu mesh selection in Forest.update
    const lift: N = (scale as N).mul(at.center.y);
    const dist = length((uViewPos as N).sub(root.add(vec3(0, lift, 0) as N)));
    const toView = toSun ? (uSunDir as N) : cameraPosition.sub(cw);
    const vl = rotY(normalize(toView), c, s.negate()) as N;
    // the card faces the view continuously; the atlas frames are blended, never snapped
    const D = normalize(vec3(vl.x, max(vl.y, 0.0), vl.z)) as N;
    const right = normalize(cross(impostorUpNode(D), D)) as N;
    const up = cross(D, right) as N;
    const g = positionGeometry as N;
    const q = right.mul(g.x).add(up.mul(g.y)) as N;
    // far crowns swell a little so a distant slope reads as closed canopy instead of dots
    const grow = float(1).add(smoothstep(forestDist.near.mul(2.2), forestDist.near.mul(6), dist).mul(0.2));
    const Rw = float(R).mul(scale).mul(grow);
    // pushed toward the viewer so slopes do not clip the lower half of the card
    let wp = cw.add(rotY(q.mul(Rw).add(D.mul(Rw.mul(0.45))), c, s)) as N;
    const w = windAt(root.xz) as N;
    const top = g.y.mul(0.5).add(0.5);
    wp = wp.add(vec3(w.x, 0, w.y).mul(w.z.mul(0.45).add(w.w.mul(0.3)).mul(Rw).mul(0.02).mul(top.mul(top))));
    // fade in across the mesh band (the mesh fades out over the same distances); nearer, collapse.
    // in the shadow pass, cards past the shadow range collapse too: their shadow lands beyond it
    const fadeIn = smoothstep(forestDist.near.sub(forestDist.band), forestDist.near, dist);
    wp = dist.lessThan(forestDist.near.sub(forestDist.band)).select(cw, wp);
    if (toSun) wp = dist.greaterThan(forestDist.shadowFar).select(cw, wp);
    // barycentric blend of the three nearest frames on the hemi-octahedral grid
    const sum = abs(D.x).add(abs(D.y)).add(abs(D.z));
    const px = D.x.div(sum), pz = D.z.div(sum);
    const gx = px.add(pz).mul(0.5).add(0.5).mul(F).sub(0.5), gy = px.sub(pz).mul(0.5).add(0.5).mul(F).sub(0.5);
    const i0 = floor(gx), j0 = floor(gy);
    const fx = gx.sub(i0), fy = gy.sub(j0);
    const upper = fx.add(fy).greaterThan(1);
    const cA = select(upper, vec2(i0.add(1), j0.add(1)), vec2(i0, j0));
    const wA = select(upper, fx.add(fy).sub(1), float(1).sub(fx).sub(fy));
    const wB = select(upper, float(1).sub(fy), fx);
    const wC = select(upper, float(1).sub(fx), fy);
    vF0.assign(frame(cA, q, D));
    vF1.assign(frame(vec2(i0.add(1), j0), q, D));
    vF2.assign(frame(vec2(i0, j0.add(1)), q, D));
    vW.assign(vec4(wA, wB, wC, fadeIn));
    vRot.assign(vec3(c, s, seed));
    return wp;
  })();
  m.positionNode = card(false);
  m.castShadowPositionNode = card(true);
  const cellUv = (f: N) => f.zw.add(f.xy.clamp(-0.985, 0.985).mul(0.5).add(0.5)).div(F);
  const u0 = cellUv(vF0), u1 = cellUv(vF1), u2 = cellUv(vF2);
  const ta = (texture(at.albedo, u0) as N).mul(vW.x).add((texture(at.albedo, u1) as N).mul(vW.y)).add((texture(at.albedo, u2) as N).mul(vW.z)) as N;
  const tn = (texture(at.normal, u0) as N).mul(vW.x).add((texture(at.normal, u1) as N).mul(vW.y)).add((texture(at.normal, u2) as N).mul(vW.z)) as N;
  const a = ta.a;
  const rgb = ta.rgb.div(max(a, 0.02)).pow(2);
  const dUv = max(length(dFdx(vF0.xy)), length(dFdy(vF0.xy))).mul(128 * at.frames / F);
  const lod = log2(max(dUv, 1));
  const tint = treeTint(v.species.id, vRot.z);
  // alpha grows in from the dense core while the mesh cards shrink away
  m.colorNode = vec4(rgb.mul(tint), a.mul(lod.mul(0.25).add(1.1)).mul(vW.w));
  const nl = tn.rgb.div(max(tn.a, 0.02)).mul(2).sub(1);
  const nw = normalize(rotY(nl, vRot.x, vRot.y));
  m.normalNode = normalize((cameraViewMatrix as N).mul(vec4(nw, float(0))).xyz);
  m.roughnessNode = float(0.65);
  // the mesh's crown-depth occlusion, averaged over the outer shell the capture sees
  m.aoNode = float(0.84);
  m.translucencyNode = float(v.species.translucency * 0.8);
  m.translucencyTint = vec3(1.0, 1.08, 0.6);
  return m;
}

function instGeom(base: BufferGeometry, buf: InstancedInterleavedBuffer): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry();
  g.index = base.index;
  for (const name of Object.keys(base.attributes)) g.setAttribute(name, base.getAttribute(name));
  g.setAttribute('aTreeA', new InterleavedBufferAttribute(buf, 4, 0));
  g.setAttribute('aTreeB', new InterleavedBufferAttribute(buf, 4, 4));
  g.instanceCount = 0;
  g.boundingSphere = new Sphere(new Vector3(), 1e6);
  return g;
}

function quadGeometry() {
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** collect variant parts from a gltf scene: meshes under the named node (or the whole scene) */
function partsOf(scene: Object3D, nodeName: string | null): Part[] {
  let root: Object3D | undefined = scene;
  if (nodeName) root = scene.getObjectByName(nodeName) ?? scene.getObjectByName(nodeName.replace(/\./g, ''));
  if (!root) return [];
  const parts: Part[] = [];
  root.traverse((o: any) => {
    if (!o.isMesh || !o.geometry.getAttribute('position')?.count) return;
    const name = (o.material?.name || '') as string;
    const kind = /(leaves|twigs)/.test(name) ? 'leaf' : 'bark';
    parts.push({ geometry: o.geometry, kind, src: o.material });
  });
  return parts;
}

export interface ForestTree { species: string; variant: number; x: number; y: number; z: number; yaw: number; scale: number; seed: number }

export class Forest {
  root = new Group();
  variants: Variant[] = [];
  private cells = new Map<number, { v: Variant; i: number }[]>();
  private cellSize = 32;
  private frustum = new Frustum();
  private m4 = new Matrix4();
  private sphere = new Sphere();
  private sunShift = new Vector3();
  stats = { trees: 0, near0: 0, near1: 0, bakeMs: 0, loadedAtlases: 0, capturedAtlases: 0 };
  ctx: GameContext;

  constructor(ctx: GameContext) {
    this.ctx = ctx;
    this.root.name = 'forest';
  }

  async load(defs: SpeciesDef[]) {
    const t0 = performance.now();
    const rebake = new URLSearchParams(location.search).has('bakeStartup');
    const manifest: Record<string, AtlasRecord> = rebake ? {} : await fetch('/assets/vegetation/impostors/manifest.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
    const sources = await Promise.all(defs.map(def => {
      const base = `/assets/vegetation/${def.asset}/`;
      return Promise.all([
        this.ctx.assets.gltf(`${base}${def.asset}.gltf`),
        this.ctx.assets.gltf(`${base}${def.asset}_lod1.glb`),
      ]);
    }));
    for (const [index, def] of defs.entries()) {
      const [g0, g1] = sources[index];
      const names = def.nodes.length ? def.nodes : [null];
      names.forEach((nm, k) => {
        const p0 = partsOf(g0.scene, nm), p1 = partsOf(g1.scene, nm);
        if (!p0.length) return;
        // lod1 ships without textures: borrow the near lod's materials by name
        for (const p of p1) {
          const twin = p0.find((q) => q.src.name === p.src.name);
          if (twin) p.src = twin.src;
        }
        let minY = 1e9, maxY = -1e9;
        const bb = { x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9 };
        const crownBB = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, z0: 1e9, z1: -1e9 };
        for (const p of p0) {
          p.geometry.computeBoundingBox();
          const b = p.geometry.boundingBox!;
          minY = Math.min(minY, b.min.y); maxY = Math.max(maxY, b.max.y);
          bb.x0 = Math.min(bb.x0, b.min.x); bb.x1 = Math.max(bb.x1, b.max.x);
          bb.z0 = Math.min(bb.z0, b.min.z); bb.z1 = Math.max(bb.z1, b.max.z);
          if (p.kind === 'leaf') {
            crownBB.x0 = Math.min(crownBB.x0, b.min.x); crownBB.x1 = Math.max(crownBB.x1, b.max.x);
            crownBB.y0 = Math.min(crownBB.y0, b.min.y); crownBB.y1 = Math.max(crownBB.y1, b.max.y);
            crownBB.z0 = Math.min(crownBB.z0, b.min.z); crownBB.z1 = Math.max(crownBB.z1, b.max.z);
          }
        }
        const grow = def.cardScale > 1 ? 1 + (def.cardScale - 1) * 0.35 : 1;
        const cx = (bb.x0 + bb.x1) / 2, cz = (bb.z0 + bb.z1) / 2;
        const halfW = Math.max(bb.x1 - bb.x0, bb.z1 - bb.z0) * 0.5 * grow;
        const halfH = (maxY - minY) * 0.5 * grow;
        const center = new Vector3(cx, (minY + maxY) / 2, cz);
        const radius = Math.max(halfW, halfH) * 1.04;
        const crown = new Vector3((crownBB.x0 + crownBB.x1) / 2, (crownBB.y0 + crownBB.y1) / 2, (crownBB.z0 + crownBB.z1) / 2);
        const crownR = Math.max(0.5, Math.max(crownBB.x1 - crownBB.x0, crownBB.y1 - crownBB.y0, crownBB.z1 - crownBB.z0) * 0.5);
        this.variants.push({
          species: def, index: (def.variantOffset ?? 0) + k, lod: [p0, p1], height: maxY - minY, center, radius, crown, crownR,
          atlas: null, all: new Float32Array(0), count: 0, near: [], imp: null,
        });
      });
    }
    await Promise.all(this.variants.map(async v => {
      const record = manifest[this.variantKey(v.species.id, v.index)];
      if (record?.signature !== this.atlasSignature(v)) return;
      try {
        v.atlas = await loadImpostor(record, v.center, v.radius, v.species.frames);
        this.stats.loadedAtlases++;
      } catch (e) {
        console.warn('[vegetation] prebuilt atlas unavailable; capturing locally', e);
      }
    }));
    // development fallback: preserve full crowns and fractional needle coverage
    for (const v of this.variants) {
      if (v.atlas) continue;
      const parts = captureParts(v, v.lod[0]);
      v.atlas = bakeImpostor(this.ctx.renderer, parts, v.center, v.radius, v.species.frames, v.species.framePx);
      for (const p of parts) { p.albedo.dispose(); p.normal.dispose(); }
      this.stats.capturedAtlases++;
    }
    this.stats.bakeMs = performance.now() - t0;
  }

  private atlasSignature(v: Variant) {
    const { leafAtlas: _atlas, ...settings } = v.species;
    return JSON.stringify({ version: 2, settings, index: v.index, center: v.center.toArray(), radius: v.radius });
  }

  /** invoked by test/scripts/startup-export.mjs, never by gameplay */
  async exportAtlas(index: number) {
    const v = this.variants[index];
    const data = await exportImpostor(this.ctx.renderer, v.atlas!);
    return { ...data, key: this.variantKey(v.species.id, v.index), signature: this.atlasSignature(v) };
  }

  variantKey(species: string, variant: number) {
    return `${species}:${variant}`;
  }

  /** build draw objects for all placed trees */
  build(trees: ForestTree[]) {
    const byKey = new Map<string, ForestTree[]>();
    for (const t of trees) {
      const k = this.variantKey(t.species, t.variant);
      let a = byKey.get(k);
      if (!a) byKey.set(k, (a = []));
      a.push(t);
    }
    this.cells.clear();
    for (const v of this.variants) {
      const list = byKey.get(this.variantKey(v.species.id, v.index)) ?? [];
      v.count = list.length;
      v.all = new Float32Array(Math.max(1, list.length) * STRIDE);
      const a = v.all;
      list.forEach((t, i) => {
        const o = i * STRIDE;
        a[o] = t.x; a[o + 1] = t.y; a[o + 2] = t.z; a[o + 3] = t.yaw; a[o + 4] = t.scale; a[o + 5] = t.seed;
        const key = this.cellKey(t.x, t.z);
        let c = this.cells.get(key);
        if (!c) this.cells.set(key, (c = []));
        c.push({ v, i });
      });
      // near lods
      v.near = v.lod.map((lodParts, lod) => {
        const parts = drawParts(lodParts);
        const cap = 1024;
        const data = new Float32Array(cap * STRIDE);
        const buf = new InstancedInterleavedBuffer(data, STRIDE, 1);
        buf.setUsage(DynamicDrawUsage);
        const geoms: InstancedBufferGeometry[] = [], meshes: Mesh[] = [];
        for (const part of parts) {
          const g = instGeom(part.geometry, buf);
          const mat = part.kind === 'leaf' ? leafMaterial(v, part, lod) : barkMaterial(v, part, lod);
          const m = new Mesh(g, mat);
          m.frustumCulled = false;
          m.castShadow = true;
          m.receiveShadow = true;
          m.matrixAutoUpdate = false;
          this.root.add(m);
          geoms.push(g);
          meshes.push(m);
        }
        return { buf, data, geoms, meshes, n: 0 };
      });
      // impostors: every tree of the variant, one draw
      if (v.count && v.atlas) {
        const g = quadGeometry();
        const ib = new InstancedInterleavedBuffer(v.all, STRIDE, 1);
        g.setAttribute('aTreeA', new InterleavedBufferAttribute(ib, 4, 0));
        g.setAttribute('aTreeB', new InterleavedBufferAttribute(ib, 4, 4));
        g.instanceCount = v.count;
        g.boundingSphere = new Sphere(new Vector3(), 1e6);
        const mesh = new Mesh(g, impostorMaterial(v));
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.renderOrder = 2;
        this.root.add(mesh);
        v.imp = { geom: g, mesh };
      }
    }
    this.stats.trees = trees.length;
  }

  private cellKey(x: number, z: number) {
    return (Math.floor(x / this.cellSize) + 512) * 1024 + (Math.floor(z / this.cellSize) + 512);
  }

  /** gather near trees into the lod buffers (frustum + sun-shadow aware), with crossfade weights */
  update(camPos: Vector3) {
    const cam = this.ctx.camera;
    (uViewPos.value as Vector3).copy(camPos);
    this.m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m4);
    const sd = this.ctx.sun.direction;
    const lod0 = forestDist.lod0.value as number, near = forestDist.near.value as number;
    const band = forestDist.band.value as number, lb = forestDist.lodBand.value as number;
    for (const v of this.variants) for (const l of v.near) l.n = 0;
    const R = Math.ceil(near / this.cellSize) + 1;
    const cx = Math.floor(camPos.x / this.cellSize), cz = Math.floor(camPos.z / this.cellSize);
    let n0 = 0, n1 = 0;
    const push = (v: Variant, l: Variant['near'][number], o: number, fade: number) => {
      if (fade <= 0.001 || l.n * STRIDE >= l.data.length) return;
      const at = l.n * STRIDE;
      l.data.set(v.all.subarray(o, o + STRIDE), at);
      l.data[at + 6] = fade;
      l.n++;
    };
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      const list = this.cells.get((cx + dx + 512) * 1024 + (cz + dz + 512));
      if (!list) continue;
      for (const { v, i } of list) {
        const o = i * STRIDE, s = v.all[o + 4];
        const tx = v.all[o], ty = v.all[o + 1] + v.center.y * s, tz = v.all[o + 2];
        const d = Math.hypot(tx - camPos.x, ty - camPos.y, tz - camPos.z);
        if (d >= near) continue;
        const r = v.radius * s;
        this.sphere.center.set(tx, ty, tz);
        this.sphere.radius = r;
        if (!this.frustum.intersectsSphere(this.sphere)) {
          // keep trees whose shadow can fall into view
          const len = (v.height * s) / Math.max(0.25, sd.y);
          this.sunShift.set(tx - sd.x * len * 0.6, ty - sd.y * len * 0.6, tz - sd.z * len * 0.6);
          this.sphere.center.copy(this.sunShift);
          this.sphere.radius = r + len * 0.5;
          if (!this.frustum.intersectsSphere(this.sphere)) continue;
        }
        // mesh fades out over [near - band, near] exactly as the impostor fades in
        const fm = 1 - smooth01((d - (near - band)) / band);
        if (!v.near[1] || d <= lod0 - lb) push(v, v.near[0], o, fm);
        else if (d >= lod0 + lb) push(v, v.near[1], o, fm);
        else {
          const t = smooth01((d - (lod0 - lb)) / (2 * lb));
          push(v, v.near[0], o, (1 - t) * fm);
          push(v, v.near[1], o, t * fm);
        }
      }
    }
    for (const v of this.variants) {
      v.near.forEach((l, lod) => {
        for (const g of l.geoms) g.instanceCount = l.n;
        for (const m of l.meshes) m.visible = l.n > 0;
        if (l.n) {
          l.buf.needsUpdate = true;
          l.buf.clearUpdateRanges();
          l.buf.addUpdateRange(0, l.n * STRIDE);
        }
        if (lod === 0) n0 += l.n;
        else n1 += l.n;
      });
    }
    this.stats.near0 = n0;
    this.stats.near1 = n1;
  }
}

const smooth01 = (x: number) => {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
};

export interface PlantOptions {
  heightAt: HeightFn;
  /** trees per 100 m2 at full channel value */
  density: number;
  excluded?: (x: number, z: number) => boolean;
  /** receives the main-thread time spent planting (ms) */
  busy?: { ms: number };
}

/** place forest, cherry and maple trees from the bake */
/** world-space box around the opening stretch of the river (s 0-760) plus its valley slopes */
const OPENING_BOUNDS = (() => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let s = 0; s <= 760; s += 20) {
    const f = riverFrame(s);
    x0 = Math.min(x0, f.x); x1 = Math.max(x1, f.x); z0 = Math.min(z0, f.z); z1 = Math.max(z1, f.z);
  }
  const m = 320;
  return { x0: x0 - m, x1: x1 + m, z0: z0 - m, z1: z1 + m };
})();

export async function planForest(ctx: GameContext, o: PlantOptions, variantsOf: (id: string) => number): Promise<ForestTree[]> {
  const w = ctx.world;
  // time-sliced: yields to the frame loop every ~24 ms
  let tSlice = performance.now();
  const breathe = async () => {
    const dt = performance.now() - tSlice;
    if (dt < 24) return;
    if (o.busy) o.busy.ms += dt;
    await new Promise<void>((r) => setTimeout(r, 0));
    tSlice = performance.now();
  };
  const trees: ForestTree[] = [];
  const has = (c: string) => w.has(c);
  const S = (c: string, x: number, z: number) => (has(c) ? w.sample(c, x, z) : 0);
  const half = w.half;
  const sp = Math.sqrt(100 / o.density);
  const n = Math.floor(w.size / sp);
  const nCedar = variantsOf('cedar');
  for (let j = 0; j < n; j++) {
    await breathe();
    for (let i = 0; i < n; i++) {
      const hx = hash2(i, j, 1), hz = hash2(i, j, 2), ha = hash2(i, j, 3), hb = hash2(i, j, 4);
      const x = -half + (i + hx) * sp, z = -half + (j + hz) * sp;
      const t = S('trees', x, z);
      if (t < 0.05 || ha > t) continue;
      if (S('bamboo', x, z) > 0.25 || S('cliff', x, z) > 0.45 || S('path', x, z) > 0.2 || S('reeds', x, z) > 0.3) continue;
      if (o.excluded && o.excluded(x, z)) continue;
      const y = o.heightAt(x, z);
      if (y < 1.2) continue;
      const nn = w.normalAt(x, z, undefined, 2);
      if (nn.y < 0.62) continue;
      if (hidesFacade(x, z)) { viewStats.forest++; continue; }
      const low = 1 - Math.min(1, Math.max(0, (y - 25) / 60));
      let species = 'cedar', variant = 0;
      if (hb < 0.07 + 0.1 * low) species = 'broadleaf';
      else variant = hb < 0.55 ? 0 : hb < 0.82 ? 1 : 2;
      if (species === 'cedar') variant = Math.min(variant, nCedar - 1);
      const scale = species === 'cedar' ? (variant === 0 ? 2.0 : variant === 1 ? 2.2 : 2.6) * (0.85 + 0.35 * hash2(i, j, 5)) : 1.5 + 0.6 * hash2(i, j, 5);
      trees.push({ species, variant, x, y: y - 0.25 * scale, z, yaw: hash2(i, j, 6) * Math.PI * 2, scale, seed: hash2(i, j, 7) });
    }
  }
  // cherries: their own sparser grid where the cherry channel is set
  if (has('cherry')) {
    const cs = 8.5, m = Math.floor(w.size / cs);
    for (let j = 0; j < m; j++) { await breathe(); for (let i = 0; i < m; i++) {
      const x = -half + (i + hash2(i, j, 11)) * cs, z = -half + (j + hash2(i, j, 12)) * cs;
      const c = S('cherry', x, z);
      if (c < 0.12 || hash2(i, j, 13) > c) continue;
      if (o.excluded && o.excluded(x, z)) continue;
      const y = o.heightAt(x, z);
      if (y < 0.8) continue;
      if (hidesFacade(x, z, 3)) { viewStats.cherryGrid++; continue; }
      const scale = 1.25 + 0.5 * hash2(i, j, 15);
      trees.push({ species: 'cherry', variant: hash2(i, j, 14) < 0.55 ? 0 : 1, x, y: y - 0.15 * scale, z, yaw: hash2(i, j, 16) * 6.283, scale, seed: hash2(i, j, 17) });
    } }
  }
  // the opening valley (village to the stone bridge) is where players spend their first minutes:
  // fill its slopes densely, with blossom and spring-red maples mixed into the cedars for color
  {
    const cs = 5.2;
    const R = OPENING_BOUNDS;
    for (let z = R.z0; z < R.z1; z += cs) { await breathe(); for (let x = R.x0; x < R.x1; x += cs) {
      const i = Math.round(x / cs), j = Math.round(z / cs);
      const px = x + hash2(i, j, 21) * cs, pz = z + hash2(i, j, 22) * cs;
      // cheap rejects first: stay 12 m back from the water (baked shoreline distance), no rock/cliff
      if (S('shore', px, pz) < 12) continue;
      // hillsides above the town floor are wooded all the way up; the flat town floor keeps its own mask
      const hy = o.heightAt(px, pz);
      const t = S('cliff', px, pz) > 0.6 || hy < 7 ? S('trees', px, pz) : Math.max(S('trees', px, pz), 0.62);
      if (t < 0.08 || hash2(i, j, 23) > t * 0.85) continue;
      if (S('bamboo', px, pz) > 0.25 || S('cliff', px, pz) > 0.6 || S('path', px, pz) > 0.2) continue;
      if (o.excluded && o.excluded(px, pz)) continue;
      const y = hy;
      if (y < 1.5) continue;
      const nn = w.normalAt(px, pz, undefined, 2);
      if (nn.y < 0.42) continue;
      // the town floor stays open in front of the houses; the hillsides keep every tree
      if (hidesFacade(px, pz)) { viewStats.opening++; continue; }
      const pick = hash2(i, j, 24), low = y < 45;
      const seed = hash2(i, j, 27), yaw = hash2(i, j, 26) * Math.PI * 2;
      if (low && pick < 0.09) {
        trees.push({ species: 'cherry', variant: pick < 0.045 ? 0 : 1, x: px, y: y - 0.2, z: pz, yaw, scale: 1.3 + 0.5 * seed, seed });
      } else if (low && pick < 0.15) {
        trees.push({ species: 'maple', variant: 0, x: px, y: y - 0.2, z: pz, yaw, scale: 1.2 + 0.4 * seed, seed });
      } else if (pick < 0.27) {
        trees.push({ species: 'broadleaf', variant: 0, x: px, y: y - 0.3, z: pz, yaw, scale: 1.5 + 0.6 * seed, seed });
      } else {
        const variant = Math.min(nCedar - 1, pick < 0.6 ? 0 : pick < 0.85 ? 1 : 2);
        const scale = (variant === 0 ? 2.0 : variant === 1 ? 2.2 : 2.6) * (0.85 + 0.35 * seed);
        trees.push({ species: 'cedar', variant, x: px, y: y - 0.25 * scale, z: pz, yaw, scale, seed });
      }
    } }
  }
  // a handful of cherries in bloom beside the shrine, at the pagoda precinct edges and the landing, set
  // back from the water and clear of every building, crossing and house front
  {
    const spots: [number, number, -1 | 1, number, number, number][] = [
      // s0, s1, side, inset0, inset1, spacing
      [168, 212, -1, 6, 13, 14], [252, 292, -1, 5, 24, 10], [366, 380, 1, 6, 28, 7], [430, 440, 1, 6, 28, 5],
    ];
    let k = 0;
    const blossoms = trees.filter((t) => t.species === 'cherry');
    for (const [s0, s1, side, i0, i1, sp] of spots) {
      for (let s = s0; s < s1; s += sp) {
        k++;
        const ss = s + (hash2(k, 5, 31) - 0.5) * sp * 0.6;
        const p = bankPoint(ss, side, i0 + hash2(k, 6, 31) * (i1 - i0));
        if (DOCKS.some((d) => d.side === side && Math.abs(d.s - ss) < 14) || BRIDGES.some((b) => Math.abs(b.s - ss) < b.deckWidth * 0.5 + 8)) continue;
        if (SITES.some((q) => footprintDistance({ ...q, margin: 3.2 }, p.x, p.z) < 0)) continue;
        if (hidesFacade(p.x, p.z, 3, 6)) continue;
        if (S('path', p.x, p.z) > 0.3 || (o.excluded && o.excluded(p.x, p.z))) continue;
        const y = o.heightAt(p.x, p.z);
        if (y < 0.6 || w.normalAt(p.x, p.z).y < 0.85) continue;
        if (blossoms.some((t) => Math.abs(t.x - p.x) < 6 && Math.abs(t.z - p.z) < 6)) continue;
        const seed = hash2(k, 7, 31);
        const t: ForestTree = { species: 'cherry', variant: seed < 0.5 ? 0 : 1, x: p.x, y: y - 0.2, z: p.z, yaw: hash2(k, 8, 31) * 6.283, scale: 1.15 + 0.35 * hash2(k, 9, 31), seed };
        trees.push(t);
        blossoms.push(t);
      }
    }
  }
  // japanese maples beside the temple steps and the shrine
  const maples: [number, -1 | 1, number][] = [[418, 1, 12], [446, 1, 22], [262, -1, 26]];
  for (const [s, side, off] of maples) {
    for (let k = 0; k < 8; k++) {
      const p = bankPoint(s + k * 3, side, off + k * 2);
      const y = o.heightAt(p.x, p.z);
      if (y < 1 || (o.excluded && o.excluded(p.x, p.z)) || hidesFacade(p.x, p.z, 2, 6)) continue;
      trees.push({ species: 'maple', variant: 0, x: p.x, y: y - 0.2, z: p.z, yaw: s * 0.37, scale: 1.25 + (s % 7) * 0.05, seed: (s % 13) / 13 });
      break;
    }
  }
  if (o.busy) o.busy.ms += performance.now() - tSlice;
  return trees;
}
