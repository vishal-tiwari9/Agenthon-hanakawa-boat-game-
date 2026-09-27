// the sun: direction from SUN (layout), a warm directional light and cascaded shadows sized by the
// quality preset. cascades are texel-snapped by CSMShadowNode; splits are tight near the camera so
// the boat and jetty get crisp contact shadows while the far cascade covers the coastline.
import { Color, DirectionalLight, PCFShadowMap, Vector3, type PerspectiveCamera, type WebGPURenderer } from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { normalWorld } from 'three/tsl';
import type { QualityPreset } from '../core/settings';
import { LAYERS } from '../core/layers';
import { SUN } from '../world/layout';
import { TUNE } from './config';

const _camPos = new Vector3(), _camFwd = new Vector3();

// tsl assigns a shared var (normalView, normalWorld) where it is first built. for a material whose
// lighting never reads the normal before the sun's shadow (the water), that first build is the normal
// bias inside the nearest cascade's branch, so every fragment past the first split read a zero normal
// in the other cascades and in the ibl irradiance: a hard, camera-following line across the river.
// building it here, ahead of the cascade branches, assigns it for every fragment.
class CascadedShadow extends CSMShadowNode {
  setupShadowPosition(builder: any) {
    super.setupShadowPosition(builder);
    (normalWorld as any).toStack();
  }
}

export function sunDirection(target = new Vector3()) {
  const az = (SUN.azimuthDeg * Math.PI) / 180, el = (SUN.elevationDeg * Math.PI) / 180;
  return target.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}

// cascade refresh policy. the nearest cascade renders every frame (the boat's own shadow, nearby
// animation). outer cascades re-render when the camera has moved or turned enough to shift their
// coverage, or after a maximum number of frames so distant animated casters still update. a cascade
// that is not re-rendered keeps the matrix it was rendered with, so its lookup always matches its
// map: this never causes flicker, it only lets far shadows lag slightly.
const REFRESH = [
  { move: 0, turn: 0, frames: 1 },
  { move: 0.6, turn: 1.5, frames: 6 },
  { move: 2.5, turn: 3, frames: 24 },
  { move: 5, turn: 5, frames: 48 },
];

// fraction of the shadow distance where each cascade ends, per cascade count
const SPLITS: Record<number, number[]> = {
  1: [1],
  2: [0.16, 1],
  3: [0.075, 0.28, 1],
  4: [0.045, 0.14, 0.38, 1],
};

export class Sun {
  light: DirectionalLight;
  csm: CSMShadowNode | null = null;
  dir = sunDirection();
  private biasApplied = false;
  private frame = 0;
  /** per cascade: camera position/forward and frame at its last render */
  private last: { pos: Vector3; fwd: Vector3; frame: number }[] = [];
  private cascades = 0;
  private distance = 0;
  /** the light direction changed since the last shadow refresh (time-lapse): every cascade follows */
  private moved = false;
  private turn = 0;
  private moveFrame = 0;
  /** while the light moves: an outer cascade refreshes every `outerStride` frames (2 when the light is
   *  dim and its shadows faint), none at all while `dark` (between sunset and moonrise) */
  outerStride = 1;
  dark = false;

  constructor(renderer: WebGPURenderer) {
    const c = TUNE.sun.color;
    this.light = new DirectionalLight(new Color(c[0], c[1], c[2]), TUNE.sun.intensity);
    this.light.name = 'sun';
    this.light.position.copy(this.dir).multiplyScalar(400);
    this.light.target.position.set(0, 0, 0);
    this.light.castShadow = true;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
  }

  /** (re)builds the cascades for a quality preset. safe to call repeatedly. */
  applyQuality(q: QualityPreset) {
    const light = this.light;
    if (this.csm) {
      this.csm.dispose();
      this.csm = null;
    }
    light.shadow.dispose();
    light.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    // shadow cameras render layer 0 and the no-reflect layer (small props), never inherit the view's
    light.shadow.camera.layers.set(LAYERS.DEFAULT);
    light.shadow.camera.layers.enable(LAYERS.NO_REFLECT);
    light.shadow.camera.near = 1;
    light.shadow.camera.far = q.shadowDistance * 2.2 + 400;
    light.shadow.camera.updateProjectionMatrix();
    // wider pcf kernel for soft, dappled canopy shadows (r186 PCFShadowFilter reads radius)
    light.shadow.radius = 3.5;
    light.shadow.bias = -0.00004;
    light.shadow.normalBias = 0.02;
    // updated manually once per frame so the reflection camera does not re-render the cascades
    light.shadow.autoUpdate = false;
    this.cascades = Math.max(1, Math.min(4, q.shadowCascades));
    this.distance = q.shadowDistance;
    const splits = SPLITS[this.cascades];
    const csm = new CascadedShadow(light, {
      cascades: this.cascades,
      maxFar: q.shadowDistance,
      mode: 'custom',
      // casters up to ~350 m toward the sun (ridges above the village) reach the maps
      lightMargin: 350,
      customSplitsCallback: (n: number, near: number, far: number, target: number[]) => {
        for (let i = 0; i < n; i++) target.push(splits[i] ?? 1);
      },
    } as any);
    csm.fade = true;
    light.shadow.shadowNode = csm as any;
    this.csm = csm;
    this.biasApplied = false;
    this.frame = 0;
    this.last = [];
  }

