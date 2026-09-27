// lightweight cpu model of the launch's own wake so the hull pitches when it crosses it.
// the stern leaves a trail of points; each one spreads a pair of kelvin-arm ridges sideways at
// v * tan(19.5 deg) while decaying. the water module may read the same trail (services.boatWake).
const KELVIN = Math.tan((19.47 * Math.PI) / 180);

export interface WakeOptions {
  /** seconds between trail points */
  interval: number;
  /** seconds a trail point lives */
  life: number;
  /** ridge height at full speed, meters */
  amplitude: number;
  /** trail younger than this is ignored (the hull itself is there) */
  minAge: number;
  /** emission speed that produces the full ridge height */
  refSpeed: number;
}

export class WakeTrail {
  opts: WakeOptions;
  cap: number;
  xs: Float64Array;
  zs: Float64Array;
  ts: Float64Array;
  /** emission speed (m/s); 0 marks a break in the trail */
  vs: Float64Array;
  head = 0;
  count = 0;
  lastT = -1e9;
  // per-step candidate segments near the hull
  cand: Int32Array;
  nCand = 0;

  constructor(opts: Partial<WakeOptions> = {}) {
    this.opts = { interval: 0.12, life: 20, amplitude: 0.1, minAge: 1.4, refSpeed: 5.5, ...opts };
    this.cap = Math.ceil(this.opts.life / this.opts.interval) + 4;
    this.xs = new Float64Array(this.cap);
    this.zs = new Float64Array(this.cap);
    this.ts = new Float64Array(this.cap);
    this.vs = new Float64Array(this.cap);
    this.cand = new Int32Array(this.cap);
  }

  clear() {
    this.count = 0;
    this.head = 0;
    this.lastT = -1e9;
    this.nCand = 0;
  }

  /** i-th point counting back from the newest (0 = newest) */
  idx(i: number) {
    return (this.head - 1 - i + this.cap * 2) % this.cap;
  }

  record(x: number, z: number, t: number, speed: number) {
    if (t - this.lastT < this.opts.interval) return;
    const moving = speed > 1.2;
    // a stationary boat leaves no trail; write a single break marker
    if (!moving && this.count > 0 && this.vs[this.idx(0)] === 0) return;
    this.lastT = t;
    const i = this.head;
    this.xs[i] = x;
    this.zs[i] = z;
    this.ts[i] = t;
    this.vs[i] = moving ? speed : 0;
    this.head = (this.head + 1) % this.cap;
    this.count = Math.min(this.count + 1, this.cap);
  }

  /** collect segments that can reach the circle (cx, cz, radius) this step */
  prepare(cx: number, cz: number, t: number, radius: number) {
    this.nCand = 0;
    const { life, minAge } = this.opts;
    for (let i = 0; i + 1 < this.count; i++) {
      const a = this.idx(i), b = this.idx(i + 1);
      const age = t - this.ts[a];
      if (age < minAge) continue;
      if (age > life) break;
      if (this.vs[a] === 0 || this.vs[b] === 0) continue;
      const reach = radius + KELVIN * this.vs[a] * age + 3;
      const dx = this.xs[a] - cx, dz = this.zs[a] - cz;
      if (dx * dx + dz * dz > reach * reach) continue;
      this.cand[this.nCand++] = i;
    }
  }

  /** wake surface offset at (x, z) from the prepared candidates */
  heightAt(x: number, z: number, t: number) {
    if (this.nCand === 0) return 0;
    const { amplitude, life } = this.opts;
    // the kelvin arms are the envelope of the wavelets, so only the nearest point of the track
    // matters: its age sets how far the ridge has spread sideways
    let best = Infinity, bestAge = 0, bestV = 0;
    for (let c = 0; c < this.nCand; c++) {
      const i = this.cand[c];
      const a = this.idx(i), b = this.idx(i + 1);
      const ax = this.xs[a], az = this.zs[a];
      const ex = this.xs[b] - ax, ez = this.zs[b] - az;
      const len2 = ex * ex + ez * ez;
      let u = len2 > 1e-9 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const px = ax + ex * u - x, pz = az + ez * u - z;
      const d2 = px * px + pz * pz;
      if (d2 < best) {
        best = d2;
        bestAge = t - (this.ts[a] + (this.ts[b] - this.ts[a]) * u);
        bestV = this.vs[a];
      }
    }
    if (best === Infinity) return 0;
    const d = Math.sqrt(best), age = bestAge;
    const arm = KELVIN * bestV * age;
    const width = 0.7 + 0.12 * age;
    const q = (d - arm) / width;
    if (q > 3 || q < -4.5) return 0;
    const sp = Math.min(1, bestV / this.opts.refSpeed);
    // divergent waves lose height roughly with the square root of distance; fade out at end of life
    const fade = Math.min(1, (life - age) / (life * 0.3));
    const amp = (amplitude * sp * sp * fade) / Math.sqrt(1 + 0.5 * age);
    const q2 = q + 1.5;
    return amp * (Math.exp(-q * q) - 0.45 * Math.exp(-q2 * q2));
  }
}
