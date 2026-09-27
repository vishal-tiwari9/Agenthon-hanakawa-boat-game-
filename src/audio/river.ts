// the river itself. a gentle stereo bed around the listener (a calm trickle loop, a babbling layer
// that opens up where the current runs faster or over rocks, and a rapids layer in the gorge), plus
// spatial bank voices: every ~0.5 s rays are marched over the baked `shore` signed-distance channel
// (sphere tracing: |shore| is a safe step) to find the water's edge on both banks. up to four well
// separated edge points become voices (trickle, or babble on rocky banks) with soft synthesized laps
// that come more often while the boat's wake is washing in. voices glide when their point moves a
// little and crossfade to a fresh voice when it jumps.
import type { WorldData } from '../world/worldData';
import type { GameContext } from '../core/context';
import type { AudioEnv } from './env';
import { channelHasData } from './site';
import { burst, clamp, cleanupOnEnd, envelope, filter, gain, glide, glidePos, hold, loopSource, panner, rand, setPos, smoothstep } from './dsp';

export interface EdgeHit {
  x: number;
  z: number;
  /** ray angle (rad, compass-style: 0 = north) */
  angle: number;
  /** horizontal distance from the listener */
  dist: number;
  /** 0..1 rockiness just inland of the edge */
  rock: number;
  /** terrain height ~20 m inland (tall banks: trees, bamboo, perches) */
  bank: number;
  /** how much bank this point stands for (neighbouring hits) */
  weight: number;
}

type Sampler = Pick<WorldData, 'sample' | 'has'>;

/** march `rays` rays from (x, z) and return where each first crosses the water's edge */
export function findEdges(world: Sampler, x: number, z: number, rays = 32, maxR = 160, rocky = true): EdgeHit[] {
  const hits: EdgeHit[] = [];
  if (!world.has('shore')) return hits;
  const hasH = world.has('height');
  // listener over land (photo camera on a hill): look for the water's edge from the other side
  const sign = world.sample('shore', x, z) >= 0 ? 1 : -1;
  for (let r = 0; r < rays; r++) {
    const a = (r / rays) * Math.PI * 2;
    const dx = Math.sin(a), dz = -Math.cos(a);
    let t = 0;
    let found = false;
    for (let i = 0; i < 40 && t < maxR; i++) {
      const s = world.sample('shore', x + dx * t, z + dz * t) * sign;
      if (s <= 0.5) {
        found = true;
        break;
      }
      t += Math.max(1.5, s * 0.9);
    }
    if (!found) continue;
    const land = sign < 0 ? t + 3 : Math.max(0, t - 3);
    const inland = sign < 0 ? t + 20 : Math.max(0, t - 20);
    hits.push({
      x: x + dx * t,
      z: z + dz * t,
      angle: a,
      dist: t,
      rock: rocky ? clamp(world.sample('rock', x + dx * land, z + dz * land) * 1.6) : 0,
      bank: hasH ? world.sample('height', x + dx * inland, z + dz * inland) : 0,
      weight: 1,
    });
  }
  return hits;
}

const angDiff = (a: number, b: number) => {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
};

/** nearest hits first, at least `minSep` apart in bearing; weight grows with the bank each one represents */
export function pickEdges(hits: EdgeHit[], max = 4, minSep = (50 * Math.PI) / 180): EdgeHit[] {
  const sorted = [...hits].sort((a, b) => a.dist - b.dist);
  const out: EdgeHit[] = [];
  for (const h of sorted) {
    if (out.length >= max) break;
    if (!out.every((o) => angDiff(o.angle, h.angle) >= minSep)) continue;
    let n = 0;
    for (const o of hits) if (angDiff(o.angle, h.angle) <= (34 * Math.PI) / 180 && o.dist <= h.dist * 1.8 + 10) n++;
    out.push({ ...h, weight: clamp(Math.sqrt(n / 3), 0.7, 1.5) });
  }
  return out;
}

interface Voice {
  state: 'free' | 'active' | 'release';
  x: number;
  z: number;
  rock: number;
  dist: number;
  target: number;
  freeAt: number;
  nextLap: number;
  trickle: GainNode;
  babble: GainNode;
  fallback: GainNode;
  lp: BiquadFilterNode;
  level: GainNode;
  pan: PannerNode;
}

const POOL = 6;
const MAX_EDGES = 4;
const EDGE_Y = 0.3;

