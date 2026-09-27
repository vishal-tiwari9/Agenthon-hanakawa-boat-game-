// the loading screen: a painted hanakawa valley (red bridge, pagoda, machiya, blossoms) with the
// wooden canopy boat crossing the river as the progress mark, and the hills panning a little behind
// it. the markup lives in index.html so it paints before any script arrives. everything that moves
// runs on the compositor (transform/opacity), so the scene can build on the main thread without the
// screen stuttering: each boot phase sends the boat to that phase's end with a css transition as long
// as the phase took on this machine last time.

type Phase = { id: string; label: string; ms: number };

// default durations (ms) from a cold headless boot; replaced by this machine's own timings after one visit
const PHASES: Phase[] = [
  { id: 'start', label: 'Unrolling the map', ms: 150 },
  { id: 'render', label: 'Mixing the morning light', ms: 500 },
  { id: 'terrain', label: 'Shaping the valley', ms: 700 },
  { id: 'water', label: 'Filling the river', ms: 200 },
  { id: 'boat', label: 'Launching the boat', ms: 250 },
  { id: 'harbor', label: 'Charting the landings', ms: 60 },
  { id: 'vegetation', label: 'Planting the hills', ms: 80 },
  { id: 'structures', label: 'Raising the town', ms: 900 },
  { id: 'bridges', label: 'Spanning the river', ms: 500 },
  { id: 'audio', label: 'Listening for birdsong', ms: 60 },
  { id: 'background', label: 'Opening the blossoms', ms: 80 },
  { id: 'warm', label: 'Lighting the lanterns', ms: 5000 },
];
const STORE = 'hanakawa.boot';
// the boat stops short of the far edge until the scene is really ready
const RESERVE = 0.96;

/** resolves after the next paint, or shortly anyway when the tab is hidden and never paints */
export function yieldFrame() {
  return new Promise<void>((resolve) => {
    let done = false;
    const go = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 60);
  });
}

export class LoadingScreen {
  private el = document.getElementById('loading');
  private carrier = this.el?.querySelector<HTMLElement>('.river-carrier') ?? null;
  private wake = this.el?.querySelector<HTMLElement>('.river-wake') ?? null;
  private label = this.el?.querySelector<HTMLElement>('.loading-label') ?? null;
  /** layers that pan against the boat's travel, by percent of their width over the whole load */
  private layers = [...(this.el?.querySelectorAll<HTMLElement>('[data-parallax]') ?? [])].map((el) => ({ el, f: Number(el.dataset.parallax) || 0 }));
  private reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private expected = PHASES.map((p) => p.ms);
  private measured: Record<string, number> = {};
  private current = -1;
  private since = performance.now();

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || '{}') as Record<string, number>;
      PHASES.forEach((p, i) => {
        const ms = saved[p.id];
        if (typeof ms === 'number' && ms >= 0 && ms < 30000) this.expected[i] = Math.max(60, ms);
      });
    } catch {}
    void this.phase('start');
  }

  /** enter a boot phase: new label, and the boat sets off toward the end of it. resolves after a paint
   *  so the transition is on the compositor before the caller blocks the main thread */
  phase(id: string) {
    const i = PHASES.findIndex((p) => p.id === id);
    if (i <= this.current) return Promise.resolve();
    this.close();
    this.current = i;
    if (this.label) this.label.textContent = PHASES[i].label;
    const total = this.expected.reduce((a, b) => a + b, 0);
    const end = this.expected.slice(0, i + 1).reduce((a, b) => a + b, 0) / total;
    this.move(end * RESERVE, this.expected[i] * 1.1, 'linear');
    return yieldFrame();
  }

  /** the scene is ready: the boat glides in to the far bank */
  arrive() {
    this.close();
    this.current = PHASES.length;
    try {
      localStorage.setItem(STORE, JSON.stringify(this.measured));
    } catch {}
    this.move(1, 420, 'var(--ease-out)');
  }

  /** lift the veil. resolves as the finished scene starts to show, which is when play begins */
  async reveal() {
    await new Promise((r) => setTimeout(r, this.reduced ? 0 : 260));
    document.getElementById('ui')?.removeAttribute('inert');
    if (!this.el) return;
    this.el.dataset.state = 'reveal';
    document.body.dataset.boot = 'reveal';
    setTimeout(() => {
      this.el?.remove();
      document.body.dataset.boot = 'done';
    }, this.reduced ? 700 : 1800);
  }

  fail(message: string) {
    if (this.el) this.el.dataset.state = 'failed';
    if (this.label) this.label.textContent = message;
  }

  private close() {
    const now = performance.now();
    if (this.current >= 0 && this.current < PHASES.length) this.measured[PHASES[this.current].id] = Math.round(now - this.since);
    this.since = now;
  }

  private move(p: number, ms: number, ease: string) {
    const t = this.reduced ? 'none' : `transform ${Math.round(ms)}ms ${ease}`;
    if (this.carrier) {
      this.carrier.style.transition = t;
      this.carrier.style.transform = `translateX(${(p * 100).toFixed(2)}%)`;
    }
    if (this.wake) {
      this.wake.style.transition = t;
      this.wake.style.transform = `scaleX(${p.toFixed(4)})`;
    }
    for (const { el, f } of this.layers) {
      el.style.transition = t;
      el.style.transform = `translate3d(${(-p * f).toFixed(3)}%, 0, 0)`;
    }
  }
}
