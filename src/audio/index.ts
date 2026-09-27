// audio module: the soundscape of hanakawa. nothing is created until the player's first
// interaction (pointer or key); then an AudioContext starts, the mix fades in, and every frame
// (order 80) the listener follows the camera and each layer updates. published as
// ctx.services.audio = { play(name, opts), ... }.
//
// layers: engine (./engine), hull water + slaps + thuds + creaks (./hull), river bed + spatial bank
// voices (./river), waterfalls and the weir (./falls), wind in leaves and gorge bamboo (./wind),
// forest birds and a distant cuckoo (./birds), village furin chimes (./village), the temple bell
// (./temple), ui cues (./ui), and the day cycle's rain, thunder, storm wind and night chorus (./weather,
// built only once the time-lapse or a weather/night value asks for it). ./site tracks where the listener
// is along the river.
import { Quaternion, Vector3 } from 'three/webgpu';
import type { GameContext } from '../core/context';
import type { Settings } from '../core/settings';
import type { AudioEnv } from './env';
import { Mixer } from './mixer';
import { Samples } from './samples';
import { noiseBuffer } from './dsp';
import { Engine } from './engine';
import { Hull } from './hull';
import { Wind } from './wind';
import { River } from './river';
import { Falls } from './falls';
import { Birds } from './birds';
import { Village } from './village';
import { Temple } from './temple';
import { Weather } from './weather';
import { createSite, updateSite } from './site';
import { UiSounds, UI_SOUNDS, type PlayOptions } from './ui';

export type { PlayOptions } from './ui';

export interface AudioService {
  /** one-shot cue: 'complete' | 'discovery' | 'unlock' | 'dock' | 'undock' | 'toast' | 'click' */
  play(name: string, opts?: PlayOptions): void;
  readonly sounds: readonly string[];
  /** true once the AudioContext exists (after the first interaction) */
  readonly started: boolean;
  /** debug/tests */
  readonly context: AudioContext | null;
  levels(): Record<string, number> | null;
  meter(ms?: number): Promise<Record<string, number> | null>;
  stats(): Record<string, unknown> | null;
  /** debug/tests: ring the temple bell now */
  bell(): void;
}

class AudioSystem {
  readonly ac: AudioContext;
  readonly mx: Mixer;
  readonly env: AudioEnv;
  readonly samples: Samples;
  engine: Engine;
  hull: Hull;
  wind: Wind;
  river: River;
  falls: Falls;
  birds: Birds;
  village: Village;
  temple: Temple;
  weather: Weather;
  ui: UiSounds;
  /** set by the 'pause' event, cleared by 'resume'; ctx.paused alone also ducks */
  pauseEvent = false;
  private nextSite = 0;
  private lastT = 0;
  private q = new Quaternion();
  private f = new Vector3();
  private u = new Vector3();

  constructor(private ctx: GameContext, samples: Samples) {
    const Ctor: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    this.ac = new Ctor({ latencyHint: 'interactive' });
    this.mx = new Mixer(this.ac, ctx.settings);
    this.samples = samples;
    this.env = {
      ac: this.ac,
      mx: this.mx,
      noise: {
        white: noiseBuffer(this.ac, 'white', 5.3),
        pink: noiseBuffer(this.ac, 'pink', 7.1),
        brown: noiseBuffer(this.ac, 'brown', 6.7),
      },
      samples,
      listener: new Vector3(),
      site: createSite(),
      gust: 0.8,
    };
    this.readListener();
    updateSite(ctx.world, this.env.listener.x, this.env.listener.y, this.env.listener.z, this.env.site);
    this.engine = new Engine(this.env);
    this.hull = new Hull(this.env, ctx);
    this.wind = new Wind(this.env);
    this.river = new River(this.env, ctx);
    this.falls = new Falls(this.env, ctx.world);
    this.birds = new Birds(this.env, ctx);
    this.village = new Village(this.env, ctx);
    this.temple = new Temple(this.env, ctx);
    this.weather = new Weather(this.env, this.birds);
    this.ui = new UiSounds(this.env);
    samples.decodeAll(this.ac).catch((e) => console.warn('[audio] sample decode failed', e));
    this.lastT = this.ac.currentTime;
  }

  /** camera world pose -> env.listener (+ forward/up scratch) */
  private readListener() {
    const cam = this.ctx.camera;
    cam.updateWorldMatrix(true, false);
    cam.getWorldPosition(this.env.listener);
    cam.getWorldQuaternion(this.q);
    this.f.set(0, 0, -1).applyQuaternion(this.q);
    this.u.set(0, 1, 0).applyQuaternion(this.q);
  }

