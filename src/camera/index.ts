// camera rig: follow (third person), helm (first person) and a free photo camera, plus the debug
// override used by the harness. an override pose always wins over every controller.
import { Vector3 } from 'three/webgpu';
import type { CameraApi, CameraMode, GameContext } from '../core/context';
import { FOLLOW, FollowCam } from './follow';
import { HELM, HelmCam } from './helm';
import { PhotoCam } from './photo';

const ORDER: CameraMode[] = ['follow', 'helm', 'photo'];
/** radians per pixel at mouse sensitivity 1 */
const LOOK = 0.0022;
const OVERRIDE_FOV = 60;

export async function init(ctx: GameContext) {
  const cam = ctx.camera;
  const follow = new FollowCam(), helm = new HelmCam(), photo = new PhotoCam();
  let override: { pos: Vector3; target: Vector3 } | null = null;
  let chartOpen = false;

  const setFov = (f: number) => {
    if (cam.fov === f) return;
    cam.fov = f;
    cam.updateProjectionMatrix();
  };

  const enter = (m: CameraMode) => {
    if (m === 'follow') {
      follow.snap();
      setFov(FOLLOW.fov);
    } else if (m === 'helm') {
      helm.snap();
      setFov(HELM.fov);
    } else photo.enter(cam);
  };

  const rig: CameraApi = {
    mode: 'follow',
    setMode(m: CameraMode) {
      if (!ORDER.includes(m) || m === rig.mode) return;
      rig.mode = m;
      enter(m);
      ctx.events.emit('camera:mode', m);
    },
    setOverride(pos, target) {
      override = pos ? { pos: pos.clone(), target: (target ?? new Vector3()).clone() } : null;
      // coming back from a fixed pose: jump straight to the controller instead of springing
      if (!override) enter(rig.mode);
    },
  };

  ctx.events.on('input:camera', () => {
    if (ctx.paused || !ctx.input.gameplayEnabled) return;
    rig.setMode(ORDER[(ORDER.indexOf(rig.mode) + 1) % ORDER.length]);
  });

  // pointer lock on a canvas click while playing; drag-to-look works without it. the ui module
  // owns lock/unlock (and pauses when the lock is lost) whenever it is running
  const uiOwnsLock = () => !!(window as any).__lumaUi;
  ctx.events.on('input:pointerdown', () => {
    if (uiOwnsLock() || ctx.paused || chartOpen || !ctx.input.gameplayEnabled || document.pointerLockElement) return;
    try {
      const p = ctx.canvas.requestPointerLock?.() as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch {}
  });
  const release = () => {
    if (!uiOwnsLock() && document.pointerLockElement) document.exitPointerLock?.();
  };
  ctx.events.on('pause', release);
  ctx.events.on('ui:chart', (open: boolean) => {
    chartOpen = !!open;
    if (chartOpen) release();
  });

  ctx.onUpdate((c) => {
    const m = c.input.consumeMouse();
    if (override) {
      setFov(OVERRIDE_FOV);
      cam.position.copy(override.pos);
      cam.up.set(0, 1, 0);
      cam.lookAt(override.target);
      cam.updateMatrixWorld();
      return;
    }
    const dt = Math.min(0.1, c.time.frameDt);
    const live = !c.paused && !chartOpen;
    const sens = LOOK * (c.settings.mouseSensitivity || 1);
    const dx = live ? m.dx * sens : 0;
    const dy = live ? m.dy * sens * (c.settings.invertY ? -1 : 1) : 0;
    const wheel = live ? m.wheel : 0;
    if (rig.mode === 'photo') {
      photo.look(dx, dy);
      photo.update(c, cam, dt, wheel);
    } else if (!c.boat) {
      return;
    } else if (rig.mode === 'helm') {
      helm.look(dx, dy);
      helm.update(c, cam, dt);
    } else {
      follow.look(dx, dy);
      follow.update(c, cam, dt, wheel);
    }
    cam.updateMatrixWorld();
  }, 50);

  setFov(FOLLOW.fov);
  ctx.cameraRig = rig;
}
