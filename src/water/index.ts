// water module: camera-centred gerstner clipmap river with a near-mirror planar reflection, refraction,
// depth absorption, flow-advected ripples, bank and rock foam, caustics (./caustics), boat wake
// (./wake), waterfalls and the weir (./falls) and a hull mask. the boat throws no spray: a quiet river
// boat leaves glassy ridges, not white water (./spray is kept but unused).
// publishes ctx.services.water (see WaterService below).
import {
  Color, FloatType, Group, Light, Matrix4, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, QuadMesh, RenderTarget, SphereGeometry,
  Texture, Vector2, Vector3, Vector4,
} from 'three/webgpu';
import { float, int, screenCoordinate, uniformArray, vec4 } from 'three/tsl';
import type { GameContext } from '../core/context';
import type { QualityPreset } from '../core/settings';
import type { DayState } from '../core/daycycle';
import { LAYERS } from '../core/layers';
import { uWaveAmp, uWindDir, uWindStrength } from '../core/uniforms';
import { waterHeight } from '../world/waves';
import { buildClipmapGeometry, clipmapSpec, setClipParams, uClipCam, type ClipmapSpec } from './clipmap';
import { buildWaterMaterial, createWaterUniforms, WIND_LAYER, type WaterUniforms } from './material';
import { createFoamTexture, createRippleTexture, createWorldPack } from './textures';
import { gerstnerDisplacement } from './gerstner';
import { causticsNode, uCausticsEnabled } from './caustics';
import { Wake } from './wake';
import { Falls } from './falls';

export interface WaterService {
  mesh: Mesh;
  material: unknown;
  /** planar reflection on/off (off falls back to the environment/sky) */
  reflectionEnabled: boolean;
  setReflectionEnabled(on: boolean): void;
  /** mask water out of the player's hull (on by default when a boat exists) */
  setBoatMask(on: boolean): void;
  /** convenience: rendered water surface height at world (x, z) (constant river level + chop) */
  heightAt(x: number, z: number): number;
  /** boat wave sim display: r = height (m), g/b = slope, a = turbulence; uv = (xz - center) / size + 0.5 */
  wake: { texture: Texture; center: Vector2; size: () => number; reset(): void };
  /** falls/weir: the sheets group and the weir's downstream pool drop (the bridges owner builds the weir) */
  falls: { group: Group; weir: { x: number; z: number; tx: number; tz: number; halfWidth: number; drop: number } };
  /** tuning uniforms (absorption, scattering, foam, glint...) */
  uniforms: WaterUniforms;
  causticsNode: typeof causticsNode;
  /** called around the planar reflection render (e.g. to skip expensive passes) */
  reflectionHooks: { before: Set<() => void>; after: Set<() => void> };
  debug: {
    sampleDisplacement(points: number[][]): Promise<number[][]>;
    /** small spheres kept at cpu waterHeight() (x, z) positions; null clears */
    markers(points: number[][] | null, radius?: number): void;
    /** wake and falls particles on or off (perf probes) */
    setWake(on: boolean): void;
    info(): Record<string, unknown>;
    /** readback stats of the wave sim display */
    wakeProbe(): Promise<Record<string, unknown>>;
    /** perf probes: false makes the water ignore the day cycle (defaults look, no rain drops); 'sim' keeps
     *  only the wave sim's rain, 'mat' only the material's response */
    weather(on: boolean | 'sim' | 'mat'): void;
  };
}

// time and weather looks for the water (multiplied in by amount; all neutral at 0)
const SKY_NIGHT_H = [0.07, 0.085, 0.13], SKY_NIGHT_Z = [0.035, 0.05, 0.1];
const SKY_CLOUD_H = [0.9, 0.9, 0.88], SKY_CLOUD_Z = [0.95, 0.88, 0.76];
const SKY_TWI_H = [1.35, 0.92, 0.66], SKY_TWI_Z = [0.95, 0.82, 0.92];
const BODY_NIGHT = [0.3, 0.36, 0.52], BODY_TWI = [1.12, 0.96, 0.8], BODY_CLOUD = [0.86, 0.9, 0.93];
const FLASH = [0.75, 0.8, 1.0];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function grade(out: Color, t: [number[], number][]) {
  let r = 1, g = 1, b = 1;
  for (const [c, k] of t) {
    r *= lerp(1, c[0], k);
    g *= lerp(1, c[1], k);
    b *= lerp(1, c[2], k);
  }
  out.setRGB(r, g, b);
}

