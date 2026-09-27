// the river map (M), drawn from ctx.world in ink on washi: paper grain, sumi hill washes lit from the
// north-west, a pale indigo wash for the water, inked banks, faint contours, flow lines along the
// current, each bridge in its own hand (the vermilion one in vermilion), small ink glyphs for the
// landmarks, landings, and a vermilion seal as the title mark. lettering follows map convention:
// roman for places on land, italic for water. north stays up, so the valley reads as a tall scroll.
// the raster is built once in slices; lettering is drawn at display resolution; the boat, target and
// lanterns are drawn live while open.
import { Vector3 } from 'three/webgpu';
import type { GameContext } from '../core/context';
import type { GameService, ObjectiveView } from '../game/types';
import { BRIDGES, DOCKS, LANDMARKS, RIVER_LENGTH, bankPoint, forwardToHeading, riverFrame, type Bridge } from '../world/layout';
import { SITES } from '../world/sites';
import { h, kbd, reducedMotion } from './dom';

const RASTER_H = 1400;
const GRID = 4; // contour grid spacing (m)

const SUMI = '29, 26, 22';
const VERMILION = '#c3432a';
const SERIF = "'Cormorant Garamond', Georgia, serif";
const SANS = 'Geist, system-ui, sans-serif';
const SEAL = "'Hanakawa Seal', 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif";

const PAPER = [239, 232, 216];
const WATER = [120, 150, 164];
const FOREST = [132, 146, 118];
const MEADOW = [196, 202, 160];

type Seg = Float32Array;

