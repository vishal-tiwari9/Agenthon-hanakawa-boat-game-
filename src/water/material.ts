// the river surface material. a MeshStandardNodeMaterial with its own lighting model so it plugs into
// the scene's lights (sun with shadows, csm, hemisphere/probes, scene.environment irradiance) while
// every water term is computed here:
//  - analytic gerstner normals (the few-centimetre wind chop of src/world/waves.ts) per pixel
//  - ripple normals advected along the baked river current (flowX/flowZ) with a two-phase flow map,
//    lively in the current and glassy in slack water and the lake, plus faint wind cat's paws
//  - near-mirror planar reflection (projective, gently normal-distorted and bent into bands by the
//    wake swells, never smeared) with an
//    environment fallback and schlick fresnel for water (f0 0.02)
//  - refraction of the riverbed with halo rejection; beer-lambert absorption along the view and sun
//    paths (depth buffer + baked height) and single-scatter in-scattering tuned to a jade/teal river
//  - ggx sun glints whose roughness grows with the slope variance the pixel cannot resolve (lean)
//  - foam only where it belongs: gentle lapping at the banks, current breaking on rocks, falls and
//    weir churn (capsule sources); the boat's waves (./wake sim) shade and bend the mirror, never whiten
//  - hull mask from the boat model's tsl hull lines: no water inside the boat below the gunwale
//  - time and weather (src/core/daycycle.ts): rain rings and rain roughness, storm chop, a lightning lift
//    on the reflection and specular, a darker body at night (the key light is the moon then, so its glint is the moon's), warm twilight. every term
//    is neutral (x1, +0) or skipped by a uniform branch while the day cycle sits at its defaults
import { Color, LightingModel, Matrix4, MeshStandardNodeMaterial, Texture, Vector2, Vector3, Vector4 } from 'three/webgpu';
import {
  D_GGX, F_Schlick, If, V_GGX_SmithCorrelated, abs, cameraPosition, cameraProjectionMatrix, cameraProjectionMatrixInverse,
  cameraViewMatrix, cameraWorldMatrix, clamp, cos, dot, exp, float, floor, fract, fwidth, getViewPosition, log2, max, min, mix,
  normalize, pmremTexture, positionView, positionWorld, pow, reflect, reflector, saturate, screenUV, select, sin,
  smoothstep, sqrt, texture, uniform, uniformArray, varying, vec2, vec3, vec4, viewportDepthTexture, viewportSharedTexture,
} from 'three/tsl';
import type { WorldData } from '../world/worldData';
import { uTime, uWaveAmp } from '../core/uniforms';
import { hullLines } from '../boat/model/hullNodes';
import { clipmapRest } from './clipmap';
import { gerstnerDisplacement, gerstnerNormal } from './gerstner';

type N = any;

/** ripple layers advected by the current: tile (m), texture rotation (deg), slope amplitude */
export const FLOW_LAYERS = [
  { tile: 3.4, angleDeg: 17, amp: 0.026 },
  { tile: 1.15, angleDeg: -41, amp: 0.012 },
];
/** wind cat's paws, scrolled downwind */
export const WIND_LAYER = { tile: 8.5, speed: 0.55, amp: 0.012 };
/** max foam/churn capsule sources (falls plunge pools, weir) */
export const MAX_SOURCES = 4;

