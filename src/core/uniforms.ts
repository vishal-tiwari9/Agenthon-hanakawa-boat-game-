// shared tsl uniforms, updated once per frame by core (see main.ts). any material may read them.
import { Vector2, Vector3 } from 'three/webgpu';
import { uniform, uniformArray } from 'three/tsl';
import { WAVE_COUNT, wavePhases, waveGlobal } from '../world/waves';
import type { GameContext } from './context';

/** sim time interpolated to the rendered frame (seconds). wraps nothing; use for slow anims only */
export const uTime = uniform(0);
/** wall-clock seconds, keeps running while paused (ui-ish ambient motion) */
export const uRealTime = uniform(0);
/** current gerstner phases (radians, wrapped), one per WAVES entry. see src/world/waves.ts */
export const uWavePhases = uniformArray(new Array(WAVE_COUNT).fill(0), 'float');
/** global wave amplitude multiplier (waveGlobal.amplitude) */
export const uWaveAmp = uniform(1);
/** unit vector toward the sun */
export const uSunDir = uniform(new Vector3(0, 1, 0));
/** wind: direction (unit, world xz) and strength 0..1, shared by grass, trees, water ripples, flags */
export const uWindDir = uniform(new Vector2(0.78, -0.62));
export const uWindStrength = uniform(0.45);

const phases = new Float32Array(WAVE_COUNT);

export function updateSharedUniforms(ctx: GameContext) {
  uTime.value = ctx.time.render;
  uRealTime.value = ctx.time.real;
  wavePhases(ctx.time.render, phases);
  const arr = uWavePhases.array as number[];
  for (let i = 0; i < WAVE_COUNT; i++) arr[i] = phases[i];
  uWaveAmp.value = waveGlobal.amplitude;
  (uSunDir.value as Vector3).copy(ctx.sun.direction);
}
