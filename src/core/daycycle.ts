// time of day and weather, shared by every module (ctx.services.day, plus the tsl uniforms below).
// with the time-lapse setting off the valley stays at its authored morning (SUN in layout.ts) in clear
// weather, and every value here matches the fixed look exactly. with it on, a whole day passes every
// DAY_SECONDS and the weather runs through clear, cloud, rain and a thunderstorm on the way.
import { Vector3 } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { SUN } from '../world/layout';
import type { GameContext } from './context';

/** real seconds for one full day while the time-lapse is on */
export const DAY_SECONDS = 20;
/** of those, extra seconds spent in the clear daytime (DAY_HOLD hours), the rest runs at an even pace */
const DAY_EXTRA = 5;
const DAY_HOLD: [number, number] = [7, 11];
/** the authored look: SUN (azimuth 150, elevation 38) falls at this hour on the sun path below */
export const DEFAULT_HOURS = 8.62;
/** highest sun elevation of the day (noon), degrees */
const NOON_ELEVATION = 60;

export type WeatherName = 'clear' | 'cloudy' | 'rain' | 'storm';

export interface DayState {
  /** 0..24 */
  hours: number;
  /** unit vector toward the sun; below the horizon at night (y < 0) */
  sunDir: Vector3;
  /** unit vector toward the moon (opposite the sun, lifted so it rides the night sky) */
  moonDir: Vector3;
  /** 0 = full day, 1 = full night; eases through dusk and dawn */
  night: number;
  /** 0..1, peaks around sunrise and sunset (warm low light) */
  twilight: number;
  /** 0..1 overcast */
  cloud: number;
  /** 0..1 rainfall */
  rain: number;
  /** 0..1 thunderstorm (gusts, lightning) */
  storm: number;
  /** 0..1 lightning flash this frame (a short double flicker) */
  flash: number;
  /** 0..1 surface wetness, trails the rain */
  wet: number;
  /** named weather the schedule is in (for ui and audio) */
  weather: WeatherName;
  timeLapse: boolean;
}

/** 0 = day .. 1 = night */
export const uNight = uniform(0);
/** 0..1 dusk/dawn */
export const uTwilight = uniform(0);
export const uCloud = uniform(0);
export const uRain = uniform(0);
export const uStorm = uniform(0);
export const uFlash = uniform(0);
export const uWet = uniform(0);
export const uMoonDir = uniform(new Vector3(0, 1, 0));

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** the sun path: rises in the east-southeast, peaks at noon, and passes SUN at DEFAULT_HOURS */
export function sunAt(hours: number, out = new Vector3()) {
  const h0 = DEFAULT_HOURS;
  // elevation follows a sine over the 24 h day, scaled so DEFAULT_HOURS lands exactly on SUN.elevationDeg
  const phase = ((hours - 6) / 24) * Math.PI * 2;
  const phase0 = ((h0 - 6) / 24) * Math.PI * 2;
  const k = SUN.elevationDeg / Math.sin(phase0);
  const el = Math.max(-80, Math.min(NOON_ELEVATION, k * Math.sin(phase)));
  const az = SUN.azimuthDeg + (hours - h0) * 15;
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
}

/**
 * weather through one time-lapse day: a clear night and dawn, clouds building by midday, afternoon
 * rain, a thunderstorm through dusk into the night, then clearing to stars. values blend smoothly.
 */
function weatherAt(hours: number) {
  const h = ((hours % 24) + 24) % 24;
  const cloud = Math.max(smooth(10, 13, h) * (1 - smooth(21, 23.5, h)), 0);
  const rain = smooth(13.5, 15, h) * (1 - smooth(20.5, 22, h));
  const storm = smooth(16.5, 17.5, h) * (1 - smooth(20, 21.5, h));
  const weather: WeatherName = storm > 0.5 ? 'storm' : rain > 0.5 ? 'rain' : cloud > 0.5 ? 'cloudy' : 'clear';
  return { cloud, rain, storm, weather };
}

