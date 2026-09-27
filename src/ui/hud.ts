// heads-up display: compass strip, objective line, speed, contextual cue, destination marker, toasts.
// instruments never animate (they are read constantly); only arrivals like toasts and cues move.
import { Vector3 } from 'three/webgpu';
import type { GameContext } from '../core/context';
import type { GameService, ToastView } from '../game/types';
import { forwardToHeading } from '../world/layout';
import { formatDistance, h, kbd, reducedMotion, setAttr, setText } from './dom';

const CARDINALS: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
const _v = new Vector3(), _c = new Vector3(), _dir = new Vector3();

export class Hud {
  readonly el: HTMLElement;
  private compass: HTMLCanvasElement;
  private cctx: CanvasRenderingContext2D;
  private headingEl: HTMLElement;
  private objective: HTMLElement;
  private objEyebrow: HTMLElement;
  private objTitle: HTMLElement;
  private objLine: HTMLElement;
  private objCount: HTMLElement;
  private speedValue: HTMLElement;
  private speedUnit: HTMLElement;
  private throttle: HTMLElement;
  private prompt: HTMLElement;
  private hints: HTMLElement;
  private marker: HTMLElement;
  private markerArrow: HTMLElement;
  private markerLabel: HTMLElement;
  private toastsEl: HTMLElement;
  private queue: ToastView[] = [];
  private showing = false;
  private lastCompass = '';
  private lastObjective = '';
  private lastCue = '';
  private dpr = 1;
  private compassW = 440;

  constructor(private ctx: GameContext, root: HTMLElement) {
    this.compass = h('canvas', { 'aria-hidden': 'true' });
    this.cctx = this.compass.getContext('2d')!;
    this.headingEl = h('span', { class: 'compass-heading' });
    this.objEyebrow = h('div', { class: 'objective-eyebrow' });
    this.objTitle = h('div', { class: 'objective-title' });
    this.objCount = h('span', { class: 'objective-count' });
    this.objLine = h('div', { class: 'objective-line' });
    this.objective = h('section', { class: 'objective hud-fade', 'aria-label': 'Current objective', 'aria-live': 'polite' }, this.objEyebrow, this.objTitle, this.objLine);
    this.speedValue = h('span', { class: 'speed-value', text: '0.0' });
    this.speedUnit = h('span', { class: 'speed-unit', text: 'kn' });
    this.throttle = h('i');
    this.prompt = h('div', { class: 'prompt', 'data-on': 'false', role: 'status' });
    this.hints = h('div', { class: 'hints', 'data-on': 'false' });
    this.markerArrow = h('i', { class: 'marker-arrow' });
    this.markerLabel = h('span', { class: 'marker-label' });
    this.marker = h('div', { class: 'marker', 'aria-hidden': 'true' }, h('i', { class: 'marker-diamond' }), this.markerArrow, this.markerLabel);
    this.toastsEl = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    this.el = h('div', { class: 'hud', 'data-on': 'false' },
      this.marker,
      h('div', { class: 'compass hud-fade', 'aria-hidden': 'true' }, this.compass, this.headingEl),
      this.objective,
      h('div', { class: 'speed hud-fade', 'aria-hidden': 'true' }, this.speedValue, this.speedUnit, h('div', { class: 'throttle' }, this.throttle)),
      h('div', { class: 'cue hud-fade' }, this.prompt, this.hints),
      this.toastsEl,
    );
    root.append(this.el);
    this.sizeCompass();
    ctx.events.on('resize', () => this.sizeCompass());
    ctx.events.on('game:toast', (t: ToastView) => this.toast(t));
  }

  show(on: boolean) {
    setAttr(this.el, 'data-on', on ? 'true' : 'false');
  }

  /** hide instruments while a menu or the chart covers the view (toasts stay) */
  dim(on: boolean) {
    setAttr(this.el, 'data-dim', on ? 'true' : 'false');
  }

  private sizeCompass() {
    this.compassW = innerWidth < 760 ? 300 : 440;
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.compass.width = Math.round(this.compassW * this.dpr);
    this.compass.height = Math.round(40 * this.dpr);
    this.lastCompass = '';
  }

  update(game: GameService | undefined, overlays: boolean) {
    const ctx = this.ctx;
    const cam = ctx.camera;
    cam.getWorldDirection(_dir);
    const heading = forwardToHeading(_dir.x, _dir.z);
    const b = ctx.boat;
    const target = game?.target ?? null;
    let bearing: number | null = null;
    if (target && b) bearing = forwardToHeading(target.x - cam.position.x, target.z - cam.position.z);
    this.drawCompass(heading, bearing);

    // speed
    const units = ctx.settings.units;
    const ms = Math.abs(b?.speed ?? 0);
    const v = units === 'kmh' ? ms * 3.6 : ms * 1.943844;
    setText(this.speedValue, v < 0.05 ? '0.0' : v.toFixed(1));
    setText(this.speedUnit, units === 'kmh' ? 'km/h' : 'kn');
    const th = Math.max(-1, Math.min(1, b?.throttle ?? 0));
    const w = Math.round(Math.abs(th) * 42);
    this.throttle.style.width = `${w}px`;
    this.throttle.style.left = th >= 0 ? '42px' : `${42 - w}px`;
    setAttr(this.throttle, 'data-dir', th < 0 ? 'rev' : 'fwd');

    this.updateObjective(game);
    this.updateCue(game, overlays);
    this.updateMarker(game, overlays);
  }

