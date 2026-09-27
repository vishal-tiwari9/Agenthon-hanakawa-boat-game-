// what every audio layer gets: the context, the mixer, shared noise, decoded samples and the
// listener pose (updated each frame before the layers run).
import { Vector3 } from 'three/webgpu';
import type { BoatApi } from '../core/context';
import type { Mixer } from './mixer';
import type { Samples } from './samples';
import type { Site } from './site';

export interface AudioEnv {
  ac: AudioContext;
  mx: Mixer;
  noise: { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer };
  samples: Samples;
  /** listener (camera) world position */
  listener: Vector3;
  /** listener's place along the river (see ./site) */
  site: Site;
  /** 0.5..1.3 shared gust level (wind layer writes it; leaves, bamboo and chimes follow it) */
  gust: number;
}

/** a boat anchor from the live BoatApi (hull spec), with a fallback while the model changes */
export function anchor(boat: BoatApi, name: string, fallback: { x: number; y: number; z: number }) {
  const a = boat.anchors?.[name];
  return a && Number.isFinite(a.x + a.y + a.z) ? a : fallback;
}

/** boat-local point (hullSpec frame) to world */
export function boatPoint(boat: BoatApi, local: { x: number; y: number; z: number }, out: Vector3): Vector3 {
  return out.set(local.x, local.y, local.z).applyQuaternion(boat.quaternion).add(boat.position);
}
