// weather and night sounds, driven by ctx.services.day (src/core/daycycle.ts). nothing is built while the
// day cycle sits at its defaults (time-lapse off, clear morning): the first time the time-lapse runs or
// any weather or night value rises, the rain/thunder/night buses and the noise voices start, and the
// synthesized loops (./chorus) are rendered one per frame. after a while back at the defaults the voices
// stop again (the buffers are kept).
//  - rain: a stereo hiss bed (pink noise, brighter as it gets heavier), a low roar in the storm, and rain
//    on the water (a loop of tiny clicks and bubble plinks, a second denser layer in the storm)
//  - thunder on 'weather:lightning': delayed by distance (true time for near strikes, far ones compressed
//    into 3 s so they fit the 20 s day), a sharp crack for near strikes, then a rolling low rumble;
//    loudness from strength and distance
//  - storm wind: a gusting howl band on top of ./wind (which also leans harder into its gusts)
//  - night: a cricket chorus and a frog chorus (tree frogs also call in the rain)
//  - birds fade out at night and in the rain (the birds bus plus fewer bouts, see ./birds)
import type { GameContext } from '../core/context';
import type { DayState } from '../core/daycycle';
import type { AudioEnv } from './env';
import type { Birds } from './birds';
import { cricketBuffer, frogBuffer, patterBuffer } from './chorus';
import { burst, clamp, cleanupOnEnd, envelope, filter, gain, glide, loopSource, rand, smoothstep } from './dsp';

interface Voices {
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  bed: GainNode;
  bedLp: BiquadFilterNode;
  roar: GainNode;
  howl: GainNode;
  howlBp: BiquadFilterNode;
  patter: GainNode | null;
  patterHeavy: GainNode | null;
  crickets: GainNode | null;
  frogs: GainNode | null;
}

/** thunder delay: true (distance / 343) for near strikes, far ones eased into at most 3 s */
export function thunderDelay(distance: number) {
  const raw = Math.max(0, distance) / 343;
  return clamp(Math.min(raw, 0.2 + 2.8 * (1 - Math.exp(-raw / 3))), 0.2, 3);
}

export class Weather {
  private v: Voices | null = null;
  private buses: { rain: GainNode; thunder: GainNode; night: GainNode } | null = null;
  private buf: { patter?: AudioBuffer; crickets?: [AudioBuffer, AudioBuffer]; frogs?: [AudioBuffer, AudioBuffer] } = {};
  private idle = 0;
  private birdLevel = 1;
  thunders = 0;
  lastDelay = 0;
  lastThunderAt = 0;
  buildMs = 0;

  constructor(private env: AudioEnv, private birds: Birds) {}

  private ensureBuses() {
    if (this.buses) return this.buses;
    const { mx } = this.env;
    this.buses = { rain: mx.layer('rain'), thunder: mx.layer('thunder'), night: mx.layer('night') };
    return this.buses;
  }

  /** the always-cheap part: noise voices on the shared buffers, all at gain 0 */
  private start(): Voices {
    const { ac, noise } = this.env;
    const b = this.ensureBuses();
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const stereo = (buf: AudioBuffer, rateL = 1, rateR = 1) => {
      const m = ac.createChannelMerger(2);
      for (const [ch, rate] of [[0, rateL], [1, rateR]] as const) {
        const s = loopSource(ac, buf, rate);
        s.connect(m, 0, ch);
        sources.push(s);
      }
      nodes.push(m);
      return m;
    };
    const chain = (...list: AudioNode[]) => {
      for (let i = 0; i + 1 < list.length; i++) list[i].connect(list[i + 1]);
      nodes.push(...list);
      return list[list.length - 1];
    };
    // rain hiss: pink noise band-limited, the top opens with the downpour
    const bed = gain(ac, 0), bedLp = filter(ac, 'lowpass', 3000, 0.6);
    chain(stereo(noise.pink, 1, 0.97), filter(ac, 'highpass', 600, 0.6), bedLp, bed, b.rain);
    // storm roar: the whole valley under heavy rain
    const roar = gain(ac, 0);
    chain(stereo(noise.brown, 1, 0.93), filter(ac, 'lowpass', 520, 0.5), roar, b.rain);
    // storm wind howl: a resonant band that rides the gusts
    const howl = gain(ac, 0), howlBp = filter(ac, 'bandpass', 520, 1.3);
    chain(stereo(noise.pink, 0.9, 0.87), howlBp, howl, this.env.mx.layers.wind);
    return { sources, nodes, bed, bedLp, roar, howl, howlBp, patter: null, patterHeavy: null, crickets: null, frogs: null };
  }

