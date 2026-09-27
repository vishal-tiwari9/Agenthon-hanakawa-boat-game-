// small interface sounds, all synthesized in one key (d major pentatonic) so they sit together:
// soft marimba-like plucks (sine + the bar's 4x overtone, quick decay), glassy bells with slightly
// inharmonic partials, a breath of air for discoveries, and a wooden knock for docking. everything
// is low-passed and gets a short reverb so nothing pokes out.
import type { AudioEnv } from './env';
import { burst, cleanupOnEnd, envelope, filter, gain, rand } from './dsp';

export interface PlayOptions {
  /** 0..1 multiplier on the sound's own level */
  volume?: number;
  /** transpose in semitones */
  pitch?: number;
  /** stereo position -1..1 */
  pan?: number;
}

export type UiSound = 'complete' | 'discovery' | 'unlock' | 'dock' | 'undock' | 'toast' | 'click';
export const UI_SOUNDS: UiSound[] = ['complete', 'discovery', 'unlock', 'dock', 'undock', 'toast', 'click'];

const ALIASES: Record<string, { name: UiSound; opts?: PlayOptions }> = {
  cargo: { name: 'dock', opts: { volume: 0.7, pitch: -2 } },
  gate: { name: 'toast', opts: { volume: 0.6, pitch: 2 } },
  'ui-open': { name: 'click', opts: { volume: 0.6 } },
  'ui-close': { name: 'click', opts: { volume: 0.5, pitch: -3 } },
  chart: { name: 'click', opts: { volume: 0.6, pitch: -5 } },
};

const N: Record<string, number> = {
  D4: 293.66, E4: 329.63, Fs4: 369.99, A4: 440, B4: 493.88,
  D5: 587.33, E5: 659.26, Fs5: 739.99, A5: 880, B5: 987.77, D6: 1174.66,
};

export class UiSounds {
  private last = new Map<string, number>();

  constructor(private env: AudioEnv) {}

