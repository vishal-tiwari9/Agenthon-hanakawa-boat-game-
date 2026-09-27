// node materials for the wasen. each surface family answers light differently: weathered cedar
// planking (dry and bleached above, dark and wet at the waterline, copper nails with verdigris),
// woven toma matting (fibrous, rough, mottled with age), bamboo (waxy skin, nodes), tatami, straw
// rope, a paper lantern that glows through, lacquer, iron, copper and bronze.
import { DoubleSide, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, Vector3, type Material, type Texture } from 'three/webgpu';
import {
  TBNViewMatrix, abs, attribute, clamp, cos, dot, exp, faceDirection, float, floor, fract, fwidth, hash, max, min, mix, normalize, oneMinus,
  positionLocal, sin, smoothstep, sqrt, step, texture, transformNormalToView, uniform, uniformArray, uv, varying, vec2, vec3,
} from 'three/tsl';
import { uTime } from '../../core/uniforms';
import { flicker, lampLevel } from '../../structures/night';

type N = any;

export interface BoatTextures {
  detail: Texture;
  plankD: Texture;
  plankN: Texture;
  plankA: Texture;
  tatamiD: Texture;
  tatamiN: Texture;
  tatamiA: Texture;
  thatchD: Texture;
  thatchN: Texture;
  clothD: Texture;
  clothN: Texture;
  lantern: Texture;
}

export interface Finish {
  id: string;
  name: string;
  unlock?: string;
  group: 'hull' | 'canopy' | 'lantern';
}

export const FINISHES: Finish[] = [
  { id: 'natural', name: 'Weathered Cedar', group: 'hull', unlock: 'deliver incense to the temple' },
  { id: 'dark', name: 'Charred Cedar', group: 'hull', unlock: 'deliver to the lakeside teahouse' },
  { id: 'vermilion', name: 'Vermilion Trim', group: 'hull' },
  { id: 'reed', name: 'Reed Toma Canopy', group: 'canopy' },
  { id: 'indigo', name: 'Indigo Cloth Canopy', group: 'canopy', unlock: 'discover Maiden Falls' },
  { id: 'lantern-white', name: 'Paper Lantern', group: 'lantern' },
  { id: 'lantern-red', name: 'Red Lantern', group: 'lantern', unlock: 'visit the water torii' },
];

// planks inside brown_planks_03 (u centers and widths), so a strake samples a single board
const PLANK_C = [0.062, 0.182, 0.296, 0.404, 0.51, 0.612, 0.719, 0.829, 0.942];
const PLANK_W = [0.121, 0.119, 0.108, 0.109, 0.102, 0.103, 0.112, 0.107, 0.119];

/** coverage of a line of half width hw at unsigned distance d, box filtered over the pixel */
function lineCov(d: N, hw: number | N) {
  const fw = max(fwidth(d), 1e-6);
  const H = float(hw as number);
  return clamp(min(d.add(fw.mul(0.5)), H).sub(max(d.sub(fw.mul(0.5)), H.negate())).div(fw), 0, 1);
}

/** anti-aliased disc mask of radius r at distance d */
function dotMask(d: N, r: number) {
  const w = max(fwidth(d), 1e-5);
  return oneMinus(smoothstep(float(r).sub(w), float(r).add(w), d));
}

const toView = (nts: N) => (TBNViewMatrix as N).mul(normalize(nts)).normalize();

