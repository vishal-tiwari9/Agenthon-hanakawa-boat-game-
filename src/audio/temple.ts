// the temple bell (bonsho) by the five-storey pagoda: struck now and then with a wooden beam, a deep
// bronze tone with inharmonic partials that die away at different rates, each partial a close
// pair so the tone wavers (the slow beating the japanese call "unari"), a soft thud for the strike,
// and a long valley echo. heard within ~900 m, a strike every minute or two.
import type { GameContext } from '../core/context';
import { LANDMARKS, landmarkPoint } from '../world/layout';
import type { AudioEnv } from './env';
import { channelHasData } from './site';
import { burst, cleanupOnEnd, envelope, filter, gain, panner, rand, setPos } from './dsp';

/** [ratio to the strike tone, amplitude, seconds to fade by 60 dB] */
const PARTIALS: [number, number, number][] = [
  [0.5, 0.3, 26],
  [1, 1, 24],
  [1.47, 0.55, 18],
  [2.03, 0.6, 14],
  [2.69, 0.45, 10],
  [3.4, 0.35, 7],
  [4.25, 0.25, 5],
  [5.2, 0.15, 3.2],
  [6.3, 0.1, 2.2],
  [7.6, 0.06, 1.4],
];
const RANGE = 900;

export class Temple {
  private x = 0;
  private y = 8;
  private z = 0;
  private next = 0;
  strikes = 0;
  dist = Infinity;

  constructor(private env: AudioEnv, ctx: GameContext) {
    const l = LANDMARKS.find((m) => m.id === 'pagoda');
    if (l) {
      const p = landmarkPoint(l);
      this.x = p.x;
      this.z = p.z;
      this.y = (channelHasData(ctx.world, 'height') ? Math.max(0, ctx.world.heightAt(p.x, p.z)) : 5) + 6;
    }
  }

  update(t: number) {
    const L = this.env.listener;
    this.dist = Math.hypot(this.x - L.x, this.y - L.y, this.z - L.z);
    if (this.dist > RANGE) {
      this.next = 0;
      return;
    }
    if (!this.next) this.next = t + rand(12, 30);
    if (t < this.next) return;
    this.next = t + rand(75, 170);
    this.strike(t + 0.05);
  }

  /** ring the bell now (also used by tests) */
  strike(t = this.env.ac.currentTime + 0.05) {
    const { ac, mx, noise, listener: L } = this.env;
    const d = Math.max(20, Math.hypot(this.x - L.x, this.y - L.y, this.z - L.z));
    const pan = panner(ac, 'equalpower');
    setPos(pan, this.x, this.y, this.z);
    const out = gain(ac, 0.45 * Math.pow(50 / Math.max(50, d), 0.85));
    out.connect(filter(ac, 'lowpass', 700 + 7000 * Math.exp(-d / 220), 0.5)).connect(pan).connect(mx.layers.temple);
    const send = gain(ac, 0.5);
    out.connect(send).connect(mx.worldVerb);
    const f0 = rand(66, 74);
    let end = t;
    for (const [ratio, amp, t60] of PARTIALS) {
      const beat = rand(0.3, 1.1);
      for (const det of [0, beat]) {
        const o = ac.createOscillator();
        o.frequency.value = f0 * ratio + det;
        const e = envelope(ac, t, amp * 0.07, ratio < 1.2 ? 0.03 : 0.008, t60 / 6.9);
        o.connect(e.node).connect(out);
        o.start(t);
        const stop = t + Math.min(t60 + 1, 30);
        o.stop(stop);
        cleanupOnEnd(o, e.node);
        end = Math.max(end, stop);
      }
    }
    // the wooden beam's soft thud
    const te = envelope(ac, t, 0.5, 0.002, 0.05);
    const ts = burst(ac, noise.pink, t, te.end);
    ts.connect(filter(ac, 'lowpass', 350, 0.7)).connect(te.node).connect(out);
    cleanupOnEnd(ts, te.node);
    this.strikes++;
    setTimeout(() => [out, send, pan].forEach((n) => { try { n.disconnect(); } catch {} }), (end - ac.currentTime + 4) * 1000);
  }
}
