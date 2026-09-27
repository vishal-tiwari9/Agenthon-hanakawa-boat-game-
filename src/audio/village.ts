// hanakawa village (left bank, s ~60-330): furin wind chimes hanging under the eaves. a glass furin
// gives a bright, fairly pure ring that fades in half a second; an iron one a lower, longer ring
// with a slow beat. the clapper swings in little clusters of strikes, more often when the wind
// gusts. faint, and only within ~170 m of the houses.
import type { GameContext } from '../core/context';
import { bankPoint } from '../world/layout';
import type { AudioEnv } from './env';
import { channelHasData } from './site';
import { burst, cleanupOnEnd, envelope, filter, gain, panner, rand, setPos } from './dsp';

interface Chime {
  x: number;
  y: number;
  z: number;
  kind: 'glass' | 'iron';
  f: number;
}

const CHIME_S = [85, 140, 205, 255, 315];
const GLASS = { parts: [1, 2.32, 4.1], amps: [1, 0.18, 0.05], taus: [0.5, 0.2, 0.08] };
const IRON = { parts: [1, 2.76, 5.4], amps: [1, 0.3, 0.1], taus: [1.4, 0.5, 0.2] };

export class Village {
  private chimes: Chime[];
  private next = 0;
  nearest = Infinity;
  strikes = 0;

  constructor(private env: AudioEnv, ctx: GameContext) {
    const heights = channelHasData(ctx.world, 'height');
    this.chimes = CHIME_S.map((s, i) => {
      const p = bankPoint(s, -1, rand(9, 24));
      const ground = heights ? Math.max(0.5, ctx.world.heightAt(p.x, p.z)) : 1.2;
      const kind = i % 2 ? 'iron' : 'glass';
      return { x: p.x, z: p.z, y: ground + 2.8, kind, f: kind === 'glass' ? rand(2600, 3400) : rand(1250, 1650) };
    });
    this.next = env.ac.currentTime + rand(2, 5);
  }

  update(t: number) {
    const L = this.env.listener;
    let wsum = 0;
    const w = this.chimes.map((c) => {
      const d = Math.hypot(c.x - L.x, c.y - L.y, c.z - L.z);
      const v = d < 170 ? 1 / (d + 20) : 0;
      wsum += v;
      return { c, d, v };
    });
    this.nearest = Math.min(...w.map((e) => e.d));
    if (!wsum || t < this.next) return;
    const gust = this.env.gust;
    this.next = t + rand(2.5, 8) / (0.4 + 0.8 * gust);
    let r = Math.random() * wsum;
    let pickd = w[0];
    for (const e of w) if ((r -= e.v) <= 0) { pickd = e; break; }
    if (!pickd.v) return;
    const n = 2 + Math.floor(Math.random() * (gust > 0.9 ? 4 : 3));
    let tt = t + 0.02, vel = 1;
    for (let i = 0; i < n; i++) {
      this.ring(tt, pickd.c, pickd.d, vel);
      tt += rand(0.1, 0.35);
      vel *= rand(0.6, 0.85);
    }
  }

  private ring(t: number, c: Chime, d: number, vel: number) {
    const { ac, mx, noise } = this.env;
    const spec = c.kind === 'glass' ? GLASS : IRON;
    const pan = panner(ac, 'equalpower');
    setPos(pan, c.x, c.y, c.z);
    const out = gain(ac, 0.06 * vel * Math.pow(10 / Math.max(10, d), 1.05));
    out.connect(filter(ac, 'lowpass', 3000 + 9000 * Math.exp(-d / 80), 0.5)).connect(pan).connect(mx.layers.village);
    const send = gain(ac, 0.18);
    out.connect(send).connect(mx.worldVerb);
    const f0 = c.f * rand(0.995, 1.005);
    let end = t;
    for (let i = 0; i < spec.parts.length; i++) {
      // the iron bell's fundamental gets a slightly detuned twin for its slow beat
      for (const det of c.kind === 'iron' && i === 0 ? [0, 1.2] : [0]) {
        const o = ac.createOscillator();
        o.frequency.value = f0 * spec.parts[i] + det;
        const e = envelope(ac, t, spec.amps[i] * (det ? 0.6 : 1), 0.002, spec.taus[i] * rand(0.8, 1.2));
        o.connect(e.node).connect(out);
        o.start(t);
        o.stop(e.end);
        cleanupOnEnd(o, e.node);
        end = Math.max(end, e.end);
      }
    }
    // the clapper's tiny tick
    const te = envelope(ac, t, 0.2, 0.001, 0.003);
    const ts = burst(ac, noise.white, t, te.end);
    ts.connect(filter(ac, 'bandpass', 5200, 1.2)).connect(te.node).connect(out);
    cleanupOnEnd(ts, te.node);
    this.strikes++;
    setTimeout(() => [out, send, pan].forEach((n) => { try { n.disconnect(); } catch {} }), (end - ac.currentTime + 0.5) * 1000);
  }
}
