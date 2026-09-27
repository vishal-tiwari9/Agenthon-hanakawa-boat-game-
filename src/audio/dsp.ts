// shared web audio helpers: procedural noise, seamless loops, reverb impulse, param smoothing,
// panners and small one-shot envelopes. everything here is allocation-light and framework-free.

export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const clamp = (v: number, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

/** glide an AudioParam toward v. non-finite values are dropped (setTargetAtTime throws on NaN) */
export function glide(p: AudioParam, v: number, t: number, tau: number) {
  if (!Number.isFinite(v)) return;
  p.setTargetAtTime(v, t, Math.max(0.002, tau));
}

/** set an AudioParam now, cancelling scheduled automation */
export function hold(p: AudioParam, v: number, t: number) {
  if (!Number.isFinite(v)) return;
  p.cancelScheduledValues(t);
  p.setValueAtTime(v, t);
}

export type NoiseKind = 'white' | 'pink' | 'brown';

/** looping mono noise buffer; pink uses paul kellet's filter, brown a leaky integrator */
export function noiseBuffer(ac: BaseAudioContext, kind: NoiseKind, seconds: number): AudioBuffer {
  const fade = Math.floor(ac.sampleRate * 0.1);
  const n = Math.floor(ac.sampleRate * seconds) + fade;
  const d = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') d[i] = w * 0.5;
    else if (kind === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return toBuffer(ac, crossfadeLoop(d, fade));
}

/** a looping control signal: random values in -1..1 at `rate` per second, smoothly interpolated */
export function slowNoise(ac: BaseAudioContext, rate: number, seconds = 6): AudioBuffer {
  const sr = ac.sampleRate;
  const n = Math.floor(sr * seconds);
  const k = Math.max(2, Math.round(seconds * rate));
  const pts = Array.from({ length: k }, () => Math.random() * 2 - 1);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = (i / n) * k;
    const j = Math.floor(u), f = u - j;
    const a = pts[j % k], b = pts[(j + 1) % k];
    d[i] = a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * f));
  }
  return toBuffer(ac, d);
}

/**
 * seamless loop: the last `f` samples are equal-power crossfaded into the first `f`, and the result
 * is `f` samples shorter. the wrap then continues exactly where the tail left off.
 */
export function crossfadeLoop(d: Float32Array, f: number): Float32Array {
  f = Math.min(f, Math.floor(d.length / 3));
  const n = d.length - f;
  const out = d.slice(0, n);
  for (let i = 0; i < f; i++) {
    const a = (i + 0.5) / f;
    out[i] = d[i] * Math.sin(a * Math.PI * 0.5) + d[n + i] * Math.cos(a * Math.PI * 0.5);
  }
  return out;
}

export function toBuffer(ac: BaseAudioContext, d: Float32Array): AudioBuffer {
  const buf = ac.createBuffer(1, d.length, ac.sampleRate);
  buf.getChannelData(0).set(d);
  return buf;
}

/**
 * turn a decoded recording into a seamless mono loop. trims the encoder padding and authored fades
 * at both ends, then crossfades the tail into the head.
 */
export function makeLoop(ac: BaseAudioContext, src: AudioBuffer, fadeSec = 2): AudioBuffer {
  const sr = src.sampleRate;
  const len = src.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < src.numberOfChannels; c++) {
    const ch = src.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += ch[i] / src.numberOfChannels;
  }
  const a = Math.floor(sr * 0.06), b = len - Math.floor(sr * 0.16);
  const body = mono.subarray(a, Math.max(a + sr, b));
  const looped = crossfadeLoop(body, Math.floor(sr * fadeSec));
  const buf = ac.createBuffer(1, looped.length, sr);
  buf.getChannelData(0).set(looped);
  return buf;
}

/** stereo outdoor-ish reverb impulse: short predelay, decorrelated noise tail that darkens over time */
export function reverbIR(ac: BaseAudioContext, seconds: number, decay = 3): AudioBuffer {
  const sr = ac.sampleRate;
  const n = Math.floor(sr * seconds);
  const pre = Math.floor(sr * 0.012);
  const buf = ac.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let y = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / (n - pre);
      const k = 0.5 * (1 - t) + 0.05;
      y += ((Math.random() * 2 - 1) - y) * k;
      d[i] = y * Math.pow(1 - t, decay) * (1 + (c ? 0.03 : -0.03));
    }
  }
  return buf;
}

/** a started looping source over `buffer` at a random offset */
export function loopSource(ac: BaseAudioContext, buffer: AudioBuffer, rate = 1): AudioBufferSourceNode {
  const s = ac.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  s.playbackRate.value = rate;
  s.start(ac.currentTime, Math.random() * buffer.duration);
  return s;
}

export function filter(ac: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.707, gainDb = 0): BiquadFilterNode {
  const f = ac.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  f.gain.value = gainDb;
  return f;
}

export function gain(ac: BaseAudioContext, v = 1): GainNode {
  const g = ac.createGain();
  g.gain.value = v;
  return g;
}

/** panner; rolloff 0 means direction only (we attenuate by distance ourselves) */
export function panner(ac: BaseAudioContext, model: PanningModelType = 'equalpower', ref = 1, rolloff = 0): PannerNode {
  const p = ac.createPanner();
  p.panningModel = model;
  p.distanceModel = 'inverse';
  p.refDistance = ref;
  p.rolloffFactor = rolloff;
  p.maxDistance = 10000;
  return p;
}

export function setPos(p: PannerNode, x: number, y: number, z: number) {
  if (!Number.isFinite(x + y + z)) return;
  if (p.positionX) {
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
  } else (p as any).setPosition(x, y, z);
}

export function glidePos(p: PannerNode, x: number, y: number, z: number, t: number, tau: number) {
  if (!Number.isFinite(x + y + z)) return;
  if (p.positionX) {
    glide(p.positionX, x, t, tau);
    glide(p.positionY, y, t, tau);
    glide(p.positionZ, z, t, tau);
  } else (p as any).setPosition(x, y, z);
}

/**
 * percussive envelope gain: 0 -> peak over `attack`, then exponential decay with time constant `tau`.
 * returns the node and the time by which it is silent.
 */
export function envelope(ac: BaseAudioContext, t: number, peak: number, attack: number, tau: number) {
  const g = ac.createGain();
  g.gain.value = 0;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(Math.max(0, peak), t + attack);
  g.gain.setTargetAtTime(0, t + attack, tau);
  return { node: g, end: t + attack + tau * 7 };
}

/** one-shot slice of a (noise) buffer starting at a random offset; stops itself at `end` */
export function burst(ac: BaseAudioContext, buffer: AudioBuffer, t: number, end: number, rate = 1): AudioBufferSourceNode {
  const s = ac.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  s.playbackRate.value = rate;
  s.start(t, Math.random() * buffer.duration * 0.9);
  s.stop(end);
  return s;
}

/** disconnect the tail of a one-shot chain once its source has ended, so the graph stays small */
export function cleanupOnEnd(src: AudioScheduledSourceNode, ...nodes: AudioNode[]) {
  src.onended = () => {
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {}
    }
  };
}

/** rms of an analyser's current window in dBFS */
export function rmsDb(an: AnalyserNode, scratch: Float32Array<ArrayBuffer>): number {
  an.getFloatTimeDomainData(scratch);
  let s = 0;
  for (let i = 0; i < scratch.length; i++) s += scratch[i] * scratch[i];
  return 10 * Math.log10(s / scratch.length + 1e-12);
}
