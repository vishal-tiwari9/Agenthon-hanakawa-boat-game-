// boot: renderer, shared context, world data, physics, then every feature module in isolation.
// a module that fails to import or init is logged and skipped so the rest of the game still runs.
import { PerspectiveCamera, Scene, Vector3, WebGPURenderer } from 'three/webgpu';
import type { Backend, GameContext } from './core/context';
import { EventBus } from './core/events';
import { Input } from './core/input';
import { AssetLoader } from './core/assets';
import { PhysicsWorld } from './core/physics';
import { Loop } from './core/loop';
import { loadSettings, resolveQuality, saveSettings, type QualityName } from './core/settings';
import { installDebug } from './core/debug';
import { LAYERS } from './core/layers';
import { WorldData } from './world/worldData';
import { setWaveScaleFn } from './world/waves';
import { updateSharedUniforms } from './core/uniforms';
import { DayCycle } from './core/daycycle';
import { LoadingScreen, yieldFrame } from './ui/loading';
import { installGzipFetch } from './core/compression';
import { installPrefetch } from './core/prefetch';
import { releaseUploaded } from './core/memory';
import { Streamer } from './core/stream';

type Module = { init(ctx: GameContext): Promise<unknown> | unknown };

// order matters: render sets up lights/env before materials compile; boat before camera/game.
const MODULES: [string, () => Promise<Module>][] = [
  ['render', () => import('./render/index')],
  ['terrain', () => import('./terrain/index')],
  ['water', () => import('./water/index')],
  ['vegetation', () => import('./vegetation/index')],
  ['structures', () => import('./structures/index')],
  ['bridges', () => import('./bridges/index')],
  ['boat', () => import('./boat/index')],
  ['camera', () => import('./camera/index')],
  ['game', () => import('./game/index')],
  ['ui', () => import('./ui/index')],
  ['audio', () => import('./audio/index')],
];

/** modules the rest depend on; they initialize first, then the town, forest, bridges and audio */
const CRITICAL = new Set(['render', 'terrain', 'water', 'boat', 'camera', 'game', 'ui']);
/** loading screen phase for each module (camera, game and ui are quick and share one) */
const PHASE_OF: Record<string, string> = { camera: 'harbor', game: 'harbor', ui: 'harbor' };

// prefetch sits under the gzip unpacking so prefetched .bin/.hdr files are unpacked like any other
const prefetch = installPrefetch();
installGzipFetch();
void prefetch('/preload.json');

const params = new URLSearchParams(location.search);
const loading = new LoadingScreen();