/** push the day cycle into the water uniforms; with the defaults (all 0) every value is neutral */
function applyDay(u: WaterUniforms, day: DayState | undefined, windStrength: number) {
  const night = day?.night ?? 0, twi = day?.twilight ?? 0, cloud = day?.cloud ?? 0;
  const rain = day?.rain ?? 0, storm = day?.storm ?? 0, flash = day?.flash ?? 0;
  // storm gusts and rain whip up the ripples
  u.uRippleAmp.value = (0.5 + 1.1 * windStrength) * (1 + 1.5 * storm + 0.3 * rain);
  u.uChop.value = 1 + 0.9 * storm + 0.25 * rain;
  u.uRainK.value = rain * (1 + 0.5 * storm);
  // rain softens the mirror: allow a wider blur than the calm river's ripples ever do
  u.uReflMaxLod.value = 1.6 + 1.3 * rain;
  // sky fallback: greyer and flatter under cloud, warm low horizon at twilight, navy at night
  u.uSkyDesat.value = Math.min(1, 0.55 * cloud + 0.35 * night);
  grade(u.uSkyTintH.value as Color, [[SKY_CLOUD_H, cloud], [SKY_TWI_H, twi], [SKY_NIGHT_H, night]]);
  grade(u.uSkyTintZ.value as Color, [[SKY_CLOUD_Z, cloud], [SKY_TWI_Z, twi], [SKY_NIGHT_Z, night]]);
  (u.uSkyAdd.value as Color).setRGB(FLASH[0] * flash * 0.6, FLASH[1] * flash * 0.6, FLASH[2] * flash * 0.6);
  u.uReflGain.value = 1 + 1.4 * flash;
  (u.uFlashCol.value as Color).setRGB(FLASH[0] * flash * 1.2, FLASH[1] * flash * 1.2, FLASH[2] * flash * 1.2);
  grade(u.uBodyTint.value as Color, [[BODY_CLOUD, cloud], [BODY_TWI, twi * 0.6], [BODY_NIGHT, night]]);
}

// wave sim grid: ~0.1 m cells carry the short ripple rings; the window follows the boat
function wakeSettings(q: QualityPreset) {
  if (q.name === 'low') return { res: 384, size: 48 };
  if (q.name === 'high') return { res: 768, size: 72 };
  return { res: 640, size: 64 };
}

// the reflection is the look of this river: render it sharper than the generic preset asks for
function reflectionSettings(ctx: GameContext, q: QualityPreset) {
  const scale = Math.min(1, q.reflectionScale * (q.name === 'low' ? 1.2 : q.name === 'balanced' ? 1.2 : 1.4));
  const samples = q.name === 'low' || ctx.backend === 'webgl2' ? 0 : 4;
  return { scale, samples };
}