export function createMaterials(tex: BoatTextures) {
  const U: N = uv();
  const P: N = positionLocal;
  const det = (scale: number | N) => texture(tex.detail, U.mul(scale));
  const detW: N = texture(tex.detail, vec2(P.x.add(P.z.mul(0.37)), P.y.add(P.z.mul(0.61))).mul(0.45));

  const u = {
    woodTint: uniform(new Vector3(1, 1, 1)),
    woodDark: uniform(0),
    trimOn: uniform(0),
    canopyReed: uniform(1),
    lanternRed: uniform(0),
    lanternGlow: uniform(0.6),
    flagWind: uniform(0.4),
  };
  const centers = uniformArray(PLANK_C, 'float');
  const widths = uniformArray(PLANK_W, 'float');

  // ---------- weathered cedar: planking, decks, timbers ----------
  const wood = new MeshPhysicalNodeMaterial({ name: 'wasen-wood' });
  {
    const w: N = attribute('wood', 'vec4');
    const code = w.x, mode = code.sub(floor(code.div(10)).mul(10)), swap = step(9.5, code);
    const isStrake = step(0.5, mode).mul(step(mode, 1.5));
    const isPlank = step(1.5, mode);
    const seed = w.z, trim = w.w;
    const along = mix(U.x, U.y, swap), across = mix(U.y, U.x, swap);
    // strakes: across is the strake coordinate (0..3); planks: across in meters / plank width
    const pw = max(w.y, 0.02);
    const pc = mix(across.div(pw), across, isStrake);
    const planked = isStrake.add(isPlank);
    const idx = mix(float(0), floor(pc), planked);
    const f = mix(fract(across.mul(4)), fract(pc), planked);
    const h1 = hash(idx.mul(7.31).add(seed.mul(17.3)).add(500)), h2 = hash(idx.mul(3.17).add(seed.mul(5.9)).add(900));
    const j = floor(h1.mul(8.999));
    const tc: N = centers.element(j), tw: N = widths.element(j);
    const tuv = vec2(tc.add(f.sub(0.5).mul(tw).mul(0.84)), along.mul(0.4).add(h2.mul(3.7)));
    const base: N = texture(tex.plankD, tuv).rgb;
    const arm: N = texture(tex.plankA, tuv);
    const nt: N = texture(tex.plankN, tuv).xyz.mul(2).sub(1);
    // seams between boards (not at the chine or the sheer of a strake run)
    const k = floor(pc.add(0.5));
    const seamOk = mix(float(1), step(0.5, k).mul(step(k, 2.5)), isStrake).mul(planked);
    const plankM = mix(pw, w.y.div(3), isStrake);
    const sv = pc.sub(k).mul(plankM);
    const seam = lineCov(abs(sv), 0.0018).mul(seamOk);
    const groove = sv.div(0.004).mul(exp(sv.div(0.004).mul(sv.div(0.004)).negate())).mul(0.6).mul(seamOk);
    // copper nail heads in a row just above each strake seam, weeping a faint stain below
    const nz = fract(along.div(0.15).add(k.mul(0.37))).sub(0.5).mul(0.15);
    const nv = sv.sub(0.016);
    const nailD = sqrt(nz.mul(nz).add(nv.mul(nv)));
    const nail = dotMask(nailD, 0.0055).mul(seamOk).mul(isStrake);
    const weep = exp(abs(nz).div(0.0035).negate()).mul(smoothstep(0.0, -0.05, nv)).mul(smoothstep(-0.12, -0.02, nv)).mul(seamOk).mul(isStrake).mul(0.35);
    // grade: sun-bleached and dry above, dark and wet toward the waterline, faint algae line
    const y = P.y;
    const wet = oneMinus(smoothstep(-0.02, 0.07, y));
    const algae = smoothstep(-0.06, -0.01, y).mul(oneMinus(smoothstep(0.0, 0.035, y))).mul(detW.a.mul(0.6).add(0.4));
    const grain = base.mul(h2.mul(0.18).add(0.91));
    const bleach = smoothstep(0.15, 0.5, y).mul(0.08);
    let col: N = grain.mul(u.woodTint).mul(bleach.add(1));
    // charred / stained finish (yakisugi-like): darker with the grain still reading
    const lum = dot(grain, vec3(0.3, 0.55, 0.15));
    const dark = vec3(0.075, 0.062, 0.052).mul(lum.mul(2.2).add(0.35));
    col = mix(col, dark, u.woodDark);
    col = mix(col, col.mul(vec3(0.72, 0.8, 0.62)), algae.mul(0.6));
    col = col.mul(mix(float(1), float(0.5), wet));
    col = mix(col, col.mul(vec3(0.62, 0.72, 0.6)), weep);
    // vermilion lacquer on the rail and beam ends, rubbed through at worn spots
    const wear = smoothstep(0.62, 0.8, detW.a.add(texture(tex.detail, U.mul(3.1)).b.mul(0.35)));
    const lacq = trim.mul(u.trimOn).mul(oneMinus(wear.mul(0.8)));
    col = mix(col, vec3(0.5, 0.055, 0.03), lacq);
    const copper = mix(vec3(0.42, 0.22, 0.1), vec3(0.2, 0.36, 0.3), detW.b.mul(0.8));
    col = mix(col.mul(oneMinus(seam.mul(0.85))), copper, nail);
    wood.colorNode = col;
    wood.metalnessNode = nail.mul(0.55);
    wood.roughnessNode = mix(arm.g.mul(0.18).add(0.78), float(0.32), wet).sub(lacq.mul(0.45)).sub(nail.mul(0.3)).add(seam.mul(0.1));
    wood.clearcoatNode = max(lacq.mul(0.7), wet.mul(0.45));
    wood.clearcoatRoughnessNode = mix(float(0.12), float(0.25), wet);
    // texture u runs across the board and v along the grain; the geometry's uv.x is along the
    // grain unless the part is swapped
    const ns = mix(float(0.9), float(0.3), lacq);
    const nx = mix(nt.y, nt.x, swap).mul(ns).sub(groove.mul(swap));
    const ny = mix(nt.x, nt.y, swap).mul(ns).sub(groove.mul(oneMinus(swap)));
    wood.normalNode = toView(vec3(nx, ny, 1));
  }

  // ---------- woven toma matting (or indigo cloth), double sided ----------
  const canopy = new MeshPhysicalNodeMaterial({ name: 'wasen-canopy', side: DoubleSide });
  {
    // u: along the boat (m), v: around the arch (m). mirror the weave band so no seam shows
    const tri = (x: N) => abs(fract(x.mul(0.5)).sub(0.5)).mul(2);
    const tuvT = vec2(U.x.div(0.8), float(0.03).add(tri(U.y.div(0.36)).mul(0.42)));
    const reedC: N = texture(tex.tatamiD, tuvT).rgb;
    const reedN: N = texture(tex.tatamiN, tuvT).xyz.mul(2).sub(1);
    const reedA: N = texture(tex.tatamiA, tuvT);
    const cuv = U.mul(1 / 0.55);
    const clothC: N = texture(tex.clothD, cuv).rgb;
    const clothN: N = texture(tex.clothN, cuv).xyz.mul(2).sub(1);
    // age: large mottled patches of grey weathering, moss green and rusty straw
    const m1: N = texture(tex.detail, U.mul(0.35)), m2: N = texture(tex.detail, U.mul(1.3).add(0.37));
    const reedLum = dot(reedC, vec3(0.3, 0.55, 0.15));
    // fresh honey-coloured reed with only light weathering, so the canopy reads warm from the follow camera
    let reed: N = mix(reedC.mul(vec3(1.04, 0.86, 0.58)), vec3(reedLum.mul(1.0), reedLum.mul(0.88), reedLum.mul(0.66)), 0.2);
    reed = mix(reed, reed.mul(vec3(0.7, 0.76, 0.5)), smoothstep(0.62, 0.9, m1.a).mul(0.35));
    reed = mix(reed, reed.mul(vec3(1.05, 0.72, 0.55)), smoothstep(0.5, 0.8, m2.b).mul(0.5));
    reed = reed.mul(m2.a.mul(0.3).add(0.72));
    // mat panels overlap every ~0.95 m along the boat, and cross ties hold the weave
    const pz = fract(U.x.div(0.95).add(0.13)).sub(0.5).mul(0.95);
    const lap = lineCov(float(0.475).sub(abs(pz)), 0.004);
    const ties = lineCov(abs(fract(U.y.div(0.24)).sub(0.5).mul(0.24)), 0.0022).mul(0.5);
    const indigo = clothC.mul(vec3(0.06, 0.1, 0.24)).mul(smoothstep(0.3, 0.9, m1.a).mul(0.35).add(0.9));
    let col: N = mix(indigo, reed, u.canopyReed);
    col = col.mul(oneMinus(lap.mul(0.45))).mul(oneMinus(ties.mul(u.canopyReed)));
    // the inside is shaded by the mat itself and a touch sootier
    col = mix(col.mul(0.72), col, faceDirection.mul(0.5).add(0.5));
    canopy.colorNode = col;
    canopy.roughnessNode = mix(float(0.85), reedA.g.mul(0.12).add(0.82), u.canopyReed);
    canopy.sheenNode = mix(vec3(0.1, 0.12, 0.2), vec3(0.3, 0.27, 0.2), u.canopyReed);
    canopy.sheenRoughnessNode = float(0.6);
    const n: N = mix(clothN, reedN.mul(vec3(1.4, 1.4, 1)), u.canopyReed);
    canopy.normalNode = toView(vec3(n.x, n.y.sub(lap.mul(0.4)), n.z));
  }

  // ---------- bamboo: hoops, ridge pole, lantern pole ----------
  const bamboo = new MeshPhysicalNodeMaterial({ name: 'wasen-bamboo' });
  {
    const nodeGap = 0.3;
    const q = fract(U.x.div(nodeGap).add(attribute('seed', 'float').mul(0.37)));
    const dq = min(q, oneMinus(q)).mul(nodeGap);
    const ring = exp(dq.div(0.006).mul(dq.div(0.006)).negate());
    const streak = texture(tex.detail, vec2(U.x.mul(0.6), U.y.mul(9))).b;
    let col: N = mix(vec3(0.46, 0.38, 0.2), vec3(0.56, 0.47, 0.27), streak);
    col = mix(col, vec3(0.26, 0.2, 0.1), ring.mul(0.7));
    col = col.mul(texture(tex.detail, U.mul(0.9)).a.mul(0.3).add(0.8));
    bamboo.colorNode = col;
    bamboo.roughnessNode = float(0.42).add(ring.mul(0.2));
    bamboo.clearcoatNode = float(0.35);
    bamboo.clearcoatRoughnessNode = float(0.3);
    const bump = fract(U.x.div(nodeGap)).sub(0.5).sign().mul(ring).mul(0.8);
    bamboo.normalNode = toView(vec3(bump.negate(), streak.sub(0.5).mul(0.15), 1));
  }

  // ---------- tatami ----------
  const tatami = new MeshPhysicalNodeMaterial({ name: 'wasen-tatami' });
  {
    const tuv = U.div(1.82);
    tatami.colorNode = texture(tex.tatamiD, tuv).rgb.mul(vec3(0.95, 0.9, 0.78)).mul(det(0.8).a.mul(0.18).add(0.86));
    tatami.roughnessNode = texture(tex.tatamiA, tuv).g.mul(0.2).add(0.68);
    const n: N = texture(tex.tatamiN, tuv).xyz.mul(2).sub(1);
    tatami.normalNode = toView(n);
    tatami.sheenNode = vec3(0.18, 0.17, 0.12);
    tatami.sheenRoughnessNode = float(0.5);
  }

  // ---------- straw rope (warazuna) ----------
  const rope = new MeshPhysicalNodeMaterial({ name: 'wasen-rope' });
  {
    const lay = 0.05, circ = 2 * Math.PI * 0.009;
    const ph = U.x.div(lay).add(U.y.div(circ)).mul(2);
    const f = fract(ph).mul(2).sub(1);
    const crev = smoothstep(0.5, 1.0, abs(f));
    const fib = texture(tex.detail, U.mul(vec2(1 / 0.03, 1 / 0.01))).b;
    rope.colorNode = vec3(0.5, 0.4, 0.22).mul(oneMinus(crev.mul(0.55))).mul(fib.mul(0.35).add(0.8));
    rope.roughnessNode = float(0.92);
    const g = new Vector3(1 / lay, 1 / circ, 0).normalize();
    rope.normalNode = toView(vec3(f.mul(-0.8 * g.x), f.mul(-0.8 * g.y), 1));
    rope.sheenNode = vec3(0.45, 0.38, 0.22);
    rope.sheenRoughnessNode = float(0.45);
  }

  // ---------- straw (mino cape, bundles) ----------
  const straw = new MeshPhysicalNodeMaterial({ name: 'wasen-straw', side: DoubleSide });
  {
    const tuv = U.mul(vec2(1 / 0.5, 1 / 0.5));
    const c: N = texture(tex.thatchD, tuv).rgb;
    straw.colorNode = c.mul(vec3(1.45, 1.25, 0.88)).mul(texture(tex.detail, U.mul(0.7)).a.mul(0.3).add(0.8));
    straw.roughnessNode = float(0.9);
    straw.normalNode = toView(texture(tex.thatchN, tuv).xyz.mul(2).sub(1).mul(vec3(1.3, 1.3, 1)));
    straw.sheenNode = vec3(0.35, 0.3, 0.18);
    straw.sheenRoughnessNode = float(0.5);
  }

  // ---------- paper lantern: glows through, lacquered rims ----------
  const lantern = new MeshPhysicalNodeMaterial({ name: 'wasen-lantern' });
  {
    const paper: N = attribute('paper', 'float');
    const ribs = lineCov(abs(fract(U.y.div(0.022)).sub(0.5)).mul(0.022), 0.0012);
    const print: N = texture(tex.lantern, U);
    const paperCol = mix(vec3(0.8, 0.77, 0.68), vec3(0.62, 0.06, 0.035), u.lanternRed);
    let col: N = paperCol.mul(oneMinus(ribs.mul(0.35)));
    col = mix(col, vec3(0.02, 0.018, 0.016), print.a.mul(0.92));
    lantern.colorNode = mix(vec3(0.015, 0.013, 0.012), col, paper);
    const glowCol = mix(vec3(1.0, 0.78, 0.5), vec3(1.0, 0.25, 0.1), u.lanternRed);
    // the candle burns brighter from dusk (lampLevel is 0 in the authored day)
    const glow: N = u.lanternGlow.add(lampLevel.mul(flicker(0.37)).mul(3.2));
    lantern.emissiveNode = glowCol.mul(glow).mul(paper).mul(oneMinus(ribs.mul(0.5))).mul(oneMinus(print.a.mul(0.9)));
    lantern.roughnessNode = mix(float(0.22), float(0.7), paper);
    lantern.clearcoatNode = oneMinus(paper);
    lantern.clearcoatRoughnessNode = float(0.12);
    lantern.sheenNode = vec3(0.2).mul(paper);
  }

  // ---------- metals: iron, copper, bronze via per-vertex tint and (metalness, roughness) ----------
  const metal = new MeshPhysicalNodeMaterial({ name: 'wasen-metal' });
  {
    const tint: N = attribute('tint', 'vec3');
    const mr: N = attribute('mr', 'vec2');
    const pat = det(6).a;
    metal.colorNode = tint.mul(pat.mul(0.35).add(0.75));
    metal.metalnessNode = mr.x;
    metal.roughnessNode = mr.y.add(pat.mul(0.15));
  }

  // ---------- cloth (boatman) ----------
  const cloth = new MeshPhysicalNodeMaterial({ name: 'wasen-cloth' });
  {
    const tint: N = attribute('tint', 'vec3');
    const cuv = U.mul(1 / 0.3);
    cloth.colorNode = tint.mul(texture(tex.clothD, cuv).rgb.mul(1.2));
    cloth.roughnessNode = float(0.92);
    cloth.normalNode = toView(texture(tex.clothN, cuv).xyz.mul(2).sub(1));
    cloth.sheenNode = tint.mul(0.6);
    cloth.sheenRoughnessNode = float(0.6);
  }

  // ---------- flag-like streamer on the lantern pole: vertex flutter in the shared wind ----------
  const flag = new MeshStandardNodeMaterial({ name: 'wasen-streamer', side: DoubleSide });
  {
    const L = 0.5;
    const t: N = uTime;
    const x = P.x, ux = clamp(x.div(L), 0, 1);
    const k = (2 * Math.PI) / 0.3;
    const wv = u.flagWind.mul(8).add(5);
    const amp = u.flagWind.mul(-0.015).add(0.035).mul(ux.pow(1.2));
    const ph = x.mul(k).sub(t.mul(wv));
    const dz = amp.mul(sin(ph).add(sin(ph.mul(2.3).add(1.1)).mul(0.35)));
    const droop = oneMinus(u.flagWind).mul(0.12).mul(ux.mul(ux));
    flag.positionNode = vec3(P.x.sub(abs(dz).mul(0.2)).sub(droop.mul(0.3)), P.y.sub(droop), dz);
    const dzdx = amp.mul(cos(ph).mul(k).add(cos(ph.mul(2.3).add(1.1)).mul(0.805 * k)));
    const nLocal = varying(normalize(vec3(dzdx.negate(), 0, 1)), 'vStreamerN');
    flag.normalNode = transformNormalToView(normalize(nLocal)).mul(faceDirection);
    flag.colorNode = vec3(0.5, 0.05, 0.03);
    flag.roughnessNode = float(0.8);
  }

  const materials: Record<string, Material> = { wood, canopy, bamboo, tatami, rope, straw, lantern, metal, cloth, flag };

  const set = (id: string) => {
    const f = FINISHES.find((x) => x.id === id);
    if (!f) return false;
    if (f.group === 'hull') {
      u.woodDark.value = id === 'dark' ? 1 : 0;
      u.trimOn.value = id === 'vermilion' ? 1 : 0;
      // warm honeyed cedar; the charred finish keeps its own neutral base
      if (id === 'dark') (u.woodTint.value as Vector3).set(0.98, 0.93, 0.86);
      else (u.woodTint.value as Vector3).set(1.12, 0.92, 0.72);
    } else if (f.group === 'canopy') u.canopyReed.value = id === 'reed' ? 1 : 0;
    else u.lanternRed.value = id === 'lantern-red' ? 1 : 0;
    return true;
  };
  set('vermilion');

  return {
    materials,
    uniforms: u,
    set,
    dispose() {
      for (const k in materials) materials[k].dispose();
    },
  };
}

export type BoatMaterials = ReturnType<typeof createMaterials>;