async function boot() {
  const startup = { phases: {} as Record<string, number>, firstPaintMs: 0, firstViewMs: 0, firstPlayableMs: 0, transferredBytes: 0 };
  let phaseStarted = performance.now();
  const markPhase = (name: string) => {
    startup.phases[name] = Math.round(performance.now() - phaseStarted);
    phaseStarted = performance.now();
  };
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const events = new EventBus();
  const settings = loadSettings();
  const qp = params.get('quality') as QualityName | null;
  if (qp === 'low' || qp === 'balanced' || qp === 'high') settings.quality = qp;

  // fetch and parse every module now; they still initialize in order below, but their download
  // overlaps the renderer, physics and world setup and the modules ahead of them
  const imports = new Map(MODULES.map(([name, load]) => {
    const p = load();
    p.catch(() => {}); // reported when the module's turn comes
    return [name, p] as const;
  }));

  const forceWebGL = params.get('backend') === 'webgl' || params.get('backend') === 'webgl2';
  const renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL, powerPreference: 'high-performance' });
  const assets = new AssetLoader(events);
  const physics = new PhysicsWorld();
  const world = new WorldData();
  // the renderer, the physics wasm and the world channels do not depend on each other
  await Promise.all([
    renderer.init().then(() => markPhase('renderer')),
    assets.track('physics', physics.init(), 2),
    assets.track('world', world.load(assets), 4),
  ]);
  markPhase('world');
  const backend: Backend = (renderer.backend as any).isWebGPUBackend ? 'webgpu' : 'webgl2';
  assets.useImageBitmap = backend === 'webgpu';
  console.info(`[luma] backend: ${backend}`);

  const quality = resolveQuality(settings.quality, backend);
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 1, 0.1, 6000);
  camera.layers.enable(LAYERS.NO_REFLECT);
  scene.add(camera);

  const input = new Input(canvas, events);
  const loop = new Loop();

  const ctx: GameContext = {
    renderer, backend, scene, camera, canvas,
    time: { real: 0, sim: 0, render: 0, alpha: 1, frameDt: 1 / 60, fixedDt: physics.fixedDt },
    sun: { direction: new Vector3(0, 1, 0), color: { r: 1, g: 0.96, b: 0.9 }, intensity: 3 },
    world, physics, events, input, assets, settings, quality,
    paused: false,
    boat: null,
    cameraRig: null,
    onUpdate: (fn, order = 0) => loop.add(loop.updates, fn, order),
    onFixed: (fn, order = 0) => loop.add(loop.fixed, fn, order),
    onPostFixed: (fn, order = 0) => loop.add(loop.postFixed, fn, order),
    render: () => renderer.render(scene, camera),
    services: { loop, startup },
  };

  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    const budget = Math.sqrt(ctx.quality.maxPixels / Math.max(1, w * h));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, ctx.quality.maxPixelRatio, budget));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    events.emit('resize', { width: w, height: h });
  };
  window.addEventListener('resize', resize);
  resize();

  events.on('settings:change', (patch: Partial<typeof settings>) => {
    Object.assign(settings, patch);
    saveSettings(settings);
    if (patch.quality) {
      ctx.quality = resolveQuality(settings.quality, backend);
      resize();
      events.emit('quality', ctx.quality);
    }
  });

  if (world.has('waveScale')) setWaveScaleFn((x, z) => world.sample('waveScale', x, z));

  // time of day and weather advance first; render turns them into the sun, sky and light before the
  // shared uniforms copy ctx.sun (-100)
  const day = new DayCycle(ctx);
  day.timeLapse = settings.timeLapse || params.get('timelapse') === '1';
  ctx.services.day = day;
  ctx.onUpdate(() => day.update(ctx.time.frameDt), -120);
  events.on('settings:change', (patch: Partial<typeof settings>) => {
    if (patch.timeLapse !== undefined) day.timeLapse = patch.timeLapse;
  });
  ctx.onUpdate(updateSharedUniforms, -100);

  // the loading screen covers everything until the scene is complete and every pipeline is built.
  // behind it the loop advances the sim and streaming but draws nothing, since nobody can see it:
  // all drawing cost goes into one warm-up frame at the end, then the finished valley is revealed.
  const failed: string[] = [];
  const loadModule = async (name: string) => {
    await loading.phase(PHASE_OF[name] ?? name);
    try {
      const mod = await assets.track(name, imports.get(name)!, 1);
      await assets.track(name, Promise.resolve(mod.init(ctx)), 2);
      markPhase(name);
    } catch (e) {
      failed.push(name);
      console.error(`[luma] module "${name}" failed`, e);
    }
  };
  const critical = MODULES.filter(([n]) => CRITICAL.has(n));
  const deferred = MODULES.filter(([n]) => !CRITICAL.has(n));
  for (const [name] of critical) await loadModule(name);
  ctx.services.failedModules = failed;
  // the boat is moored at its start (the save's dock, or the village) now: the modules below build the
  // river around it before the reveal and queue the far reaches, which stream in after it
  ctx.services.stream = new Streamer(ctx);

  installDebug(ctx);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) events.emit('app:hidden');
    loop.resetClock();
  });

  // the warm-up must run inside the animation loop: pass nodes render once per renderer frame, so a
  // render issued between frames is skipped as a repeat and builds nothing. it runs in steps while the
  // rest still downloads (the main thread is mostly idle then), so the last one only builds what's new.
  let warmWaiters: (() => void)[] = [];
  const requestWarm = () => new Promise<void>((r) => warmWaiters.push(r));
  let drawing = false;
  let lastTick = -Infinity;
  const skipDraw = () => {};
  renderer.setAnimationLoop((t) => {
    if (warmWaiters.length) {
      warmPipelines(ctx);
      const done = warmWaiters;
      warmWaiters = [];
      for (const r of done) r();
    } else if (drawing) loop.frame(ctx, t);
    else if (t - lastTick >= 12) {
      // at most ~60 updates a second while hidden, so building keeps most of the main thread
      lastTick = t;
      const draw = ctx.render;
      ctx.render = skipDraw;
      try {
        loop.frame(ctx, t);
      } finally {
        ctx.render = draw;
      }
    }
  });

  void requestWarm();
  for (const [name] of deferred) await loadModule(name);
  void requestWarm();
  ctx.services.failedModules = failed;
  // modules may keep building near-first in the background after init; wait for the part around the
  // start (`nearReady`, else all of it: `ready`). the far reaches stream in after the reveal
  await loading.phase('background');
  const pending = Object.values(ctx.services)
    .map((sv) => {
      const m = sv as { nearReady?: Promise<unknown>; ready?: Promise<unknown> } | null;
      return m?.nearReady ?? m?.ready;
    })
    .filter((p): p is Promise<unknown> => !!p && typeof (p as Promise<unknown>).then === 'function');
  await Promise.all(pending.map((p) => p.catch((e) => console.error('[luma] background build failed', e))));
  markPhase('background');

  // everything is in: vegetation clears building footprints and the title button unlocks (still
  // behind the loading screen). fill the grass around the opening view, then build every pipeline.
  events.emit('game:ready');
  await loading.phase('warm');
  await settleStreaming(ctx);
  markPhase('settle');

  // pipeline warm-up: one frame with every object visible and unculled builds every shader pipeline
  // (main, mirror and shadow passes) up front, so nothing compiles mid-voyage (first sightings used
  // to stall a frame for ~120 ms)
  await requestWarm();
  markPhase('warm');
  // a few real frames behind the veil so the first one anybody sees is settled, while the boat arrives
  drawing = true;
  loading.arrive();
  await nextFrames(3);
  markPhase('firstFrame');

  await loading.reveal();
  // stamped before app:revealed, whose handlers start the after-reveal downloads
  startup.firstViewMs = startup.firstPlayableMs = Math.round(performance.now());
  events.emit('app:revealed');
  // merged static geometry keeps a cpu copy until the gpu holds it; sweep now and as late builds land
  const sweep = () => { const freed = releaseUploaded(ctx); if (freed) console.info(`[luma] released ${Math.round(freed / 1048576)} MB of uploaded geometry`); };
  sweep();
  setInterval(sweep, 4000);
  startup.firstPaintMs = Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0);
  startup.transferredBytes = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
    .reduce((bytes, entry) => bytes + entry.transferSize, 0);
  console.info('[startup]', JSON.stringify(startup));
  (window as any).__lumaFirstView = true;
  (window as any).__lumaReady = true;
}

