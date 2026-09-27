// render module (owner: render/lighting): sun + cascaded shadows, photographed sky with an analytic
// sun disc, ibl from the same sky, height-aware aerial perspective, post pipeline, tone mapping.
// publishes ctx.services.render (see RenderService) for modules that need the haze or sky.
import { ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping, Vector3, type Node } from 'three/webgpu';
import { pmremTexture, uniform } from 'three/tsl';
import type { GameContext } from '../core/context';
import type { QualityPreset } from '../core/settings';
import { TUNE, type ToneMapName } from './config';
import { Sun } from './sun';
import { createSkyNode, loadSky, type SkyData, type SkyNodes } from './sky';
import { createAtmosphere, type Atmosphere, type MistZone } from './atmosphere';
import { RIVER_LENGTH, riverFrame } from '../world/layout';
import { Post, uAOStrength, uGrade, type PostOptions } from './post';
import { BounceProbes } from './probes';
import { Birds } from './birds';
import { Rain } from './rain';
import { DayLight } from './daylight';

export interface RenderService {
  sun: Sun;
  sky: SkyData;
  skyNodes: SkyNodes;
  atmosphere: Atmosphere;
  /** haze color along a world direction (linear, scene units) */
  hazeColor: (dir: Node) => Node;
  /** sunlit mist color along a world direction (includes the forward-scatter glow toward the sun) */
  mistColor: (dir: Node) => Node;
  /** relative mist density (>= 0, 1 = base) at a world xz: zones + drift */
  mistField: (xz: Node) => Node;
  /** haze + mist for a lit color at a world position, seen from the current camera. this is exactly
   *  what scene.fogNode applies to every material with fog = true */
  applyHaze: (color: Node, worldPos: Node) => Node;
  /** haze + mist transmittance (1 = clear) from the current camera to a world position */
  transmittance: (worldPos: Node) => Node;
  /** full-color sky (equirect DataTexture) for pmremTexture() sky reflections; scene.environment is the
   *  ibl and has reduced chroma, so mirror-like surfaces should prefer this one */
  skyReflection: SkyData['reflection'];
  /** 1 draws the sun disc in the background; set 0 around a reflection render if needed */
  sunDisc: SkyNodes['sunDisc'];
  /** the time-of-day / weather grade of the visible sky, for another sky lookup (e.g. the water's
   *  skyReflection fallback): gradeSky(color, worldDir). identity in the authored look */
  gradeSky: SkyNodes['gradeSky'];
  /** rgb multiplier on the scene ibl (warm at twilight, blue at night); scene.environmentIntensity scales it */
  envTint: ReturnType<typeof uniform>;
  rain: Rain | null;
  post: () => Post | null;
  probes: () => BounceProbes | null;
  setToneMapping(name: ToneMapName, exposure?: number): void;
  tune: typeof TUNE;
}

const TONEMAPS = { neutral: NeutralToneMapping, agx: AgXToneMapping, aces: ACESFilmicToneMapping } as const;

/** where the river mist gathers: along the gorge, over the lake, in the spray of the falls */
function mistZones(): MistZone[] {
  const at = (s: number, radius: number, strength: number): MistZone => {
    const f = riverFrame(s);
    return { x: f.x, z: f.z, radius, strength };
  };
  return [
    at(870, 110, 2.2), at(990, 120, 3.0), at(1110, 110, 2.4),
    at(1640, 170, 1.1), at(1790, 170, 1.2),
    at(RIVER_LENGTH - 25, 80, 2.2),
    at(10, 60, 0.7),
  ];
}