  play(name: string, opts: PlayOptions = {}) {
    // names the game/ui modules use that map onto existing cues
    const alias = ALIASES[name];
    if (alias) {
      name = alias.name;
      opts = { ...alias.opts, ...opts };
    }
    const { ac, mx } = this.env;
    const t = ac.currentTime + 0.01;
    // the same cue from an event and from the ui in the same moment plays once
    if (t - (this.last.get(name) ?? -1) < 0.25) return;
    this.last.set(name, t);
    const vol = Math.max(0, Math.min(1, opts.volume ?? 1));
    const k = Math.pow(2, (opts.pitch ?? 0) / 12);
    const out = gain(ac, vol * 0.8);
    const pan = ac.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, opts.pan ?? 0));
    const tone = filter(ac, 'lowpass', 4200, 0.5);
    out.connect(tone).connect(pan).connect(mx.ui);
    const send = gain(ac, 0.35);
    tone.connect(send).connect(mx.uiVerb);
    let end = t + 0.3;
    const pl = (f: number, dt: number, g: number, decay = 0.45) => (end = Math.max(end, this.pluck(out, f * k, t + dt, g, decay)));
    const bl = (f: number, dt: number, g: number, decay = 1.2) => (end = Math.max(end, this.bell(out, f * k, t + dt, g, decay)));

    switch (name) {
      case 'complete':
        pl(N.D5, 0, 0.22);
        pl(N.Fs5, 0.11, 0.2);
        pl(N.A5, 0.22, 0.2);
        bl(N.D6, 0.36, 0.1, 1.4);
        break;
      case 'discovery':
        this.air(out, t, 0.9);
        bl(N.A4, 0.05, 0.12, 1.6);
        bl(N.E5, 0.32, 0.1, 1.8);
        end = Math.max(end, t + 2.6);
        break;
      case 'unlock':
        bl(N.D5, 0, 0.1, 0.9);
        bl(N.Fs5, 0.08, 0.09, 0.9);
        bl(N.A5, 0.16, 0.09, 1);
        bl(N.D6, 0.26, 0.08, 1.5);
        break;
      case 'dock':
        end = Math.max(end, this.knock(out, t, 0.35));
        pl(N.A4, 0.12, 0.14, 0.4);
        pl(N.D5, 0.24, 0.14, 0.55);
        break;
      case 'undock':
        pl(N.D5, 0, 0.12, 0.4);
        pl(N.A4, 0.13, 0.12, 0.55);
        break;
      case 'toast':
        pl(N.Fs5, 0, 0.12, 0.35);
        break;
      case 'click':
        end = Math.max(end, this.tick(out, t, 0.12));
        break;
      default:
        pl(N.E5, 0, 0.1, 0.3);
    }
    setTimeout(() => {
      for (const n of [out, send, pan]) {
        try {
          n.disconnect();
        } catch {}
      }
    }, (end - ac.currentTime + 1.6) * 1000);
  }

  /** marimba-ish: fundamental plus the bar's 4x overtone, which dies quickly */
  private pluck(dest: AudioNode, f: number, t: number, g: number, decay: number) {
    const { ac } = this.env;
    let end = t;
    for (const [mul, amp, tau] of [[1, 1, decay / 3], [4, 0.16, decay / 14], [2, 0.08, decay / 8]] as const) {
      const o = ac.createOscillator();
      o.frequency.value = f * mul * rand(0.998, 1.002);
      const e = envelope(ac, t, g * amp, 0.004, tau);
      o.connect(e.node).connect(dest);
      o.start(t);
      o.stop(e.end);
      cleanupOnEnd(o, e.node);
      end = Math.max(end, e.end);
    }
    return end;
  }

  /** soft glassy bell: slightly stretched partials, each with its own decay, a detuned twin for shimmer */
  private bell(dest: AudioNode, f: number, t: number, g: number, decay: number) {
    const { ac } = this.env;
    let end = t;
    const parts = [[1, 1, 1], [2.01, 0.3, 0.6], [3.02, 0.14, 0.4], [4.24, 0.07, 0.28]] as const;
    for (const [mul, amp, dk] of parts) {
      for (const det of [1, 1.0025]) {
        const o = ac.createOscillator();
        o.frequency.value = f * mul * det;
        const e = envelope(ac, t, g * amp * 0.5, 0.006, (decay * dk) / 3);
        o.connect(e.node).connect(dest);
        o.start(t);
        o.stop(e.end);
        cleanupOnEnd(o, e.node);
        end = Math.max(end, e.end);
      }
    }
    return end;
  }

  /** a breath of air that swells and fades (discovery) */
  private air(dest: AudioNode, t: number, dur: number) {
    const { ac, noise } = this.env;
    const g = gain(ac, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05, t + dur * 0.45);
    g.gain.linearRampToValueAtTime(0, t + dur * 1.4);
    const s = burst(ac, noise.pink, t, t + dur * 1.5);
    const bp = filter(ac, 'bandpass', 2400, 0.8);
    bp.frequency.setValueAtTime(1600, t);
    bp.frequency.linearRampToValueAtTime(3400, t + dur * 1.4);
    s.connect(bp).connect(g).connect(dest);
    cleanupOnEnd(s, g);
  }

  /** muffled wooden knock with a low body */
  private knock(dest: AudioNode, t: number, g: number) {
    const { ac, noise } = this.env;
    const o = ac.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(95, t + 0.1);
    const oe = envelope(ac, t, g, 0.003, 0.045);
    o.connect(oe.node).connect(dest);
    o.start(t);
    o.stop(oe.end);
    cleanupOnEnd(o, oe.node);
    const ne = envelope(ac, t, g * 0.5, 0.001, 0.02);
    const s = burst(ac, noise.white, t, ne.end);
    s.connect(filter(ac, 'bandpass', 620, 1.6)).connect(ne.node).connect(dest);
    cleanupOnEnd(s, ne.node);
    return Math.max(oe.end, ne.end);
  }

  /** a short soft tick: filtered noise click plus a faint woody tone */
  private tick(dest: AudioNode, t: number, g: number) {
    const { ac, noise } = this.env;
    const ne = envelope(ac, t, g, 0.001, 0.006);
    const s = burst(ac, noise.white, t, ne.end);
    s.connect(filter(ac, 'bandpass', 2600, 1.1)).connect(ne.node).connect(dest);
    cleanupOnEnd(s, ne.node);
    const o = ac.createOscillator();
    o.frequency.value = 880;
    const oe = envelope(ac, t, g * 0.35, 0.002, 0.012);
    o.connect(oe.node).connect(dest);
    o.start(t);
    o.stop(oe.end);
    cleanupOnEnd(o, oe.node);
    return Math.max(ne.end, oe.end);
  }
}