export function createWaterUniforms() {
  return {
    uProj: uniform(new Vector2(1, 1)),
    uReflOn: uniform(1),
    uReflH: uniform(540),
    uReflDistort: uniform(0.55),
    /** how far the wake ridges bend the mirror (fraction of the true reflected-ray tilt): they slice it into bands */
    uReflWake: uniform(1.7),
    /** cap on the reflection blur mip: ripples break the mirror, they never smear it */
    uReflMaxLod: uniform(1.6),
    uSunCosRefr: uniform(0.82),
    uFlowPeriod: uniform(1.7),
    uWindDirR: uniform(new Vector2(1, 0)),
    uWindOff: uniform(new Vector2()),
    uRippleAmp: uniform(1),
    uGustOff: uniform(new Vector2()),
    // absorption and scattering (1/m): a clear but green-tinted river (dissolved organics absorb blue)
    uSigmaA: uniform(new Vector3(0.45, 0.1, 0.115)),
    uSigmaS: uniform(new Vector3(0.036, 0.042, 0.038)),
    uScatterGain: uniform(0.5),
    uFoamGain: uniform(1),
    uGlint: uniform(1),
    uSkyHorizon: uniform(new Color(0.62, 0.76, 0.88)),
    uSkyZenith: uniform(new Color(0.16, 0.36, 0.7)),
    // time and weather (set each frame from ctx.services.day; the defaults are exactly neutral)
    /** sky fallback grade: desaturation (overcast), then horizon/zenith tints and an additive flash lift */
    uSkyDesat: uniform(0),
    uSkyTintH: uniform(new Color(1, 1, 1)),
    uSkyTintZ: uniform(new Color(1, 1, 1)),
    uSkyAdd: uniform(new Color(0, 0, 0)),
    /** whole reflection gain (lightning) */
    uReflGain: uniform(1),
    /** in-scatter tint: navy and darker at night, warm at twilight, greyer under cloud */
    uBodyTint: uniform(new Color(1, 1, 1)),
    /** flow ripple amplitude (storm chop) */
    uChop: uniform(1),
    /** rain on the surface 0..1+: ring layers and roughness */
    uRainK: uniform(0),
    /** lightning sheen on the fresnel reflection */
    uFlashCol: uniform(new Color(0, 0, 0)),
    uBoatInv: uniform(new Matrix4()),
    uMaskOn: uniform(0),
    uWakeOn: uniform(0),
    /** weir crest point and upstream tangent (x, z, tx, tz); (half width, pool drop below the crest) */
    uWeir: uniform(new Vector4(0, 1e5, 0, -1)),
    uWeirB: uniform(new Vector2(20, 0)),
    /** capsule sources: a = (x0, z0, x1, z1), b = (radius, foam, churn, 0) */
    uSrcA: uniformArray(Array.from({ length: MAX_SOURCES }, () => new Vector4()), 'vec4'),
    uSrcB: uniformArray(Array.from({ length: MAX_SOURCES }, () => new Vector4()), 'vec4'),
    /** 0 = final, 1 = reflection, 2 = refraction*transmit, 3 = foam, 4 = normal, 5 = in-scatter, 6 = wake, 7 = flow */
    uDebug: uniform(0),
  };
}

export type WaterUniforms = ReturnType<typeof createWaterUniforms>;

export interface WakeBinding {
  /** wave sim display: r = height (m), g/b = slope (dh/dx, dh/dz), a = turbulence */
  texture: Texture;
  /** quarter-res low-passed height for vertex displacement */
  low: Texture;
  uCenter: N;
  uSize: N;
  uTexel: N;
  res: () => number;
}

export class WaterMaterial extends MeshStandardNodeMaterial {
  surfaceFn: (() => any) | null = null;
  constructor() {
    super();
    this.transparent = true;
    this.depthWrite = true;
    this.fog = true;
  }
  setupLightingModel() {
    return new WaterLightingModel(this) as any;
  }
}

