// the shared contract every module codes against. see ARCHITECTURE.md.
import type { Object3D, PerspectiveCamera, Quaternion, Scene, Vector3, WebGPURenderer } from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { EventBus } from './events';
import type { Input } from './input';
import type { QualityPreset, Settings } from './settings';
import type { AssetLoader } from './assets';
import type { PhysicsWorld } from './physics';
import type { WorldData } from '../world/worldData';

export type Backend = 'webgpu' | 'webgl2';

export interface TimeState {
  /** wall-clock seconds since start (keeps running while paused, for ui/ambient anims) */
  real: number;
  /** fixed-step simulation time, advances only when not paused */
  sim: number;
  /** sim time interpolated to the rendered frame; the gpu ocean uses this */
  render: number;
  /** interpolation factor between previous and current physics state */
  alpha: number;
  /** last frame delta in seconds (clamped) */
  frameDt: number;
  /** fixed physics step */
  fixedDt: number;
}

export interface SunState {
  /** unit vector pointing from the scene toward the sun */
  direction: Vector3;
  /** linear color, multiplied by intensity for the directional light */
  color: { r: number; g: number; b: number };
  intensity: number;
}

export type CameraMode = 'follow' | 'helm' | 'photo';

/** published by the boat module (src/boat/index.ts) */
export interface BoatApi {
  /** interpolated render root, parented to the scene */
  object: Object3D;
  body: RAPIER.RigidBody;
  position: Vector3;
  quaternion: Quaternion;
  velocity: Vector3;
  angularVelocity: Vector3;
  /** forward speed in m/s (signed, + ahead) */
  speed: number;
  /** actual engine throttle -1..1 after spool smoothing */
  throttle: number;
  /** rudder angle -1..1 (+ = turning to starboard/right) */
  rudder: number;
  /** 0..1, how deep the hull currently sits relative to design draft */
  submersion: number;
  controlsEnabled: boolean;
  docked: boolean;
  /** local-space anchors on the hull (see src/boat/hullSpec.ts) */
  anchors: Record<string, Vector3>;
  reset(): void;
  teleport(x: number, z: number, headingDeg: number): void;
  dockTo(pose: { x: number; z: number; headingDeg: number }): void;
  undock(): void;
  setPaint(schemeId: string): void;
}

export interface CameraApi {
  mode: CameraMode;
  setMode(mode: CameraMode): void;
  /** debug/screenshot override: fixed pose, disables controllers until cleared */
  setOverride(pos: Vector3 | null, target?: Vector3): void;
}

type UpdateFn = (ctx: GameContext) => void;
type FixedFn = (ctx: GameContext, dt: number) => void;

export interface GameContext {
  renderer: WebGPURenderer;
  backend: Backend;
  scene: Scene;
  camera: PerspectiveCamera;
  canvas: HTMLCanvasElement;
  time: TimeState;
  sun: SunState;
  world: WorldData;
  physics: PhysicsWorld;
  events: EventBus;
  input: Input;
  assets: AssetLoader;
  settings: Settings;
  quality: QualityPreset;
  paused: boolean;
  /** set by modules as they come up; null until then */
  boat: BoatApi | null;
  cameraRig: CameraApi | null;
  /** per-frame update, sorted by order (lower first). camera ~ 50, water ~ 60, render last */
  onUpdate(fn: UpdateFn, order?: number): () => void;
  /** per physics step, before world.step(). sorted by order. */
  onFixed(fn: FixedFn, order?: number): () => void;
  /** per physics step, after world.step() */
  onPostFixed(fn: FixedFn, order?: number): () => void;
  /** the render module replaces this with its pipeline (post, etc). default: renderer.render */
  render: () => void;
  /** free-form registry for cross-module handles (e.g. water exposes 'water') */
  services: Record<string, unknown>;
}
