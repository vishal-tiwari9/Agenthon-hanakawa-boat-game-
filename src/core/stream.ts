// near-first streaming. modules build the reach around the start (the spawn, or the dock a save resumes
// at) before the reveal and queue the far pieces here. after the reveal the queue runs in slices of at
// most ~4 ms a frame, nearest ahead of the camera first. a finished piece gets its pipelines built
// before anyone can see it: it sits under a zero-scale group (every triangle degenerate, nothing
// rasterizes), first on the no-reflect layer only (main pass), then on its own layers (ao prepass,
// mirror), and only then goes to its module's group. its gpu pipelines are created asynchronously (the
// path three's compileAsync uses; the renderer skips a draw until its pipeline is ready), so a heavy
// material compiles off the gpu queue instead of stalling a frame, and nothing compiles on first sight.
import { Group, type Object3D } from 'three/webgpu';
import type { GameContext } from './context';
import { LAYERS } from './layers';
import { SPAWN, nearestRiver, riverFrame } from '../world/layout';

/** `await slice()` between pieces of work yields to the next frame once this frame's budget is spent;
 *  `await slice.wait(p)` waits on something that is not work (a download, a warm-up) */
export interface Slice {
  (): Promise<void>;
  wait<T>(p: Promise<T>): Promise<T>;
}

export interface StreamJob {
  label: string;
  /** along-river position, orders the queue */
  s: number;
  run(slice: Slice): Promise<void> | void;
}

interface Queued extends StreamJob {
  urgent: boolean;
  done: Promise<void>;
  resolve(): void;
}

interface Warming {
  obj: Object3D;
  parent: Object3D;
  placed?: () => void;
  phase: number;
  saved: [Object3D, number, boolean, boolean][];
  resolve(): void;
}

/** per-frame cpu budget for queued work after the reveal */
const BUDGET_MS = 4;
/** anything this close to the start is always built before the reveal */
const ALWAYS_NEAR = 400;
/** where the player can be while the queue runs: this reach of river around the start */
const VIEW_BEHIND = 150, VIEW_AHEAD = 250;

export class Streamer {
  readonly startS: number;
  readonly start: { x: number; z: number };
  /**
   * frameMaxMs: the longest frame while anything was queued, running or warming (after the reveal).
   * log: those frames, [frame ms, queued work ms, warm step, pipelines created] (the first 120)
   */
  stats = {
    queued: 0, done: 0, cpuMs: 0, maxStepMs: 0, warmed: 0, frames: 0, frameMaxMs: 0,
    late: [] as string[], pending: [] as string[], log: [] as [number, number, string, number][],
  };
  private lastTick = 0;
  private lastWork = 0;
  private lastWarm = '';
  private lastPipes = -1;
  private queue: Queued[] = [];
  private warming: Warming[] = [];
  private warmRoot = new Group();
  private active = false;
  private running = false;
  private rush = 0;
  private used = 0;
  private resumed = 0;
  private waiters: (() => void)[] = [];
  private focusS: number;
  private frame = 0;
  private viewpoints: [number, number, number][] = [];
  /** async pipeline compiles started for warming objects, still running */
  private compiling = 0;
  private waitFrames = 0;

  constructor(private ctx: GameContext) {
    const b = ctx.boat?.position;
    this.start = b ? { x: b.x, z: b.z } : { x: SPAWN.x, z: SPAWN.z };
    this.startS = this.focusS = nearestRiver(this.start.x, this.start.z).s;
    // viewpoints the player can reach while the queue drains: both halves of the channel, low and high
    for (let s = this.startS - VIEW_BEHIND; s <= this.startS + VIEW_AHEAD; s += 50) {
      const f = riverFrame(s);
      for (const lat of [-0.25, 0.25]) for (const h of [3, 12]) this.viewpoints.push([f.x + f.nx * f.width * lat, h, f.z + f.nz * f.width * lat]);
    }
    this.warmRoot.name = 'stream.warm';
    this.warmRoot.scale.setScalar(0);
    this.warmRoot.position.y = -1000;
    ctx.scene.add(this.warmRoot);
    ctx.events.on('app:revealed', () => {
      this.active = true;
      this.pump();
    });
    ctx.onUpdate(() => this.tick(), -200);
    // render objects under the warm group take three's async pipeline path (see the header)
    const pipes = (ctx.renderer as any)._pipelines;
    if (pipes && typeof pipes.updateForRender === 'function' && typeof pipes.getForRender === 'function') {
      const sync = pipes.updateForRender.bind(pipes);
      const started: Promise<unknown>[] = [];
      pipes.updateForRender = (ro: { object: Object3D }) => {
        if (!this.warming.length || !this.underWarm(ro.object)) return sync(ro);
        pipes.getForRender(ro, started);
        for (const p of started.splice(0)) {
          this.compiling++;
          void p.finally(() => this.compiling--);
        }
      };
    }
  }