  private drawCompass(heading: number, bearing: number | null) {
    const key = `${heading.toFixed(1)}|${bearing === null ? '-' : bearing.toFixed(1)}|${this.compassW}`;
    if (key === this.lastCompass) return;
    this.lastCompass = key;
    setText(this.headingEl, `${String(Math.round(heading) % 360).padStart(3, '0')}°`);
    const c = this.cctx, W = this.compassW, H = 40, dpr = this.dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const cx = W / 2, ppd = W / 150; // about 150 degrees across the strip
    c.shadowColor = 'rgba(18, 14, 10, 0.6)';
    c.shadowBlur = 4;
    c.shadowOffsetY = 1;
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    const start = Math.floor((heading - 80) / 5) * 5;
    for (let d = start; d <= heading + 80; d += 5) {
      const x = cx + (d - heading) * ppd;
      const n = ((d % 360) + 360) % 360;
      const label = CARDINALS[n];
      const major = n % 90 === 0, mid = n % 45 === 0, minor15 = n % 15 === 0;
      const len = major ? 9 : mid ? 7 : minor15 ? 5 : 3;
      c.fillStyle = major ? 'rgba(244,239,228,0.95)' : mid ? 'rgba(244,239,228,0.8)' : 'rgba(244,239,228,0.5)';
      c.fillRect(Math.round(x * dpr) / dpr - 0.5, 4, 1, len);
      if (label) {
        c.font = major ? '600 13px Geist, system-ui, sans-serif' : '500 10.5px Geist, system-ui, sans-serif';
        c.fillStyle = major ? 'rgba(244,239,228,0.98)' : 'rgba(244,239,228,0.78)';
        c.fillText(label, x, 30);
      } else if (n % 30 === 0) {
        c.font = '500 9.5px Geist, system-ui, sans-serif';
        c.fillStyle = 'rgba(244,239,228,0.5)';
        c.fillText(String(n), x, 29);
      }
    }
    // lubber line at the center
    c.fillStyle = 'rgba(244,239,228,0.98)';
    c.beginPath();
    c.moveTo(cx - 4, 0);
    c.lineTo(cx + 4, 0);
    c.lineTo(cx, 5);
    c.closePath();
    c.fill();
    if (bearing !== null) {
      let rel = ((bearing - heading + 540) % 360) - 180;
      const lim = (W / 2 - 22) / ppd;
      const edge = Math.abs(rel) > lim;
      rel = Math.max(-lim, Math.min(lim, rel));
      const x = cx + rel * ppd;
      c.shadowBlur = 3;
      c.fillStyle = '#e2623f';
      c.globalAlpha = edge ? 0.75 : 1;
      c.beginPath();
      c.moveTo(x, 12);
      c.lineTo(x + 4.5, 16.5);
      c.lineTo(x, 21);
      c.lineTo(x - 4.5, 16.5);
      c.closePath();
      c.fill();
      if (edge) {
        const s = Math.sign(rel);
        c.beginPath();
        c.moveTo(x + s * 8, 13);
        c.lineTo(x + s * 11.5, 16.5);
        c.lineTo(x + s * 8, 20);
        c.strokeStyle = '#e2623f';
        c.lineWidth = 1.5;
        c.stroke();
      }
      c.globalAlpha = 1;
    }
  }

  private updateObjective(game: GameService | undefined) {
    const t = game?.phase === 'playing' ? game.tracked : null;
    const key = t ? `${t.id}|${t.status}|${t.line}|${t.progress?.done}/${t.progress?.total}|${!!game?.dockedAt}` : game?.allDone ? 'done' : 'none';
    if (key === this.lastObjective) return;
    this.lastObjective = key;
    if (!t) {
      if (game?.phase === 'playing' && game.allDone) {
        this.objective.hidden = false;
        setText(this.objEyebrow, 'Free cruising');
        setText(this.objTitle, 'The whole river');
        this.objLine.replaceChildren('Every landing visited. Drift wherever the light is good.');
      } else this.objective.hidden = true;
      return;
    }
    this.objective.hidden = false;
    setText(this.objEyebrow, t.status === 'available' && !t.intro ? `Next  ·  ${t.label}` : t.label);
    setText(this.objTitle, t.title);
    const kids: (Node | string)[] = [t.line];
    const moored = !!game?.dockedAt && t.status !== 'active';
    if (t.progress && t.progress.total > 1 && t.kind !== 'delivery' && !moored) {
      setText(this.objCount, `${t.progress.done} / ${t.progress.total}`);
      kids.push(this.objCount);
    }
    this.objLine.replaceChildren(...kids);
  }

