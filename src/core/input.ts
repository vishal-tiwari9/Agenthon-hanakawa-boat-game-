// keyboard + mouse state. actions are polled each frame; edge-triggered presses are also
// emitted on the bus as 'input:<action>' so ui and gameplay can react without polling.
import type { EventBus } from './events';

export type Action =
  | 'forward' | 'reverse' | 'left' | 'right'
  | 'camera' | 'interact' | 'chart' | 'pause' | 'reset'
  | 'photoUp' | 'photoDown' | 'photoFast';

const BINDINGS: Record<string, Action> = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'reverse', ArrowDown: 'reverse',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  KeyC: 'camera',
  KeyE: 'interact',
  KeyM: 'chart',
  Escape: 'pause',
  KeyR: 'reset',
  Space: 'photoUp',
  KeyQ: 'photoDown',
  ShiftLeft: 'photoFast', ShiftRight: 'photoFast',
};

export class Input {
  private down = new Set<Action>();
  private pressedThisFrame = new Set<Action>();
  /** accumulated mouse delta since last consume, in pixels */
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  dragging = false;
  pointerLocked = false;
  /** when false (menus open) gameplay actions read as released */
  gameplayEnabled = true;

  constructor(private canvas: HTMLCanvasElement, private events: EventBus) {
    window.addEventListener('keydown', (e) => {
      const a = BINDINGS[e.code];
      if (!a) return;
      if (a !== 'pause') e.preventDefault();
      if (e.repeat) return;
      this.down.add(a);
      this.pressedThisFrame.add(a);
      events.emit('input:' + a);
    });
    window.addEventListener('keyup', (e) => {
      const a = BINDINGS[e.code];
      if (a) this.down.delete(a);
    });
    window.addEventListener('blur', () => this.down.clear());
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 0 || e.button === 2) {
        this.dragging = true;
        canvas.setPointerCapture?.(e.pointerId);
      }
      events.emit('input:pointerdown', e);
    });
    window.addEventListener('pointerup', () => (this.dragging = false));
    window.addEventListener('pointermove', (e) => {
      if (this.pointerLocked || this.dragging) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    canvas.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    });
  }

  /** held state; returns false for gameplay actions while gameplay input is disabled */
  isDown(a: Action) {
    return this.gameplayEnabled && this.down.has(a);
  }

  wasPressed(a: Action) {
    return this.pressedThisFrame.has(a);
  }

  /** read and clear mouse deltas (camera calls this once per frame) */
  consumeMouse() {
    const d = { dx: this.mouseDX, dy: this.mouseDY, wheel: this.wheel };
    this.mouseDX = this.mouseDY = this.wheel = 0;
    return d;
  }

  /** test/debug hook: simulate holding an action */
  setHeld(a: Action, held: boolean) {
    if (held) {
      if (!this.down.has(a)) this.pressedThisFrame.add(a);
      this.down.add(a);
    } else this.down.delete(a);
  }

  endFrame() {
    this.pressedThisFrame.clear();
  }
}
