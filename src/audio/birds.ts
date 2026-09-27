// forest birds in the trees on the banks. a bird picks a perch near the listener (on either bank,
// in the tree line when the bake has trees) and sings a short bout from it: the japanese bush
// warbler (uguisu) repeats its "hoo-hokekyo" a few times, a tit or a wren sings once or twice.
// bouts are sparse and at most two overlap. far up the valley sides a cuckoo calls its two soft
// notes now and then (synthesized: the call is nearly a pure tone). distance darkens and echoes.
// `activity` (set by ./weather) thins the bouts out at night and in the rain.
import type { GameContext } from '../core/context';
import { RIVER_LENGTH, bankPoint } from '../world/layout';
import type { AudioEnv } from './env';
import type { Songbird } from './samples';
import { channelHasData } from './site';
import { clamp, filter, gain, panner, pick, rand, setPos } from './dsp';

const SPECIES: { id: Songbird; weight: number; amp: number; calls: [number, number]; gap: [number, number] }[] = [
  { id: 'uguisu', weight: 0.45, amp: 0.3, calls: [2, 4], gap: [5, 11] },
  { id: 'tit', weight: 0.3, amp: 0.18, calls: [1, 3], gap: [3, 7] },
  { id: 'wren', weight: 0.25, amp: 0.16, calls: [1, 2], gap: [5, 9] },
];

interface Bout {
  species: (typeof SPECIES)[number];
  x: number;
  y: number;
  z: number;
  left: number;
  next: number;
}

export class Birds {
  private bouts: Bout[] = [];
  private nextBout: number;
  private nextCuckoo: number;
  calls = 0;
  cuckoos = 0;
  /** 0..1 how lively the birds are: 1 in fair daylight, falling at night and in the rain */
  activity = 1;

  constructor(private env: AudioEnv, private ctx: GameContext) {
    const t = env.ac.currentTime;
    this.nextBout = t + rand(3, 8);
    this.nextCuckoo = t + rand(25, 60);
  }

  /** a spot in the trees on a bank, between minD and maxD from the listener */
  private perch(ds: [number, number], off: [number, number], up: [number, number], minD: number, maxD: number) {
    const { site, listener: L } = this.env;
    const world = this.ctx.world;
    const trees = channelHasData(world, 'trees');
    const heights = channelHasData(world, 'height');
    let fallback: { x: number; y: number; z: number } | null = null;
    for (let i = 0; i < 12; i++) {
      const s = clamp(site.s + (Math.random() < 0.5 ? -1 : 1) * rand(ds[0], ds[1]), 5, RIVER_LENGTH - 5);
      const p = bankPoint(s, Math.random() < 0.5 ? -1 : 1, rand(off[0], off[1]));
      const ground = heights ? Math.max(0, world.heightAt(p.x, p.z)) : 1.5;
      const y = ground + rand(up[0], up[1]);
      const d = Math.hypot(p.x - L.x, y - L.y, p.z - L.z);
      if (d < minD || d > maxD) continue;
      if (!trees || world.sample('trees', p.x, p.z) > 0.3) return { x: p.x, y, z: p.z };
      fallback ??= { x: p.x, y, z: p.z };
    }
    return fallback;
  }

  update(t: number) {
    const { samples } = this.env;
    if (t > this.nextBout) {
      this.nextBout = t + rand(9, 22);
      const avail = SPECIES.filter((s) => samples.birds[s.id].length);
      if (avail.length && this.bouts.length < 2 && (this.activity >= 1 || Math.random() < this.activity)) {
        let r = Math.random() * avail.reduce((a, s) => a + s.weight, 0);
        let sp = avail[0];
        for (const s of avail) if ((r -= s.weight) <= 0) { sp = s; break; }
        const p = this.perch([10, 130], [6, 45], [3, 12], 25, 150);
        if (p) this.bouts.push({ species: sp, ...p, left: Math.round(rand(sp.calls[0], sp.calls[1])), next: t + 0.05 });
      }
    }
    for (const b of this.bouts) {
      if (t < b.next) continue;
      this.sing(b);
      b.left--;
      b.next = t + rand(b.species.gap[0], b.species.gap[1]);
    }
    this.bouts = this.bouts.filter((b) => b.left > 0);

    if (t > this.nextCuckoo) {
      this.nextCuckoo = t + rand(55, 140);
      const p = this.perch([120, 320], [50, 140], [15, 35], 140, 420);
      if (p && (this.activity >= 1 || Math.random() < this.activity)) this.cuckoo(t + 0.1, p);
    }
  }