  private underWarm(o: Object3D | null) {
    for (; o; o = o.parent) if (o === this.warmRoot) return true;
    return false;
  }

  /**
   * can a piece (center x/z, `top` meters high, `radius` across) be seen from the river around the
   * start within its cull distance `far`? terrain blocks sightlines; trees are ignored, so a doubtful
   * case counts as seen and gets built before the reveal
   */
  seen(x: number, z: number, top: number, far: number, radius = 0) {
    if (Math.hypot(x - this.start.x, z - this.start.z) < ALWAYS_NEAR) return true;
    const w = this.ctx.world;
    const r = radius * 0.7;
    const targets: [number, number][] = [[x, z], [x + r, z], [x - r, z], [x, z + r], [x, z - r]];
    const clear = (vx: number, vy: number, vz: number, tx: number, ty: number, tz: number) => {
      const d = Math.hypot(tx - vx, tz - vz);
      const n = Math.ceil(d / 8);
      for (let i = 1; i < n; i++) {
        const t = i / n;
        if (t * d < 12 || (1 - t) * d < 12) continue;
        const px = vx + (tx - vx) * t, pz = vz + (tz - vz) * t;
        if (w.heightAt(px, pz) > vy + (ty - vy) * t + 0.5) return false;
      }
      return true;
    };
    for (const [vx, vy, vz] of this.viewpoints) {
      if (Math.hypot(x - vx, z - vz) - radius > far) continue;
      for (const [tx, tz] of targets) for (const ty of [1.5, top]) if (clear(vx, vy, vz, tx, ty, tz)) return true;
    }
    return false;
  }

  /** queue a far piece; it runs after the reveal (or when a debug view forces its region) */
  add(job: StreamJob): Promise<void> {
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    this.queue.push({ ...job, urgent: false, done, resolve });
    this.stats.queued++;
    this.stats.late.push(job.label);
    this.stats.pending.push(job.label);
    this.pump();
    return done;
  }

  /** build every queued piece within `radius` of along-river s now, without the frame budget or warm-up */
  force(s: number, radius = 600) {
    const hit = this.queue.filter((j) => Math.abs(j.s - s) < radius);
    for (const w of this.warming.splice(0)) this.handBack(w);
    if (!hit.length) return;
    for (const j of hit) j.urgent = true;
    this.rush++;
    void Promise.all(hit.map((j) => j.done)).finally(() => this.rush--);
    this.pump();
  }

  /** true once nothing is queued, running or warming */
  get idle() {
    return !this.queue.length && !this.running && !this.warming.length;
  }

