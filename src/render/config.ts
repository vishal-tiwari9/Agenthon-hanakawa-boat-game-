// render tunables in one place. url overrides (?tm=agx&exp=1.4&haze=1.2...) exist only for
// tuning screenshots; the defaults below are the shipped look.
const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const num = (k: string, d: number) => {
  const v = q.get(k);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
/** ?dream=0 restores the look before the dreamy layer (for comparison and perf a/b) */
const DREAM = q.get('dream') !== '0';
const dv = <T>(dream: T, plain: T): T => (DREAM ? dream : plain);

export type ToneMapName = 'neutral' | 'agx' | 'aces';

export const TUNE = {
  sky: {
    url: '/assets/render/kloofendal_48d_partly_cloudy_puresky/kloofendal_48d_partly_cloudy_puresky_4k.hdr',
    /** overall photo radiance scale; the sun is matched to the hdri at scale 1 */
    gain: num('skygain', 1.0),
    /** clear-sky target (scene-linear) at the horizon and zenith; the photo's clouds are kept */
    horizon: [0.56 * num('skyh', 1), 0.71 * num('skyh', 1), 0.86 * num('skyh', 1)] as [number, number, number],
    zenith: [0.062 * num('skyz', 1), 0.255 * num('skyz', 1), 0.62 * num('skyz', 1)] as [number, number, number],
    /** e-folding elevation (deg) of the horizon to zenith gradient */
    gradientDeg: num('skygrad', 16),
    /** hdri pixels near its own sun are capped to this (the analytic sun replaces the disc) */
    sunCap: 12,
    /** synthetic ground radiance for the lower hemisphere of the ibl (sunlit meadow, forest, river) */
    ground: [0.1, 0.125, 0.075] as [number, number, number],
  },
  sun: {
    /** direct normal irradiance, matched to the hdri's own sun (~4.5 at scale 1) */
    intensity: num('sun', 4.2),
    /** linear rgb, slightly warm afternoon sun */
    color: [1.0, 0.86, 0.7] as [number, number, number],
    /** radiance of the visible disc (kept below fp16 range so bloom stays sane) */
    discRadiance: 400,
  },
  env: {
    /** scene.environmentIntensity */
    intensity: num('env', 1.16),
    /** chroma kept in the ibl relative to the visible sky (1 = same azure) */
    saturation: num('envsat', 0.72),
  },
  haze: {
    /** aerosol extinction per meter at the river surface; layers the successive ridges */
    aerosol: num('hazeA', dv(3.6e-4, 3.4e-4)),
    aerosolHeight: 700,
    /** multiplier on the in-scattered horizon color: a little above the sky so far ridges read luminous */
    brightness: num('hazeB', dv(1.02, 1.0)),
  },
  mist: {
    /** extinction per meter at the water surface, before zones and drift */
    density: num('mist', 1.5e-3),
    /** e-folding height (m) above the water: it lies low */
    height: num('mistH', 4.5),
    /** clear radius around the camera (m) and the distance over which the mist eases in */
    near: num('mistNear', 50),
    fade: 90,
    /** radiance of the sunlit droplets (scene units, before the forward-scatter glow) */
    lit: [0.95, 0.89, 0.86] as [number, number, number],
    /** strength of the forward-scattering glow toward the sun */
    sunGlow: num('mistSun', 1.6),
    /** 0..1 depth of the drifting density pattern, and its drift speed (m/s along the wind) */
    noise: 0.55,
    drift: 0.6,
  },
  grade: {
    /** base saturation multiplier and extra vibrance for low-chroma colours (1 / 0 = neutral) */
    saturation: num('sat', dv(1.16, 1.12)),
    vibrance: num('vib', dv(0.35, 0.28)),
  },
  tone: {
    mapping: (q.get('tm') as ToneMapName) || 'neutral',
    exposure: num('exp', dv(1.14, 1.08)),
  },
  ao: {
    /** 0..1, how much of the gtao result is applied to indirect light */
    strength: num('ao', 0.68),
    radius: 2.0,
  },
  bloom: {
    /** a wide, soft glow: sunlit plaster, clouds, lantern paper and glints bleed gently into their
     *  surroundings (the knee keeps mid-grey surfaces out of it) */
    strength: num('bloom', dv(0.3, 0.1)),
    radius: dv(0.75, 0.35),
    /** scene-linear luminance threshold (before exposure) and the soft knee above it */
    threshold: num('bloomT', dv(0.9, 7)),
    knee: dv(1.0, 0.01),
    /** per-mip tint, fine to wide: the wide mips carry a warm peach halo */
    tint: dv([[1, 1, 1], [1.02, 0.98, 0.94], [1.04, 0.95, 0.88], [1.06, 0.92, 0.84], [1.08, 0.9, 0.82]], [[1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1]]) as [number, number, number][],
  },
  /** the dreamy spring-morning layer over the physical base. none of it is part of the sky or bounce
   *  cache keys, and every value is a uniform (__lumaRender.dream) */
  dream: {
    /** off (?dream=0): the air tint, sky grade and split tone are left out of the shaders entirely */
    enabled: DREAM,
    /** colour of the air (multiplies the haze / horizon ring): warm toward the sun's azimuth, cool away */
    airSun: [1.08, 1.0, 0.9] as [number, number, number],
    airAway: [0.94, 1.0, 1.16] as [number, number, number],
    /** sky: peach blush in the lowest degrees, richer azure toward the zenith */
    blush: [1.12, 0.97, 0.95] as [number, number, number],
    blushDeg: 6,
    zenithSat: 1.15,
    /** clouds: shaded parts lifted toward lavender-white, sunlit parts toward cream */
    cloudShade: [1.12, 1.1, 1.24] as [number, number, number],
    cloudLit: [1.08, 1.03, 0.95] as [number, number, number],
    /** display-referred split tone: warm highlights, blue-violet shadows, a small coloured lift at black */
    hiTint: [1.05, 1.0, 0.93] as [number, number, number],
    loTint: [0.92, 0.96, 1.13] as [number, number, number],
    lift: [0.008, 0.01, 0.026] as [number, number, number],
  },
  probes: {
    /** bounce probes over the village / bridge / pagoda stretch. webgpu only: the same bake takes
     *  ~12 s on the webgl2 backend */
    enabled: q.get('probes') !== '0',
    /** along-river range covered, margin beyond the banks (m), probe spacing (m), height span */
    sRange: [90, 470] as [number, number],
    margin: 45,
    spacing: 28,
    yRange: [1.5, 23] as [number, number],
    layers: 3,
    falloff: 40,
    intensity: num('probeI', 1),
  },
  /** antialiasing override for every preset (?aa=traa|smaa|fxaa|none); '' keeps the preset's */
  aa: (q.get('aa') || '') as '' | 'none' | 'fxaa' | 'smaa' | 'traa',
  /** outer shadow cascade refresh: 'policy' (movement-driven) or 'all' (every cascade, every frame) */
  shadowRefresh: q.get('shadowRefresh') || 'policy',
  debugOverride: q.get('rdebug') || '',
};
