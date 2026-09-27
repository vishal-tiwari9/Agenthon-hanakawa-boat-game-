// interface: hud, chart (M), pause menu (Esc). owns the ui mode, gates gameplay input while anything
// covers the view, pauses the sim for the menu, and handles pointer lock. there is no title gate: play
// begins as the loading screen lifts, a saved voyage resumes where it was moored, and the first click
// on the view takes pointer lock (audio starts on the first key or click by itself).
import type { GameContext } from '../core/context';
import type { GameService } from '../game/types';
import { DOCKS } from '../world/layout';
import { Chart } from './chart';
import { Hud } from './hud';
import { Menu } from './menu';

type Mode = 'title' | 'play' | 'pause' | 'chart';

export async function init(ctx: GameContext) {
  const root = document.getElementById('ui');
  if (!root) return;
  const game = () => ctx.services.game as GameService | undefined;
  let mode: Mode = 'title';
  let expectUnlock = false;
  let pausedAt = 0;
  ctx.input.gameplayEnabled = false;

  const play = (name: string) => {
    try {
      (ctx.services.audio as any)?.play?.(name);
    } catch {}
  };

  const hud = new Hud(ctx, root);
  const chart = new Chart(ctx, root, () => closeChart(true), (id) => game()?.track(id));
  const menu = new Menu(ctx, root, game, () => resume(true), () => newGame());

  function lock() {
    if (document.pointerLockElement === ctx.canvas) return;
    try {
      const p = (ctx.canvas.requestPointerLock as () => Promise<void> | void)?.call(ctx.canvas);
      (p as Promise<void> | undefined)?.catch?.(() => {});
    } catch {}
  }

  function unlock() {
    if (!document.pointerLockElement) return;
    expectUnlock = true;
    document.exitPointerLock?.();
  }

  /** 'title' is the state before the reveal; play starts without a gesture, so no pointer lock yet */
  function begin() {
    if (mode !== 'title') return;
    mode = 'play';
    const g = game();
    // a saved voyage resumes on its own; say where, first in the toast queue
    if (g?.hasSave) {
      const dock = DOCKS.find((d) => d.id === g.dockedAt);
      const done = g.objectives.filter((o) => o.status === 'done').length;
      ctx.events.emit('game:toast', { tone: 'info', eyebrow: 'Welcome back', title: dock?.name ?? 'The village', detail: `${done} of ${g.objectives.length} objectives complete.` });
    }
    g?.start();
    ctx.input.gameplayEnabled = true;
    hud.show(true);
    ctx.canvas.focus({ preventScroll: true });
  }

  function pause() {
    if (mode !== 'play') return;
    mode = 'pause';
    pausedAt = performance.now();
    ctx.paused = true;
    ctx.input.gameplayEnabled = false;
    ctx.events.emit('pause');
    hud.dim(true);
    unlock();
    menu.open();
    play('ui-open');
  }

  function resume(gesture: boolean) {
    if (mode !== 'pause') return;
    menu.close();
    mode = 'play';
    ctx.paused = false;
    ctx.input.gameplayEnabled = true;
    ctx.events.emit('resume');
    hud.dim(false);
    if (gesture) lock();
    ctx.canvas.focus({ preventScroll: true });
    play('ui-close');
  }

  function openChart() {
    if (mode !== 'play') return;
    mode = 'chart';
    ctx.input.gameplayEnabled = false;
    hud.dim(true);
    unlock();
    void chart.open(game());
    ctx.events.emit('ui:chart', true);
    play('chart');
  }

  function closeChart(gesture: boolean) {
    if (mode !== 'chart') return;
    chart.close();
    mode = 'play';
    ctx.input.gameplayEnabled = true;
    hud.dim(false);
    ctx.events.emit('ui:chart', false);
    if (gesture) lock();
    ctx.canvas.focus({ preventScroll: true });
  }

  function newGame() {
    game()?.newGame();
    resume(true);
  }

  ctx.events.on('input:pause', () => {
    if (mode === 'chart') return closeChart(false);
    if (mode === 'pause') {
      // escape that released pointer lock can arrive right after the lock-loss pause
      if (performance.now() - pausedAt > 350) resume(false);
      return;
    }
    if (mode === 'play') pause();
  });
  ctx.events.on('input:chart', () => {
    if (mode === 'play') openChart();
    else if (mode === 'chart') closeChart(true);
  });
  ctx.events.on('input:pointerdown', () => {
    if (mode === 'play') lock();
  });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === ctx.canvas) {
      expectUnlock = false;
      return;
    }
    if (expectUnlock) {
      expectUnlock = false;
      return;
    }
    // escape releases pointer lock without always delivering a key event: treat it as pause
    if (mode === 'play') pause();
  });
  ctx.events.on('app:hidden', () => { if (mode === 'play') pause(); });
  ctx.events.on('game:ready', () => setTimeout(() => void chart.prebuild(), 1200));
  ctx.events.on('app:revealed', () => begin());
  ctx.events.on('resize', () => chart.resize());

  ctx.onUpdate(() => {
    const g = game();
    hud.update(g, mode !== 'play');
    if (mode === 'chart') chart.render(g);
    // gameplay input follows the ui mode, whoever else touched it
    const want = mode === 'play';
    if (ctx.input.gameplayEnabled !== want) ctx.input.gameplayEnabled = want;
  }, 90);

  // harness hooks
  (window as any).__lumaUi = {
    get mode() { return mode; },
    start: () => begin(),
    pause,
    resume: () => resume(false),
    openChart,
    closeChart: () => closeChart(false),
    menu,
    chart,
  };
}
