// small, quiet inboard for a 7.5 m wooden river boat: a single-cylinder putter (the "pon-pon" of
// japanese river boats). a looping buffer of exhaust pulses with slight irregularity is replayed
// faster as rpm rises and shaped by fixed resonances, so the timbre stays put while the firing
// rate climbs. a soft wet-exhaust gurgle is noise gated by the same pulses. it sits at the stern.
import { Vector3 } from 'three/webgpu';
import type { GameContext } from '../core/context';
import { anchor, boatPoint, type AudioEnv } from './env';
import { clamp, filter, gain, glide, loopSource, panner, rand, setPos } from './dsp';

/** firing rate of the excitation buffer at playbackRate 1 (~960 rpm single, four-stroke) */
const F0 = 8;
const PULSES = 64;
/** max playbackRate: ~21 Hz firing, ~2500 rpm */
const RATE_SPAN = 1.65;
/** forward speed (m/s) treated as "full" for the load term */
const REF_SPEED = 7.6;

function excitation(ac: BaseAudioContext): AudioBuffer {
  const sr = ac.sampleRate;
  const len = Math.round((PULSES / F0) * sr);
  const d = new Float32Array(len);
  const period = len / PULSES;
  const tauA = 0.0028 * sr, tauB = 0.007 * sr, delayB = Math.round(0.0045 * sr), tauN = 0.005 * sr;
  const L = Math.round(0.04 * sr);
  let drift = 0;
  for (let i = 0; i < PULSES; i++) {
    drift = drift * 0.7 + (Math.random() - 0.5) * 0.06;
    const start = Math.round(i * period + drift * period * 0.2);
    let amp = rand(0.88, 1.05);
    if (Math.random() < 0.05) amp *= 0.7;
    for (let k = 0; k < L; k++) {
      // exhaust pressure pulse, delayed rarefaction, a little combustion rasp. wraps so the loop closes
      const a = k / tauA;
      const kb = k - delayB;
      const b = kb > 0 ? (kb / tauB) * Math.exp(1 - kb / tauB) : 0;
      const n = (Math.random() * 2 - 1) * Math.exp(-k / tauN) * 0.25;
      d[(start + k) % len] += amp * (a * Math.exp(1 - a) - 0.5 * b + n);
    }
  }
  let mean = 0;
  for (let i = 0; i < len; i++) mean += d[i];
  mean /= len;
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs((d[i] -= mean)));
  const buf = ac.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  for (let i = 0; i < len; i++) out[i] = (d[i] / peak) * 0.9;
  return buf;
}

export class Engine {
  private src: AudioBufferSourceNode;
  private tone: BiquadFilterNode;
  private out: GainNode;
  private burble: GainNode;
  private pan: PannerNode;
  private rpm = 0;
  private wander = 0;
  private wanderTarget = 0;
  private nextWander = 0;
  private pos = new Vector3();
  rate = 1;

  constructor(private env: AudioEnv) {
    const { ac, mx, noise } = env;
    this.src = loopSource(ac, excitation(ac), 1);
    const hp = filter(ac, 'highpass', 45, 0.7);
    const body = filter(ac, 'peaking', 115, 1.4, 5);
    const box = filter(ac, 'peaking', 240, 2, 3);
    this.tone = filter(ac, 'lowpass', 380, 0.6);
    this.out = gain(ac, 0);
    this.pan = panner(ac, 'equalpower', 5, 0.4);
    this.src.connect(hp).connect(body).connect(box).connect(this.tone);

    // wet exhaust gurgle: band-limited noise, gated by a rectified copy of the pulse train
    const rect = ac.createWaveShaper();
    const curve = new Float32Array(1025);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.abs(i / 512 - 1);
    rect.curve = curve;
    const envLp = filter(ac, 'lowpass', 45, 0.5);
    const am = gain(ac, 0);
    this.src.connect(rect).connect(envLp).connect(gain(ac, 2.2)).connect(am.gain);
    loopSource(ac, noise.pink).connect(filter(ac, 'bandpass', 560, 1)).connect(am);
    this.burble = gain(ac, 0.5);
    am.connect(this.burble).connect(this.tone);

    this.tone.connect(this.out).connect(this.pan).connect(mx.engine);
  }

  update(ctx: GameContext, dt: number) {
    const boat = ctx.boat;
    const t = this.env.ac.currentTime;
    if (!boat) {
      glide(this.out.gain, 0, t, 0.3);
      return;
    }
    const thr = Math.abs(boat.throttle || 0);
    const spd = clamp(Math.abs(boat.speed || 0) / REF_SPEED);
    const target = clamp(thr * 0.82 + spd * 0.18);
    // spool: rises a little quicker than it falls
    const k = 1 - Math.exp(-dt / (target > this.rpm ? 0.6 : 1));
    this.rpm += (target - this.rpm) * k;

    // slow, small irregularity so the idle never sounds like a loop
    if (ctx.time.real > this.nextWander) {
      this.wanderTarget = rand(-1, 1);
      this.nextWander = ctx.time.real + rand(0.4, 1.4);
    }
    this.wander += (this.wanderTarget - this.wander) * (1 - Math.exp(-dt / 0.5));

    const helm = ctx.cameraRig?.mode === 'helm';
    const r = this.rpm;
    this.rate = 1 + RATE_SPAN * r + this.wander * 0.015;
    glide(this.src.playbackRate, this.rate, t, 0.06);
    glide(this.tone.frequency, (340 + 900 * Math.pow(r, 1.3)) * (helm ? 1.15 : 1), t, 0.08);
    glide(this.burble.gain, 0.6 + 0.2 * r, t, 0.1);
    const docked = boat.docked ? 0.7 : 1;
    const level = (0.2 + 0.22 * Math.pow(r, 0.85)) * (1 + this.wander * 0.04) * docked;
    glide(this.out.gain, level, t, 0.08);

    // engine box just forward of the stern, from the live hull anchors
    const prop = anchor(boat, 'propeller', { x: 0, y: -0.36, z: 2.45 });
    boatPoint(boat, { x: 0, y: 0.25, z: prop.z - 0.8 }, this.pos);
    setPos(this.pan, this.pos.x, this.pos.y, this.pos.z);
  }

  get stats() {
    return { rpm: +this.rpm.toFixed(3), rate: +this.rate.toFixed(3), firingHz: +(F0 * this.rate).toFixed(1) };
  }
}