export class River {
  private voices: Voice[] = [];
  private nextSearch = 0;
  private attached = false;
  private bed: { calm: GainNode; babble: GainNode; rapids: GainNode; fallback: GainNode; calmLp: BiquadFilterNode };
  private breathe = 1;
  private breatheTarget = 1;
  private nextBreathe = 0;
  edges: EdgeHit[] = [];
  bedLevel = 0;

  constructor(private env: AudioEnv, private ctx: GameContext) {
    const { ac, mx, noise } = env;
    const out = mx.layers.river;
    // bed: each layer is fed later by two decorrelated copies of a loop, left and right
    const calm = gain(ac, 0), babble = gain(ac, 0), rapids = gain(ac, 0), fallback = gain(ac, 0);
    const calmLp = filter(ac, 'lowpass', 2500, 0.5);
    calm.connect(calmLp).connect(out);
    babble.connect(filter(ac, 'lowpass', 7000, 0.5)).connect(out);
    rapids.connect(out);
    // until the recordings decode: soft filtered noise so the river is never silent
    loopSource(ac, noise.pink).connect(filter(ac, 'lowpass', 1100, 0.5)).connect(fallback).connect(out);
    this.bed = { calm, babble, rapids, fallback, calmLp };

    const fbBus = gain(ac, 1);
    loopSource(ac, noise.pink).connect(filter(ac, 'bandpass', 900, 0.6)).connect(fbBus);
    for (let i = 0; i < POOL; i++) {
      const v: Voice = {
        state: 'free', x: 0, z: 0, rock: 0, dist: 0, target: 0, freeAt: 0, nextLap: 0,
        trickle: gain(ac, 0), babble: gain(ac, 0), fallback: gain(ac, 0.4),
        lp: filter(ac, 'lowpass', 3000, 0.5), level: gain(ac, 0), pan: panner(ac, 'equalpower'),
      };
      fbBus.connect(v.fallback);
      for (const n of [v.trickle, v.babble, v.fallback]) n.connect(v.lp);
      v.lp.connect(v.level).connect(v.pan).connect(out);
      this.voices.push(v);
    }
    env.samples.onReady(() => this.attach());
  }

  /** once the recordings decode: the bed gets stereo pairs, each bank voice its own copies */
  private attach() {
    const { ac, samples } = this.env;
    const L = samples.loops;
    if (this.attached || !L.calm) return;
    this.attached = true;
    const stereo = (buf: AudioBuffer | undefined, dest: GainNode) => {
      if (!buf) return;
      const m = ac.createChannelMerger(2);
      loopSource(ac, buf, rand(0.97, 1.03)).connect(m, 0, 0);
      loopSource(ac, buf, rand(0.97, 1.03)).connect(m, 0, 1);
      m.connect(dest);
    };
    stereo(L.calm, this.bed.calm);
    stereo(L.babble, this.bed.babble);
    stereo(L.rapids, this.bed.rapids);
    const t = ac.currentTime;
    glide(this.bed.fallback.gain, 0, t, 0.8);
    for (const v of this.voices) {
      if (L.trickle) loopSource(ac, L.trickle, rand(0.9, 1.08)).connect(v.trickle);
      if (L.babble) loopSource(ac, L.babble, rand(0.9, 1.08)).connect(v.babble);
      glide(v.fallback.gain, 0, t, 0.8);
      this.mixVoice(v, t);
    }
  }

  private mixVoice(v: Voice, t: number) {
    if (!this.attached) return;
    const babble = this.env.samples.loops.babble ? smoothstep(0.1, 0.6, v.rock) : 0;
    glide(v.trickle.gain, 1 - 0.6 * babble, t, 0.5);
    glide(v.babble.gain, 0.8 * babble, t, 0.5);
  }