  private applyListener() {
    const l = this.ac.listener;
    const p = this.env.listener, f = this.f, u = this.u;
    if (!Number.isFinite(p.x + p.y + p.z + f.x + f.y + f.z + u.x + u.y + u.z)) return;
    if (l.positionX) {
      l.positionX.value = p.x;
      l.positionY.value = p.y;
      l.positionZ.value = p.z;
      l.forwardX.value = f.x;
      l.forwardY.value = f.y;
      l.forwardZ.value = f.z;
      l.upX.value = u.x;
      l.upY.value = u.y;
      l.upZ.value = u.z;
    } else {
      (l as any).setPosition(p.x, p.y, p.z);
      (l as any).setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }

  update(ctx: GameContext) {
    if (this.ac.state !== 'running') return;
    const t = this.ac.currentTime;
    const dt = Math.min(0.1, Math.max(0, t - this.lastT)) || ctx.time.frameDt;
    this.lastT = t;
    this.readListener();
    this.applyListener();
    this.mx.setDucked(ctx.paused || this.pauseEvent);
    if (t >= this.nextSite) {
      this.nextSite = t + 0.25;
      const L = this.env.listener;
      updateSite(ctx.world, L.x, L.y, L.z, this.env.site);
    }
    this.engine.update(ctx, dt);
    this.hull.update(ctx, dt);
    this.wind.update(ctx, dt);
    this.river.update(t, dt);
    this.falls.update(t);
    this.weather.update(ctx, dt);
    this.birds.update(t);
    this.village.update(t);
    this.temple.update(t);
  }

  stats() {
    return {
      state: this.ac.state,
      sampleRate: this.ac.sampleRate,
      time: +this.ac.currentTime.toFixed(2),
      listener: this.env.listener.toArray().map((v) => +v.toFixed(1)),
      site: Object.fromEntries(Object.entries(this.env.site).map(([k, v]) => [k, +v.toFixed(2)])),
      engine: this.engine.stats,
      wind: +this.wind.level.toFixed(3),
      gust: +this.env.gust.toFixed(2),
      riverBed: +this.river.bedLevel.toFixed(3),
      banks: this.river.stats,
      falls: this.falls.stats,
      birdCalls: this.birds.calls,
      cuckoos: this.birds.cuckoos,
      chimeStrikes: this.village.strikes,
      nearestChime: Math.round(this.village.nearest),
      bellStrikes: this.temple.strikes,
      bellDist: Math.round(this.temple.dist),
      weather: this.weather.stats(),
      samples: {
        ready: this.samples.ready,
        birds: Object.fromEntries(Object.entries(this.samples.birds).map(([k, v]) => [k, v.length])),
        loops: Object.keys(this.samples.loops),
        failed: this.samples.failed,
      },
    };
  }
}

export async function init(ctx: GameContext) {
  const samples = new Samples();
  // the recordings are only heard after the first key press: keep them off the wire until the valley
  // is on screen (decoding fetches them itself if audio starts first)
  ctx.events.on('app:revealed', () => samples.prefetch());
  let sys: AudioSystem | null = null;
  let failed = false;

  const hidden = () => document.hidden;
  const start = () => {
    if (failed) return;
    if (!sys) {
      try {
        sys = new AudioSystem(ctx, samples);
      } catch (e) {
        failed = true;
        console.warn('[audio] could not start', e);
        return;
      }
      sys.ac.resume().catch(() => {});
      sys.mx.setOpen(!hidden(), 1.2);
      return;
    }
    // later gestures revive a context the browser suspended (safari interruptions, autoplay)
    if (sys.ac.state !== 'running' && sys.ac.state !== 'closed' && !hidden()) {
      sys.ac.resume().then(() => sys?.mx.setOpen(true, 0.3)).catch(() => {});
    }
  };
  for (const type of ['pointerdown', 'keydown', 'touchend', 'mousedown'] as const) window.addEventListener(type, start, { capture: true });
  // a click during loading already counts as activation; start right away if the browser agrees
  if ((navigator as any).userActivation?.hasBeenActive) start();

  const hide = () => {
    const s = sys;
    if (!s) return;
    s.mx.setOpen(false, 0.05);
    setTimeout(() => {
      if (s.mx.isHidden && s.ac.state === 'running') s.ac.suspend().catch(() => {});
    }, 250);
  };
  const show = () => {
    const s = sys;
    if (!s || s.ac.state === 'closed') return;
    s.ac.resume().then(() => s.mx.setOpen(true, 0.35)).catch(() => {});
  };
  document.addEventListener('visibilitychange', () => (hidden() ? hide() : show()));
  ctx.events.on('app:hidden', hide);

  const ev = ctx.events;
  ev.on('settings:change', (patch: Partial<Settings>) => sys?.mx.applySettings({ ...ctx.settings, ...patch }));
  ev.on('pause', () => {
    if (sys) sys.pauseEvent = true;
  });
  ev.on('resume', () => {
    if (sys) sys.pauseEvent = false;
  });
  ev.on('boat:splash', (p) => sys?.hull.splash(p, ctx.boat));
  ev.on('boat:impact', (p) => sys?.hull.impact(p, ctx.boat));
  ev.on('boat:docked', () => {
    sys?.hull.setDocked(true);
    sys?.ui.play('dock');
  });
  ev.on('boat:undocked', () => {
    sys?.hull.setDocked(false);
    sys?.ui.play('undock');
  });
  ev.on('objective:completed', () => sys?.ui.play('complete'));
  ev.on('discovery', () => sys?.ui.play('discovery'));
  ev.on('unlock', () => sys?.ui.play('unlock'));
  ev.on('weather:lightning', (p) => sys?.weather.thunder(p));

  ctx.onUpdate((c) => sys?.update(c), 80);

  const service: AudioService = {
    play(name, opts) {
      sys?.ui.play(name, opts);
    },
    sounds: UI_SOUNDS,
    get started() {
      return !!sys;
    },
    get context() {
      return sys?.ac ?? null;
    },
    levels: () => sys?.mx.levels() ?? null,
    meter: async (ms) => (sys ? sys.mx.meter(ms) : null),
    stats: () => sys?.stats() ?? null,
    bell: () => sys?.temple.strike(),
  };
  ctx.services.audio = service;
}
