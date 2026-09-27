// time of day and weather made visible. turns ctx.services.day (core/daycycle.ts) into the key light
// (sun by day, a cool moon by night, crossfaded through zero so the direction swap never pops), the
// sky grade, the ibl and bounce, the haze ring and mist, the post grade and the rain.
// the authored look (time-lapse off, no freeze) is untouched: values are snapshotted when the state
// first leaves it, restored on the frame it comes back, and every other frame returns right away.
import { Color, Vector3, type PerspectiveCamera } from 'three/webgpu';
import type { uniform } from 'three/tsl';
import { DEFAULT_HOURS, type DayCycle } from '../core/daycycle';
import { uWindDir } from '../core/uniforms';
import type { GameContext } from '../core/context';
import type { Sun } from './sun';
import type { SkyNodes } from './sky';
import type { Atmosphere } from './atmosphere';
import type { Post } from './post';
import { uGrade } from './post';
import type { BounceProbes } from './probes';
import type { Rain } from './rain';
import { TUNE } from './config';

type U = ReturnType<typeof uniform>;

const LUMA = [0.2126, 0.7152, 0.0722];
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** kasten-young relative air mass for a sun direction's height (y = sin elevation) */
function airmass(y: number) {
  const el = Math.max(-0.5, (Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI);
  return 1 / (Math.sin((el * Math.PI) / 180) + 0.50572 * Math.pow(el + 6.07995, -1.6364));
}

// looks, scene-linear. the day values come from the authored sky; these are only what changes
const OVERCAST_H = [0.46, 0.48, 0.51], OVERCAST_Z = [0.34, 0.36, 0.4];
const NIGHT_H = [0.012, 0.019, 0.042], NIGHT_Z = [0.003, 0.0055, 0.016];
const GLOW_SUN = [1.0, 0.4, 0.12], GLOW_SKY = [0.5, 0.28, 0.42];
const FLASH = [0.75, 0.85, 1.0];
const MOON = [0.62, 0.74, 1.0];
/** moonlight relative to the authored sun intensity */
const MOON_K = 0.1;
/** per-channel extinction for the sun's color through the air mass (reddens at dawn and dusk) */
const EXT = [0.09, 0.16, 0.34];
/** the haze ring is read a little above the horizon (matches the band it was averaged from) */
const RING_Y = 0.03;

export interface DayLightDeps {
  ctx: GameContext;
  sun: Sun;
  skyNodes: SkyNodes;
  atmosphere: Atmosphere;
  envTint: U;
  post: () => Post | null;
  probes: () => BounceProbes | null;
  rain: Rain | null;
}

interface Base {
  dir: Vector3;
  sunI: number;
  sunColor: Color;
  ctxColor: { r: number; g: number; b: number };
  disc: Vector3;
  env: number;
  probe: number;
  exposure: number;
  bloom: number;
  bloomT: number;
  sat: number;
  vib: number;
  aerosol: number;
  mist: number;
  mistNear: number;
  mistSun: number;
  mistLit: Vector3;
  atmSun: Vector3;
  airSun: Vector3;
  airAway: Vector3;
}

export class DayLight {
  private base: Base | null = null;
  private keyDir = new Vector3();
  private col = [0, 0, 0];
  private tint = [1, 1, 1];

  constructor(private d: DayLightDeps) {}

  private get day() {
    return this.d.ctx.services.day as DayCycle | undefined;
  }

  /** order -110: after the day cycle (-120), before the shared uniforms copy ctx.sun (-100) */
  update() {
    const day = this.day;
    const authored = !day || (day.hours === DEFAULT_HOURS && day.cloud === 0 && day.rain === 0 && day.storm === 0 && day.flash === 0 && day.wet === 0);
    if (authored) {
      if (this.base) this.restore();
      return;
    }
    if (!this.base) this.base = this.snapshot();
    this.apply(day!, this.base);
  }

  private snapshot(): Base {
    const { ctx, sun, skyNodes, atmosphere, post, probes } = this.d;
    const u = atmosphere.uniforms;
    const b = post()?.bloomNode;
    const s = ctx.sun.color;
    return {
      dir: sun.dir.clone(),
      sunI: sun.light.intensity,
      sunColor: sun.light.color.clone(),
      ctxColor: { r: s.r, g: s.g, b: s.b },
      disc: (skyNodes.sunColor.value as Vector3).clone(),
      env: ctx.scene.environmentIntensity,
      probe: probes()?.grid.intensity ?? TUNE.probes.intensity,
      exposure: ctx.renderer.toneMappingExposure,
      bloom: b ? (b.strength.value as number) : TUNE.bloom.strength,
      bloomT: b ? (b.threshold.value as number) : TUNE.bloom.threshold,
      sat: uGrade.saturation.value as number,
      vib: uGrade.vibrance.value as number,
      aerosol: u.aerosol.value as number,
      mist: u.mist.value as number,
      mistNear: u.mistNear.value as number,
      mistSun: u.mistSun.value as number,
      mistLit: (u.mistLit.value as Vector3).clone(),
      atmSun: (u.sunColor.value as Vector3).clone(),
      airSun: (u.airSun.value as Vector3).clone(),
      airAway: (u.airAway.value as Vector3).clone(),
    };
  }

  private restore() {
    const b = this.base!;
    this.base = null;
    const { ctx, sun, skyNodes, atmosphere, envTint, post, probes, rain } = this.d;
    sun.outerStride = 1;
    sun.dark = false;
    sun.setDirection(b.dir);
    sun.light.intensity = b.sunI;
    sun.light.color.copy(b.sunColor);
    ctx.sun.direction.copy(b.dir);
    Object.assign(ctx.sun.color, b.ctxColor);
    ctx.sun.intensity = b.sunI;
    (skyNodes.sunDir.value as Vector3).copy(b.dir);
    (skyNodes.sunColor.value as Vector3).copy(b.disc);
    skyNodes.weather.active.value = 0;
    ctx.scene.environmentIntensity = b.env;
    (envTint.value as Vector3).set(1, 1, 1);
    const p = probes();
    if (p) p.grid.intensity = b.probe;
    ctx.renderer.toneMappingExposure = b.exposure;
    const bl = post()?.bloomNode;
    if (bl) { bl.strength.value = b.bloom; bl.threshold.value = b.bloomT; }
    uGrade.saturation.value = b.sat;
    uGrade.vibrance.value = b.vib;
    const u = atmosphere.uniforms;
    u.aerosol.value = b.aerosol;
    u.mist.value = b.mist;
    u.mistNear.value = b.mistNear;
    u.mistSun.value = b.mistSun;
    (u.mistLit.value as Vector3).copy(b.mistLit);
    (u.sunColor.value as Vector3).copy(b.atmSun);
    (u.airSun.value as Vector3).copy(b.airSun);
    (u.airAway.value as Vector3).copy(b.airAway);
    atmosphere.ring.forEach((v, i) => v.copy(atmosphere.ringBase[i]));
    rain?.setAmount(0);
  }

  private apply(day: DayCycle, b: Base) {
    const { ctx, sun, skyNodes, atmosphere, envTint, post, probes, rain } = this.d;
    const sd = day.sunDir, sy = sd.y;
    const { night, twilight: tw, cloud, rain: wetAir, storm, flash } = day;
    const clearTw = tw * (1 - cloud);

    // ---- key light: the sun reddens and fades through the air mass, the moon takes over below
    const dm = airmass(sy) - airmass(b.dir.y);
    const bc = [b.sunColor.r, b.sunColor.g, b.sunColor.b];
    const col = this.col;
    for (let k = 0; k < 3; k++) col[k] = bc[k] * Math.min(1.3, Math.exp(-EXT[k] * dm));
    const lumB = LUMA[0] * bc[0] + LUMA[1] * bc[1] + LUMA[2] * bc[2];
    const lum = LUMA[0] * col[0] + LUMA[1] * col[1] + LUMA[2] * col[2];
    const peak = Math.max(col[0], col[1], col[2], 1e-6);
    for (let k = 0; k < 3; k++) col[k] /= peak;
    const sunUp = smooth(-0.04, 0.05, sy);
    const cloudK = (1 - 0.8 * cloud) * (1 - 0.6 * storm);
    const sunI = b.sunI * (lum / lumB) * sunUp * cloudK;
    const moonW = smooth(-0.05, -0.16, sy);
    const moonI = b.sunI * MOON_K * moonW * (1 - 0.7 * cloud);
    // sun and moon never overlap (between them both are dark), so the direction swaps at zero light
    let keyI: number, kr: number, kg: number, kb: number;
    const key = this.keyDir;
    if (sunUp > 0) {
      // the light itself stays a couple of degrees up: grazing shadow frusta degenerate
      key.copy(sd);
      if (key.y < 0.035) { const h = Math.hypot(key.x, key.z) || 1; const s = Math.sqrt(1 - 0.035 * 0.035) / h; key.set(key.x * s, 0.035, key.z * s); }
      keyI = sunI; kr = col[0]; kg = col[1]; kb = col[2];
    } else {
      key.copy(day.moonDir);
      keyI = moonI; kr = MOON[0]; kg = MOON[1]; kb = MOON[2];
    }
    sun.setDirection(key);
    // faint shadows (night, overcast, storm) can follow the moving light a little more lazily
    sun.outerStride = keyI < 0.3 * b.sunI ? 2 : 1;
    sun.dark = keyI < 0.004 * b.sunI;
    sun.light.intensity = keyI;
    sun.light.color.setRGB(kr, kg, kb);
    ctx.sun.direction.copy(key);
    ctx.sun.color.r = kr; ctx.sun.color.g = kg; ctx.sun.color.b = kb;
    ctx.sun.intensity = keyI;

    // ---- sky
    const skyLight = smooth(-0.16, 0.3, sy);
    const dark = 1 - skyLight;
    const W = skyNodes.weather;
    W.active.value = 1;
    const sat = (1 - 0.82 * cloud) * (1 - 0.25 * clearTw);
    const mulK = skyLight * (1 - 0.78 * cloud) * (1 - 0.5 * storm) * (1 - 0.2 * wetAir);
    W.sat.value = sat;
    (W.mul.value as Vector3).setScalar(mulK);
    const ovK = cloud * skyLight * (1 - 0.7 * storm) * (1 - 0.18 * wetAir);
    const nightK = dark * (1 - 0.35 * cloud);
    const slate = [lerp(1, 0.84, storm), lerp(1, 0.92, storm), lerp(1, 1.06, storm)];
    const addH = W.addH.value as Vector3, addZ = W.addZ.value as Vector3;
    addH.set(
      OVERCAST_H[0] * ovK * slate[0] + NIGHT_H[0] * nightK,
      OVERCAST_H[1] * ovK * slate[1] + NIGHT_H[1] * nightK,
      OVERCAST_H[2] * ovK * slate[2] + NIGHT_H[2] * nightK,
    );
    addZ.set(
      OVERCAST_Z[0] * ovK * slate[0] + NIGHT_Z[0] * nightK,
      OVERCAST_Z[1] * ovK * slate[1] + NIGHT_Z[1] * nightK,
      OVERCAST_Z[2] * ovK * slate[2] + NIGHT_Z[2] * nightK,
    );
    const glowK = tw * (1 - 0.85 * cloud);
    (W.glowSun.value as Vector3).set(GLOW_SUN[0], GLOW_SUN[1], GLOW_SUN[2]).multiplyScalar(1.5 * glowK);
    (W.glowSky.value as Vector3).set(GLOW_SKY[0], GLOW_SKY[1], GLOW_SKY[2]).multiplyScalar(0.3 * glowK);
    // the photographed sun stays at SUN: flatten it once the real one has moved on, or under cloud / at night
    const away = 1 - smooth(0.992, 0.9995, sd.dot(b.dir));
    W.photoDim.value = Math.max(away, night, cloud);
    (W.cloudTint.value as Vector3).set(lerp(1, 1.3, clearTw), lerp(1, 0.84, clearTw), lerp(1, 0.78, clearTw));
    const discK = sunUp * (1 - 0.97 * cloud);
    (W.halo.value as Vector3).set(col[0], col[1], col[2]).multiplyScalar(2.2 * away * discK * Math.max(0.3, lum / lumB));
    W.stars.value = night * (1 - cloud);
    W.moon.value = night * (1 - 0.85 * cloud);
    (W.flash.value as Vector3).set(FLASH[0], FLASH[1], FLASH[2]).multiplyScalar(2.8 * flash);
    const cam = ctx.camera as PerspectiveCamera;
    const bufH = ctx.renderer.domElement.height || window.innerHeight;
    W.pixel.value = (2 * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(1, bufH);
    (skyNodes.sunDir.value as Vector3).copy(sd);
    // disc radiance follows the sun's color and dims through the air (never above the authored one)
    const bd = b.disc;
    (skyNodes.sunColor.value as Vector3).set(col[0], col[1], col[2]).multiplyScalar((bd.x / Math.max(bc[0], 1e-6)) * Math.min(1, lum / lumB) * discK);

    // ---- haze ring: the same grade as the sky, evaluated a little above the horizon, per azimuth
    const elT = 1 - Math.exp(-RING_Y / 0.28), band = Math.exp(-RING_Y / 0.12);
    const gs = W.glowSun.value as Vector3, gk = W.glowSky.value as Vector3, fl = W.flash.value as Vector3;
    const flashK = 0.45 * (0.6 + 0.4 * elT);
    const ring = atmosphere.ring, rb = atmosphere.ringBase, N = ring.length;
    const cy = Math.sqrt(1 - RING_Y * RING_Y);
    for (let i = 0; i < N; i++) {
      const a = ((i + 0.5) / N - 0.5) * Math.PI * 2;
      const cs = Math.cos(a) * cy * sd.x + RING_Y * sd.y + Math.sin(a) * cy * sd.z;
      const t = Math.min(1, Math.max(0, cs * 0.5 + 0.5));
      const toward = t * t * t;
      const o = rb[i];
      const L = LUMA[0] * o.x + LUMA[1] * o.y + LUMA[2] * o.z;
      ring[i].set(
        (L + (o.x - L) * sat) * mulK + lerp(addH.x, addZ.x, elT) + (gs.x * toward + gk.x) * band + fl.x * flashK,
        (L + (o.y - L) * sat) * mulK + lerp(addH.y, addZ.y, elT) + (gs.y * toward + gk.y) * band + fl.y * flashK,
        (L + (o.z - L) * sat) * mulK + lerp(addH.z, addZ.z, elT) + (gs.z * toward + gk.z) * band + fl.z * flashK,
      );
    }

    // ---- air: denser grey mist in rain, blue at night, golden at dusk
    const u = atmosphere.uniforms;
    u.aerosol.value = b.aerosol * (1 + 0.7 * cloud + 1.8 * wetAir + 1.2 * storm);
    u.mist.value = b.mist * (1 + 0.8 * tw + 1.6 * wetAir + 0.6 * storm + 0.4 * night);
    u.mistNear.value = b.mistNear * (1 - 0.4 * wetAir);
    u.mistSun.value = b.mistSun * (1 - 0.85 * cloud);
    const lightLevel = skyLight * (1 - 0.4 * cloud) * (1 - 0.55 * storm) + 0.035 * night + 2.0 * flash;
    const ml = u.mistLit.value as Vector3, bl = b.mistLit;
    const mix3 = (v: Vector3, x: number, y: number, z: number, t: number) => v.set(lerp(v.x, x, t), lerp(v.y, y, t), lerp(v.z, z, t));
    ml.copy(bl);
    mix3(ml, 0.8, 0.82, 0.86, cloud);
    mix3(ml, 1.0, 0.78, 0.62, clearTw * 0.6);
    mix3(ml, 0.55, 0.66, 1.0, night);
    ml.multiplyScalar(lightLevel);
    (u.sunColor.value as Vector3).set(kr, kg, kb).multiplyScalar(keyI / Math.max(b.sunI, 1e-6));
    const neutral = Math.max(cloud, night) * 0.85;
    const as = u.airSun.value as Vector3, aa = u.airAway.value as Vector3;
    as.copy(b.airSun); mix3(as, 1.3, 0.92, 0.62, clearTw); mix3(as, 1, 1, 1, neutral);
    aa.copy(b.airAway); mix3(aa, 0.98, 0.86, 1.08, clearTw); mix3(aa, 1, 1, 1, neutral);

    // ---- ibl and bounce: follow the sky light, warm at twilight, grey under cloud, blue at night
    const envK = skyLight * (1 - 0.35 * cloud) * (1 - 0.45 * storm) * (1 - 0.2 * wetAir) + 0.045 * night * (1 - 0.3 * cloud);
    ctx.scene.environmentIntensity = b.env * (envK + 2.4 * flash);
    const tint = this.tint;
    tint[0] = 1; tint[1] = 1; tint[2] = 1;
    const tmix = (x: number, y: number, z: number, t: number) => { tint[0] = lerp(tint[0], x, t); tint[1] = lerp(tint[1], y, t); tint[2] = lerp(tint[2], z, t); };
    tmix(1.16, 0.96, 0.8, clearTw * 0.7);
    tmix(1.1, 1.02, 0.9, cloud);
    tmix(0.6, 0.74, 1.3, night);
    tmix(0.85, 0.93, 1.15, (2.4 * flash) / (2.4 * flash + envK + 1e-3));
    (envTint.value as Vector3).set(tint[0], tint[1], tint[2]);
    const p = probes();
    if (p) p.grid.intensity = b.probe * (0.7 * (sunI / Math.max(b.sunI, 1e-6)) + 0.3 * envK + 0.5 * moonI / Math.max(b.sunI, 1e-6));

    // ---- post: night is dark but legible (eyes adapt a little), lanterns bloom, colour drains
    ctx.renderer.toneMappingExposure = b.exposure * (1 + 0.6 * night) * (1 + 0.15 * cloud) * (1 + 0.2 * tw * (1 - night));
    const bloom = post()?.bloomNode;
    if (bloom) {
      bloom.strength.value = b.bloom * (1 + 0.8 * night);
      bloom.threshold.value = b.bloomT * (1 - 0.6 * night);
    }
    uGrade.saturation.value = b.sat * (1 - 0.3 * night - 0.1 * cloud);
    uGrade.vibrance.value = b.vib * (1 - 0.6 * night - 0.3 * cloud);

    // ---- rain
    if (rain) {
      rain.setAmount(wetAir * (0.5 + 0.5 * storm));
      if (wetAir > 0) {
        rain.uSpeed.value = 8.5 + 3.5 * storm;
        rain.uLen.value = 0.55 + 0.35 * storm;
        const wd = uWindDir.value as { x: number; y: number };
        (rain.uDrift.value as { set(x: number, y: number): void }).set(wd.x * (1.2 + 4.5 * storm), wd.y * (1.2 + 4.5 * storm));
        const rl = skyLight * (1 - 0.45 * cloud) * (1 - 0.5 * storm) + 0.05 * night;
        (rain.uColor.value as Vector3).set(0.95 * rl + FLASH[0] * 1.6 * flash, 1.0 * rl + FLASH[1] * 1.6 * flash, 1.08 * rl + FLASH[2] * 1.6 * flash);
        rain.uOpacity.value = 0.3 + 0.12 * storm;
        rain.uPixel.value = W.pixel.value as number;
      }
    }
  }
}