class WaterLightingModel extends LightingModel {
  private s: any = null;
  constructor(private mat: WaterMaterial) {
    super();
  }
  start(builder: any) {
    this.s = this.mat.surfaceFn!();
    super.start(builder);
  }
  direct({ lightDirection, lightColor, reflectedLight }: any) {
    const s = this.s;
    const L = normalize(cameraWorldMatrix.mul(vec4(lightDirection, 0)).xyz);
    const nl = saturate(dot(s.N, L));
    const H = normalize(L.add(s.V));
    const nh = saturate(dot(s.N, H));
    const vh = saturate(dot(s.V, H));
    const D = D_GGX({ alpha: s.alpha, dotNH: nh });
    const Vis = V_GGX_SmithCorrelated({ alpha: s.alpha, dotNL: nl, dotNV: s.nv });
    const F = F_Schlick({ f0: vec3(0.02), f90: float(1), dotVH: vh });
    const glint = (F as N).mul(D).mul(Vis).mul(nl).mul(s.specMask);
    reflectedLight.directSpecular.addAssign(lightColor.mul(glint));
    // sunlight entering the water column (shadowed by the light's own shadow term)
    const eIn = lightColor.mul(max(L.y, 0)).mul(0.97);
    const body = s.scatter.mul(s.inscatter).mul(s.bodyMask).mul(1 / Math.PI);
    const foamLit = s.foamAlbedo.mul(nl.mul(0.65).add(0.35)).mul(s.foam).mul(1 / Math.PI);
    reflectedLight.directDiffuse.addAssign(eIn.mul(body).add(lightColor.mul(foamLit)));
  }
  indirect(builder: any) {
    const s = this.s;
    const { irradiance, iblIrradiance, reflectedLight } = builder.context;
    const amb = irradiance.add(iblIrradiance).mul(1 / Math.PI);
    reflectedLight.indirectSpecular.addAssign(s.reflection.mul(s.reflMask));
    // lightning: the whole sky lights up for a moment, so the fresnel reflection flares
    reflectedLight.indirectSpecular.addAssign(vec3(s.flashCol).mul(s.reflMask));
    const body = s.refraction.mul(s.transmit).add(amb.mul(s.scatter).mul(s.inscatter)).mul(s.bodyMask);
    reflectedLight.indirectDiffuse.addAssign(body.add(amb.mul(s.foamAlbedo).mul(s.foam)));
    // debug views replace the whole result
    const dbg = s.debug;
    If(dbg.greaterThan(0.5), () => {
      reflectedLight.directDiffuse.assign(vec3(0));
      reflectedLight.directSpecular.assign(vec3(0));
      reflectedLight.indirectSpecular.assign(vec3(0));
      reflectedLight.indirectDiffuse.assign(select(dbg.lessThan(1.5), s.reflection,
        select(dbg.lessThan(2.5), s.refraction.mul(s.transmit),
        select(dbg.lessThan(3.5), vec3(s.foam),
        select(dbg.lessThan(4.5), s.N.mul(0.5).add(0.5),
        select(dbg.lessThan(5.5), amb.mul(s.scatter).mul(s.inscatter),
        select(dbg.lessThan(6.5), s.wakeDbg, s.flowDbg)))))));
    });
  }
  ambientOcclusion() {}
  finish() {}
}

export interface BuildOptions {
  world: WorldData;
  u: WaterUniforms;
  ripple: Texture;
  foam: Texture;
  /** packed world channels (see createWorldPack): r height, g flowX, b flowZ, a waveScale */
  worldPack: Texture;
  wake: WakeBinding;
  reflectionScale: number;
  reflectionSamples: number;
  env: Texture | null;
}

/** sine-free 2d hash (dave hoskins hash22): two values in [0, 1) */
function hash22(p: N): N {
  let p3: N = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.103, 0.0973)));
  p3 = p3.add(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.xx.add(p3.yz).mul(p3.zy));
}

/**
 * one layer of rain rings: every `cell` metres a drop lands at a random spot and a ring runs out and
 * fades, `rate` times a second, in a random fraction `cover` of the cells. rings stay inside their cell
 * (centre in the middle third, radius < 0.3 cell) so one cell lookup is enough. returns the surface
 * slope, faded out where the pixel footprint is wider than the ring (the caller adds that as roughness)
 */
function rainRings(p: N, t: N, cell: number, rate: number, cover: N, seed: number, footprint: N): N {
  const q = p.div(cell).add(seed);
  const id = floor(q), f = fract(q);
  const h0 = hash22(id);
  const ph = t.mul(h0.y.mul(0.4).add(0.8).mul(rate)).add(h0.x);
  const n = floor(ph), a = fract(ph);
  const h1 = hash22(id.add(n.mul(vec2(7.31, 3.17))));
  const live = select(fract(h1.x.add(h1.y).mul(17.13)).lessThan(cover), float(1), float(0));
  const dv = f.sub(h1.mul(0.36).add(0.32));
  const d = max(dv.length(), 1e-3);
  const w = a.mul(0.04).add(0.06);
  const x = d.sub(a.mul(0.3)).div(w);
  const prof = exp(x.mul(x).negate()).mul(cos(x.mul(2.2)));
  const fade = float(1).sub(smoothstep(0.35 * 0.06 * cell, 1.2 * 0.06 * cell, footprint));
  const life = float(1).sub(a);
  const amp = life.mul(life).mul(live).mul(fade);
  return dv.div(d).mul(prof.mul(amp));
}