  update(t: number, dt: number) {
    const { site, listener: L } = this.env;
    // slow breathing of the bed so it never sits dead still
    if (t > this.nextBreathe) {
      this.breatheTarget = rand(0.8, 1.15);
      this.nextBreathe = t + rand(2, 6);
    }
    this.breathe += (this.breatheTarget - this.breathe) * (1 - Math.exp(-dt / 1.5));

    // bed: close to the water and not high above it
    const near = 1 / (1 + site.toWater / 25) / (1 + Math.max(0, site.height - 3) / 40);
    const flowN = smoothstep(0.1, 0.75, site.flow);
    const fast = smoothstep(0.45, 0.8, site.flow);
    const calm = (0.1 + 0.14 * flowN) * near * this.breathe;
    const babble = (0.2 * fast * (0.35 + 0.65 * site.rock) + 0.22 * site.gorge) * near * this.breathe;
    const rapids = (0.28 * site.gorge * (0.5 + 0.5 * site.rock) + 0.1 * site.rock * (1 - site.gorge)) * near;
    this.bedLevel = calm + babble + rapids;
    glide(this.bed.calm.gain, calm, t, 0.4);
    glide(this.bed.babble.gain, babble, t, 0.4);
    glide(this.bed.rapids.gain, rapids, t, 0.4);
    glide(this.bed.calmLp.frequency, 1800 + 3000 * flowN, t, 0.5);
    if (!this.attached) glide(this.bed.fallback.gain, calm * 0.6, t, 0.4);

    if (t >= this.nextSearch) {
      this.nextSearch = t + 0.5;
      const world = this.ctx.world;
      this.edges = world ? pickEdges(findEdges(world, L.x, L.z, 32, 160, channelHasData(world, 'rock')), MAX_EDGES) : [];
      this.assign(t);
    }

    // laps along the active banks; the boat's wake reaching the bank makes them come more often
    const wake = clamp(Math.abs(this.ctx.boat?.speed || 0) / 4);
    for (const v of this.voices) {
      if (v.state === 'release' && t > v.freeAt) v.state = 'free';
      if (v.state === 'active' && t > v.nextLap) {
        this.lap(v, t + 0.02, 1 + wake);
        v.nextLap = t + rand(0.7, 2.6) / (1 + 1.5 * wake);
      }
    }
  }

  private assign(t: number) {
    const L = this.env.listener;
    const used = new Set<Voice>();
    for (const h of this.edges) {
      let best: Voice | null = null;
      let bestD = Math.max(12, h.dist * 0.3);
      for (const v of this.voices) {
        if (v.state !== 'active' || used.has(v)) continue;
        const d = Math.hypot(v.x - h.x, v.z - h.z);
        if (d < bestD) {
          bestD = d;
          best = v;
        }
      }
      let v = best;
      if (v) {
        glidePos(v.pan, h.x, EDGE_Y, h.z, t, 0.35);
      } else {
        v = this.voices.find((c) => c.state === 'free' && !used.has(c)) ?? null;
        if (!v) continue;
        v.state = 'active';
        hold(v.level.gain, 0, t);
        setPos(v.pan, h.x, EDGE_Y, h.z);
        v.nextLap = t + rand(0.2, 1.5);
      }
      used.add(v);
      v.x = h.x;
      v.z = h.z;
      v.rock = h.rock;
      const d3 = Math.hypot(h.x - L.x, EDGE_Y - L.y, h.z - L.z);
      v.dist = d3;
      v.target = 0.26 * Math.pow(12 / Math.max(12, d3), 1.1) * (0.7 + 0.5 * h.rock) * h.weight;
      glide(v.lp.frequency, clamp(1200 + 9000 * Math.exp(-d3 / 45), 900, 10000), t, 0.5);
      glide(v.level.gain, v.target, t, best ? 0.6 : 0.8);
      this.mixVoice(v, t);
    }
    for (const v of this.voices) {
      if (v.state === 'active' && !used.has(v)) {
        v.state = 'release';
        v.freeAt = t + 4;
        v.target = 0;
        glide(v.level.gain, 0, t, 0.9);
      }
    }
  }

  /** a soft lap at the bank: one or two darker water clops */
  private lap(v: Voice, t: number, amount: number) {
    const { ac, noise } = this.env;
    const f = rand(260, 520);
    const n = Math.random() < 0.55 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const t0 = t + i * rand(0.06, 0.14);
      const e = envelope(ac, t0, 0.5 * v.target * amount * (i ? 0.6 : 1), 0.02, rand(0.05, 0.11));
      const s = burst(ac, noise.pink, t0, e.end);
      s.connect(filter(ac, 'bandpass', f * (i ? 1.35 : 1), 1.2)).connect(e.node).connect(v.pan);
      cleanupOnEnd(s, e.node);
    }
  }

  get stats() {
    return this.voices
      .filter((v) => v.state !== 'free')
      .map((v) => ({ state: v.state, x: Math.round(v.x), z: Math.round(v.z), dist: Math.round(v.dist), rock: +v.rock.toFixed(2), level: +v.target.toFixed(3) }));
  }
}
