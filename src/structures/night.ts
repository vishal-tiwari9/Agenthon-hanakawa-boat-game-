// night lamps: paper lanterns, lit windows and the boats' lanterns glow from dusk (uNight) and a
// little under heavy cloud. every term is scaled by lampLevel, so with the time-lapse off
// (uNight = uCloud = 0) the glow adds exactly nothing and the authored day is unchanged.
import { clamp, float, fract, max, sin, smoothstep, sqrt, step, vec3 } from 'three/tsl';
import { uCloud, uNight } from '../core/daycycle';
import { uTime } from '../core/uniforms';

// tsl node graphs are loosely typed here
type N = any;

/** 0 in the authored day .. 1 at night; heavy cloud lights the lamps a little */
export const lampLevel: N = clamp(uNight.add(uCloud.mul(0.3)), 0, 1);
/** cpu mirror of lampLevel, for night-only visibility toggles */
export const lampLevelNow = () => Math.min(1, (uNight.value as number) + (uCloud.value as number) * 0.3);

/** candle flicker around 1 from a 0..1 per-lamp phase */
export function flicker(phase: N): N {
  const p = float(phase).mul(6.283);
  const slow = sin(uTime.mul(7.3).add(p)).mul(sin(uTime.mul(2.9).add(p.mul(3.7)))).mul(0.08);
  return slow.add(sin(uTime.mul(17.0).add(p.mul(9.1))).mul(0.03)).add(1);
}

/** candle light seen through lantern paper */
export const LAMP_RGB: [number, number, number] = [1.0, 0.72, 0.4];
/** night glow gain on the paper colour: well past the bloom threshold (~0.9 scene linear) */
export const LAMP_GAIN = 5.5;
/** the colour a lit paper glows: sqrt lifts dim dyes so red lanterns still read as lit */
export function lampColor(paper: N): N {
  return sqrt(max(paper, 0)).mul(vec3(...LAMP_RGB));
}

/** warm interior light behind shoji and lattice windows */
export const WINDOW_RGB: [number, number, number] = [1.0, 0.6, 0.27];
export const WINDOW_GAIN = 2.6;
/** per-window switch from a 0..1 hash: about 60% light up, each at its own point through dusk */
export function windowOn(r: N): N {
  const lit = step(0.4, fract(float(r).mul(7.13)));
  const at = float(r).mul(0.4);
  return smoothstep(at, at.add(0.3), lampLevel).mul(lit);
}

/** firelight in a stone lantern's openings */
export const FIRE_RGB: [number, number, number] = [1.0, 0.55, 0.22];
export const FIRE_GAIN = 4.0;
