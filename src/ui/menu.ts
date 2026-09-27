// pause menu (Esc): a left-anchored sheet so the paused scene stays visible. settings, boat paint,
// controls and a guarded new game. settings changes go through 'settings:change' (core persists).
import type { GameContext } from '../core/context';
import type { QualityName, Settings } from '../core/settings';
import type { GameService } from '../game/types';
import { h, kbd, reducedMotion } from './dom';

type Panel = 'settings' | 'paint' | 'controls' | 'voyage';

const TABS: [Panel, string][] = [
  ['settings', 'Settings'],
  ['paint', 'Boat finish'],
  ['controls', 'Controls'],
  ['voyage', 'New game'],
];

const CONTROLS: [string[], string][] = [
  [['W'], 'Throttle ahead'],
  [['S'], 'Throttle astern, slows you progressively'],
  [['A', 'D'], 'Steer to port or starboard'],
  [['Mouse'], 'Look around (click the view to capture the mouse, or drag)'],
  [['C'], 'Camera: follow, helm, photo'],
  [['E'], 'Dock alongside or cast off'],
  [['M'], 'River map and log'],
  [['R'], 'Reset if you run aground'],
  [['Esc'], 'Pause'],
  [['Space', 'Q'], 'Photo camera up and down, Shift for speed'],
];

let uid = 0;

export class Menu {
  readonly el: HTMLElement;
  private tabs = new Map<Panel, HTMLButtonElement>();
  private panels = new Map<Panel, HTMLElement>();
  private resumeBtn: HTMLButtonElement;
  private paintList: HTMLElement;
  private voyage: HTMLElement;
  private current: Panel = 'settings';
  private inputs: { sync(): void }[] = [];
  isOpen = false;