  /** one synthesized loop per frame, each hooked up as soon as it exists */
  private grow(v: Voices) {
    const { ac } = this.env;
    const b = this.ensureBuses();
    const t0 = performance.now();
    const stereo = (l: AudioBuffer, r: AudioBuffer, rate = 1) => {
      const m = ac.createChannelMerger(2);
      for (const [ch, buf] of [[0, l], [1, r]] as const) {
        const s = loopSource(ac, buf, rate);
        s.connect(m, 0, ch);
        v.sources.push(s);
      }
      v.nodes.push(m);
      return m;
    };
    if (!v.patter) {
      this.buf.patter ??= patterBuffer(ac, 4.3, 170);
      const p = this.buf.patter;
      const hp = filter(ac, 'highpass', 900, 0.6);
      v.patter = gain(ac, 0);
      stereo(p, p).connect(hp).connect(v.patter).connect(b.rain);
      const hp2 = filter(ac, 'highpass', 1100, 0.6);
      v.patterHeavy = gain(ac, 0);
      stereo(p, p, 1.19).connect(hp2).connect(v.patterHeavy).connect(b.rain);
      v.nodes.push(hp, v.patter, hp2, v.patterHeavy);
    } else if (!v.crickets) {
      this.buf.crickets ??= [cricketBuffer(ac, 6.1), cricketBuffer(ac, 6.7)];
      const [l, r] = this.buf.crickets;
      v.crickets = gain(ac, 0);
      stereo(l, r).connect(v.crickets).connect(b.night);
      v.nodes.push(v.crickets);
    } else if (!v.frogs) {
      this.buf.frogs ??= [frogBuffer(ac, 8.3), frogBuffer(ac, 9.1)];
      const [l, r] = this.buf.frogs;
      const lp = filter(ac, 'lowpass', 5200, 0.6);
      v.frogs = gain(ac, 0);
      stereo(l, r).connect(lp).connect(v.frogs).connect(b.night);
      v.nodes.push(lp, v.frogs);
    }
    this.buildMs = Math.max(this.buildMs, +(performance.now() - t0).toFixed(1));
  }

  private stop() {
    const v = this.v;
    if (!v) return;
    this.v = null;
    const t = this.env.ac.currentTime;
    for (const s of v.sources) {
      try {
        s.stop(t);
      } catch {}
    }
    for (const n of v.nodes) {
      try {
        n.disconnect();
      } catch {}
    }
  }

  update(ctx: GameContext, dt: number) {
    const day = ctx.services.day as DayState | undefined;
    const night = day?.night ?? 0, rain = day?.rain ?? 0, storm = day?.storm ?? 0, cloud = day?.cloud ?? 0;
    const { ac, site } = this.env;
    const t = ac.currentTime;

    // birds go quiet at night and in the rain (untouched while both are 0)
    const birds = (1 - night) * (1 - 0.85 * rain);
    if (Math.abs(birds - this.birdLevel) > 0.002) {
      this.birdLevel = birds;
      glide(this.env.mx.layers.birds.gain, birds, t, 0.8);
      this.birds.activity = birds;
    }

    const active = !!day && (day.timeLapse || night > 0.001 || rain > 0.001 || storm > 0.001 || cloud > 0.001);
    if (!active) {
      if (this.v && (this.idle += dt) > 6) this.stop();
      if (!this.v) return;
    } else this.idle = 0;
    if (!this.v) this.v = this.start();
    const v = this.v;
    if (!v.frogs) this.grow(v);

    const gust = this.env.gust;
    const high = smoothstep(12, 140, site.height);
    const rainK = Math.pow(rain, 1.2);
    glide(v.bed.gain, 0.34 * rainK * (1 + 0.6 * storm), t, 0.5);
    glide(v.bedLp.frequency, 2600 + 4800 * rain + 1500 * storm, t, 0.6);
    glide(v.roar.gain, 0.2 * storm * rain * (0.8 + 0.3 * gust), t, 0.5);
    if (v.patter && v.patterHeavy) {
      const onWater = 1 - 0.7 * high;
      glide(v.patter.gain, 0.8 * rainK * onWater, t, 0.5);
      glide(v.patterHeavy.gain, 0.75 * storm * rain * onWater, t, 0.5);
    }
    glide(v.howl.gain, 0.09 * storm * gust * gust, t, 0.35);
    glide(v.howlBp.frequency, 360 + 520 * clamp(gust - 0.4, 0, 1.4), t, 0.5);

    // night chorus: crickets in the grass and trees (hushed by rain), frogs by the water (rain wakes
    // them even in daylight; a storm quiets them)
    const dusk = smoothstep(0.25, 0.9, night);
    const low = 1 - high;
    if (v.crickets) glide(v.crickets.gain, 0.55 * dusk * (1 - 0.85 * rain) * (0.55 + 0.45 * site.trees) * low, t, 1.2);
    if (v.frogs) {
      const frogs = Math.max(dusk, 0.4 * rain) * (1 - 0.6 * storm) / (1 + site.toWater / 60);
      glide(v.frogs.gain, 0.5 * frogs * low, t, 1.2);
    }
  }