const nextFrames = (n = 2) => new Promise<void>((resolve) => {
  let k = 0;
  const tick = () => (++k >= n ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
});

// grass, flowers and shrubs stream in around the camera a few tiles per frame. fill the opening view
// before it is shown, using each layer's own update with a bigger budget until its queue is empty.
async function settleStreaming(ctx: GameContext, maxMs = 2500) {
  type Layer = { update(cam: Vector3, budgetMs: number): void; queue?: unknown };
  const veg = ctx.services.vegetation as { grass?: Layer; flowers?: Layer; shrubs?: Layer | null } | undefined;
  const layers = [veg?.grass, veg?.flowers, veg?.shrubs].filter((l): l is Layer => typeof l?.update === 'function');
  if (!layers.length) return;
  const known = layers.every((l) => Array.isArray(l.queue));
  const cam = new Vector3();
  const t0 = performance.now();
  for (let i = 0; ; i++) {
    ctx.camera.getWorldPosition(cam);
    for (const l of layers) l.update(cam, 16);
    const idle = known ? layers.every((l) => (l.queue as unknown[]).length === 0) : i >= 6;
    if (idle || performance.now() - t0 > maxMs) break;
    await yieldFrame();
  }
  const startup = ctx.services.startup as { settleMs?: number } | undefined;
  if (startup) startup.settleMs = Math.round(performance.now() - t0);
}

function warmPipelines(ctx: GameContext) {
  const saved: [any, boolean, boolean, number][] = [];
  ctx.scene.traverse((o: any) => {
    saved.push([o, o.visible, o.frustumCulled, o.count]);
    o.visible = true;
    o.frustumCulled = false;
    // one instance builds the same pipeline as all of them; drawing every tree and grass blade into
    // every pass at once was a multi-second gpu frame, long enough to reset a weaker gpu
    if (o.isInstancedMesh && o.count > 1) o.count = 1;
  });
  (ctx.services.render as any)?.sun?.refreshAll?.();
  const t0 = performance.now();
  const pipes = () => (ctx.renderer as any)._pipelines?.caches?.size ?? -1;
  const p0 = pipes();
  try {
    ctx.render();
  } catch (e) {
    console.warn('[luma] pipeline warm-up failed', e);
  }
  for (const [o, v, f, n] of saved) {
    o.visible = v;
    o.frustumCulled = f;
    if (o.isInstancedMesh) o.count = n;
  }
  (ctx.services.render as any)?.sun?.refreshAll?.();
  const startup = ctx.services.startup as { warmMs?: number; warmPipelines?: number } | undefined;
  if (startup) {
    // the last step's cost; earlier steps overlap the downloads
    startup.warmMs = Math.round(performance.now() - t0);
    startup.warmPipelines = pipes() - p0;
    (startup as { warmSteps?: number[] }).warmSteps = [...((startup as { warmSteps?: number[] }).warmSteps ?? []), startup.warmMs];
  }
}

boot().catch((e) => {
  console.error('[luma] boot failed', e);
  loading.fail('The valley could not load: ' + (e?.message || e) + '. Reload the page to try again.');
});