  constructor(private ctx: GameContext, root: HTMLElement, private game: () => GameService | undefined, private onResume: () => void, private onNewGame: () => void) {
    this.resumeBtn = h('button', { class: 'btn btn-primary menu-resume', type: 'button', text: 'Resume' });
    this.resumeBtn.addEventListener('click', () => this.onResume());
    const tabList = h('div', { class: 'menu-tabs', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Menu sections' });
    for (const [id, label] of TABS) {
      const b = h('button', { class: 'menu-tab', type: 'button', role: 'tab', id: `tab-${id}`, 'aria-controls': `panel-${id}`, 'aria-selected': 'false', tabindex: '-1', text: label });
      b.addEventListener('click', () => this.select(id, true));
      b.addEventListener('keydown', (e) => this.tabKeys(e, id));
      this.tabs.set(id, b);
      tabList.append(b);
    }
    this.paintList = h('div', { class: 'paints', role: 'radiogroup', 'aria-label': 'Boat finish' });
    this.voyage = h('div');
    this.panels.set('settings', this.settingsPanel());
    this.panels.set('paint', this.panel('paint', 'Boat finish', 'New finishes are earned along the river. The boat changes the moment you choose.', this.paintList));
    this.panels.set('controls', this.controlsPanel());
    this.panels.set('voyage', this.panel('voyage', 'New game', 'Start again from the village landing with the lessons ahead of you.', this.voyage));
    this.el = h('div', { class: 'overlay menu', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'menu-title', hidden: true, 'data-open': 'false' },
      h('div', { class: 'menu-sheet' },
        h('nav', { class: 'menu-nav', 'aria-label': 'Pause menu' },
          h('p', { class: 'menu-eyebrow', text: 'Paused' }),
          h('h2', { class: 'menu-title', id: 'menu-title' }, 'Hanakawa', h('span', { class: 'seal', 'aria-hidden': 'true', text: '花川' })),
          this.resumeBtn,
          tabList,
          h('p', { class: 'menu-foot', text: 'Progress saves at every landing and every completed objective.' }),
        ),
        ...this.panels.values(),
      ),
    );
    // keys inside the menu stay here, so arrows move sliders and space presses buttons instead of
    // steering the boat. escape still reaches the game to close the menu.
    this.el.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') return;
      e.stopPropagation();
      if (e.code === 'Tab') this.trap(e);
    });
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) this.onResume(); });
    root.append(this.el);
  }

  open() {
    this.isOpen = true;
    this.el.hidden = false;
    for (const i of this.inputs) i.sync();
    this.renderPaints();
    this.renderVoyage(false);
    this.select(this.current, false);
    requestAnimationFrame(() => this.el.setAttribute('data-open', 'true'));
    this.resumeBtn.focus({ preventScroll: true });
  }

  close() {
    this.isOpen = false;
    this.el.setAttribute('data-open', 'false');
    setTimeout(() => { if (!this.isOpen) this.el.hidden = true; }, reducedMotion() ? 0 : 240);
  }

  private trap(e: KeyboardEvent) {
    const f = [...this.el.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]')].filter((x) => !x.closest('[hidden]') && !(x as HTMLInputElement).disabled && x.tabIndex >= 0);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  private tabKeys(e: KeyboardEvent, id: Panel) {
    const order = TABS.map((t) => t[0]);
    const i = order.indexOf(id);
    let next: Panel | null = null;
    if (e.code === 'ArrowDown') next = order[(i + 1) % order.length];
    else if (e.code === 'ArrowUp') next = order[(i - 1 + order.length) % order.length];
    else if (e.code === 'Home') next = order[0];
    else if (e.code === 'End') next = order[order.length - 1];
    if (next) {
      e.preventDefault();
      this.select(next, true);
    }
  }

  private select(id: Panel, focus: boolean) {
    this.current = id;
    for (const [pid, b] of this.tabs) {
      const on = pid === id;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      this.panels.get(pid)!.hidden = !on;
    }
    if (id === 'paint') this.renderPaints();
    if (id === 'voyage') this.renderVoyage(false);
    if (focus) this.tabs.get(id)!.focus({ preventScroll: true });
  }

  private panel(id: Panel, title: string, lede: string, ...body: Node[]) {
    return h('section', { class: 'menu-panel', id: `panel-${id}`, role: 'tabpanel', 'aria-labelledby': `tab-${id}`, hidden: true },
      h('h3', { class: 'panel-title', text: title }),
      h('p', { class: 'panel-lede', text: lede }),
      ...body,
    );
  }

  private set(patch: Partial<Settings>) {
    this.ctx.events.emit('settings:change', patch);
  }

  // ---------------------------------------------------------------- settings

  private slider(label: string, key: keyof Settings, min: number, max: number, step: number, fmt: (v: number) => string) {
    const id = `set-${++uid}`;
    const out = h('output', { class: 'row-value', for: id });
    const input = h('input', { class: 'slider', type: 'range', id, min, max, step });
    const paint = () => {
      const v = Number(input.value);
      out.textContent = fmt(v);
      input.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
    };
    input.addEventListener('input', () => {
      paint();
      this.set({ [key]: Number(input.value) } as Partial<Settings>);
    });
    this.inputs.push({ sync: () => { input.value = String(this.ctx.settings[key]); paint(); } });
    return h('div', { class: 'row' }, h('label', { class: 'row-label', for: id, text: label }), out, h('div', { class: 'row-slider' }, input));
  }

  private toggle(label: string, key: 'invertY' | 'showMarker' | 'timeLapse') {
    const id = `set-${++uid}`;
    const input = h('input', { class: 'switch', type: 'checkbox', role: 'switch', id });
    input.addEventListener('change', () => this.set({ [key]: input.checked } as Partial<Settings>));
    this.inputs.push({ sync: () => { input.checked = !!this.ctx.settings[key]; } });
    return h('div', { class: 'row' }, h('label', { class: 'row-label', for: id, text: label }), input);
  }

  private segmented<T extends string>(label: string, key: 'quality' | 'units', options: [T, string][]) {
    const name = `seg-${++uid}`;
    const labelId = `${name}-label`;
    const radios = options.map(([value, text]) => {
      const input = h('input', { type: 'radio', name, value });
      input.addEventListener('change', () => { if (input.checked) this.set({ [key]: value } as Partial<Settings>); });
      return { input, el: h('label', {}, input, text) };
    });
    this.inputs.push({ sync: () => { for (const r of radios) r.input.checked = r.input.value === this.ctx.settings[key]; } });
    return h('div', { class: 'row' },
      h('span', { class: 'row-label', id: labelId, text: label }),
      h('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': labelId }, ...radios.map((r) => r.el)),
    );
  }

  private settingsPanel() {
    const pct = (v: number) => `${Math.round(v * 100)}`;
    const webgl = this.ctx.backend === 'webgl2';
    const note = webgl
      ? 'Running on the WebGL2 fallback: every preset is reduced (no screen-space GI, smaller reflections and shadows).'
      : 'Balanced targets 60 fps at 1080p. High adds screen-space GI and larger reflections. The WebGL2 fallback always runs a reduced preset.';
    return this.panel('settings', 'Settings', 'Changes apply immediately and are remembered on this device.',
      h('fieldset', { class: 'group' },
        h('legend', { class: 'group-title', text: 'Sound' }),
        this.slider('Master volume', 'masterVolume', 0, 1, 0.01, pct),
        this.slider('Engine', 'engineVolume', 0, 1, 0.01, pct),
        this.slider('River and birds', 'ambienceVolume', 0, 1, 0.01, pct),
        this.slider('Interface', 'uiVolume', 0, 1, 0.01, pct),
      ),
      h('fieldset', { class: 'group' },
        h('legend', { class: 'group-title', text: 'Graphics' }),
        this.segmented<QualityName>('Quality', 'quality', [['low', 'Low'], ['balanced', 'Balanced'], ['high', 'High']]),
        h('p', { class: 'note', text: note }),
      ),
      h('fieldset', { class: 'group' },
        h('legend', { class: 'group-title', text: 'World' }),
        this.toggle('Time-lapse: a full day every 20 seconds', 'timeLapse'),
        h('p', { class: 'note', text: 'Runs through dawn, clouds, rain, a thunderstorm and a starry night on repeat. Off keeps the clear spring morning.' }),
      ),
      h('fieldset', { class: 'group' },
        h('legend', { class: 'group-title', text: 'Camera' }),
        this.slider('Mouse sensitivity', 'mouseSensitivity', 0.2, 2.5, 0.05, (v) => `${v.toFixed(2)}×`),
        this.toggle('Invert vertical look', 'invertY'),
      ),
      h('fieldset', { class: 'group' },
        h('legend', { class: 'group-title', text: 'Interface' }),
        this.toggle('Destination marker', 'showMarker'),
        this.segmented<'knots' | 'kmh'>('Speed units', 'units', [['knots', 'Knots'], ['kmh', 'km/h']]),
      ),
    );
  }

  private controlsPanel() {
    return this.panel('controls', 'Controls', 'The boat glides on when you ease off; reverse slows her gradually.',
      h('dl', { class: 'keys' }, ...CONTROLS.flatMap(([keys, text]) => [h('dt', {}, ...kbd(...keys)), h('dd', { text })])),
    );
  }

  // ---------------------------------------------------------------- paint

  private renderPaints() {
    const g = this.game();
    if (!g) {
      this.paintList.replaceChildren(h('p', { class: 'note', text: 'Finishes appear once the boat has loaded.' }));
      return;
    }
    g.refreshPaints();
    const name = `paint-${++uid}`;
    this.paintList.replaceChildren(...g.paints.map((p) => {
      const input = h('input', { type: 'radio', name, value: p.id, disabled: !p.unlocked, 'aria-describedby': `${name}-${p.id}` });
      input.checked = g.paint === p.id;
      input.addEventListener('change', () => { if (input.checked) g.selectPaint(p.id); });
      const swatch = h('span', { class: 'swatch', 'aria-hidden': 'true' });
      swatch.style.setProperty('--hull', p.swatch);
      swatch.style.setProperty('--trim', p.trim);
      return h('label', { class: 'paint' },
        input,
        swatch,
        h('span', { class: 'paint-name', text: p.name }),
        h('span', { class: 'paint-note', id: `${name}-${p.id}`, text: p.unlocked ? (g.paint === p.id ? 'On the boat now' : '') : p.unlockText ?? 'Locked' }),
      );
    }));
    this.paintList.querySelectorAll<HTMLInputElement>('input').forEach((inp) => inp.addEventListener('change', () => this.renderPaintNotes()));
  }

  private renderPaintNotes() {
    const g = this.game();
    if (!g) return;
    this.paintList.querySelectorAll<HTMLElement>('.paint').forEach((row, i) => {
      const p = g.paints[i];
      const note = row.querySelector('.paint-note');
      if (note && p.unlocked) note.textContent = g.paint === p.id ? 'On the boat now' : '';
    });
  }

  // ---------------------------------------------------------------- new game

  private renderVoyage(confirming: boolean) {
    if (!confirming) {
      const start = h('button', { class: 'btn', type: 'button', text: 'Start a new journey' });
      start.addEventListener('click', () => this.renderVoyage(true));
      this.voyage.replaceChildren(start);
      return;
    }
    const keep = h('button', { class: 'btn btn-quiet', type: 'button', text: 'Keep cruising' });
    const go = h('button', { class: 'btn btn-primary', type: 'button', text: 'Start over' });
    keep.addEventListener('click', () => this.renderVoyage(false));
    go.addEventListener('click', () => this.onNewGame());
    this.voyage.replaceChildren(h('div', { class: 'confirm', role: 'alertdialog', 'aria-labelledby': 'confirm-text' },
      h('p', { id: 'confirm-text', text: 'This clears your progress, cargo and discoveries. Your settings are kept.' }),
      h('div', { class: 'confirm-actions' }, keep, go),
    ));
    keep.focus({ preventScroll: true });
  }
}