  /** schedule thunder for a strike `distance` m away */
  thunder(p: { distance?: number; strength?: number } | undefined) {
    const { ac, noise, mx } = this.env;
    const dist = Math.max(50, Number(p?.distance) || 1500);
    const strength = clamp(Number(p?.strength) || 0.7);
    const b = this.ensureBuses();
    const delay = thunderDelay(dist);
    const t0 = ac.currentTime + delay;
    const near = 1 - smoothstep(350, 1400, dist);
    const loud = strength * (0.3 + 0.7 * Math.pow(400 / Math.max(400, dist), 0.7));

    const pan = ac.createStereoPanner();
    pan.pan.value = rand(-0.6, 0.6);
    pan.connect(b.thunder);
    const send = gain(ac, 0.3 + 0.2 * (1 - near));
    pan.connect(send).connect(mx.worldVerb);
    let end = t0;

    // the crack: a few sharp broadband bursts, only when the strike is close
    if (near > 0.05) {
      const n = 2 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) {
        const ti = t0 + (i ? rand(0.01, 0.22) : 0);
        const e = envelope(ac, ti, loud * near * (i ? rand(0.3, 0.8) : 1) * 0.8, 0.002, rand(0.03, 0.09));
        const s = burst(ac, noise.white, ti, e.end);
        const hp = filter(ac, 'highpass', rand(400, 900), 0.7);
        s.connect(hp).connect(e.node).connect(pan);
        cleanupOnEnd(s, hp, e.node);
        end = Math.max(end, e.end);
      }
    }

    // the rumble: brown noise, darker with distance, under a rolling envelope of a few swells. far
    // thunder builds slowly and rolls longer
    const tr = t0 + (near > 0.05 ? 0.04 : 0);
    const dur = 2.4 + 2.2 * (1 - near) + rand(0, 1.5);
    const peak = loud * 0.9;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, tr);
    const att = 0.04 + 0.4 * (1 - near);
    g.gain.linearRampToValueAtTime(peak, tr + att);
    const swells = 3 + Math.floor(Math.random() * 4);
    let tt = tr + att;
    for (let k = 0; k < swells; k++) {
      tt = Math.min(tr + dur - 0.3, tt + (dur / (swells + 1)) * rand(0.6, 1.3));
      g.gain.linearRampToValueAtTime(peak * Math.exp(-(tt - tr) / (dur * 0.45)) * rand(0.45, 1.05), tt);
    }
    g.gain.linearRampToValueAtTime(0, tr + dur);
    const fc = 90 + 260 * near + rand(0, 60);
    const lp1 = filter(ac, 'lowpass', fc, 0.7), lp2 = filter(ac, 'lowpass', fc * 1.6, 0.5);
    const body = filter(ac, 'peaking', 70, 0.9, 5);
    const src = burst(ac, noise.brown, tr, tr + dur + 0.05, rand(0.7, 0.9));
    src.connect(lp1).connect(lp2).connect(body).connect(g).connect(pan);
    cleanupOnEnd(src, lp1, lp2, body, g);
    end = Math.max(end, tr + dur);
    // the verb tail outlives the dry sound; drop the panner and send once it has rung out
    setTimeout(() => {
      try {
        pan.disconnect();
        send.disconnect();
      } catch {}
    }, (end - ac.currentTime + 4) * 1000);

    this.thunders++;
    this.lastDelay = +delay.toFixed(3);
    this.lastThunderAt = +t0.toFixed(3);
  }

  stats() {
    const v = this.v;
    const val = (g: GainNode | null | undefined) => (g ? +g.gain.value.toFixed(4) : null);
    return {
      voices: !!v,
      loops: { patter: !!v?.patter, crickets: !!v?.crickets, frogs: !!v?.frogs },
      rainBed: val(v?.bed),
      patter: val(v?.patter),
      patterHeavy: val(v?.patterHeavy),
      roar: val(v?.roar),
      howl: val(v?.howl),
      crickets: val(v?.crickets),
      frogs: val(v?.frogs),
      birds: +this.birdLevel.toFixed(3),
      thunders: this.thunders,
      lastDelay: this.lastDelay,
      lastThunderAt: this.lastThunderAt,
      buildMs: this.buildMs,
    };
  }
}