const WEATHER_PRESETS: Record<WeatherName, { cloud: number; rain: number; storm: number }> = {
  clear: { cloud: 0, rain: 0, storm: 0 },
  cloudy: { cloud: 1, rain: 0, storm: 0 },
  rain: { cloud: 1, rain: 1, storm: 0 },
  storm: { cloud: 1, rain: 1, storm: 1 },
};

export class DayCycle implements DayState {
  hours = DEFAULT_HOURS;
  sunDir = sunAt(DEFAULT_HOURS);
  moonDir = new Vector3(0, 1, 0);
  night = 0;
  twilight = 0;
  cloud = 0;
  rain = 0;
  storm = 0;
  flash = 0;
  wet = 0;
  weather: WeatherName = 'clear';
  timeLapse = false;
  /** debug/test override: a fixed hour and weather, time-lapse or not */
  private frozen: { hours: number; weather: WeatherName } | null = null;
  private nextBolt = 0;
  private bolt = -1;

  constructor(private ctx: GameContext) {}

  /** hold a fixed time and weather (tests, screenshots); null releases it */
  freeze(hours: number | null, weather: WeatherName = 'clear') {
    this.frozen = hours === null ? null : { hours, weather };
    this.bolt = -1;
  }

  update(dt: number) {
    const f = this.frozen;
    if (f) this.hours = f.hours;
    else if (this.timeLapse) {
      // an even pace over DAY_SECONDS - DAY_EXTRA, slowed through the clear daytime so it lasts DAY_EXTRA longer
      const even = 24 / (DAY_SECONDS - DAY_EXTRA), span = DAY_HOLD[1] - DAY_HOLD[0];
      const inHold = this.hours >= DAY_HOLD[0] && this.hours < DAY_HOLD[1];
      const rate = inHold ? span / (span / even + DAY_EXTRA) : even;
      this.hours = (this.hours + rate * dt) % 24;
    }
    else this.hours = DEFAULT_HOURS;
    sunAt(this.hours, this.sunDir);
    const sy = this.sunDir.y;
    this.night = 1 - smooth(-0.12, 0.08, sy);
    this.twilight = smooth(-0.14, 0.02, sy) * (1 - smooth(0.05, 0.32, sy));
    this.moonDir.set(-this.sunDir.x, Math.abs(this.sunDir.y) * 0.8 + 0.35, -this.sunDir.z).normalize();

    const w = f ? { ...WEATHER_PRESETS[f.weather], weather: f.weather } : this.timeLapse ? weatherAt(this.hours) : { ...WEATHER_PRESETS.clear, weather: 'clear' as const };
    this.cloud = w.cloud;
    this.rain = w.rain;
    this.storm = w.storm;
    this.weather = w.weather;
    // wetness soaks in with the rain and dries a little slower
    const target = this.rain;
    this.wet += (target - this.wet) * Math.min(1, dt * (target > this.wet ? 1.5 : 0.5));
    if (!this.timeLapse && !f) this.wet = 0;

    // lightning: random strikes while the storm is up, each a quick double flicker
    const now = this.ctx.time.real;
    if (this.storm > 0.3 && now >= this.nextBolt) {
      this.bolt = now;
      this.nextBolt = now + 0.7 + Math.random() * (2.6 - this.storm * 1.4);
      // distance in meters drives the thunder delay and loudness (audio listens for this)
      this.ctx.events.emit('weather:lightning', { distance: 300 + Math.random() * 2200, strength: 0.5 + Math.random() * 0.5 });
    }
    const t = this.bolt < 0 ? 99 : now - this.bolt;
    this.flash = this.storm > 0 ? Math.max(Math.exp(-t * 22), t > 0.12 ? 0.7 * Math.exp(-(t - 0.12) * 14) : 0) : 0;

    uNight.value = this.night;
    uTwilight.value = this.twilight;
    uCloud.value = this.cloud;
    uRain.value = this.rain;
    uStorm.value = this.storm;
    uFlash.value = this.flash;
    uWet.value = this.wet;
    (uMoonDir.value as Vector3).copy(this.moonDir);
  }
}
