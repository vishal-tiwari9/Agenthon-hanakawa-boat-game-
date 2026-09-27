// fixed-timestep simulation with interpolated rendering and bounded catch-up.
import type { GameContext } from './context';

type Entry<F> = { fn: F; order: number; errors?: number };
type UpdateFn = (ctx: GameContext) => void;
type FixedFn = (ctx: GameContext, dt: number) => void;

const MAX_FRAME = 0.1; // clamp a stalled frame to 100ms
const MAX_STEPS = 5; // never simulate more than this per frame; drop the rest

export class Loop {
  updates: Entry<UpdateFn>[] = [];
  fixed: Entry<FixedFn>[] = [];
  postFixed: Entry<FixedFn>[] = [];
  private acc = 0;
  private last = -1;
  /** rolling frame-time stats for the perf overlay/harness */
  stats = { fps: 0, frameMs: 0, steps: 0, frames: 0 };
  private fpsWindow: number[] = [];
  private renderErrors = 0;

  add<F>(list: Entry<F>[], fn: F, order: number) {
    const e = { fn, order };
    list.push(e);
    list.sort((a, b) => a.order - b.order);
    return () => {
      const i = list.indexOf(e);
      if (i >= 0) list.splice(i, 1);
    };
  }

  frame(ctx: GameContext, nowMs: number) {
    const now = nowMs / 1000;
    let dt = this.last < 0 ? 1 / 60 : now - this.last;
    this.last = now;
    if (!(dt > 0)) dt = 1 / 60;
    dt = Math.min(dt, MAX_FRAME);
    const t = ctx.time;
    t.frameDt = dt;
    t.real += dt;

    const h = t.fixedDt;
    let steps = 0;
    if (!ctx.paused) {
      this.acc += dt;
      while (this.acc >= h && steps < MAX_STEPS) {
        for (const e of this.fixed) guard(e, () => e.fn(ctx, h));
        ctx.physics.step();
        t.sim += h;
        for (const e of this.postFixed) guard(e, () => e.fn(ctx, h));
        this.acc -= h;
        steps++;
      }
      if (steps === MAX_STEPS && this.acc > h) this.acc = this.acc % h;
    }
    t.alpha = ctx.paused ? 1 : this.acc / h;
    t.render = t.sim - (1 - t.alpha) * h;

    for (const e of this.updates) guard(e, () => e.fn(ctx));
    try {
      ctx.render();
    } catch (err) {
      if ((this.renderErrors = (this.renderErrors || 0) + 1) < 5) console.error('[loop] render threw', err);
    }
    ctx.input.endFrame();

    this.stats.steps = steps;
    this.stats.frames++;
    this.fpsWindow.push(dt);
    if (this.fpsWindow.length > 60) this.fpsWindow.shift();
    const avg = this.fpsWindow.reduce((a, b) => a + b, 0) / this.fpsWindow.length;
    this.stats.frameMs = avg * 1000;
    this.stats.fps = 1 / avg;
  }

  /** after a tab comes back, forget the gap instead of simulating it */
  resetClock() {
    this.last = -1;
    this.acc = 0;
  }
}

// one module's per-frame exception must not stop the loop for everyone else. log the first few.
function guard(e: Entry<unknown>, run: () => void) {
  try {
    run();
  } catch (err) {
    e.errors = (e.errors || 0) + 1;
    if (e.errors <= 3) console.error('[loop] callback threw', (e.fn as any).name || '', err);
  }
}