  private out(x: number, y: number, z: number, level: number, verb: number, lpHz: number) {
    const { ac, mx } = this.env;
    const g = gain(ac, level);
    const lp = filter(ac, 'lowpass', lpHz, 0.5);
    const pan = panner(ac, 'HRTF');
    setPos(pan, x, y, z);
    g.connect(lp).connect(pan).connect(mx.layers.birds);
    const send = gain(ac, verb);
    lp.connect(send).connect(mx.worldVerb);
    return { g, nodes: [g, lp, pan, send] as AudioNode[] };
  }

  private sing(b: Bout) {
    const { ac, samples, listener: L } = this.env;
    const buf = pick(samples.birds[b.species.id]);
    if (!buf) return;
    const d = Math.max(5, Math.hypot(b.x - L.x, b.y - L.y, b.z - L.z));
    const level = b.species.amp * Math.pow(25 / Math.max(25, d), 0.9) * rand(0.75, 1);
    const o = this.out(b.x, b.y, b.z, level, 0.2 + 0.3 * clamp(d / 250), 2000 + 10000 * Math.exp(-d / 120));
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rand(0.97, 1.03);
    src.connect(o.g);
    src.start(ac.currentTime + 0.02);
    src.onended = () => o.nodes.forEach((n) => { try { n.disconnect(); } catch {} });
    this.calls++;
  }

  /** "kak-ko": two soft hooting notes a third apart, repeated slowly */
  private cuckoo(t: number, p: { x: number; y: number; z: number }) {
    const { ac, listener: L } = this.env;
    const d = Math.max(40, Math.hypot(p.x - L.x, p.y - L.y, p.z - L.z));
    const o = this.out(p.x, p.y, p.z, 0.2 * Math.pow(40 / d, 0.9), 0.45, 2400);
    const f1 = rand(620, 700), f2 = f1 * rand(0.79, 0.84);
    const n = Math.round(rand(4, 8));
    const period = rand(1.0, 1.25);
    let end = t;
    for (let i = 0; i < n; i++) {
      const t0 = t + i * period * rand(0.97, 1.03);
      for (const [f, at, dur] of [[f1, 0, 0.2], [f2, 0.33, 0.32]] as const) {
        const ts = t0 + at;
        const eg = gain(ac, 0);
        eg.gain.setValueAtTime(0, ts);
        eg.gain.linearRampToValueAtTime(1, ts + 0.035);
        eg.gain.linearRampToValueAtTime(0.75, ts + dur - 0.05);
        eg.gain.linearRampToValueAtTime(0, ts + dur);
        eg.connect(o.g);
        for (const [mul, amp] of [[1, 1], [2, 0.1], [3, 0.03]] as const) {
          const osc = ac.createOscillator();
          osc.frequency.setValueAtTime(f * mul, ts);
          osc.frequency.exponentialRampToValueAtTime(f * mul * 0.97, ts + dur);
          const a = gain(ac, amp);
          osc.connect(a).connect(eg);
          osc.start(ts);
          osc.stop(ts + dur + 0.01);
          osc.onended = () => { try { a.disconnect(); } catch {} };
        }
        end = ts + dur;
      }
    }
    this.cuckoos++;
    setTimeout(() => o.nodes.forEach((n) => { try { n.disconnect(); } catch {} }), (end - ac.currentTime + 3.5) * 1000);
  }
}
