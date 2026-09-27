// synthesized loops for the weather and the night: rain on water, a cricket chorus, a frog chorus.
// each is rendered once into a mono buffer (call twice for a decorrelated stereo pair) and loops
// seamlessly (crossfadeLoop). every voice is a damped or enveloped sinusoid run by a two-pole
// recurrence, so a buffer costs a few milliseconds, not a sin() per sample.
import { crossfadeLoop, rand, toBuffer } from './dsp';

/** add a * r^i * sin(w i) (a damped resonance, decay time constant tau s) into d from i0 */
function ring(d: Float32Array, sr: number, i0: number, f: number, tau: number, a: number) {
  const w = (2 * Math.PI * f) / sr, r = Math.exp(-1 / (tau * sr));
  const c = 2 * r * Math.cos(w), r2 = r * r;
  const n = Math.min(Math.ceil(tau * 5 * sr), d.length - i0);
  let y2 = 0, y1 = a * r * Math.sin(w);
  if (n > 1) d[i0 + 1] += y1;
  for (let i = 2; i < n; i++) {
    const y = c * y1 - r2 * y2;
    d[i0 + i] += y;
    y2 = y1;
    y1 = y;
  }
}

/** add a steady tone of `len` samples under a smooth (4x(1-x))^2 window into d from i0 */
function tone(d: Float32Array, sr: number, i0: number, f: number, len: number, a: number) {
  const w = (2 * Math.PI * f) / sr, c = 2 * Math.cos(w);
  const n = Math.min(len, d.length - i0);
  const ph = Math.random() * Math.PI * 2;
  let y2 = Math.sin(ph - w), y1 = Math.sin(ph);
  for (let i = 0; i < n; i++) {
    const x = i / len, e = 4 * x * (1 - x);
    d[i0 + i] += y1 * e * e * a;
    const y = c * y1 - y2;
    y2 = y1;
    y1 = y;
  }
}

function frame(sr: number, seconds: number, fadeSec: number) {
  const fade = Math.floor(sr * fadeSec);
  return { d: new Float32Array(Math.floor(sr * seconds) + fade), fade };
}

/**
 * rain on water: every drop is a tiny impact click, and some trap a bubble that rings for a few
 * milliseconds (1.4-5 kHz). most drops are faint, a few land close.
 */
export function patterBuffer(ac: BaseAudioContext, seconds: number, perSec: number): AudioBuffer {
  const sr = ac.sampleRate;
  const { d, fade } = frame(sr, seconds, 0.08);
  const count = Math.round(seconds * perSec);
  const room = d.length - Math.ceil(sr * 0.08);
  for (let e = 0; e < count; e++) {
    const i0 = Math.floor(Math.random() * room);
    const a = Math.pow(Math.random(), 2.2);
    const tick = Math.floor(sr * rand(0.0004, 0.0014));
    for (let i = 0; i < tick; i++) d[i0 + i] += (Math.random() * 2 - 1) * a * 0.3 * (1 - i / tick);
    if (Math.random() < 0.4) ring(d, sr, i0 + tick, rand(1400, 5200), rand(0.003, 0.011), a * rand(0.2, 0.5));
  }
  return toBuffer(ac, crossfadeLoop(d, fade));
}

/**
 * a few crickets at different distances: bell crickets (suzumushi) trilling "riiin" in phrases and
 * field crickets chirping three or four quick pulses
 */
export function cricketBuffer(ac: BaseAudioContext, seconds: number, insects = 5): AudioBuffer {
  const sr = ac.sampleRate;
  const { d, fade } = frame(sr, seconds, 0.12);
  const end = d.length / sr;
  for (let k = 0; k < insects; k++) {
    const trill = Math.random() < 0.45;
    const f = trill ? rand(3900, 4500) : rand(4300, 5300);
    const amp = 0.03 + 0.1 * Math.pow(Math.random(), 1.6);
    let t = rand(0, 0.9);
    while (t < end) {
      if (trill) {
        const len = rand(0.25, 0.6), rate = rand(40, 55), np = Math.floor(len * rate);
        for (let p = 0; p < np; p++) {
          const x = p / np;
          tone(d, sr, Math.floor((t + p / rate) * sr), f, Math.floor(sr * 0.012), amp * Math.min(1, x * 6) * (1 - 0.4 * x));
        }
        t += len + rand(0.5, 1.4);
      } else {
        const np = Math.random() < 0.5 ? 3 : 4;
        for (let p = 0; p < np; p++) tone(d, sr, Math.floor((t + p * 0.036) * sr), f * rand(0.995, 1.005), Math.floor(sr * 0.02), amp);
        t += rand(0.35, 0.75);
      }
    }
  }
  return toBuffer(ac, crossfadeLoop(d, fade));
}

/**
 * a paddy frog chorus: japanese tree frogs (amagaeru) calling "kwa kwa kwa" in runs, each note a short
 * train of pulses ringing a bright formant and a lower body; frogs overlap at their own pitch and pace
 */
export function frogBuffer(ac: BaseAudioContext, seconds: number, frogs = 5): AudioBuffer {
  const sr = ac.sampleRate;
  const { d, fade } = frame(sr, seconds, 0.12);
  const end = d.length / sr;
  for (let k = 0; k < frogs; k++) {
    const f = rand(1500, 2300), fl = f * rand(0.42, 0.52);
    const amp = 0.05 + 0.14 * Math.pow(Math.random(), 1.5);
    const noteLen = rand(0.06, 0.11), pulseRate = rand(55, 85), noteRate = rand(3.6, 6.2);
    let t = rand(0, 3);
    while (t < end) {
      const notes = Math.floor(rand(4, 16));
      for (let j = 0; j < notes; j++) {
        const tn = t + (j / noteRate) * rand(0.96, 1.04);
        const np = Math.max(2, Math.round(noteLen * pulseRate));
        // runs swell in, then tire a little
        const na = amp * Math.min(1, (j + 1) / 3) * (1 - 0.3 * (j / notes));
        for (let p = 0; p < np; p++) {
          const i0 = Math.floor((tn + p / pulseRate) * sr);
          if (i0 >= d.length - 2) break;
          const pa = na * Math.sin((Math.PI * (p + 0.5)) / np);
          ring(d, sr, i0, f * rand(0.98, 1.02), 0.0025, pa);
          ring(d, sr, i0, fl, 0.004, pa * 0.7);
        }
      }
      t += notes / noteRate + rand(1.5, 6);
    }
  }
  return toBuffer(ac, crossfadeLoop(d, fade));
}
