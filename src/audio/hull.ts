// water against the hull: a wash on each side that opens up with speed, bow hiss and prop churn,
// small laps against the planks at rest, slaps on 'boat:splash', thuds on 'boat:impact', and rope /
// wood creaks while moored. all voices sit on the hull so the photo camera hears them recede.
import { Vector3 } from 'three/webgpu';
import type { GameContext } from '../core/context';
import { anchor, boatPoint, type AudioEnv } from './env';
import { burst, clamp, cleanupOnEnd, envelope, filter, gain, glide, loopSource, panner, rand, setPos, smoothstep } from './dsp';

// fallbacks while the hull spec changes; live values come from boat.anchors
const FALLBACK = {
  midCleatPort: { x: -0.9, y: 0.6, z: 0 },
  midCleatStarboard: { x: 0.9, y: 0.6, z: 0 },
  bow: { x: 0, y: 0.1, z: -2.6 },
  propeller: { x: 0, y: -0.36, z: 2.45 },
  sternCleatPort: { x: -0.56, y: 0.64, z: 2.36 },
  sternCleatStarboard: { x: 0.56, y: 0.64, z: 2.36 },
  bowCleat: { x: 0, y: 0.8, z: -2.25 },
};
const CLEATS = ['sternCleatPort', 'sternCleatStarboard', 'bowCleat'] as const;
const REF_SPEED = 6;

interface Side {
  src: AudioBufferSourceNode;
  bp: BiquadFilterNode;
  g: GainNode;
  pan: PannerNode;
  anchor: 'midCleatPort' | 'midCleatStarboard';
}

/** a short friction creak: a jittery click train swept in rate, through a couple of wood/rope resonances */
function clickTrain(ac: BaseAudioContext): AudioBuffer {
  const sr = ac.sampleRate;
  const len = sr; // 1 s at 40 clicks/s
  const d = new Float32Array(len);
  const n = 40;
  for (let i = 0; i < n; i++) {
    const start = Math.round((i / n) * len + rand(-0.15, 0.15) * (len / n));
    const amp = rand(0.5, 1);
    const L = Math.round(0.0025 * sr);
    for (let k = 0; k < L; k++) d[(start + k + len) % len] += amp * (Math.random() * 2 - 1) * Math.exp(-k / (0.0006 * sr));
  }
  const buf = ac.createBuffer(1, len, sr);
  buf.getChannelData(0).set(d);
  return buf;
}

export class Hull {
  private sides: Side[] = [];
  private bow: { g: GainNode; bp: BiquadFilterNode; pan: PannerNode };
  private churn: { g: GainNode; lp: BiquadFilterNode; pan: PannerNode };
  private tmp = new Vector3();
  private clicks: AudioBuffer;
  private nextLap = 0;
  private nextCreak = 0;
  private lastSlap = 0;
  private lastThud = 0;
  private prevY = NaN;
  private heave = 0;
  private docked = false;

  constructor(private env: AudioEnv, ctx: GameContext) {
    const { ac, mx, noise } = env;
    const out = mx.layers.hull;
    for (const name of ['midCleatPort', 'midCleatStarboard'] as const) {
      const src = loopSource(ac, noise.pink);
      const bp = filter(ac, 'bandpass', 450, 0.7);
      const g = gain(ac, 0);
      const pan = panner(ac, 'equalpower', 5, 0.7);
      src.connect(bp).connect(g).connect(pan).connect(out);
      this.sides.push({ src, bp, g, pan, anchor: name });
    }
    {
      const bp = filter(ac, 'bandpass', 2200, 0.6);
      const g = gain(ac, 0);
      const pan = panner(ac, 'equalpower', 5, 0.7);
      loopSource(ac, noise.white).connect(filter(ac, 'highpass', 900, 0.7)).connect(bp).connect(g).connect(pan).connect(out);
      this.bow = { g, bp, pan };
    }
    {
      const lp = filter(ac, 'lowpass', 350, 0.6);
      const g = gain(ac, 0);
      const pan = panner(ac, 'equalpower', 5, 0.7);
      loopSource(ac, noise.brown).connect(filter(ac, 'highpass', 45, 0.7)).connect(lp).connect(g).connect(pan).connect(out);
      this.churn = { g, lp, pan };
    }
    this.clicks = clickTrain(ac);
    this.docked = !!ctx.boat?.docked;
  }

  setDocked(on: boolean) {
    this.docked = on;
    if (on) this.nextCreak = this.env.ac.currentTime + rand(1.5, 3);
  }