  private updateCue(game: GameService | undefined, overlays: boolean) {
    const p = overlays ? null : game?.prompt ?? null;
    const hints = overlays || p ? null : game?.hints ?? null;
    const key = p ? `p|${p.key}|${p.text}|${p.tone}` : hints ? `h|${hints.map((x) => x.keys.join('+') + x.label).join('|')}` : '';
    if (key === this.lastCue) return;
    this.lastCue = key;
    if (p) {
      this.prompt.replaceChildren(...(p.key ? kbd(p.key) : []), h('span', { text: p.text }));
      setAttr(this.prompt, 'data-tone', p.tone);
    }
    setAttr(this.prompt, 'data-on', p ? 'true' : 'false');
    if (hints) this.hints.replaceChildren(...hints.map((x) => h('span', { class: 'hint' }, ...kbd(...x.keys), x.label)));
    setAttr(this.hints, 'data-on', hints ? 'true' : 'false');
  }

  private updateMarker(game: GameService | undefined, overlays: boolean) {
    const ctx = this.ctx, t = game?.target, b = ctx.boat;
    const visible = !!(t && b && ctx.settings.showMarker && !overlays && game?.phase === 'playing');
    if (!visible || !t || !b) {
      setAttr(this.marker, 'data-on', 'false');
      return;
    }
    const dist = Math.hypot(t.x - b.position.x, t.z - b.position.z);
    if (dist < 7) {
      setAttr(this.marker, 'data-on', 'false');
      return;
    }
    const cam = ctx.camera;
    const W = innerWidth, H = innerHeight;
    _v.set(t.x, t.y, t.z);
    _c.copy(_v).applyMatrix4(cam.matrixWorldInverse);
    const behind = _c.z > -0.1;
    _v.project(cam);
    let x = (_v.x * 0.5 + 0.5) * W, y = (-_v.y * 0.5 + 0.5) * H;
    if (behind) {
      // mirror through the center so the edge arrow points the right way
      x = W - x;
      y = H - y;
    }
    const inset = 56, top = 90, bottom = 110;
    const onScreen = !behind && x >= inset && x <= W - inset && y >= top && y <= H - bottom;
    let angle = 0;
    if (!onScreen) {
      const cx = W / 2, cy = H / 2;
      let dx = x - cx, dy = y - cy;
      if (behind && Math.abs(dy) < 1e-3) dy = 1;
      const sx = dx !== 0 ? ((dx > 0 ? W - inset : inset) - cx) / dx : Infinity;
      const sy = dy !== 0 ? ((dy > 0 ? H - bottom : top) - cy) / dy : Infinity;
      const s = Math.min(Math.abs(sx), Math.abs(sy));
      x = cx + dx * s;
      y = cy + dy * s;
      angle = Math.atan2(dy, dx);
    }
    this.marker.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    setAttr(this.marker, 'data-on', 'true');
    setAttr(this.marker, 'data-edge', onScreen ? 'false' : 'true');
    if (!onScreen) this.markerArrow.style.transform = `rotate(${angle}rad) translateX(15px) rotate(45deg)`;
    const label = `${formatDistance(dist)}`;
    const key = `${label}|${t.label}`;
    if (this.markerLabel.dataset.key !== key) {
      this.markerLabel.dataset.key = key;
      this.markerLabel.replaceChildren(label, h('small', { text: t.label }));
    }
  }

  // ---------------------------------------------------------------- toasts

  toast(t: ToastView) {
    this.queue.push(t);
    if (!this.showing) this.next();
  }

  private next() {
    const t = this.queue.shift();
    if (!t) {
      this.showing = false;
      return;
    }
    this.showing = true;
    const el = h('div', { class: 'toast', 'data-tone': t.tone },
      h('div', { class: 'toast-eyebrow', text: t.eyebrow }),
      h('i', { class: 'toast-rule', 'aria-hidden': 'true' }),
      h('div', { class: 'toast-title', text: t.title, 'data-italic': t.italic ? 'true' : 'false' }),
      t.detail ? h('div', { class: 'toast-detail', text: t.detail }) : null,
    );
    this.toastsEl.append(el);
    // completions, cargo and discoveries already chime from gameplay; plain notices get the soft toast
    if (t.tone === 'info') {
      try {
        (this.ctx.services.audio as any)?.play?.('toast');
      } catch {}
    }
    requestAnimationFrame(() => requestAnimationFrame(() => setAttr(el, 'data-state', 'in')));
    // a backed-up queue moves faster so feedback stays close to the moment it describes
    const hold = (this.queue.length >= 2 ? 1900 : this.queue.length ? 3000 : 4600) + Math.min(1600, (t.detail?.length ?? 0) * 16);
    setTimeout(() => {
      setAttr(el, 'data-state', 'out');
      setTimeout(() => {
        el.remove();
        this.next();
      }, reducedMotion() ? 200 : 460);
    }, hold);
  }
}