  /**
   * build `obj`'s pipelines out of sight, then add it to `parent`. `placed` runs in the same frame, before
   * anything draws it, so the owner can put it under its distance culling. `obj` moves under the warm group
   */
  warm(obj: Object3D, parent: Object3D, placed?: () => void): Promise<void> {
    obj.removeFromParent();
    if (this.rush || !this.active) {
      this.handBack({ obj, parent, placed, phase: 0, saved: [], resolve: () => {} });
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.warmRoot.add(obj);
      this.warming.push({ obj, parent, placed, phase: 0, saved: [], resolve });
    });
  }

  private tick() {
    const now = performance.now();
    const pipes = (this.ctx.renderer as any)._pipelines?.caches?.size ?? -1;
    if (this.active && this.lastTick && (!this.idle || this.lastWork || this.lastWarm)) {
      const ms = Math.round(now - this.lastTick);
      this.stats.frames++;
      this.stats.frameMaxMs = Math.max(this.stats.frameMaxMs, ms);
      if (this.stats.log.length < 120) this.stats.log.push([ms, +this.used.toFixed(1), this.lastWarm, pipes - this.lastPipes]);
    }
    this.lastTick = now;
    this.lastPipes = pipes;
    this.lastWork = this.used;
    // one warm phase per frame, so a piece's new builds spread over frames; a phase waits for the async
    // pipeline compiles of the one before (bounded, in case a compile never reports back)
    const w = this.warming[0];
    const compiled = this.compiling === 0 || ++this.waitFrames > 90;
    if (w && (w.phase === 0 || compiled)) {
      this.waitFrames = 0;
      if (w.phase === 0) {
        w.obj.traverse((o) => {
          w.saved.push([o, o.layers.mask, o.frustumCulled, o.visible]);
          o.layers.mask = 1 << LAYERS.NO_REFLECT;
          o.frustumCulled = false;
          o.visible = true;
        });
        w.phase = 1;
      } else if (w.phase === 1) {
        let reflected = false;
        for (const [o, mask] of w.saved) {
          o.layers.mask = mask;
          if (mask & (1 << LAYERS.DEFAULT)) reflected = true;
        }
        w.phase = 2;
        if (!reflected) this.handBack(this.warming.shift()!);
      } else this.handBack(this.warming.shift()!);
    }
    // what this frame renders from the warm-up (phase 1: main pass, 2: ao prepass and mirror)
    const h = this.warming[0];
    this.lastWarm = h && h.phase ? `${h.obj.name}:${h.phase}` : '';
    // the queue orders by the camera's along-river position; refreshed a few times a second
    if (++this.frame % 15 === 0) {
      const c = this.ctx.camera.position;
      this.focusS = nearestRiver(c.x, c.z).s;
    }
    this.used = 0;
    for (const r of this.waiters.splice(0)) r();
  }

  private handBack(w: Warming) {
    for (const [o, mask, culled, visible] of w.saved) {
      o.layers.mask = mask;
      o.frustumCulled = culled;
      o.visible = visible;
    }
    w.obj.removeFromParent();
    w.parent.add(w.obj);
    w.obj.updateMatrixWorld(true);
    w.placed?.();
    this.stats.warmed++;
    w.resolve();
  }

  /** close the current step of work: count it against this frame's budget */
  private account() {
    const step = performance.now() - this.resumed;
    this.stats.cpuMs += step;
    this.stats.maxStepMs = Math.max(this.stats.maxStepMs, step);
    this.used += step;
  }

  private slice: Slice = Object.assign(
    async () => {
      this.account();
      if (!this.rush && this.used >= BUDGET_MS) await new Promise<void>((r) => this.waiters.push(r));
      this.resumed = performance.now();
    },
    {
      wait: async <T>(p: Promise<T>) => {
        this.account();
        try {
          return await p;
        } finally {
          this.resumed = performance.now();
        }
      },
    },
  );

  private next() {
    const urgent = this.queue.find((j) => j.urgent);
    if (urgent) return urgent;
    // nearest ahead of the camera first; behind it counts double and after everything ahead nearby
    const cost = (s: number) => (s >= this.focusS - 50 ? s - this.focusS : 300 + 2 * (this.focusS - s));
    let best: Queued | undefined;
    for (const j of this.queue) if (!best || cost(j.s) < cost(best.s)) best = j;
    return best;
  }

  private async pump() {
    if (this.running || (!this.active && !this.rush)) return;
    this.running = true;
    try {
      for (let job = this.next(); job && (this.active || this.rush); job = this.next()) {
        this.queue.splice(this.queue.indexOf(job), 1);
        this.resumed = performance.now();
        try {
          await job.run(this.slice);
        } catch (e) {
          console.error(`[stream] ${job.label} failed`, e);
        }
        await this.slice();
        this.stats.done++;
        this.stats.pending.splice(this.stats.pending.indexOf(job.label), 1);
        job.resolve();
      }
    } finally {
      this.running = false;
    }
  }
}