  update(ctx: GameContext, dt: number) {
    const boat = ctx.boat;
    const { ac } = this.env;
    const t = ac.currentTime;
    if (!boat) {
      for (const s of this.sides) glide(s.g.gain, 0, t, 0.3);
      glide(this.bow.g.gain, 0, t, 0.3);
      glide(this.churn.g.gain, 0, t, 0.3);
      return;
    }
    const speed = Math.abs(boat.speed || 0);
    const sN = clamp(speed / REF_SPEED);
    const thr = Math.abs(boat.throttle || 0);

    // heave activity from the rendered pose; drives a little extra wash when the bow works in the waves
    const y = boat.position.y;
    if (Number.isFinite(this.prevY) && dt > 0) {
      const vy = Math.abs(y - this.prevY) / dt;
      this.heave += (Math.min(vy, 2) - this.heave) * (1 - Math.exp(-dt / 0.25));
    }
    this.prevY = y;

    const helm = ctx.cameraRig?.mode === 'helm' ? 1.2 : 1;
    const sub = 0.8 + 0.4 * clamp(boat.submersion ?? 0.5);
    const wash = (0.015 + 0.34 * smoothstep(0.2, 6.5, speed) + 0.08 * clamp(this.heave)) * sub * helm;
    for (const s of this.sides) {
      glide(s.g.gain, wash, t, 0.12);
      glide(s.bp.frequency, 420 + 1100 * sN, t, 0.15);
      const a = anchor(boat, s.anchor, FALLBACK[s.anchor]);
      boatPoint(boat, { x: a.x * 1.05, y: 0.05, z: a.z }, this.tmp);
      setPos(s.pan, this.tmp.x, this.tmp.y, this.tmp.z);
    }
    glide(this.bow.g.gain, 0.12 * Math.pow(sN, 1.6) * helm, t, 0.12);
    glide(this.bow.bp.frequency, 1800 + 1400 * sN, t, 0.2);
    boatPoint(boat, anchor(boat, 'bow', FALLBACK.bow), this.tmp);
    setPos(this.bow.pan, this.tmp.x, this.tmp.y, this.tmp.z);
    glide(this.churn.g.gain, (0.06 * thr + 0.1 * sN) * helm, t, 0.15);
    glide(this.churn.lp.frequency, 320 + 380 * Math.max(thr, sN), t, 0.2);
    boatPoint(boat, anchor(boat, 'propeller', FALLBACK.propeller), this.tmp);
    setPos(this.churn.pan, this.tmp.x, this.tmp.y, this.tmp.z);

    // small laps against the planks when slow; they thin out as the wash takes over
    if (speed < 3 && t > this.nextLap) {
      this.lap(boat.docked ? 0.8 : 1 - speed / 3);
      this.nextLap = t + rand(0.5, 2.2) * (1 + speed);
    }
    if ((this.docked || boat.docked) && t > this.nextCreak) {
      const c = CLEATS[Math.floor(Math.random() * CLEATS.length)];
      boatPoint(boat, anchor(boat, c, FALLBACK[c]), this.tmp);
      this.creak(this.tmp, Math.random() < 0.65 ? 'rope' : 'wood', 1);
      this.nextCreak = t + rand(3.5, 9);
    }
  }

  private lap(amount: number) {
    const { ac, noise } = this.env;
    const side = this.sides[Math.random() < 0.5 ? 0 : 1];
    const t = ac.currentTime + 0.01;
    const f = rand(320, 620);
    for (let i = 0; i < (Math.random() < 0.5 ? 2 : 1); i++) {
      const t0 = t + i * rand(0.07, 0.14);
      const e = envelope(ac, t0, 0.1 * amount * (i ? 0.55 : 1), 0.025, rand(0.07, 0.14));
      const src = burst(ac, noise.pink, t0, e.end);
      const bp = filter(ac, 'bandpass', f * (i ? 1.3 : 1), 1.2);
      src.connect(bp).connect(e.node).connect(side.pan);
      cleanupOnEnd(src, e.node);
    }
  }

  /** hull slap from a wave or spray landing. strength ~ m/s */
  splash(p: { strength?: number; x?: number; y?: number; z?: number } | undefined, boat: GameContext['boat']) {
    const { ac, noise } = this.env;
    const t = ac.currentTime;
    if (t - this.lastSlap < 0.06) return;
    this.lastSlap = t;
    const k = clamp((Number(p?.strength) || 1) / 4, 0.08, 1);
    const pan = this.oneShotPanner(p, boat);
    const e = envelope(ac, t, 0.28 * k, 0.004, 0.05 + 0.09 * k);
    const src = burst(ac, noise.white, t, e.end);
    src.connect(filter(ac, 'bandpass', 650 + 900 * k, 0.9)).connect(e.node).connect(pan);
    cleanupOnEnd(src, e.node);
    // body of the slap: a short low knock in the hull
    const thump = ac.createOscillator();
    thump.frequency.setValueAtTime(110, t);
    thump.frequency.exponentialRampToValueAtTime(62, t + 0.12);
    const te = envelope(ac, t, 0.22 * k, 0.003, 0.05);
    thump.connect(te.node).connect(pan);
    thump.start(t);
    thump.stop(te.end);
    cleanupOnEnd(thump, te.node);
    if (k > 0.4) {
      // spray falling back
      const se = envelope(ac, t + 0.05, 0.05 * k, 0.03, 0.18);
      const s2 = burst(ac, noise.white, t + 0.05, se.end);
      s2.connect(filter(ac, 'highpass', 3200, 0.7)).connect(se.node).connect(pan);
      cleanupOnEnd(s2, se.node);
    }
  }

