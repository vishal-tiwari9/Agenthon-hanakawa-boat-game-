// falling water: hanakawa falls closing the valley, maiden falls (a small cascade off the left bank
// in the gorge) and the old weir at the downstream end. each is a few spatial points spread across
// its width so it sounds wide up close. a point is dense filtered noise (the roar: darker and
// heavier for the big falls, brighter for the cascade, a hissing sheet for the weir) with slow
// random swells, plus the recorded stream babble for the churn at the foot. distance darkens it;
// a shared low rumble sits under the big falls. lip positions come from the terrain bake report
// (world.json extra) when present, otherwise from the layout.
import type { WorldData } from '../world/worldData';
import { LANDMARKS, RIVER_LENGTH, bankPoint, nearestRiver, riverFrame } from '../world/layout';
import type { AudioEnv } from './env';
import { clamp, filter, gain, glide, loopSource, panner, rand, setPos } from './dsp';

interface FallsSpec {
  id: string;
  points: { x: number; y: number; z: number }[];
  /** distance (m) inside which the roar stays at full level */
  ref: number;
  amp: number;
  /** roar lowpass, rumble and babble amounts */
  tone: number;
  rumble: number;
  churn: number;
}

interface Point {
  spec: FallsSpec;
  x: number;
  y: number;
  z: number;
  level: GainNode;
  lp: BiquadFilterNode;
  roar: GainNode;
  churn: GainNode;
  pan: PannerNode;
  wobble: number;
  wobbleTarget: number;
  dist: number;
}

type Lip = { lipX: number; lipZ: number; lipY: number };

function bakedLip(world: WorldData | null | undefined, id: 'falls' | 'cascade'): Lip | null {
  const r = (world?.meta?.extra as any)?.terrain?.report?.[id];
  return r && Number.isFinite(r.lipX + r.lipZ + r.lipY) ? r : null;
}

/** hanakawa's plunge pool radius (terrain bake) */
const POOL_R = 17;

function specs(world: WorldData | null | undefined): FallsSpec[] {
  const out: FallsSpec[] = [];
  const end = riverFrame(RIVER_LENGTH);
  const across = (f: typeof end, k: number) => ({ x: f.x + f.nx * f.width * k, z: f.z + f.nz * f.width * k });
  {
    // water drops from the lip into a pool on the river side of it; the pool is the loud part
    const lip = bakedLip(world, 'falls') ?? { lipX: end.x - end.tx * 19, lipZ: end.z - end.tz * 19, lipY: 30 };
    let dx = end.x - lip.lipX, dz = end.z - lip.lipZ;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    const pool = { x: lip.lipX + dx * POOL_R * 0.55, z: lip.lipZ + dz * POOL_R * 0.55 };
    const w = POOL_R * 0.65;
    out.push({
      id: 'falls',
      points: [
        { x: pool.x - dz * w, z: pool.z + dx * w, y: 1 },
        { x: pool.x + dz * w, z: pool.z - dx * w, y: 1 },
        { ...pool, y: 1.5 },
        { x: lip.lipX + dx * 3, z: lip.lipZ + dz * 3, y: lip.lipY * 0.5 },
      ],
      ref: 30, amp: 0.85, tone: 2600, rumble: 0.7, churn: 0.8,
    });
  }
  const cascade = LANDMARKS.find((l) => l.id === 'cascade');
  if (cascade) {
    const side = (cascade.side || -1) as -1 | 1;
    const top = bankPoint(cascade.s, side, cascade.offset);
    const lip = bakedLip(world, 'cascade') ?? { lipX: top.x, lipZ: top.z, lipY: 8 };
    // the foot is the water's edge nearest the lip
    const nr = nearestRiver(lip.lipX, lip.lipZ);
    const foot = bankPoint(nr.s, nr.lateral < 0 ? -1 : 1, 0.5);
    out.push({
      id: 'cascade',
      points: [
        { ...foot, y: 0.5 },
        { x: (foot.x + lip.lipX) / 2, z: (foot.z + lip.lipZ) / 2, y: lip.lipY * 0.5 },
      ],
      ref: 10, amp: 0.55, tone: 5500, rumble: 0.1, churn: 1,
    });
  }
  const weir = LANDMARKS.find((l) => l.id === 'weir');
  if (weir) {
    const f = riverFrame(weir.s);
    out.push({ id: 'weir', points: [{ ...across(f, -0.3), y: 0.3 }, { ...across(f, 0), y: 0.3 }, { ...across(f, 0.3), y: 0.3 }], ref: 20, amp: 0.4, tone: 3800, rumble: 0.25, churn: 0.6 });
  }
  return out;
}