function hash(i: number, j: number) {
  let n = (i * 374761393 + j * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

const yieldFrame = () => new Promise<void>((r) => setTimeout(r, 0));

interface Bounds {
  x0: number;
  z0: number;
  w: number;
  h: number;
}

/** the valley around the river, padded to at least a 0.56 aspect so the hills have room */
function valleyBounds(): Bounds {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let s = 0; s <= RIVER_LENGTH; s += 10) {
    const f = riverFrame(s);
    const r = f.width / 2;
    x0 = Math.min(x0, f.x - r); x1 = Math.max(x1, f.x + r);
    z0 = Math.min(z0, f.z - r); z1 = Math.max(z1, f.z + r);
  }
  x0 -= 230; x1 += 230; z0 -= 90; z1 += 60;
  const minW = (z1 - z0) * 0.56;
  if (x1 - x0 < minW) {
    const pad = (minW - (x1 - x0)) / 2;
    x0 -= pad; x1 += pad;
  }
  return { x0, z0, w: x1 - x0, h: z1 - z0 };
}

export class Chart {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private B = valleyBounds();
  private raster: HTMLCanvasElement | null = null;
  private water: HTMLCanvasElement | null = null;
  private base: HTMLCanvasElement | null = null;
  private baseKey = '';
  private contours: { level: number; segs: Seg }[] = [];
  private building: Promise<void> | null = null;
  private logList: HTMLElement;
  private logFoot: HTMLElement;
  private closeBtn: HTMLButtonElement;
  private lastLog = '';
  private Dh = 800;
  private Dw = 450;
  private dpr = 1;
  isOpen = false;

  constructor(private ctx: GameContext, root: HTMLElement, private onClose: () => void, private onTrack: (id: string) => void) {
    this.canvas = h('canvas', { class: 'chart-canvas', role: 'img', 'aria-label': 'River map of Hanakawa with your boat, the landings, the bridges and the places you have found' });
    this.g = this.canvas.getContext('2d')!;
    this.logList = h('ol', { class: 'log-list' });
    this.logFoot = h('div', { class: 'log-foot' });
    this.closeBtn = h('button', { class: 'btn btn-quiet log-close', type: 'button', 'aria-label': 'Close the river map' }, ...kbd('M'), 'Close');
    this.closeBtn.addEventListener('click', () => this.onClose());
    this.el = h('div', { class: 'overlay chart', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'chart-log-title', hidden: true, 'data-open': 'false' },
      h('div', { class: 'chart-stage' },
        h('div', { class: 'chart-paper' }, this.canvas),
        h('aside', { class: 'chart-log' },
          h('div', { class: 'log-head' }, h('h2', { class: 'log-title', id: 'chart-log-title', text: 'Log' }), this.closeBtn),
          this.logList,
          this.logFoot,
        ),
      ),
    );
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) this.onClose(); });
    // keys inside the map stay out of gameplay input (m and escape still close it)
    this.el.addEventListener('keydown', (e) => { if (e.code !== 'Escape' && e.code !== 'KeyM') e.stopPropagation(); });
    root.append(this.el);
  }

  prebuild() {
    if (!this.building) this.building = this.build().catch((e) => console.warn('[ui] map build failed', e));
    return this.building;
  }

  // ---------------------------------------------------------------- raster (once per bake)

  private async build() {
    const w = this.ctx.world;
    if (!w?.has?.('height')) return;
    const B = this.B;
    const RH = RASTER_H, RW = Math.round((RASTER_H * B.w) / B.h);
    const cx = B.w / RW, cz = B.h / RH;
    const hts = new Float32Array(RW * RH);
    for (let j = 0; j < RH; j++) {
      const z = B.z0 + (j + 0.5) * cz;
      for (let i = 0; i < RW; i++) hts[j * RW + i] = w.heightAt(B.x0 + (i + 0.5) * cx, z);
      if (j % 160 === 159) await yieldFrame();
    }
    const img = new ImageData(RW, RH);
    const mask = new ImageData(RW, RH);
    const d = img.data, m = mask.data;
    const has = { trees: w.has('trees'), grass: w.has('grass') };
    const lx = -0.5, ly = 0.707, lz = -0.5;
    for (let j = 0; j < RH; j++) {
      const z = B.z0 + (j + 0.5) * cz;
      for (let i = 0; i < RW; i++) {
        const k = j * RW + i;
        const ht = hts[k];
        let r = PAPER[0], g = PAPER[1], b = PAPER[2];
        if (ht < 0) {
          // indigo wash, a touch deeper in the channel than along the banks
          const a = 0.2 + 0.2 * Math.min(1, -ht / 4);
          r += (WATER[0] - r) * a; g += (WATER[1] - g) * a; b += (WATER[2] - b) * a;
          m[k * 4 + 3] = 255;
        } else {
          const x = B.x0 + (i + 0.5) * cx;
          const tr = has.trees ? w.sample('trees', x, z) : Math.min(1, ht / 30);
          const gr = has.grass ? w.sample('grass', x, z) : 0;
          r += (FOREST[0] - r) * tr * 0.42; g += (FOREST[1] - g) * tr * 0.42; b += (FOREST[2] - b) * tr * 0.42;
          r += (MEADOW[0] - r) * gr * 0.22; g += (MEADOW[1] - g) * gr * 0.22; b += (MEADOW[2] - b) * gr * 0.22;
          // sumi wash on the slopes turned away from the light, and a faint layering with height
          const hx = hts[j * RW + Math.min(RW - 1, i + 1)] - hts[j * RW + Math.max(0, i - 1)];
          const hz = hts[Math.min(RH - 1, j + 1) * RW + i] - hts[Math.max(0, j - 1) * RW + i];
          const nx = -hx, ny = 2 * (cx + cz), nz = -hz;
          const shade = (nx * lx + ny * ly + nz * lz) / Math.hypot(nx, ny, nz);
          const ink = Math.max(0, Math.min(0.42, (ly - shade) * 0.9)) + Math.min(0.1, ht / 1600) + ((Math.floor(ht / 30) % 2) * 0.025);
          const lift = Math.max(0, Math.min(0.08, (shade - ly) * 0.4));
          r = r * (1 - ink) + 58 * ink + (255 - r) * lift;
          g = g * (1 - ink) + 62 * ink + (255 - g) * lift;
          b = b * (1 - ink) + 64 * ink + (255 - b) * lift;
        }
        // washi grain: soft blotches and long fibers
        const grain = (hash(i >> 2, j >> 2) - 0.5) * 5 + (hash(i, j >> 3) - 0.5) * 4;
        d[k * 4] = r + grain;
        d[k * 4 + 1] = g + grain;
        d[k * 4 + 2] = b + grain * 0.9;
        d[k * 4 + 3] = 255;
      }
      if (j % 160 === 159) await yieldFrame();
    }
    const raster = document.createElement('canvas');
    raster.width = RW;
    raster.height = RH;
    raster.getContext('2d')!.putImageData(img, 0, 0);
    const water = document.createElement('canvas');
    water.width = RW;
    water.height = RH;
    water.getContext('2d')!.putImageData(mask, 0, 0);
    this.raster = raster;
    this.water = water;
    await yieldFrame();

    const nx = Math.floor(B.w / GRID) + 1, nz = Math.floor(B.h / GRID) + 1;
    const grid = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) grid[j * nx + i] = w.heightAt(B.x0 + i * GRID, B.z0 + j * GRID);
      if (j % 120 === 119) await yieldFrame();
    }
    for (const level of [0.02, 20, 40, 60, 80, 100, 120, 140, 160]) {
      this.contours.push({ level, segs: march(grid, nx, nz, level, B) });
      await yieldFrame();
    }
    try {
      await Promise.all([
        document.fonts.load(`600 20px ${SERIF}`),
        document.fonts.load(`italic 500 16px ${SERIF}`),
        document.fonts.load(`500 12px ${SANS}`),
        document.fonts.load(`700 16px ${SEAL}`, '花川'),
      ]);
    } catch {}
  }

  // ---------------------------------------------------------------- static layers at display size

  private composeBase() {
    const Sw = Math.round(this.Dw * this.dpr), Sh = Math.round(this.Dh * this.dpr);
    const key = `${Sw}x${Sh}`;
    if (this.base && this.baseKey === key) return;
    const cv = this.base ?? document.createElement('canvas');
    cv.width = Sw;
    cv.height = Sh;
    const c = cv.getContext('2d')!;
    const B = this.B;
    const k = Sh / B.h;
    const X = (x: number) => (x - B.x0) * k, Z = (z: number) => (z - B.z0) * k;
    const P = (v: number) => v * this.dpr * Math.max(0.8, this.Dh / 900);
    c.imageSmoothingQuality = 'high';
    if (this.raster) c.drawImage(this.raster, 0, 0, Sw, Sh);
    else {
      c.fillStyle = 'rgb(239, 232, 216)';
      c.fillRect(0, 0, Sw, Sh);
    }

    // flow lines along the current, kept inside the water
    if (this.water) {
      const fl = document.createElement('canvas');
      fl.width = Sw;
      fl.height = Sh;
      const f = fl.getContext('2d')!;
      f.strokeStyle = `rgba(52, 78, 94, 0.32)`;
      f.lineWidth = P(0.8);
      f.lineCap = 'round';
      for (const frac of [-0.3, -0.12, 0.08, 0.26]) {
        let s = 6 + Math.abs(frac) * 40;
        while (s < RIVER_LENGTH - 6) {
          const len = 14 + hash(Math.round(s), Math.round(frac * 100)) * 26;
          f.beginPath();
          for (let t = s; t <= Math.min(RIVER_LENGTH, s + len); t += 3) {
            const r = riverFrame(t);
            const x = X(r.x + r.nx * r.width * frac), z = Z(r.z + r.nz * r.width * frac);
            t === s ? f.moveTo(x, z) : f.lineTo(x, z);
          }
          f.stroke();
          s += len + 10 + hash(Math.round(frac * 100), Math.round(s)) * 22;
        }
      }
      f.globalCompositeOperation = 'destination-in';
      f.drawImage(this.water, 0, 0, Sw, Sh);
      c.drawImage(fl, 0, 0);
    }

    // contours: the banks inked, the hills in faint sepia
    for (const { level, segs } of this.contours) {
      c.beginPath();
      for (let i = 0; i < segs.length; i += 4) {
        c.moveTo(X(segs[i]), Z(segs[i + 1]));
        c.lineTo(X(segs[i + 2]), Z(segs[i + 3]));
      }
      if (level < 1) {
        c.strokeStyle = `rgba(${SUMI}, 0.86)`;
        c.lineWidth = P(1.3);
      } else {
        c.strokeStyle = `rgba(92, 76, 58, ${level % 40 === 0 ? 0.2 : 0.12})`;
        c.lineWidth = P(0.7);
      }
      c.stroke();
    }

    // building footprints in ink
    c.fillStyle = `rgba(${SUMI}, 0.72)`;
    for (const s of SITES) {
      c.save();
      c.translate(X(s.x), Z(s.z));
      c.rotate((-s.yawDeg * Math.PI) / 180);
      c.fillRect(-s.hx * k, -s.hz * k, s.hx * 2 * k, s.hz * 2 * k);
      c.restore();
    }

    // the village: a cluster of roofs on the left bank and its name
    const village = LANDMARKS.find((l) => l.id === 'village');
    if (village) {
      for (let i = 0; i < 9; i++) {
        const s = village.s - 90 + i * 22 + (hash(i, 3) - 0.5) * 10;
        const p = bankPoint(s, village.side as -1 | 1, 12 + hash(i, 7) * 26);
        roof(c, X(p.x), Z(p.z), P(4.2), `rgba(${SUMI}, 0.7)`);
      }
      const lp = bankPoint(village.s, village.side as -1 | 1, 95);
      c.fillStyle = `rgba(${SUMI}, 0.88)`;
      c.font = `600 ${P(17)}px ${SERIF}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      (c as any).letterSpacing = `${P(4)}px`;
      haloText(c, 'HANAKAWA', X(lp.x), Z(lp.z), P(3));
      (c as any).letterSpacing = '0px';
    }

    // bridges, each in its own hand
    for (const b of BRIDGES) drawBridge(c, b, X, Z, k, P);

    // landings: a timber bar along the bank and the name set on the land side
    for (const d of DOCKS) {
      const f = riverFrame(d.s);
      const x = X(d.moorX), z = Z(d.moorZ);
      c.save();
      c.translate(x, z);
      c.rotate(Math.atan2(f.tz, f.tx));
      c.fillStyle = `rgba(${SUMI}, 0.9)`;
      c.fillRect(-P(7), -P(1.6), P(14), P(3.2));
      c.restore();
      const lp = bankPoint(d.s, d.side, 26);
      c.font = `600 ${P(13)}px ${SERIF}`;
      c.textAlign = X(lp.x) > x ? 'left' : 'right';
      c.textBaseline = 'middle';
      c.fillStyle = `rgba(${SUMI}, 0.92)`;
      haloText(c, d.name, X(lp.x), Z(lp.z), P(3));
    }

    // title mark: vermilion seal, name and scale, top left
    const tx = P(30), ty = P(34);
    seal(c, tx, ty, P(40));
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.fillStyle = `rgba(${SUMI}, 0.92)`;
    c.font = `600 ${P(24)}px ${SERIF}`;
    (c as any).letterSpacing = `${P(5)}px`;
    haloText(c, 'HANAKAWA', tx + P(52), ty + P(19), P(4));
    (c as any).letterSpacing = '0px';
    c.font = `italic 500 ${P(15)}px ${SERIF}`;
    haloText(c, 'The river valley', tx + P(53), ty + P(38), P(4));
    scaleBar(c, tx, ty + P(66), k, P);

    northArrow(c, Sw - P(34), Sh - P(58), P);
    frame(c, Sw, Sh, P);
    this.base = cv;
    this.baseKey = key;
  }

  private layout() {
    const W = innerWidth, H = innerHeight;
    const logW = W < 760 ? 0 : W < 1100 ? 260 + 16 : 300 + 22;
    const aspect = this.B.w / this.B.h;
    this.Dh = Math.max(320, Math.floor(Math.min(H - 64, (W - logW - 64) / aspect, 1000)));
    this.Dw = Math.round(this.Dh * aspect);
    this.dpr = Math.min(2, devicePixelRatio || 1);
    const Sw = Math.round(this.Dw * this.dpr), Sh = Math.round(this.Dh * this.dpr);
    if (this.canvas.width !== Sw || this.canvas.height !== Sh) {
      this.canvas.width = Sw;
      this.canvas.height = Sh;
      this.canvas.style.width = `${this.Dw}px`;
      this.canvas.style.height = `${this.Dh}px`;
    }
    (this.el.querySelector('.chart-log') as HTMLElement).style.height = `${this.Dh}px`;
  }

  async open(game: GameService | undefined) {
    this.isOpen = true;
    this.el.hidden = false;
    this.layout();
    this.renderLog(game, true);
    requestAnimationFrame(() => this.el.setAttribute('data-open', 'true'));
    this.closeBtn.focus({ preventScroll: true });
    await this.prebuild();
    if (!this.isOpen) return;
    this.composeBase();
  }

  close() {
    this.isOpen = false;
    this.el.setAttribute('data-open', 'false');
    setTimeout(() => { if (!this.isOpen) this.el.hidden = true; }, reducedMotion() ? 0 : 220);
  }

  resize() {
    if (!this.isOpen) return;
    this.layout();
    if (this.raster) this.composeBase();
  }

  // ---------------------------------------------------------------- log

  private renderLog(game: GameService | undefined, force = false) {
    if (!game) return;
    const key = game.objectives.map((o) => `${o.id}:${o.status}:${o.progress?.done}`).join() + `|${game.tracked?.id}|${game.pois.filter((p) => p.discovered).length}|${game.cargo?.label}`;
    if (!force && key === this.lastLog) return;
    this.lastLog = key;
    const focusId = (document.activeElement as HTMLElement | null)?.dataset?.track;
    this.logList.replaceChildren(...game.objectives.map((o) => this.logItem(o, game.tracked?.id === o.id)));
    const found = game.pois.filter((p) => p.discovered);
    this.logFoot.replaceChildren(
      h('div', {}, 'Found ', h('b', { text: `${found.length} of ${game.pois.length}` }), ' places'),
      h('div', { text: game.cargo ? `Aboard: ${game.cargo.label.toLowerCase()} for ${game.cargo.to}.` : 'Undiscovered places show as dotted rings.' }),
    );
    if (focusId) (this.logList.querySelector(`[data-track="${focusId}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
  }

  private logItem(o: ObjectiveView, tracked: boolean) {
    const meta: (Node | string)[] = [];
    if (o.status === 'locked') meta.push(`After ${o.lockedBy}.`);
    else if (o.status === 'done') meta.push(o.reward ? `Complete. ${o.reward.name} unlocked.` : 'Complete.');
    else {
      meta.push(o.summary);
      if (o.progress && o.progress.total > 1) meta.push(' ', h('b', { text: `${o.progress.done} / ${o.progress.total}` }));
      if (o.reward) meta.push(h('br'), `Reward: ${o.reward.name}`);
    }
    const canTrack = (o.status === 'available' || o.status === 'active') && !tracked;
    const btn = canTrack ? h('button', { class: 'btn log-course', type: 'button', 'data-track': o.id, text: 'Set course' }) : null;
    btn?.addEventListener('click', () => this.onTrack(o.id));
    return h('li', { class: 'log-item', 'data-status': o.status, 'data-tracked': tracked ? 'true' : 'false' },
      h('i', { class: 'log-dot', 'aria-hidden': 'true' }),
      h('div', {},
        h('div', { class: 'log-name' }, o.title, tracked ? h('span', { class: 'sr-only', text: ' (current course)' }) : null),
        h('div', { class: 'log-meta' }, ...meta),
        btn,
      ),
    );
  }

  // ---------------------------------------------------------------- live layer

  render(game: GameService | undefined) {
    if (!this.isOpen) return;
    this.renderLog(game);
    const c = this.g, Sw = this.canvas.width, Sh = this.canvas.height;
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (this.base) c.drawImage(this.base, 0, 0);
    else {
      c.fillStyle = 'rgb(239, 232, 216)';
      c.fillRect(0, 0, Sw, Sh);
      c.fillStyle = `rgba(${SUMI}, 0.6)`;
      c.font = `italic 500 ${Math.round(18 * this.dpr)}px ${SERIF}`;
      c.textAlign = 'center';
      c.fillText('Drawing the river', Sw / 2, Sh / 2);
      return;
    }
    if (!game) return;
    const B = this.B;
    const k = Sh / B.h;
    const X = (x: number) => (x - B.x0) * k, Z = (z: number) => (z - B.z0) * k;
    const P = (v: number) => v * this.dpr * Math.max(0.85, this.Dh / 900);
    const t = this.ctx.time.real;

    // lantern run: pairs of small lanterns, passed ones faded
    for (const r of game.routes) {
      r.gates.forEach((g, i) => {
        c.globalAlpha = i < r.next ? 0.35 : 1;
        const sx = -g.dz * g.half, sz = g.dx * g.half;
        for (const sgn of [-1, 1]) {
          c.beginPath();
          c.arc(X(g.x + sx * sgn), Z(g.z + sz * sgn), P(2.4), 0, Math.PI * 2);
          c.fillStyle = '#e39a4a';
          c.fill();
          c.strokeStyle = `rgba(${SUMI}, 0.7)`;
          c.lineWidth = P(0.8);
          c.stroke();
        }
      });
      c.globalAlpha = 1;
    }

    // landmarks: found ones as ink glyphs with names, the rest as dotted rings
    c.textBaseline = 'middle';
    for (const p of game.pois) {
      if (p.kind === 'bridge') continue;
      const x = X(p.x), z = Z(p.z);
      if (!p.discovered) {
        c.beginPath();
        c.arc(x, z, P(9), 0, Math.PI * 2);
        c.setLineDash([P(1.5), P(2.5)]);
        c.strokeStyle = `rgba(${SUMI}, 0.5)`;
        c.lineWidth = P(1);
        c.stroke();
        c.setLineDash([]);
        continue;
      }
      glyph(c, p.kind, x, z, P);
      const water = ['waterfall', 'falls', 'gorge', 'torii', 'weir'].includes(p.kind);
      const lm = LANDMARKS.find((l) => l.id === p.id);
      // names go to the outside of the river so they do not sit on the water
      const right = lm ? (lm.side === 0 ? (riverFrame(lm.s).nx >= 0 ? 1 : -1) : lm.side * (riverFrame(lm.s).nx >= 0 ? 1 : -1)) : 1;
      c.font = water ? `italic 500 ${P(15)}px ${SERIF}` : `600 ${P(13.5)}px ${SERIF}`;
      c.textAlign = right > 0 ? 'left' : 'right';
      c.fillStyle = `rgba(${SUMI}, 0.94)`;
      haloText(c, p.name, x + right * P(12), z, P(3));
    }

    const b = this.ctx.boat;
    const tg = game.target;
    if (tg && b) {
      c.beginPath();
      c.moveTo(X(b.position.x), Z(b.position.z));
      c.lineTo(X(tg.x), Z(tg.z));
      c.strokeStyle = 'rgba(195, 67, 42, 0.7)';
      c.lineWidth = P(1.3);
      c.setLineDash([P(4), P(4)]);
      c.stroke();
      c.setLineDash([]);
      const x = X(tg.x), z = Z(tg.z);
      const pulse = reducedMotion() ? 0.5 : (t * 0.8) % 1;
      c.beginPath();
      c.arc(x, z, P(7 + pulse * 9), 0, Math.PI * 2);
      c.strokeStyle = `rgba(195, 67, 42, ${0.65 * (1 - pulse)})`;
      c.lineWidth = P(1.3);
      c.stroke();
      c.save();
      c.translate(x, z);
      c.rotate(Math.PI / 4);
      c.fillStyle = VERMILION;
      c.strokeStyle = 'rgba(246, 239, 226, 0.95)';
      c.lineWidth = P(1.4);
      c.fillRect(-P(4.5), -P(4.5), P(9), P(9));
      c.strokeRect(-P(4.5), -P(4.5), P(9), P(9));
      c.restore();
    }

    if (b) {
      // the boat: a long narrow hull in sumi with a paper halo
      _f.set(0, 0, -1).applyQuaternion(b.quaternion);
      const hd = (forwardToHeading(_f.x, _f.z) * Math.PI) / 180;
      c.save();
      c.translate(X(b.position.x), Z(b.position.z));
      c.rotate(hd);
      c.beginPath();
      c.moveTo(0, -P(12));
      c.quadraticCurveTo(P(5), -P(4), P(4), P(8));
      c.lineTo(-P(4), P(8));
      c.quadraticCurveTo(-P(5), -P(4), 0, -P(12));
      c.closePath();
      c.lineJoin = 'round';
      c.strokeStyle = 'rgba(248, 243, 232, 0.95)';
      c.lineWidth = P(3);
      c.stroke();
      c.fillStyle = `rgb(${SUMI})`;
      c.fill();
      c.restore();
    }
  }
}

const _f = new Vector3();

function haloText(c: CanvasRenderingContext2D, text: string, x: number, y: number, halo: number) {
  const fill = c.fillStyle;
  c.lineJoin = 'round';
  c.strokeStyle = 'rgba(241, 235, 220, 0.88)';
  c.lineWidth = halo;
  c.strokeText(text, x, y);
  c.fillStyle = fill;
  c.fillText(text, x, y);
}

/** vermilion hakubun seal with the name knocked out in paper */
function seal(c: CanvasRenderingContext2D, x: number, y: number, s: number) {
  c.save();
  c.fillStyle = VERMILION;
  c.beginPath();
  (c as any).roundRect ? (c as any).roundRect(x, y, s, s, s * 0.08) : c.rect(x, y, s, s);
  c.fill();
  c.strokeStyle = 'rgba(246, 239, 226, 0.85)';
  c.lineWidth = s * 0.035;
  c.strokeRect(x + s * 0.09, y + s * 0.09, s * 0.82, s * 0.82);
  c.fillStyle = 'rgba(246, 239, 226, 0.95)';
  c.font = `700 ${s * 0.34}px ${SEAL}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('花', x + s / 2, y + s * 0.3);
  c.fillText('川', x + s / 2, y + s * 0.7);
  c.restore();
}

function roof(c: CanvasRenderingContext2D, x: number, y: number, s: number, ink: string) {
  c.fillStyle = ink;
  c.beginPath();
  c.moveTo(x - s, y + s * 0.2);
  c.lineTo(x - s * 0.55, y - s * 0.45);
  c.lineTo(x + s * 0.55, y - s * 0.45);
  c.lineTo(x + s, y + s * 0.2);
  c.closePath();
  c.fill();
  c.fillRect(x - s * 0.6, y + s * 0.2, s * 1.2, s * 0.5);
}

/** small ink glyphs for the landmark kinds */
function glyph(c: CanvasRenderingContext2D, kind: string, x: number, y: number, P: (v: number) => number) {
  const ink = `rgba(${SUMI}, 0.92)`;
  c.save();
  c.translate(x, y);
  c.strokeStyle = ink;
  c.fillStyle = ink;
  c.lineWidth = P(1.3);
  c.lineCap = 'round';
  const s = P(6);
  switch (kind) {
    case 'shrine':
    case 'torii': {
      // torii: two posts, a lintel with upturned ends, a tie beam. the water gate is vermilion
      c.strokeStyle = kind === 'torii' ? VERMILION : ink;
      c.lineWidth = P(1.6);
      c.beginPath();
      c.moveTo(-s * 0.6, s); c.lineTo(-s * 0.5, -s * 0.55);
      c.moveTo(s * 0.6, s); c.lineTo(s * 0.5, -s * 0.55);
      c.moveTo(-s * 1.05, -s * 0.95); c.quadraticCurveTo(0, -s * 0.72, s * 1.05, -s * 0.95);
      c.moveTo(-s * 0.75, -s * 0.35); c.lineTo(s * 0.75, -s * 0.35);
      c.stroke();
      break;
    }
    case 'pagoda': {
      for (let i = 0; i < 5; i++) {
        const w = s * (1.1 - i * 0.16), yy = s * (0.9 - i * 0.42);
        c.beginPath();
        c.moveTo(-w, yy); c.quadraticCurveTo(0, yy - s * 0.18, w, yy);
        c.stroke();
      }
      c.beginPath();
      c.moveTo(0, -s * 1.1); c.lineTo(0, -s * 1.7);
      c.stroke();
      break;
    }
    case 'teahouse':
    case 'village':
      roof(c, 0, 0, s * 0.9, ink);
      break;
    case 'mill': {
      c.beginPath();
      c.arc(0, 0, s * 0.85, 0, Math.PI * 2);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        c.moveTo(0, 0);
        c.lineTo(Math.cos(a) * s * 0.85, Math.sin(a) * s * 0.85);
      }
      c.stroke();
      break;
    }
    case 'waterfall':
    case 'falls': {
      for (const dx of [-0.5, 0, 0.5]) {
        c.beginPath();
        c.moveTo(dx * s, -s);
        c.bezierCurveTo(dx * s + s * 0.25, -s * 0.3, dx * s - s * 0.25, s * 0.3, dx * s, s);
        c.stroke();
      }
      break;
    }
    case 'weir': {
      c.lineWidth = P(2);
      c.beginPath();
      c.moveTo(-s * 1.2, 0); c.lineTo(s * 1.2, 0);
      c.stroke();
      c.lineWidth = P(0.8);
      for (let i = -3; i <= 3; i++) { c.beginPath(); c.moveTo(i * s * 0.35, 0); c.lineTo(i * s * 0.35 - s * 0.2, s * 0.5); c.stroke(); }
      break;
    }
    default: {
      c.beginPath();
      c.arc(0, 0, s * 0.45, 0, Math.PI * 2);
      c.fill();
    }
  }
  c.restore();
}

/** a bridge across the river at its along-river position, drawn by type */
function drawBridge(c: CanvasRenderingContext2D, b: Bridge, X: (x: number) => number, Z: (z: number) => number, k: number, P: (v: number) => number) {
  const f = riverFrame(b.s);
  const half = f.width / 2 + 7;
  const ax = X(f.x - f.nx * half), az = Z(f.z - f.nz * half);
  const bx = X(f.x + f.nx * half), bz = Z(f.z + f.nz * half);
  // the arch bows a little upstream, as a hand-drawn bridge would
  const mx = X(f.x + f.tx * 3), mz = Z(f.z + f.tz * 3);
  c.save();
  c.lineCap = 'round';
  if (b.type === 'red-arch') {
    c.strokeStyle = VERMILION;
    c.lineWidth = Math.max(P(3), b.deckWidth * k);
    c.beginPath(); c.moveTo(ax, az); c.quadraticCurveTo(mx, mz, bx, bz); c.stroke();
  } else if (b.type === 'stone-arch') {
    const ox = f.tx * 2, oz = f.tz * 2;
    c.strokeStyle = `rgba(${SUMI}, 0.85)`;
    c.lineWidth = P(1.2);
    for (const sg of [-1, 1]) {
      c.beginPath();
      c.moveTo(ax + X(ox * sg) - X(0), az + Z(oz * sg) - Z(0));
      c.lineTo(bx + X(ox * sg) - X(0), bz + Z(oz * sg) - Z(0));
      c.stroke();
    }
  } else if (b.type === 'covered') {
    c.strokeStyle = `rgba(${SUMI}, 0.9)`;
    c.lineWidth = Math.max(P(4), b.deckWidth * k);
    c.beginPath(); c.moveTo(ax, az); c.lineTo(bx, bz); c.stroke();
    c.strokeStyle = 'rgba(241, 235, 220, 0.8)';
    c.lineWidth = P(0.8);
    c.setLineDash([P(2), P(2.5)]);
    c.beginPath(); c.moveTo(ax, az); c.lineTo(bx, bz); c.stroke();
    c.setLineDash([]);
  } else {
    c.strokeStyle = `rgba(${SUMI}, 0.8)`;
    c.lineWidth = P(1.2);
    c.beginPath(); c.moveTo(ax, az); c.lineTo(bx, bz); c.stroke();
  }
  // name beside the right-hand end, in small roman capitals
  const right = bx >= ax;
  const ex = right ? bx : ax, ez = right ? bz : az;
  c.font = `600 ${P(10.5)}px ${SERIF}`;
  (c as any).letterSpacing = `${P(1.2)}px`;
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.fillStyle = b.type === 'red-arch' ? VERMILION : `rgba(${SUMI}, 0.85)`;
  haloText(c, b.name.toUpperCase(), ex + P(6), ez, P(3));
  (c as any).letterSpacing = '0px';
  c.restore();
}

function scaleBar(c: CanvasRenderingContext2D, x: number, y: number, k: number, P: (v: number) => number) {
  const seg = 100 * k;
  c.strokeStyle = `rgba(${SUMI}, 0.85)`;
  c.lineWidth = P(1);
  c.beginPath();
  c.moveTo(x, y); c.lineTo(x + seg * 2, y);
  for (let i = 0; i <= 2; i++) { c.moveTo(x + seg * i, y - P(3)); c.lineTo(x + seg * i, y + P(3)); }
  c.stroke();
  c.fillStyle = `rgba(${SUMI}, 0.8)`;
  c.font = `500 ${P(9.5)}px ${SANS}`;
  c.textAlign = 'center';
  c.textBaseline = 'top';
  for (let i = 0; i <= 2; i++) c.fillText(i === 2 ? '200 m' : String(i * 100), x + seg * i, y + P(6));
}

function northArrow(c: CanvasRenderingContext2D, x: number, y: number, P: (v: number) => number) {
  c.save();
  c.strokeStyle = `rgba(${SUMI}, 0.85)`;
  c.fillStyle = `rgba(${SUMI}, 0.85)`;
  c.lineWidth = P(1);
  c.beginPath();
  c.moveTo(x, y + P(22)); c.lineTo(x, y - P(4));
  c.stroke();
  c.beginPath();
  c.moveTo(x, y - P(10)); c.lineTo(x + P(4), y); c.lineTo(x, y - P(3)); c.lineTo(x - P(4), y);
  c.closePath();
  c.fill();
  c.font = `600 ${P(14)}px ${SERIF}`;
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  c.fillText('N', x, y - P(14));
  c.restore();
}

function frame(c: CanvasRenderingContext2D, Sw: number, Sh: number, P: (v: number) => number) {
  const o = P(9);
  c.fillStyle = 'rgba(238, 231, 214, 0.92)';
  c.fillRect(0, 0, Sw, o);
  c.fillRect(0, Sh - o, Sw, o);
  c.fillRect(0, 0, o, Sh);
  c.fillRect(Sw - o, 0, o, Sh);
  c.strokeStyle = `rgba(${SUMI}, 0.8)`;
  c.lineWidth = P(1.2);
  c.strokeRect(o, o, Sw - 2 * o, Sh - 2 * o);
  c.lineWidth = P(0.5);
  c.strokeRect(o + P(3), o + P(3), Sw - 2 * (o + P(3)), Sh - 2 * (o + P(3)));
}

/** marching squares over a height grid (world-space segments, x/z pairs) */
function march(grid: Float32Array, nx: number, nz: number, level: number, B: Bounds): Seg {
  const out: number[] = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = grid[j * nx + i], b = grid[j * nx + i + 1], c = grid[(j + 1) * nx + i + 1], d = grid[(j + 1) * nx + i];
      const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const x0 = B.x0 + i * GRID, z0 = B.z0 + j * GRID, s = GRID;
      const top = () => [x0 + s * ((level - a) / (b - a)), z0];
      const right = () => [x0 + s, z0 + s * ((level - b) / (c - b))];
      const bottom = () => [x0 + s * ((level - d) / (c - d)), z0 + s];
      const left = () => [x0, z0 + s * ((level - a) / (d - a))];
      const seg = (p: number[], q: number[]) => out.push(p[0], p[1], q[0], q[1]);
      switch (idx) {
        case 1: case 14: seg(left(), bottom()); break;
        case 2: case 13: seg(bottom(), right()); break;
        case 3: case 12: seg(left(), right()); break;
        case 4: case 11: seg(top(), right()); break;
        case 5: seg(left(), top()); seg(bottom(), right()); break;
        case 6: case 9: seg(top(), bottom()); break;
        case 7: case 8: seg(left(), top()); break;
        case 10: seg(left(), bottom()); seg(top(), right()); break;
      }
    }
  }
  return new Float32Array(out);
}
