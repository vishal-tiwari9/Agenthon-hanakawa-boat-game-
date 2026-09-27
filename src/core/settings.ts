// user settings (persisted) and quality presets. modules read ctx.quality and subscribe to
// the 'quality' event to rebuild whatever they scale (reflection size, grass density...).
import type { Backend } from './context';

export type QualityName = 'low' | 'balanced' | 'high';

export interface QualityPreset {
  name: QualityName;
  /** cap on devicePixelRatio */
  maxPixelRatio: number;
  /** cap on rendered pixels (width * height): big high-dpi windows otherwise multiply every full-screen buffer */
  maxPixels: number;
  shadowMapSize: number;
  shadowCascades: number;
  /** meters covered by the sun shadow cascades */
  shadowDistance: number;
  /** planar reflection render scale relative to the canvas */
  reflectionScale: number;
  /** multiplier on water mesh vertex density */
  waterDetail: number;
  /** multiplier on grass / flower instance counts */
  vegetationDensity: number;
  /** meters to which grass is drawn */
  grassDistance: number;
  /** multiplier on terrain lod distances */
  terrainDetail: number;
  ao: boolean;
  ssgi: boolean;
  bloom: boolean;
  antialias: 'none' | 'fxaa' | 'smaa' | 'traa';
  caustics: boolean;
  /** splash/spray particle budget multiplier */
  particles: number;
}

export const QUALITY: Record<QualityName, QualityPreset> = {
  low: {
    name: 'low', maxPixelRatio: 1, maxPixels: 1.3e6, shadowMapSize: 1024, shadowCascades: 2, shadowDistance: 160,
    reflectionScale: 0.3, waterDetail: 0.6, vegetationDensity: 0.35, grassDistance: 55, terrainDetail: 0.6,
    ao: false, ssgi: false, bloom: false, antialias: 'fxaa', caustics: false, particles: 0.5,
  },
  balanced: {
    name: 'balanced', maxPixelRatio: 1.25, maxPixels: 2.1e6, shadowMapSize: 2048, shadowCascades: 3, shadowDistance: 260,
    reflectionScale: 0.5, waterDetail: 1, vegetationDensity: 0.65, grassDistance: 85, terrainDetail: 1,
    ao: true, ssgi: false, bloom: true, antialias: 'smaa', caustics: true, particles: 1,
  },
  high: {
    name: 'high', maxPixelRatio: 2, maxPixels: 3.7e6, shadowMapSize: 4096, shadowCascades: 4, shadowDistance: 520,
    reflectionScale: 0.75, waterDetail: 1.4, vegetationDensity: 1, grassDistance: 170, terrainDetail: 1.4,
    ao: true, ssgi: true, bloom: true, antialias: 'traa', caustics: true, particles: 1.4,
  },
};

export interface Settings {
  quality: QualityName;
  masterVolume: number;
  engineVolume: number;
  ambienceVolume: number;
  uiVolume: number;
  mouseSensitivity: number;
  invertY: boolean;
  showMarker: boolean;
  units: 'knots' | 'kmh';
  /** a whole day every 20 s with changing weather (src/core/daycycle.ts) */
  timeLapse: boolean;
}

const KEY = 'luma-coast/settings/v1';

export const DEFAULT_SETTINGS: Settings = {
  quality: 'balanced',
  masterVolume: 0.8,
  engineVolume: 0.8,
  ambienceVolume: 0.8,
  uiVolume: 0.7,
  mouseSensitivity: 1,
  invertY: false,
  showMarker: true,
  units: 'knots',
  timeLapse: false,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  // first visit on a small-memory device (chrome reports 4 gb or less): start on low
  const mem = (navigator as { deviceMemory?: number }).deviceMemory;
  return { ...DEFAULT_SETTINGS, ...(mem !== undefined && mem <= 4 ? { quality: 'low' as const } : {}) };
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}

/** the webgl2 fallback always runs a reduced preset: no ssgi, smaller reflections */
export function resolveQuality(name: QualityName, backend: Backend): QualityPreset {
  const q = { ...QUALITY[name] };
  if (backend === 'webgl2') {
    q.ssgi = false;
    q.antialias = q.antialias === 'traa' ? 'smaa' : q.antialias;
    q.reflectionScale = Math.min(q.reflectionScale, 0.4);
    q.shadowMapSize = Math.min(q.shadowMapSize, 2048);
    // keep fallback shaders small: one local shadow map, baked sky visibility farther away
    q.shadowCascades = 1;
    q.shadowDistance = Math.min(q.shadowDistance, 180);
    q.vegetationDensity *= 0.7;
    q.maxPixelRatio = Math.min(q.maxPixelRatio, 1.25);
  }
  return q;
}