  /** collision with a dock, rock or the seabed. strength ~ closing speed in m/s */
  impact(p: { strength?: number; x?: number; y?: number; z?: number } | undefined, boat: GameContext['boat']) {
    const { ac, noise } = this.env;
    const t = ac.currentTime;
    if (t - this.lastThud < 0.12) return;
    this.lastThud = t;
    const k = clamp((Number(p?.strength) || 1) / 3, 0.05, 1);
    const pan = this.oneShotPanner(p, boat);
    const soft = filter(ac, 'lowpass', 1400 + 1200 * k, 0.6);
    soft.connect(pan);
    // hull thud
    const osc = ac.createOscillator();
    osc.frequency.setValueAtTime(78, t);
    osc.frequency.exponentialRampToValueAtTime(44, t + 0.25);
    const oe = envelope(ac, t, 0.55 * k, 0.004, 0.09 + 0.08 * k);
    osc.connect(oe.node).connect(soft);
    osc.start(t);
    osc.stop(oe.end);
    cleanupOnEnd(osc, oe.node);
    // wooden knock
    const ke = envelope(ac, t, 0.35 * k, 0.002, 0.035);
    const ks = burst(ac, noise.white, t, ke.end);
    ks.connect(filter(ac, 'bandpass', rand(320, 420), 1.4)).connect(ke.node).connect(soft);
    cleanupOnEnd(ks, ke.node);
    if (k > 0.35) {
      // scrape along the hull for harder hits
      const dur = 0.25 + 0.4 * k;
      const g = gain(ac, 0);
      g.gain.setValueAtTime(0, t + 0.02);
      g.gain.linearRampToValueAtTime(0.09 * k, t + 0.06);
      g.gain.setTargetAtTime(0, t + 0.06, dur / 3);
      const ss = burst(ac, noise.pink, t + 0.02, t + 0.06 + dur * 2.5);
      ss.connect(filter(ac, 'bandpass', rand(900, 1300), 0.8)).connect(g).connect(soft);
      cleanupOnEnd(ss, g);
    }
    if (k > 0.2) this.creak(new Vector3(p?.x ?? boat?.position.x ?? 0, (p?.y ?? 0) + 0.5, p?.z ?? boat?.position.z ?? 0), 'wood', 0.7 * k);
  }

  /** rope or wood creak at a world position */
  creak(pos: Vector3, kind: 'rope' | 'wood', level: number, dest?: AudioNode) {
    const { ac, mx } = this.env;
    const t = ac.currentTime + 0.02;
    const dur = rand(0.35, 0.9);
    const src = ac.createBufferSource();
    src.buffer = this.clicks;
    src.loop = true;
    const r0 = kind === 'rope' ? rand(0.6, 0.9) : rand(0.35, 0.55);
    src.playbackRate.setValueAtTime(r0, t);
    src.playbackRate.linearRampToValueAtTime(r0 * rand(1.3, 1.8), t + dur * 0.6);
    src.playbackRate.linearRampToValueAtTime(r0 * rand(0.9, 1.2), t + dur);
    const g = gain(ac, 0);
    const peak = (kind === 'rope' ? 0.36 : 0.45) * level;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + dur * 0.3);
    g.gain.linearRampToValueAtTime(peak * 0.8, t + dur * 0.8);
    g.gain.linearRampToValueAtTime(0, t + dur);
    const f1 = kind === 'rope' ? rand(900, 1300) : rand(380, 520);
    const pan = panner(ac, 'equalpower', 4, 0.8);
    setPos(pan, pos.x, pos.y, pos.z);
    const b1 = filter(ac, 'bandpass', f1, 5);
    const b2 = filter(ac, 'bandpass', f1 * 2.1, 6);
    src.connect(b1).connect(g);
    src.connect(b2).connect(gain(ac, 0.4)).connect(g);
    g.connect(filter(ac, 'lowpass', 3000, 0.7)).connect(pan).connect(dest ?? mx.layers.hull);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
    cleanupOnEnd(src, g, pan);
  }

  private oneShotPanner(p: { x?: number; y?: number; z?: number } | undefined, boat: GameContext['boat']) {
    const { ac, mx } = this.env;
    const pan = panner(ac, 'equalpower', 5, 0.7);
    const x = Number.isFinite(p?.x) ? p!.x! : boat?.position.x ?? 0;
    const y = Number.isFinite(p?.y) ? p!.y! : boat?.position.y ?? 0;
    const z = Number.isFinite(p?.z) ? p!.z! : boat?.position.z ?? 0;
    setPos(pan, x, y, z);
    pan.connect(mx.layers.hull);
    // the panner is disconnected with the longest voice of each one-shot
    setTimeout(() => {
      try {
        pan.disconnect();
      } catch {}
    }, 3000);
    return pan;
  }
}