  /** points the light along a unit direction (toward the light). the authored look never calls this */
  setDirection(d: Vector3) {
    if (this.dir.equals(d)) return;
    // a jump (sun/moon swap, a new frozen hour, back to the authored look) re-renders every cascade
    if (this.dir.dot(d) < 0.9994) this.refreshAll();
    this.dir.copy(d);
    this.light.position.copy(d).multiplyScalar(400);
    this.moved = true;
  }

  /** per frame: request one shadow render and tune per-cascade bias once the cascades exist */
  update(camera: PerspectiveCamera) {
    const csm = this.csm;
    if (!csm) return;
    const lights = (csm as any).lights as DirectionalLight[];
    if (!lights || lights.length === 0) return;
    if (!this.biasApplied) {
      const splits = SPLITS[this.cascades];
      for (let i = 0; i < lights.length; i++) {
        const s = lights[i].shadow;
        // texel size grows with the cascade (its extent ~ the far-plane diagonal of its slice)
        const far = this.distance * splits[i];
        const diag = 2 * Math.tan((camera.fov * Math.PI) / 360) * far * Math.sqrt(1 + camera.aspect * camera.aspect);
        const texel = diag / s.mapSize.x;
        s.normalBias = Math.max(0.015, texel * 1.1);
        s.bias = -0.00003 * (i + 1);
        s.camera.layers.mask = this.light.shadow.camera.layers.mask;
      }
      this.biasApplied = true;
    }
    const f = this.frame++;
    const pos = camera.getWorldPosition(_camPos);
    const fwd = camera.getWorldDirection(_camFwd);
    if (this.moved) {
      // a moving light (time-lapse) shifts every cascade's matrix. the nearest follows every frame and
      // the outer ones take turns (one per frame, or every other frame when the light is dim): each
      // keeps the matrix it was rendered with, so far shadows lag by a few frames and never flicker
      this.moved = false;
      if (this.dark && f >= 4) return;
      const n = lights.length;
      const outer = n > 1 && this.moveFrame++ % this.outerStride === 0 ? 1 + (this.turn++ % (n - 1)) : 0;
      for (let i = 0; i < n; i++) {
        if (i !== 0 && i !== outer && f >= 4) continue;
        lights[i].shadow.needsUpdate = true;
        const last = this.last[i] ?? (this.last[i] = { pos: new Vector3(), fwd: new Vector3(), frame: 0 });
        last.pos.copy(pos);
        last.fwd.copy(fwd);
        last.frame = f;
      }
      return;
    }
    // at most one outer cascade re-renders per frame, so refreshes never stack into a frame spike
    let outerDone = false;
    for (let i = 0; i < lights.length; i++) {
      const r = REFRESH[Math.min(i, REFRESH.length - 1)];
      let last = this.last[i];
      if (!last) last = this.last[i] = { pos: new Vector3(1e9, 0, 0), fwd: new Vector3(), frame: -1e9 };
      // the first frames after a (re)build render everything
      const due = f < 4 || TUNE.shadowRefresh === 'all' || f - last.frame >= r.frames || last.pos.distanceTo(pos) > r.move ||
        Math.acos(Math.min(1, Math.max(-1, last.fwd.dot(fwd)))) * (180 / Math.PI) > r.turn;
      if (!due) continue;
      if (i > 0 && f >= 4 && TUNE.shadowRefresh !== 'all') {
        if (outerDone) continue;
        outerDone = true;
      }
      lights[i].shadow.needsUpdate = true;
      last.pos.copy(pos);
      last.fwd.copy(fwd);
      last.frame = f;
    }
  }

  /** force every cascade to re-render on the next frame (pipeline warm-up, teleports) */
  refreshAll() {
    for (const l of ((this.csm as any)?.lights ?? []) as DirectionalLight[]) l.shadow.needsUpdate = true;
    this.frame = 0;
  }

  resize() {
    // a freshly created csm binds its camera on first build; nothing to refit before that
    if (this.csm && (this.csm as any).camera) this.csm.updateFrustums();
    this.biasApplied = false;
  }
}