export class Falls {
  private points: Point[] = [];
  private rumble: { g: GainNode; spec: FallsSpec; x: number; y: number; z: number }[] = [];
  private attached = false;
  nearest = { id: '', dist: Infinity };

  constructor(private env: AudioEnv, world: WorldData | null | undefined) {
    const { ac, mx, noise } = env;
    const out = mx.layers.falls;
    for (const spec of specs(world)) {
      for (const p of spec.points) {
        const roar = gain(ac, 1);
        loopSource(ac, noise.pink, rand(0.95, 1.05)).connect(filter(ac, 'lowpass', spec.tone, 0.5)).connect(filter(ac, 'highpass', 90, 0.6)).connect(roar);
        const churn = gain(ac, 0);
        const lp = filter(ac, 'lowpass', 6000, 0.5);
        const level = gain(ac, 0);
        const pan = panner(ac, 'equalpower');
        setPos(pan, p.x, p.y, p.z);
        roar.connect(lp);
        churn.connect(lp);
        lp.connect(level).connect(pan).connect(out);
        const send = gain(ac, 0.12);
        level.connect(send).connect(mx.worldVerb);
        this.points.push({ spec, ...p, level, lp, roar, churn, pan, wobble: 1, wobbleTarget: 1, dist: Infinity });
      }
      if (spec.rumble > 0.2) {
        // low rumble shared by the whole falls, at its center
        const c = spec.points.reduce((a, p) => ({ x: a.x + p.x / spec.points.length, y: a.y + p.y / spec.points.length, z: a.z + p.z / spec.points.length }), { x: 0, y: 0, z: 0 });
        const g = gain(ac, 0);
        const pan = panner(ac, 'equalpower');
        setPos(pan, c.x, c.y, c.z);
        loopSource(ac, noise.brown).connect(filter(ac, 'lowpass', 160, 0.6)).connect(filter(ac, 'highpass', 30, 0.7)).connect(g).connect(pan).connect(out);
        this.rumble.push({ g, spec, ...c });
      }
    }
    env.samples.onReady(() => this.attach());
  }

  private attach() {
    const { ac, samples } = this.env;
    const babble = samples.loops.babble;
    if (this.attached || !babble) return;
    this.attached = true;
    for (const p of this.points) {
      loopSource(ac, babble, p.spec.id === 'cascade' ? rand(1.05, 1.15) : rand(0.78, 0.9)).connect(p.churn);
      glide(p.churn.gain, p.spec.churn, ac.currentTime, 0.8);
    }
  }

  update(t: number) {
    const L = this.env.listener;
    this.nearest = { id: '', dist: Infinity };
    for (const p of this.points) {
      if (t > p.wobbleTarget) {
        p.wobble = rand(0.8, 1.1);
        p.wobbleTarget = t + rand(0.8, 3);
      }
      const d = Math.max(1, Math.hypot(p.x - L.x, p.y - L.y, p.z - L.z));
      p.dist = d;
      if (d < this.nearest.dist) this.nearest = { id: p.spec.id, dist: d };
      const s = p.spec;
      const lvl = d > 900 ? 0 : (s.amp / Math.sqrt(s.points.length)) * 0.7 * Math.pow(s.ref / Math.max(s.ref, d), 1.15) * p.wobble;
      glide(p.level.gain, lvl, t, 0.6);
      glide(p.lp.frequency, clamp(1000 + 11000 * Math.exp(-d / 110), 700, 12000), t, 0.5);
    }
    for (const r of this.rumble) {
      const d = Math.max(1, Math.hypot(r.x - L.x, r.y - L.y, r.z - L.z));
      glide(r.g.gain, d > 900 ? 0 : r.spec.rumble * r.spec.amp * Math.pow(r.spec.ref / Math.max(r.spec.ref, d), 0.9), t, 0.6);
    }
  }

  get stats() {
    return { nearest: this.nearest.id, dist: Math.round(this.nearest.dist) };
  }
}