export async function init(ctx: GameContext) {
  const t0 = performance.now();
  const ripple = createRippleTexture();
  const foam = createFoamTexture();
  const worldPack = createWorldPack(ctx.world);
  const u = createWaterUniforms();
  const wake = new Wake(ctx, worldPack);
  const ws = wakeSettings(ctx.quality);
  wake.setResolution(ws.res, ws.size);
  uCausticsEnabled.value = ctx.quality.caustics ? 1 : 0;
  const falls = new Falls(ctx, foam);
  falls.budget = ctx.quality.particles;
  falls.packSources(u.uSrcA.array as Vector4[], u.uSrcB.array as Vector4[]);
  (u.uWeir.value as Vector4).set(falls.weir.x, falls.weir.z, falls.weir.tx, falls.weir.tz);
  (u.uWeirB.value as Vector2).set(falls.weir.halfWidth, falls.weir.drop);

  let spec: ClipmapSpec = clipmapSpec(ctx.quality.waterDetail, 3000);
  setClipParams(spec);
  const mesh = new Mesh(buildClipmapGeometry(spec));
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.renderOrder = -50;
  mesh.name = 'water';
  ctx.scene.add(mesh);

  let reflectionOn = true;
  const hooks = { before: new Set<() => void>(), after: new Set<() => void>() };
  let lights: Light[] = [];
  let lightScan = 0;
  let env: Texture | null = null;
  let refl: any = null;
  let reflSamples = -1;

  const wakeBinding = { texture: wake.rt.texture, low: wake.low.texture, uCenter: wake.uCenter, uSize: wake.uSize, uTexel: wake.uTexel, res: () => wake.res };

  function build() {
    // the full-colour sky, not the chroma-reduced ibl, so the fallback matches the mirror
    const e = (ctx.services.render as { skyReflection?: Texture } | undefined)?.skyReflection ?? ctx.scene.environment;
    env = e && (e as Texture).isTexture ? (e as Texture) : null;
    const old = mesh.material as any;
    const oldRefl = refl;
    const rs = reflectionSettings(ctx, ctx.quality);
    reflSamples = rs.samples;
    const r = buildWaterMaterial({ world: ctx.world, u, ripple, foam, worldPack, wake: wakeBinding, reflectionScale: rs.scale, reflectionSamples: rs.samples, env });
    refl = r.reflector;
    mesh.add(refl.target);
    hookReflector(refl);
    mesh.material = r.material;
    if (oldRefl) {
      mesh.remove(oldRefl.target);
      oldRefl.dispose?.();
    }
    if (old && old !== r.material && old.dispose) old.dispose();
  }

  function hookReflector(node: any) {
    const base = node.reflector;
    const getCam = base.getVirtualCamera.bind(base);
    base.getVirtualCamera = (cam: any) => {
      const vc = getCam(cam);
      vc.layers.set(LAYERS.DEFAULT);
      return vc;
    };
    const update = base.updateBefore.bind(base);
    base.updateBefore = (frame: any) => {
      if (!reflectionOn) return;
      for (const f of hooks.before) f();
      // the sun is reflected by the ggx glint; a mirrored hdr sun disc would double it
      const disc = (ctx.services.render as any)?.sunDisc;
      const discWas = disc ? disc.value : 0;
      if (disc) disc.value = 0;
      // the main pass already rendered this frame's shadow maps; do not redo them for the mirror camera
      const saved = lights.map((l) => [(l as any).shadow?.autoUpdate, (l as any).shadow?.needsUpdate]);
      for (const l of lights) if ((l as any).shadow) { (l as any).shadow.autoUpdate = false; (l as any).shadow.needsUpdate = false; }
      try {
        update(frame);
      } finally {
        lights.forEach((l, i) => { const s = (l as any).shadow; if (s) { s.autoUpdate = saved[i][0]; s.needsUpdate = saved[i][1]; } });
        if (disc) disc.value = discWas;
        for (const f of hooks.after) f();
      }
    };
  }

  build();

  // wind cat's paws follow the wind at startup (turning them later would rotate the pattern about the
  // origin, so the direction only refreshes on quality changes)
  function setWindDir() {
    const w = uWindDir.value as Vector2;
    const l = Math.hypot(w.x, w.y) || 1;
    (u.uWindDirR.value as Vector2).set(w.x / l, w.y / l);
  }
  setWindDir();

  const markers = new Group();
  markers.name = 'water.markers';
  ctx.scene.add(markers);
  function setMarkers(points: number[][] | null, radius = 0.12) {
    for (const m of [...markers.children]) {
      markers.remove(m);
      ((m as Mesh).geometry as any).dispose();
    }
    if (!points) return;
    const geo = new SphereGeometry(radius, 20, 12);
    const mat = new MeshStandardNodeMaterial({ color: 0xd8402c, roughness: 0.5 });
    for (const p of points) {
      const m = new Mesh(geo, mat);
      m.position.set(p[0], 0, p[1]);
      markers.add(m);
    }
  }

  const mInv = new Matrix4();
  const one = new Vector3(1, 1, 1);
  const size = new Vector2();
  let maskWanted = true;
  let particlesOn = true;
  let weatherOn = true;

  function update(c: GameContext) {
    const cam = c.camera;
    (uClipCam.value as Vector3).copy(cam.position);
    const pe = cam.projectionMatrix.elements;
    (u.uProj.value as Vector2).set(pe[0], pe[5]);
    const dt = c.paused ? 0 : Math.min(c.time.frameDt, 0.1);
    const wind = uWindDir.value as Vector2;
    const wo = u.uWindOff.value as Vector2;
    wo.x = (wo.x - (WIND_LAYER.speed * dt) / WIND_LAYER.tile) % 1;
    const g = u.uGustOff.value as Vector2;
    const day = weatherOn ? (c.services.day as DayState | undefined) : undefined;
    // storm gusts race across the river
    const gustRate = 1.2 * (1 + 2.5 * (day?.storm ?? 0));
    g.x = (g.x - (wind.x * dt * gustRate) / 260) % 1;
    g.y = (g.y - (wind.y * dt * gustRate) / 260) % 1;
    applyDay(u, day, uWindStrength.value as number);
    const sy = Math.max(0.05, c.sun.direction.y);
    u.uSunCosRefr.value = Math.sqrt(Math.max(0.2, 1 - (1 - sy * sy) / 1.769));
    c.renderer.getDrawingBufferSize(size);
    u.uReflH.value = size.y * (refl ? refl.reflector.resolutionScale : 0.5);
    u.uReflOn.value = reflectionOn ? 1 : 0;

    // hull mask from the interpolated boat pose
    const b = c.boat;
    if (b) {
      mInv.compose(b.position, b.quaternion, one).invert();
      (u.uBoatInv.value as Matrix4).copy(mInv);
      u.uMaskOn.value = maskWanted ? 1 : 0;
    }
    u.uWakeOn.value = b ? 1 : 0;

    // scene lights with shadows, refreshed now and then (csm adds cascade lights at runtime)
    if (lightScan-- <= 0) {
      lightScan = 120;
      lights = [];
      c.scene.traverse((o) => { if ((o as Light).isLight && (o as any).shadow && o.castShadow) lights.push(o as Light); });
      // same source as build(): comparing scene.environment against the sky reflection never matched,
      // which rebuilt the material and its mirror every 120 frames (a periodic hitch)
      const e = (c.services.render as { skyReflection?: Texture } | undefined)?.skyReflection ?? c.scene.environment;
      if ((e && (e as Texture).isTexture ? e : null) !== env) build();
    }

    wake.update(c);
    if (particlesOn) {
      falls.update(c);
    }
    for (const mk of markers.children) mk.position.y = waterHeight(mk.position.x, mk.position.z, c.time.render);
  }
  ctx.onUpdate(update, 60);

  ctx.events.on('quality', (q: QualityPreset) => {
    const rs = reflectionSettings(ctx, q);
    if (rs.samples !== reflSamples) build();
    else if (refl) refl.reflector.resolutionScale = rs.scale;
    uCausticsEnabled.value = q.caustics ? 1 : 0;
    falls.budget = q.particles;
    const w = wakeSettings(q);
    wake.setResolution(w.res, w.size);
    const next = clipmapSpec(q.waterDetail, 3000);
    if (next.m !== spec.m || next.levels !== spec.levels) {
      spec = next;
      setClipParams(spec);
      const old = mesh.geometry;
      mesh.geometry = buildClipmapGeometry(spec);
      old.dispose();
    }
    setWindDir();
  });

  // gpu readback of the displacement function for cpu/gpu agreement checks
  async function sampleDisplacement(points: number[][]) {
    const n = Math.min(64, points.length);
    const arr = uniformArray(Array.from({ length: 64 }, (_, i) => new Vector2(points[i]?.[0] ?? 0, points[i]?.[1] ?? 0)), 'vec2');
    const m = new MeshBasicNodeMaterial();
    const idx = int(screenCoordinate.x);
    const rest = arr.element(idx);
    const s = ctx.world.has('waveScale') ? ctx.world.channelNode('waveScale', rest) : float(1);
    const d = gerstnerDisplacement(rest, (s as any).mul(uWaveAmp), float(0.25));
    m.fragmentNode = vec4(d, 1);
    const rt = new RenderTarget(64, 1, { type: FloatType, depthBuffer: false });
    const quad = new QuadMesh(m);
    const r = ctx.renderer as any;
    const prev = r.getRenderTarget();
    r.setRenderTarget(rt);
    quad.render(r);
    r.setRenderTarget(prev);
    const px = (await r.readRenderTargetPixelsAsync(rt, 0, 0, 64, 1)) as Float32Array;
    rt.dispose();
    m.dispose();
    const out: number[][] = [];
    for (let i = 0; i < n; i++) out.push([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]]);
    return out;
  }

  const service: WaterService = {
    mesh,
    get material() { return mesh.material; },
    get reflectionEnabled() { return reflectionOn; },
    set reflectionEnabled(v: boolean) { reflectionOn = v; },
    setReflectionEnabled(v: boolean) { reflectionOn = v; },
    setBoatMask(on: boolean) { maskWanted = on; u.uMaskOn.value = on && ctx.boat ? 1 : 0; },
    heightAt: (x, z) => waterHeight(x, z, ctx.time.render),
    wake: { texture: wake.rt.texture, center: wake.uCenter.value as Vector2, size: () => wake.size, reset: () => wake.reset() },
    falls: { group: falls.group, weir: falls.weir },
    uniforms: u,
    causticsNode,
    reflectionHooks: hooks,
    debug: {
      sampleDisplacement,
      markers: setMarkers,
      setWake: (on: boolean) => { wake.enabled = on; particlesOn = on; falls.group.visible = on; },
      wakeProbe: () => wake.probe(ctx),
      weather: (on) => { weatherOn = on === true || on === 'mat'; wake.weather = on === true || on === 'sim'; },
      info: () => ({
        m: spec.m, levels: spec.levels, extent: spec.extent, triangles: (mesh.geometry.index?.count ?? 0) / 3,
        reflectionScale: refl?.reflector.resolutionScale, reflectionSamples: reflSamples, env: !!env, wakeRes: wake.res, wakeSize: wake.size,
        weir: falls.weir, sources: falls.sources.length,
      }),
    },
  };
  ctx.services.water = service;
  console.info(`[water] ready in ${(performance.now() - t0).toFixed(0)} ms, clipmap m=${spec.m} levels=${spec.levels} extent=${spec.extent}`);
}