export async function init(ctx: GameContext) {
  const { renderer, scene, camera } = ctx;

  // sun first: other modules read ctx.sun during their init
  const sun = new Sun(renderer);
  ctx.sun.direction.copy(sun.dir);
  ctx.sun.color = { r: TUNE.sun.color[0], g: TUNE.sun.color[1], b: TUNE.sun.color[2] };
  ctx.sun.intensity = TUNE.sun.intensity;
  sun.applyQuality(ctx.quality);
  scene.add(sun.light, sun.light.target);

  // sky, environment and haze all come from the same graded hdri
  const buf = await ctx.assets.binary(TUNE.sky.url);
  const sky = await loadSky(buf, sun.dir);
  const atmosphere = createAtmosphere(sky.horizonRing, mistZones());
  const skyNodes = createSkyNode(sky, sun.dir, (d) => atmosphere.hazeColor(d), (c, d) => atmosphere.applySkyMist(c, d), (d) => atmosphere.airTint(d));
  scene.backgroundNode = skyNodes.node;
  scene.environment = sky.environment;
  // the same ibl through an rgb tint (identity in the authored look), so time of day can color it
  const envTint = uniform(new Vector3(1, 1, 1));
  scene.environmentNode = (pmremTexture(sky.environment) as any).mul(envTint);
  scene.environmentIntensity = TUNE.env.intensity;
  scene.fogNode = atmosphere.fogNode;

  const setToneMapping = (name: ToneMapName, exposure?: number) => {
    renderer.toneMapping = TONEMAPS[name] ?? NeutralToneMapping;
    if (exposure !== undefined) renderer.toneMappingExposure = exposure;
  };
  setToneMapping(TUNE.tone.mapping, TUNE.tone.exposure);

  let post: Post | null = null;
  const postOptions = (q: QualityPreset): PostOptions => {
    const webgl = ctx.backend === 'webgl2';
    return {
      ao: q.ao && !webgl,
      ssgi: q.ssgi && !webgl,
      bloom: q.bloom,
      aa: TUNE.aa || q.antialias,
    };
  };
  let optionOverride: Partial<PostOptions> = {};
  const buildPost = () => {
    post?.dispose();
    post = null;
    try {
      post = new Post(renderer, scene, camera, { ...postOptions(ctx.quality), ...optionOverride });
    } catch (e) {
      console.error('[render] post pipeline failed, falling back to direct render', e);
    }
  };
  buildPost();

  // baked bounce light around the harbor, captured once the world is populated
  let probes: BounceProbes | null = null;
  if (TUNE.probes.enabled && ctx.backend === 'webgpu') {
    try {
      probes = new BounceProbes(renderer, scene);
      await probes.loadBaked(ctx.world.meta.version);
    } catch (e) {
      console.warn('[render] bounce probes unavailable', e);
    }
  }
  // only the explicit offline-export path captures the scene; normal startup reads the shipped volume
  ctx.events.on('game:ready', () => {
    if (!probes || probes.baked) return;
    // ship cached bounce; missing/stale caches use the matching environment fill, never block play
    if (!new URLSearchParams(location.search).has('bakeStartup')) return;
    try {
      const ms = probes.bake(ctx.services.water as any);
      console.info(`[render] bounce probes baked in ${ms.toFixed(0)} ms`);
    } catch (e) {
      console.warn('[render] bounce probe bake failed; continuing without', e);
      probes.dispose();
      probes = null;
    }
  });

  let bypass = false;
  ctx.render = () => {
    if (post && !bypass) post.render();
    else renderer.render(scene, camera);
  };

  ctx.onUpdate(() => sun.update(camera), 95);

  let birds: Birds | null = null;
  try {
    birds = new Birds(scene);
    ctx.onUpdate((c) => birds?.update(c.time.real), 96);
  } catch (e) {
    console.warn('[render] birds unavailable', e);
  }
  // rain streaks and the time-of-day driver (order -110: after the day cycle, before shared uniforms)
  let rain: Rain | null = null;
  try {
    rain = new Rain(scene);
  } catch (e) {
    console.warn('[render] rain unavailable', e);
  }
  const daylight = new DayLight({ ctx, sun, skyNodes, atmosphere, envTint, post: () => post, probes: () => probes, rain });
  ctx.onUpdate(() => daylight.update(), -110);

  ctx.events.on('resize', () => sun.resize());
  ctx.events.on('quality', (q: QualityPreset) => {
    sun.applyQuality(q);
    buildPost();
  });

  const service: RenderService = {
    sun, sky, skyNodes, atmosphere,
    hazeColor: (d) => atmosphere.hazeColor(d),
    mistColor: (d) => atmosphere.mistColor(d),
    mistField: (xz) => atmosphere.mistField(xz),
    applyHaze: (c, p) => atmosphere.applyHaze(c, p),
    transmittance: (p) => atmosphere.transmittance(p),
    skyReflection: sky.reflection,
    sunDisc: skyNodes.sunDisc,
    gradeSky: skyNodes.gradeSky,
    envTint,
    rain,
    post: () => post,
    probes: () => probes,
    setToneMapping,
    tune: TUNE,
  };
  ctx.services.render = service;

  // tuning hooks for the harness (render-*.mjs scripts)
  (window as any).__lumaRender = {
    service,
    /** perf probes: render without the post pipeline / without sun shadows */
    bypassPost(on: boolean) { bypass = on; },
    shadows(on: boolean) { sun.light.castShadow = on; },
    /** rebuild the pipeline with some options forced (perf probes); {} restores the preset */
    postOptions(o: Partial<PostOptions>) { optionOverride = o; buildPost(); },
    set(o: { tm?: ToneMapName; exp?: number; env?: number; sun?: number; ao?: number; bloom?: number; hazeA?: number; hazeB?: number; mist?: number; mistH?: number; mistNear?: number; mistSun?: number; probe?: number }) {
      if (o.tm || o.exp !== undefined) setToneMapping(o.tm ?? TUNE.tone.mapping, o.exp);
      if (o.env !== undefined) scene.environmentIntensity = o.env;
      if (o.sun !== undefined) { sun.light.intensity = o.sun; ctx.sun.intensity = o.sun; }
      if (o.ao !== undefined) uAOStrength.value = o.ao;
      if (o.bloom !== undefined && post?.bloomNode) post.bloomNode.strength.value = o.bloom;
      const u = atmosphere.uniforms;
      if (o.hazeA !== undefined) u.aerosol.value = o.hazeA;
      if (o.mist !== undefined) u.mist.value = o.mist;
      if (o.mistH !== undefined) u.mistHeight.value = o.mistH;
      if (o.mistNear !== undefined) u.mistNear.value = o.mistNear;
      if (o.mistSun !== undefined) u.mistSun.value = o.mistSun;
      if (o.hazeB !== undefined) u.brightness.value = o.hazeB;
      if (o.probe !== undefined && probes) probes.grid.intensity = o.probe;
    },
    /** the dreamy layer (TUNE.dream + bloom) at runtime; vec3 values as [r, g, b] */
    dream(o: Record<string, any>) {
      const v3 = (u: any, k: string) => { const a = o[k] as number[] | undefined; if (a) u.value.set(a[0], a[1], a[2]); };
      const u = atmosphere.uniforms, g = skyNodes.grade;
      v3(u.airSun, 'airSun'); v3(u.airAway, 'airAway');
      v3(g.blush, 'blush'); v3(g.cloudShade, 'cloudShade'); v3(g.cloudLit, 'cloudLit');
      if (o.blushDeg !== undefined) g.blushDeg.value = o.blushDeg as number;
      if (o.zenithSat !== undefined) g.zenithSat.value = o.zenithSat as number;
      v3(uGrade.hiTint, 'hiTint'); v3(uGrade.loTint, 'loTint'); v3(uGrade.lift, 'lift');
      if (o.sat !== undefined) uGrade.saturation.value = o.sat;
      if (o.vib !== undefined) uGrade.vibrance.value = o.vib;
      const b = post?.bloomNode;
      if (b) {
        if (o.bloom !== undefined) b.strength.value = o.bloom as number;
        if (o.bloomRadius !== undefined) b.radius.value = o.bloomRadius as number;
        if (o.bloomThreshold !== undefined) b.threshold.value = o.bloomThreshold as number;
        if (o.bloomKnee !== undefined) b.smoothWidth.value = o.bloomKnee as number;
        if (o.bloomTint) b.bloomTintColors.forEach((t, i) => t.set(o.bloomTint[i][0], o.bloomTint[i][1], o.bloomTint[i][2]));
      }
      if (o.hazeA !== undefined) u.aerosol.value = o.hazeA as number;
      if (o.hazeB !== undefined) u.brightness.value = o.hazeB as number;
      if (o.exp !== undefined) renderer.toneMappingExposure = o.exp as number;
    },
  };
}