/** distance from p to the segment a-b (all vec2 nodes) */
function segDist(p: N, a: N, b: N): N {
  const ab = b.sub(a);
  const t = saturate(dot(p.sub(a), ab).div(max(dot(ab, ab), 1e-4)));
  return p.sub(a.add(ab.mul(t))).length();
}

export function buildWaterMaterial(o: BuildOptions) {
  const { world, u } = o;
  const mat = new WaterMaterial();
  const pack = (xz: N, level?: number): N => texture(o.worldPack, vec2(xz).div(world.size).add(0.5), level as any);

  // ---------- vertex: clipmap rest point, gerstner displacement, wake height ----------
  const { rest, spacing } = clipmapRest();
  const sV = pack(rest, 0).a.mul(uWaveAmp);
  const disp = gerstnerDisplacement(rest, sV, spacing);
  const wakeTex = o.wake.texture;
  const wakeUV = (xz: N) => xz.sub(o.wake.uCenter).div(o.wake.uSize).add(0.5);
  const wakeEdge = (uv: N) =>
    smoothstep(0, 0.07, uv.x).mul(smoothstep(1, 0.93, uv.x)).mul(smoothstep(0, 0.07, uv.y)).mul(smoothstep(1, 0.93, uv.y));
  const wvUV = wakeUV(rest);
  // the ripples are finer than the clipmap: displace with the low-passed height, shade with the full slope
  const wakeH = texture(o.wake.low, wvUV, 0).r.mul(wakeEdge(wvUV)).mul(u.uWakeOn);
  // downstream of the weir the pool sits lower; the surface curves over the crest like the nappe
  const wr = rest.sub(u.uWeir.xy);
  const along = dot(wr, u.uWeir.zw);
  const lat = abs(dot(wr, vec2(u.uWeir.w.negate(), u.uWeir.z)));
  const below = float(1).sub(smoothstep(-1.4, 0.05, along)).mul(float(1).sub(smoothstep(u.uWeirB.x, u.uWeirB.x.add(8), lat))).mul(smoothstep(-260, -220, along));
  const level = below.mul(u.uWeirB.y).negate();
  mat.positionNode = vec3(rest.x.add(disp.x), disp.y.add(wakeH).add(level), rest.y.add(disp.z));
  const vRest: N = varying(rest, 'vRest');

  // ---------- hull mask (the boat model's own tsl hull lines) ----------
  const hull = hullLines();
  const lp: N = (u.uBoatInv as N).mul(vec4(positionWorld, 1)).xyz;
  mat.maskNode = hull.inside(lp, 0.015).and(u.uMaskOn.greaterThan(0.5)).not();

  // ---------- reflection ----------
  const refl: N = reflector({ resolutionScale: o.reflectionScale, bounces: false, generateMipmaps: true, samples: o.reflectionSamples });
  refl.target.rotateX(-Math.PI / 2);

  const envTex = o.env;
  const up = vec3(0, 1, 0);

  mat.surfaceFn = () => {
    const P = positionWorld.toVar('wP');
    const toCam = cameraPosition.sub(P);
    const dist = toCam.length().toVar('wDist');
    const V = toCam.div(dist).toVar('wV');
    const r = vec2(vRest).toVar('wRest');
    const fw = fwidth(r);
    const footprint = max(max(fw.x, fw.y), 1e-4).toVar('wFoot');
    const t = uTime;

    // world channels
    const waveScale = pack(r).a.toVar('wScale');
    const wp4 = pack(P.xz).toVar('wPack');
    const terrainH = wp4.r.toVar('wTerrain');
    const flow = vec2(wp4.g, wp4.b).toVar('wFlow');
    const speed = flow.length().toVar('wSpeed');
    const current = smoothstep(0.03, 0.42, speed).toVar('wCurrent');

    // wake
    const wuv = wakeUV(P.xz);
    const wEdge = wakeEdge(wuv).mul(u.uWakeOn).toVar('wWakeEdge');
    const wt = o.wake.uTexel;
    const wc = texture(wakeTex, wuv).toVar('wWake');
    // the sim has no mips: where a pixel spans several sim cells the ripples fade into roughness instead
    // of aliasing into shimmer
    const wakeAA = float(1).sub(smoothstep(wt.mul(1.2), wt.mul(4), footprint)).toVar('wWakeAA');
    const wakeRaw = wc.gb.mul(wEdge);
    const wakeSlope = wakeRaw.mul(wakeAA).toVar('wWakeSlope');
    const wakeLost = dot(wakeRaw, wakeRaw).mul(float(1).sub(wakeAA)).mul(0.5);
    const wakeFoam = float(0);
    const wakeTurb = saturate(wc.a.mul(wEdge)).toVar('wWakeTurb');

    // falls / weir churn: capsule sources
    let srcFoam: N = float(0);
    let churn: N = float(0);
    for (let i = 0; i < MAX_SOURCES; i++) {
      const a: N = u.uSrcA.element(i), b: N = u.uSrcB.element(i);
      const d = segDist(P.xz, a.xy, a.zw);
      const k = float(1).sub(smoothstep(b.x.mul(0.25), b.x, d));
      srcFoam = max(srcFoam, k.mul(b.y));
      churn = max(churn, k.mul(b.z));
    }
    const srcFoamV = srcFoam.toVar('wSrcFoam');
    const churnV = churn.toVar('wChurn');

    // two-phase flow map timing, phase jittered per region so resets never pulse in unison
    const jitter = texture(o.foam, P.xz.mul(1 / 19)).b;
    const cyc = t.div(u.uFlowPeriod).add(jitter).toVar('wCyc');
    const f0 = fract(cyc), f1 = fract(cyc.add(0.5));
    const wA = float(1).sub(abs(f0.mul(2).sub(1))).toVar('wFlowW');
    const adv0 = flow.mul(f0.mul(u.uFlowPeriod)), adv1 = flow.mul(f1.mul(u.uFlowPeriod));

    // broad chop: analytic gerstner normal at the rest point
    const g = gerstnerNormal(r, waveScale.mul(uWaveAmp), footprint);
    const gs = g.n.xz.negate().div(g.n.y);

    // ripples: flow layers (lean moments blended across the two phases) + downwind cat's paws
    let rs: N = vec2(0);
    let rv: N = float(0);
    const flowAmp = mix(0.2, 1, current).mul(u.uChop).mul(churnV.mul(2.5).add(1)).mul(mix(float(1), float(0.55), saturate(wakeTurb.mul(1.6)))).mul(wakeFoam.mul(1.2).add(1));
    FLOW_LAYERS.forEach((l, j) => {
      const ang = (l.angleDeg * Math.PI) / 180;
      const dir = vec2(Math.cos(ang), Math.sin(ang)), perp = vec2(-Math.sin(ang), Math.cos(ang));
      const toUV = (p: N) => vec2(dot(p, dir), dot(p, perp)).div(l.tile);
      const ta = texture(o.ripple, toUV(r.sub(adv0)));
      const tb = texture(o.ripple, toUV(r.sub(adv1)).add(vec2(0.37 + j * 0.21, 0.19)));
      const m = mix(tb, ta, wA);
      const a = flowAmp.mul(l.amp);
      rs = rs.add(dir.mul(m.x).add(perp.mul(m.y)).mul(a));
      rv = rv.add(max(m.z.sub(m.x.mul(m.x)), 0).add(max(m.w.sub(m.y.mul(m.y)), 0)).mul(a.mul(a)).mul(0.5));
    });
    {
      const wd = u.uWindDirR, wp = vec2(wd.y.negate(), wd.x);
      const tw = texture(o.ripple, vec2(dot(r, wd), dot(r, wp)).div(WIND_LAYER.tile).add(u.uWindOff));
      const gust = smoothstep(0.35, 0.95, texture(o.foam, r.mul(1 / 260).add(u.uGustOff)).g);
      const a = u.uRippleAmp.mul(gust.mul(0.9).add(0.25)).mul(WIND_LAYER.amp);
      rs = rs.add(wd.mul(tw.x).add(wp.mul(tw.y)).mul(a));
      rv = rv.add(max(tw.z.sub(tw.x.mul(tw.x)), 0).add(max(tw.w.sub(tw.y.mul(tw.y)), 0)).mul(a.mul(a)).mul(0.5));
    }
    // rain: two ring layers (the second on a rotated grid) plus roughness where the rings are sub-pixel;
    // the wave sim already carries its own rain rings around the boat, so these ease off there
    const rainS = vec2(0).toVar('wRainS');
    const rainV = float(0).toVar('wRainV');
    If(u.uRainK.greaterThan(0.001), () => {
      const cover = saturate(u.uRainK.mul(0.8));
      const e1 = vec2(0.799, 0.602), e2 = vec2(-0.602, 0.799);
      const s1 = rainRings(r, t, 0.7, 1.25, cover, 0, footprint);
      const s2 = rainRings(vec2(dot(r, e1), dot(r, e2)), t, 0.45, 1.6, cover, 17, footprint);
      const k = min(u.uRainK, 1.5).mul(0.3).mul(float(1).sub(wEdge.mul(0.4)));
      rainS.assign(s1.add(e1.mul(s2.x)).add(e2.mul(s2.y)).mul(k));
      rainV.assign(u.uRainK.mul(smoothstep(0.008, 0.04, footprint).mul(0.0016).add(0.0005)));
    });
    rs = rs.add(rainS);
    rv = rv.add(rainV);
    const slope = gs.add(rs).add(wakeSlope).toVar('wSlope');
    const variance = rv.add(g.lost).add(wakeLost).add(wakeTurb.mul(0.0006)).add(churnV.mul(0.02)).toVar('wVar');

    let Nn: N = normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
    // keep micro-facets from facing away at grazing angles
    const nvRaw = dot(Nn, V);
    Nn = normalize(Nn.add(V.mul(max(float(0.03).sub(nvRaw), 0))));
    const N = Nn.toVar('wN');
    const nv = saturate(dot(N, V)).toVar('wNV');

    // ---------- depth: depth buffer + baked height ----------
    const waterViewZ = positionView.z;
    const d0 = viewportDepthTexture(screenUV).x;
    const vp0 = getViewPosition(screenUV, d0, cameraProjectionMatrixInverse);
    const thick0 = max(vp0.length().sub(positionView.length()), 0).toVar('wThick0');
    const sky0 = d0.greaterThanEqual(0.999999);
    const contact = select(sky0, float(1), smoothstep(0.0, 0.1, thick0)).toVar('wContact');

    // refraction offset from the normal tilt in view space, scaled by how much water there is
    const dn = cameraViewMatrix.mul(vec4(N.sub(up), 0)).xy;
    const refrDepth = select(sky0, float(2), min(thick0, 2.5));
    // the wake ripples also wobble the riverbed seen through them
    const dnW = cameraViewMatrix.mul(vec4(wakeSlope.x.negate(), 0, wakeSlope.y.negate(), 0)).xy;
    const off = vec2(dn.x.mul(u.uProj.x), dn.y.mul(u.uProj.y).negate()).mul(refrDepth).mul(0.22).div(max(dist, 1))
      .add(vec2(dnW.x.mul(u.uProj.x), dnW.y.mul(u.uProj.y).negate()).mul(min(refrDepth, 1.6)).mul(0.45).div(max(dist, 1)));
    const uvD = screenUV.add(off);
    const dD = viewportDepthTexture(uvD).x;
    const vpD = getViewPosition(uvD, dD, cameraProjectionMatrixInverse);
    // halo rejection: the distorted sample must lie behind the water surface
    const ok = vpD.z.lessThan(waterViewZ.sub(0.02));
    const uvR = select(ok, uvD, screenUV);
    const dR = select(ok, dD, d0);
    const vpR = select(ok, vpD, vp0);
    const sceneCol = viewportSharedTexture(uvR).rgb;
    const skyR = dR.greaterThanEqual(0.999999);
    const Po = cameraWorldMatrix.mul(vec4(vpR, 1)).xyz;

    const vertDepth = max(P.y.sub(terrainH), 0).toVar('wVert');
    const sinT2 = float(1).sub(V.y.mul(V.y)).div(1.769);
    const cosTv = sqrt(max(float(1).sub(sinT2), 0.2));
    const lh = vertDepth.div(cosTv);
    const lView = select(skyR, lh, min(Po.sub(P).length(), lh.mul(2).add(3)));
    const dObj = select(skyR, vertDepth, max(P.y.sub(Po.y), 0));
    const lSun = dObj.div(u.uSunCosRefr);

    // ---------- foam ----------
    const along = texture(o.foam, P.xz.mul(1 / 13)).b;
    const lap = sin(t.mul(1.1).add(along.mul(9))).mul(0.5).add(0.5);
    // gentle lapping line where the surface meets the bank
    const wash = float(1).sub(smoothstep(0.0, 0.09, vertDepth)).mul(lap.mul(0.5).add(0.3)).mul(along.mul(0.8).add(0.2)).mul(0.6);
    // current breaking on rocks, boulders and piles (contact from the depth buffer)
    const Po0 = cameraWorldMatrix.mul(vec4(vp0, 1)).xyz;
    const d3 = select(sky0, float(99), Po0.sub(P).length());
    // no contact foam against the player's hull: its bow wave and wake foam come from the wake sim, and
    // depth-buffer contact against the planking drew a hard white rim with holes along the waterline
    const bl: N = (u.uBoatInv as N).mul(vec4(P, 1)).xyz;
    const nearHull = float(1).sub(smoothstep(0.85, 1.25, bl.x.div(1.25).mul(bl.x.div(1.25)).add(bl.z.div(4.4).mul(bl.z.div(4.4))))).mul(u.uMaskOn);
    const touch = float(1).sub(smoothstep(0.03, current.mul(0.35).add(0.12), d3)).mul(current.mul(1.1).add(0.12)).mul(along.mul(0.6).add(0.4)).mul(float(1).sub(nearHull));
    const density = max(max(wash, touch), max(srcFoamV, wakeFoam.mul(1.1))).mul(u.uFoamGain).toVar('wDensity');
    // coverage from the equalized lace field, drifting with the current (same two phases)
    const lace0 = texture(o.foam, P.xz.sub(adv0).mul(1 / 2.6)).r;
    const lace1 = texture(o.foam, P.xz.sub(adv1).mul(1 / 2.6).add(vec2(0.53, 0.29))).r;
    const thr = mix(lace1, lace0, wA).mul(0.75).add(texture(o.foam, P.xz.mul(1 / 0.9)).r.mul(0.25));
    const cover = smoothstep(thr.mul(0.85), thr.mul(0.85).add(0.28), density).mul(smoothstep(0.02, 0.4, density));
    const foam = cover.mul(select(sky0, float(1), smoothstep(0, 0.03, thick0))).toVar('wFoam');
    const bubbles = saturate(density.mul(0.5).add(wakeFoam.mul(0.4)).add(wakeTurb.mul(0.05)).add(churnV.mul(0.8))).mul(float(1).sub(foam)).toVar('wBubbles');

    // ---------- body: absorption + scattering ----------
    const sigS = u.uSigmaS.add(vec3(0.05, 0.065, 0.065).mul(bubbles));
    const sigT = u.uSigmaA.add(sigS);
    const transmitRaw = exp(sigT.mul(lView.add(lSun)).negate());
    const inscatter = float(1).sub(exp(sigT.mul(lView).negate())).toVar('wIn');
    const scatter = sigS.div(sigT).mul(u.uScatterGain).add(vec3(0.03, 0.05, 0.05).mul(bubbles)).mul(vec3(u.uBodyTint as N));

    // ---------- reflection ----------
    // the fine ripples gently distort the mirror; the wake swells bend it into bands (below)
    const slopeB = gs.add(rs);
    const Nr = normalize(mix(up, normalize(vec3(slopeB.x.negate(), 1, slopeB.y.negate())), u.uReflDistort));
    const slopeR = slopeB.mul(u.uReflDistort).add(wakeSlope.mul(u.uReflWake));
    let R: N = reflect(V.negate(), normalize(vec3(slopeR.x.negate(), 1, slopeR.y.negate())));
    R = normalize(vec3(R.x, max(R.y, 0.01), R.z)).toVar('wR');
    // projective mirror lookup: the reflector renders the mirrored view of exactly what is on screen,
    // so sample it at this pixel's screen position, offset by the ripples. the old approach projected a
    // point along the reflected ray and fell back to sky when it left the frame, which drew a hard,
    // camera-following line across the river.
    const viewDist = max(cameraPosition.sub(P).length(), 2);
    // the wake term is where its tilted ray really lands: the mirrored reflected direction projected to the
    // screen minus the flat mirror's (-V), so swells facing the camera stretch the image like real water
    const dirUV = (d: N) => {
      const dv = cameraViewMatrix.mul(vec4(d, 0)).xyz;
      return vec2(dv.x.mul(u.uProj.x), dv.y.mul(u.uProj.y).negate()).div(max(dv.z.negate(), 0.05)).mul(0.5);
    };
    const Rw = reflect(V.negate(), normalize(vec3(wakeSlope.x.mul(u.uReflWake).negate(), 1, wakeSlope.y.mul(u.uReflWake).negate())));
    const dUV = dirUV(vec3(Rw.x, max(Rw.y, 0.01).negate(), Rw.z)).sub(dirUV(V.negate()));
    const ruv = screenUV.add(clamp(dUV, vec2(-0.22), vec2(0.22))).flipX().add(Nr.xz.mul(float(0.6).div(viewDist).add(0.003)));
    const blurPx = sqrt(variance).mul(u.uReflDistort).mul(2).mul(u.uReflH).div(1.05);
    refl.uvNode = ruv;
    refl.levelNode = clamp(log2(max(blurPx, 1)), 0, u.uReflMaxLod);
    // only the screen borders, where ripples push the lookup off the mirror image, fade to the sky
    const rEdge = smoothstep(-0.01, 0.01, ruv.x).mul(smoothstep(1.01, 0.99, ruv.x)).mul(smoothstep(-0.01, 0.01, ruv.y)).mul(smoothstep(1.01, 0.99, ruv.y));
    const planarW = rEdge.mul(u.uReflOn);
    const rough = pow(variance.mul(2).add(0.0016), 0.25);
    let skyCol: N;
    const kz = pow(saturate(R.y), 0.42);
    if (envTex) {
      skyCol = pmremTexture(envTex, R, rough);
    } else {
      skyCol = mix(vec3(u.uSkyHorizon as N), vec3(u.uSkyZenith as N), kz);
    }
    // the sky texture is the authored morning: grade it to the time and weather (identity by default).
    // the planar mirror is left alone, it already shows the live sky and the lantern glows
    skyCol = mix(skyCol, vec3(dot(skyCol, vec3(0.2126, 0.7152, 0.0722))), u.uSkyDesat)
      .mul(mix(vec3(u.uSkyTintH as N), vec3(u.uSkyTintZ as N), kz)).add(vec3(u.uSkyAdd as N));
    const reflection = mix(skyCol, refl.rgb, planarW).mul(u.uReflGain);

    // ---------- fresnel and masks ----------
    const alpha2 = variance.mul(2).add(0.035 * 0.035);
    const alpha = sqrt(alpha2).toVar('wAlpha');
    const roughP = sqrt(alpha);
    const fres = float(0.02).add(max(float(1).sub(roughP), 0.02).sub(0.02).mul(pow(float(1).sub(nv), 5))).mul(contact).toVar('wF');
    const open = float(1).sub(foam);
    return {
      N, V, nv, alpha,
      foam,
      foamAlbedo: vec3(0.78, 0.8, 0.8),
      specMask: open.mul(contact).mul(u.uGlint),
      reflection,
      reflMask: fres.mul(open),
      refraction: select(skyR, vec3(0), sceneCol),
      transmit: transmitRaw.mul(float(1).sub(bubbles.mul(0.55))),
      scatter,
      inscatter,
      bodyMask: float(1).sub(fres).mul(open),
      flashCol: u.uFlashCol,
      debug: u.uDebug,
      wakeDbg: vec3(wc.r.mul(8).add(0.5), wakeTurb, wakeSlope.length()).mul(wEdge.mul(0.9).add(0.1)),
      flowDbg: vec3(flow.x.mul(1.5).add(0.5), flow.y.mul(1.5).add(0.5), current),
    };
  };

  return { material: mat, reflector: refl };
}
