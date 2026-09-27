// shared gerstner wave field. the gpu ocean (src/water) and cpu buoyancy (src/boat/physics)
// must both evaluate exactly this model: same components, same world coords, same phases.
//
// displacement of a rest point p = (x, z), per component i:
//   theta = k * dot(D, p) - phase(t) + phi0
//   dx += Q * A * s * D.x * cos(theta)
//   dz += Q * A * s * D.y * cos(theta)
//   dy += A * s * sin(theta)
// where s is the local amplitude scale (world channel `waveScale`, sampled at the rest point).
// phase(t) = (omega * t) mod 2pi is computed in double precision on the cpu and uploaded
// as a uniform so the gpu never evaluates sin() of a large time value.

export const GRAVITY = 9.81;

export interface WaveComponent {
  /** direction of travel, unit 2d vector in world xz */
  dirX: number;
  dirZ: number;
  wavelength: number;
  amplitude: number;
  /** crest sharpness 0..1, kept low so crests stay rounded */
  steepness: number;
  phi0: number;
}

export interface WaveDerived extends WaveComponent {
  k: number;
  omega: number;
  /** Q*A, the horizontal displacement magnitude before scale */
  qa: number;
}

function comp(angleDeg: number, wavelength: number, amplitude: number, steepness: number, phi0: number): WaveComponent {
  const a = (angleDeg * Math.PI) / 180;
  return { dirX: Math.cos(a), dirZ: Math.sin(a), wavelength, amplitude, steepness, phi0 };
}

// a calm river on a light breeze: only a faint wind chop moves the geometry (a few centimeters),
// travelling roughly downwind (wind blows toward the north-east, see uWindDir). everything finer,
// and the flow-aligned ripples, lives in the gpu normal maps.
export const WAVE_COMPONENTS: WaveComponent[] = [
  comp(-40, 7.5, 0.028, 0.35, 0.0),
  comp(-62, 4.8, 0.018, 0.4, 1.7),
  comp(-20, 3.3, 0.012, 0.42, 4.1),
  comp(-75, 2.4, 0.008, 0.45, 2.6),
];

export const WAVES: WaveDerived[] = WAVE_COMPONENTS.map((w) => {
  const k = (2 * Math.PI) / w.wavelength;
  const omega = Math.sqrt(GRAVITY * k);
  return { ...w, k, omega, qa: w.steepness * w.amplitude };
});

export const WAVE_COUNT = WAVES.length;

/** global amplitude multiplier, lets settings/debug calm the sea without changing shape */
export const waveGlobal = { amplitude: 1.0 };

const TAU = Math.PI * 2;

/** current phases for each component, cpu double precision, wrapped to [0, 2pi) */
export function wavePhases(t: number, out: Float32Array | number[] = new Float32Array(WAVE_COUNT)) {
  for (let i = 0; i < WAVE_COUNT; i++) {
    const p = (WAVES[i].omega * t) % TAU;
    out[i] = p < 0 ? p + TAU : p;
  }
  return out;
}

/** scale field lookup, supplied by WorldData once loaded; defaults to open sea */
export type ScaleFn = (x: number, z: number) => number;
let scaleFn: ScaleFn = () => 1;
export function setWaveScaleFn(fn: ScaleFn) {
  scaleFn = fn;
}

export interface WaveSample {
  /** surface height (y) at the queried world xz */
  height: number;
  /** surface normal */
  nx: number;
  ny: number;
  nz: number;
  /** water particle velocity at the surface point */
  vx: number;
  vy: number;
  vz: number;
}

const _phases = new Float64Array(WAVE_COUNT);
let _phaseT = Number.NaN;
function phasesAt(t: number) {
  if (t !== _phaseT) {
    for (let i = 0; i < WAVE_COUNT; i++) _phases[i] = (WAVES[i].omega * t) % TAU;
    _phaseT = t;
  }
  return _phases;
}

/** displacement of the rest point (px, pz) at time t. writes [dx, dy, dz] */
export function displacement(px: number, pz: number, t: number, out: number[] | Float64Array) {
  const ph = phasesAt(t);
  const s = scaleFn(px, pz) * waveGlobal.amplitude;
  let dx = 0, dy = 0, dz = 0;
  for (let i = 0; i < WAVE_COUNT; i++) {
    const w = WAVES[i];
    const th = w.k * (w.dirX * px + w.dirZ * pz) - ph[i] + w.phi0;
    const c = Math.cos(th), sn = Math.sin(th);
    const h = w.qa * s * c;
    dx += h * w.dirX;
    dz += h * w.dirZ;
    dy += w.amplitude * s * sn;
  }
  out[0] = dx;
  out[1] = dy;
  out[2] = dz;
  return out;
}

const _d = new Float64Array(3);

/**
 * find the rest point whose displaced position lands on world (x, z).
 * gerstner moves points horizontally, so sampling displacement at (x, z) directly is wrong.
 * fixed-point iteration converges fast because the waves are low steepness.
 */
export function invertRest(x: number, z: number, t: number, out: number[] | Float64Array, iterations = 4) {
  let px = x, pz = z;
  for (let i = 0; i < iterations; i++) {
    displacement(px, pz, t, _d);
    px = x - _d[0];
    pz = z - _d[2];
  }
  out[0] = px;
  out[1] = pz;
  return out;
}

const _rest = new Float64Array(2);

/** surface height at world (x, z), handling horizontal displacement */
export function waterHeight(x: number, z: number, t: number): number {
  invertRest(x, z, t, _rest, 3);
  displacement(_rest[0], _rest[1], t, _d);
  return _d[1];
}

/** full surface sample (height, normal, particle velocity) at world (x, z) */
export function sampleWater(x: number, z: number, t: number, out: WaveSample): WaveSample {
  invertRest(x, z, t, _rest, 4);
  const px = _rest[0], pz = _rest[1];
  const ph = phasesAt(t);
  const s = scaleFn(px, pz) * waveGlobal.amplitude;
  let dy = 0;
  // tangent-space partials of the displaced surface (standard gerstner normal)
  let nx = 0, nz = 0, ny = 1;
  let vx = 0, vy = 0, vz = 0;
  for (let i = 0; i < WAVE_COUNT; i++) {
    const w = WAVES[i];
    const th = w.k * (w.dirX * px + w.dirZ * pz) - ph[i] + w.phi0;
    const c = Math.cos(th), sn = Math.sin(th);
    const a = w.amplitude * s;
    dy += a * sn;
    const wa = w.k * a;
    nx -= w.dirX * wa * c;
    nz -= w.dirZ * wa * c;
    ny -= w.steepness * wa * sn;
    // d/dt of displacement: theta decreases with t at rate omega
    const qa = w.qa * s;
    vx += qa * w.dirX * w.omega * sn;
    vz += qa * w.dirZ * w.omega * sn;
    vy += -a * w.omega * c;
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  out.height = dy;
  out.nx = nx / len;
  out.ny = ny / len;
  out.nz = nz / len;
  out.vx = vx;
  out.vy = vy;
  out.vz = vz;
  return out;
}

/** upper bound of |dy|, useful for culling and camera clearance */
export const MAX_WAVE_HEIGHT = WAVES.reduce((s, w) => s + w.amplitude, 0);
