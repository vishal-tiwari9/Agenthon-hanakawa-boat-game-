// wind in the valley: a soft low body, leaves rustling in the trees on the banks (bright noise with
// a fast random flutter, riding slow gusts) and, in the gorge, bamboo on both banks: a papery
// rustle plus the odd hollow knock of stems touching when a gust comes through. it follows the
// shared wind strength (same field that moves grass and leaves), rises a little with boat speed
// and camera height. writes env.gust for the chimes. in a thunderstorm (ctx.services.day.storm) the gusts
// come harder and faster and the low body and leaves swell with them (./weather adds a howl).
import type { GameContext } from '../core/context';
import type { DayState } from '../core/daycycle';
import { uWindStrength } from '../core/uniforms';
import { bankPoint } from '../world/layout';
import type { AudioEnv } from './env';
import { burst, clamp, cleanupOnEnd, envelope, filter, gain, glide, glidePos, loopSource, panner, rand, slowNoise, smoothstep } from './dsp';

/** loudness that flutters randomly at leaf rate: gain swings between 1 - 2 * depth and 1 */
function flutter(ac: BaseAudioContext, src: AudioNode, rate: number, depth: number) {
  const am = gain(ac, 1 - depth);
  loopSource(ac, slowNoise(ac, rate, rand(5, 8))).connect(gain(ac, depth)).connect(am.gain);
  src.connect(am);
  return am;
}

export class Wind {
  private low: GainNode;
  private lowLp: BiquadFilterNode;
  private leaves: GainNode;
  private leavesBp: BiquadFilterNode;
  private bamboo: { g: GainNode; pan: PannerNode; side: -1 | 1 }[] = [];
  private gustTarget = 0.8;
  private nextGust = 0;
  private nextKnock = 0;
  level = 0;

  constructor(private env: AudioEnv) {
    const { ac, mx, noise } = env;
    const out = mx.layers.wind;
    const merge = (buf: AudioBuffer) => {
      const m = ac.createChannelMerger(2);
      loopSource(ac, buf).connect(m, 0, 0);
      loopSource(ac, buf).connect(m, 0, 1);
      return m;
    };
    this.lowLp = filter(ac, 'lowpass', 280, 0.5);
    this.low = gain(ac, 0);
    merge(noise.brown).connect(filter(ac, 'highpass', 40, 0.7)).connect(this.lowLp).connect(this.low).connect(out);

    // leaves: bright band with a leaf-rate flutter, separately on each side for width
    this.leavesBp = filter(ac, 'bandpass', 3800, 0.55);
    this.leaves = gain(ac, 0);
    const lm = ac.createChannelMerger(2);
    for (const ch of [0, 1]) {
      const src = loopSource(ac, noise.pink);
      const hp = filter(ac, 'highpass', 1400, 0.6);
      src.connect(hp);
      flutter(ac, hp, 12, 0.35).connect(lm, 0, ch);
    }
    lm.connect(this.leavesBp).connect(this.leaves).connect(out);

    // bamboo, one voice per bank, following the listener along the gorge
    for (const side of [-1, 1] as const) {
      const src = loopSource(ac, noise.white);
      const hp = filter(ac, 'highpass', 3000, 0.6);
      src.connect(hp);
      const g = gain(ac, 0);
      const pan = panner(ac, 'equalpower');
      flutter(ac, hp, 22, 0.4).connect(filter(ac, 'bandpass', 6000, 0.7)).connect(g).connect(pan).connect(out);
      this.bamboo.push({ g, pan, side });
    }
  }

  update(ctx: GameContext, dt: number) {
    const { ac, site } = this.env;
    const t = ac.currentTime;
    const now = ctx.time.real;
    const storm = clamp((ctx.services.day as DayState | undefined)?.storm ?? 0);
    if (now > this.nextGust) {
      // gusts: mostly gentle swells, occasionally a fuller one; a storm gusts harder and more often
      this.gustTarget = Math.random() < 0.15 + 0.25 * storm ? rand(1.05, 1.3 + 0.5 * storm) : rand(0.55 + 0.2 * storm, 1 + 0.3 * storm);
      this.nextGust = now + rand(2.5, 7) * (1 - 0.55 * storm);
    }
    this.env.gust += (this.gustTarget - this.env.gust) * (1 - Math.exp(-dt / (1.8 * (1 - 0.5 * storm))));
    const gust = this.env.gust;

    const strength = clamp(Number((uWindStrength as any).value) || 0.45);
    const speed = Math.abs(ctx.boat?.speed || 0);
    const apparent = smoothstep(0.8, 7, speed);
    const height = smoothstep(4, 90, this.env.listener.y);
    const base = 0.35 + 0.65 * strength;
    // the valley is sheltered: the low body stays small unless the camera climbs
    const low = 0.03 * base * gust + 0.06 * apparent + 0.06 * height * gust + 0.1 * storm * gust * gust;
    const leaves = (0.07 + 0.12 * strength) * gust * gust * site.trees * (1 - 0.5 * height) / (1 + site.toWater / 60) * (1 + 1.8 * storm);
    this.level = low + leaves;
    glide(this.low.gain, low, t, 0.3);
    glide(this.lowLp.frequency, 240 + 140 * gust + 180 * apparent + 260 * storm, t, 0.4);
    glide(this.leaves.gain, leaves, t, 0.35);
    glide(this.leavesBp.frequency, 3000 + 1400 * gust, t, 0.6);

    const g = Math.max(site.bambooL, site.bambooR);
    for (const b of this.bamboo) {
      const amount = b.side < 0 ? site.bambooL : site.bambooR;
      glide(b.g.gain, 0.1 * amount * gust * gust * base, t, 0.4);
      if (amount > 0.01) {
        const p = bankPoint(site.s + 6, b.side, 10);
        glidePos(b.pan, p.x, 5, p.z, t, 0.4);
      }
    }
    // hollow knocks of stems touching, only in a decent gust
    if (g > 0.3 && gust > 0.85 && t > this.nextKnock) {
      const b = this.bamboo[site.bambooL > site.bambooR ? 0 : 1];
      const n = 1 + Math.floor(Math.random() * 3);
      const f = rand(420, 820);
      for (let i = 0; i < n; i++) this.knock(b.pan, t + 0.02 + i * rand(0.09, 0.22), f * rand(0.95, 1.08), 0.05 * g * (i ? 0.7 : 1));
      this.nextKnock = t + rand(1.2, 5);
    }
  }

  private knock(dest: AudioNode, t: number, f: number, g: number) {
    const { ac, noise } = this.env;
    const o = ac.createOscillator();
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.94, t + 0.08);
    const oe = envelope(ac, t, g, 0.002, rand(0.025, 0.045));
    o.connect(oe.node).connect(dest);
    o.start(t);
    o.stop(oe.end);
    cleanupOnEnd(o, oe.node);
    const ne = envelope(ac, t, g * 0.6, 0.001, 0.006);
    const s = burst(ac, noise.white, t, ne.end);
    s.connect(filter(ac, 'bandpass', f * 2.4, 1.5)).connect(ne.node).connect(dest);
    cleanupOnEnd(s, ne.node);
  }
}
