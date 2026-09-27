// bus structure. voices -> layer bus (wind, river, falls, hull, birds, village, temple, plus rain, thunder
// and night created on demand by ./weather) -> ambience / engine / ui
// (user volumes) -> world duck (pause) -> master (user volume) -> soft limiter -> gate (tab hidden,
// fade-in) -> destination. every bus has an analyser so the harness can read levels.
import type { Settings } from '../core/settings';
import { gain, glide, reverbIR, rmsDb } from './dsp';

export type LayerName = 'wind' | 'river' | 'falls' | 'hull' | 'birds' | 'village' | 'temple';

/** slider (0..1) to gain; squared so the slider feels even to the ear */
const curve = (v: number) => {
  const x = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  return x * x;
};

export class Mixer {
  readonly ac: AudioContext;
  readonly gate: GainNode;
  readonly master: GainNode;
  readonly engine: GainNode;
  readonly ambience: GainNode;
  readonly ui: GainNode;
  readonly layers: Record<LayerName, GainNode>;
  /** reverb sends: world one returns into ambience, ui one into the ui bus */
  readonly worldVerb: GainNode;
  readonly uiVerb: GainNode;
  private duck: GainNode;
  private extra = new Map<string, GainNode>();
  private analysers = new Map<string, AnalyserNode>();
  private scratch = new Float32Array(2048);
  private ducked = false;
  private hidden = false;

  constructor(ac: AudioContext, settings: Settings) {
    this.ac = ac;
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 10;
    limiter.ratio.value = 4;
    limiter.attack.value = 0.008;
    limiter.release.value = 0.3;
    this.gate = gain(ac, 0);
    this.master = gain(ac, curve(settings.masterVolume));
    this.master.connect(limiter).connect(this.gate).connect(ac.destination);

    this.duck = gain(ac, 1);
    this.duck.connect(this.master);
    this.engine = gain(ac, curve(settings.engineVolume));
    this.ambience = gain(ac, curve(settings.ambienceVolume));
    this.ui = gain(ac, curve(settings.uiVolume));
    this.engine.connect(this.duck);
    this.ambience.connect(this.duck);
    this.ui.connect(this.master);

    this.layers = {
      wind: gain(ac, 1),
      river: gain(ac, 1),
      falls: gain(ac, 1),
      hull: gain(ac, 1),
      birds: gain(ac, 1),
      village: gain(ac, 1),
      temple: gain(ac, 1),
    };
    for (const g of Object.values(this.layers)) g.connect(this.ambience);

    this.worldVerb = gain(ac, 1);
    const wv = ac.createConvolver();
    wv.buffer = reverbIR(ac, 3.2, 3.6);
    this.worldVerb.connect(wv).connect(gain(ac, 0.5)).connect(this.ambience);
    this.uiVerb = gain(ac, 1);
    const uv = ac.createConvolver();
    uv.buffer = reverbIR(ac, 1.4, 3);
    this.uiVerb.connect(uv).connect(gain(ac, 0.5)).connect(this.ui);

    this.tap('master', this.master);
    this.tap('engine', this.engine);
    this.tap('ambience', this.ambience);
    this.tap('ui', this.ui);
    for (const [k, g] of Object.entries(this.layers)) this.tap(k, g);
  }

  /** a layer bus created on first use (weather), into ambience like the fixed ones, with its own analyser */
  layer(name: string): GainNode {
    let g = this.extra.get(name);
    if (!g) {
      g = gain(this.ac, 1);
      g.connect(this.ambience);
      this.extra.set(name, g);
      this.tap(name, g);
    }
    return g;
  }

  private tap(name: string, node: AudioNode) {
    const an = this.ac.createAnalyser();
    an.fftSize = 2048;
    node.connect(an);
    this.analysers.set(name, an);
  }

  applySettings(s: Partial<Settings>) {
    const t = this.ac.currentTime;
    if (s.masterVolume !== undefined) glide(this.master.gain, curve(s.masterVolume), t, 0.05);
    if (s.engineVolume !== undefined) glide(this.engine.gain, curve(s.engineVolume), t, 0.05);
    if (s.ambienceVolume !== undefined) glide(this.ambience.gain, curve(s.ambienceVolume), t, 0.05);
    if (s.uiVolume !== undefined) glide(this.ui.gain, curve(s.uiVolume), t, 0.05);
  }

  /** pause: world sounds sink to a soft bed under the menu, ui stays at full level */
  setDucked(on: boolean) {
    if (on === this.ducked) return;
    this.ducked = on;
    glide(this.duck.gain, on ? 0.16 : 1, this.ac.currentTime, on ? 0.25 : 0.7);
  }

  /** first start and tab visibility: fade the whole output */
  setOpen(open: boolean, tau = 0.6) {
    this.hidden = !open;
    glide(this.gate.gain, open ? 1 : 0, this.ac.currentTime, tau);
  }

  get isHidden() {
    return this.hidden;
  }

  /** instantaneous rms per bus (dBFS, ~43 ms window) */
  levels(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, an] of this.analysers) out[k] = +rmsDb(an, this.scratch).toFixed(1);
    return out;
  }

  /** rms per bus averaged over `ms` (power mean), for tests */
  async meter(ms = 1000): Promise<Record<string, number>> {
    const acc = new Map<string, number>();
    let n = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      for (const [k, an] of this.analysers) {
        const p = Math.pow(10, rmsDb(an, this.scratch) / 10);
        acc.set(k, (acc.get(k) || 0) + p);
      }
      n++;
      await new Promise((r) => setTimeout(r, 40));
    }
    const out: Record<string, number> = {};
    for (const [k, p] of acc) out[k] = +(10 * Math.log10(p / n + 1e-12)).toFixed(1);
    return out;
  }
}
