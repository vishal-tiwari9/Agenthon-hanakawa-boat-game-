// aerial perspective and river mist, integrated analytically along the view ray and installed as
// scene.fogNode, so every lit material (terrain, forest, structures, water) gets the same air.
//  - haze: a tall aerosol layer; its in-scattered color is the sky's own horizon ring (by azimuth),
//    so successive ridges fade toward exactly the sky behind them.
//  - mist: a thin sunlit layer lying on the water (river surface y = 0), a few meters thick. it is
//    kept clear for the first tens of meters (the boat and near banks stay crisp), thickens with
//    distance, is denser in zones (gorge, lake, falls) and drifts with a slow wind-carried pattern.
import { Vector3, Vector4, type Node } from 'three/webgpu';
import {
  Fn, abs, cameraPosition, cos, dot, exp, float, floor, int, max, mix, output, positionWorld, select, sin, smoothstep,
  uniform, uniformArray, vec2, vec3, vec4,
} from 'three/tsl';
import { uSunDir, uTime, uWindDir } from '../core/uniforms';
import { TUNE } from './config';
import { azimuthU } from './sky';

export const MAX_MIST_ZONES = 8;

/** a mist zone: world center, radius (m, gaussian) and extra density (1 = doubles the base) */
export interface MistZone {
  x: number;
  z: number;
  radius: number;
  strength: number;
}

// the horizon ring and zones are uniform arrays rather than textures: every lit material runs
// this, and fragment texture slots are scarce (webgpu's default limit is 16 per stage)
export function createAtmosphere(horizonRing: Vector3[], zones: MistZone[]) {
  // own copies: time of day and weather regrade the ring on the cpu (daylight.ts), never the sky data
  const ringBase = horizonRing.map((v) => v.clone());
  const ring = uniformArray(horizonRing.map((v) => v.clone()), 'vec3');
  const N = horizonRing.length;
  const H = TUNE.haze, M = TUNE.mist;
  const uAerosol = uniform(H.aerosol);
  const uAerosolH = uniform(H.aerosolHeight);
  const uBrightness = uniform(H.brightness);
  const uMist = uniform(M.density);
  const uMistH = uniform(M.height);
  const uMistNear = uniform(M.near);
  const uMistFade = uniform(M.fade);
  const uMistLit = uniform(new Vector3(...M.lit));
  const uMistSun = uniform(M.sunGlow);
  const uMistNoise = uniform(M.noise);
  const uMistDrift = uniform(M.drift);
  const sc = TUNE.sun.color;
  const uSunColor = uniform(new Vector3(sc[0], sc[1], sc[2]));
  const zoneData: Vector4[] = [];
  for (let i = 0; i < MAX_MIST_ZONES; i++) {
    const z = zones[i];
    zoneData.push(z ? new Vector4(z.x, z.z, 1 / (z.radius * z.radius), z.strength) : new Vector4(0, 0, 1, 0));
  }
  const uZones = uniformArray(zoneData, 'vec4');
  const D = TUNE.dream;
  const uAirSun = uniform(new Vector3(...D.airSun));
  const uAirAway = uniform(new Vector3(...D.airAway));

  /** colour of the air along a world direction: warm toward the sun's azimuth, cool away from it.
   *  the sky's horizon band uses the same tint, so ridges still fade into the sky behind them */
  const airTint = Fn(([dir]: [Node]) => {
    const d = dir as any, s = uSunDir as any;
    const h = vec2(d.x, d.z), sh = vec2(s.x, s.z);
    const c = dot(h, sh).div(max(h.length().mul(sh.length()), float(1e-4)));
    // clamped: rounding can push the cosine past -1 and pow() of a negative base is nan
    return mix(vec3(uAirAway as any), vec3(uAirSun as any), c.mul(0.5).add(0.5).clamp(0, 1).pow(1.6));
  });

  /** haze / horizon sky color seen along a world direction (linear, scene units) */
  const hazeColor = Fn(([dir]: [Node]) => {
    const x = (azimuthU(dir) as any).mul(N).sub(0.5).toVar();
    const f = x.sub(floor(x));
    const i0 = int(floor(x)).add(N).mod(N);
    const i1 = i0.add(1).mod(N);
    const c = mix(ring.element(i0) as any, ring.element(i1) as any, f).mul(uBrightness);
    return D.enabled ? c.mul(airTint(dir)) : c;
  });

  /** color of the sunlit mist seen along a direction: droplets are white, lit by sky and sun, and
   *  forward-scatter strongly (it glows looking toward the sun) */
  const mistColor = Fn(([dir]: [Node]) => {
    const d = dir as any;
    const cosT = dot(d, uSunDir as any);
    // henyey-greenstein, g = 0.6, normalised so the side-on value is ~0.1
    const g = 0.6;
    const hg = float((1 - g * g) / (4 * Math.PI)).div(float(1 + g * g).sub(cosT.mul(2 * g)).pow(1.5));
    const lit = mix(hazeColor(d) as any, vec3(uMistLit as any), 0.65);
    return lit.add(vec3(uSunColor as any).mul(hg.mul(uMistSun)));
  });

  /** relative mist density at a world xz: 1 + zones, modulated by a slow drifting pattern */
  const mistField = Fn(([xz]: [Node]) => {
    const p = xz as any;
    const acc = float(1).toVar();
    for (let i = 0; i < MAX_MIST_ZONES; i++) {
      const zn = uZones.element(i) as any;
      const d = p.sub(zn.xy);
      acc.addAssign(zn.w.mul(exp(dot(d, d).mul(zn.z).negate())));
    }
    // two crossed long-wave patterns carried downwind: soft banks and thinner lanes, no noise texture
    const q = p.sub(vec2(uWindDir as any).mul(uTime.mul(uMistDrift)));
    const n = sin(q.x.mul(0.011).add(q.y.mul(0.004)).add(uTime.mul(0.05)))
      .mul(cos(q.y.mul(0.013).sub(q.x.mul(0.006))))
      .add(sin(q.x.mul(0.031).add(q.y.mul(0.027)).sub(uTime.mul(0.08))).mul(0.45));
    return acc.mul(float(1).add(n.mul(uMistNoise).mul(0.6))).max(0);
  });

  // integral of exp(-y/h) over a segment from y0 to y1, divided by its length (mean density)
  const meanDensity = (y0: any, y1: any, h: any): any => {
    const dy = y1.sub(y0);
    const e0 = exp(y0.negate().div(h));
    const e1 = exp(y1.negate().div(h));
    return select(abs(dy).greaterThan(0.02), e0.sub(e1).mul(h).div(dy), e0.add(e1).mul(0.5));
  };

  /** optical depths [haze, mist] between the camera and a world point */
  const opticalDepths = (wp: any) => {
    const cam = cameraPosition as any;
    const v = wp.sub(cam);
    const dist = max(v.length(), float(1e-4));
    const dir = v.div(dist);
    // heights clamped at the water: the planar reflection renders from a mirrored camera below it
    const camY = max(cam.y, float(0)), wpY = max(wp.y, float(0));
    const tauA = uAerosol.mul(meanDensity(camY, wpY, uAerosolH)).mul(dist);
    // the mist starts beyond a clear radius around the camera and eases in over `fade` meters
    const startY = max(camY.add(dir.y.mul(uMistNear)), float(0));
    const len = max(dist.sub(uMistNear), float(0));
    const ease = smoothstep(uMistNear, uMistNear.add(uMistFade), dist);
    const mid = cam.xz.add(v.xz.mul(0.65));
    const field = mistField(mid);
    const tauM = uMist.mul(meanDensity(startY, wpY, uMistH)).mul(len).mul(ease).mul(field);
    return { tauA, tauM, dir };
  };

  /** applies haze + mist to a lit color at a world position, as seen from the current camera */
  const applyHaze = Fn(([color, worldPos]: [Node, Node]) => {
    const { tauA, tauM, dir } = opticalDepths(worldPos as any);
    const tau = tauA.add(tauM);
    const t = exp(tau.negate());
    const air = hazeColor(dir) as any;
    const inscatter = air.mul(tauA).add((mistColor(dir) as any).mul(tauM)).div(max(tau, float(1e-5)));
    return mix(inscatter, color as any, t);
  });

  /** mist over the sky background (a ray to infinity): the low layer shows as a soft white band
   *  where the valley opens to the horizon. the sky itself already contains the aerosol haze. */
  const applySkyMist = Fn(([color, dir]: [Node, Node]) => {
    const d = dir as any, cam = cameraPosition as any;
    const camY = max(cam.y, float(0));
    const up = max(d.y, float(0.004));
    const startY = camY.add(up.mul(uMistNear));
    // integral of exp(-y/h) from startY to infinity along the ray: h / dir.y * exp(-startY / h)
    const field = mistField(cam.xz.add(d.xz.mul(400)));
    const tau = uMist.mul(uMistH).div(up).mul(exp(startY.negate().div(uMistH))).mul(field).min(8);
    return mix(mistColor(d) as any, color as any, exp(tau.negate()));
  });

  /** transmittance (1 = clear) of haze + mist between the camera and a world point */
  const transmittance = Fn(([worldPos]: [Node]) => {
    const { tauA, tauM } = opticalDepths(worldPos as any);
    return exp(tauA.add(tauM).negate());
  });

  const fogNode = Fn(() => {
    return vec4(applyHaze(output.rgb, positionWorld) as any, output.a);
  })();

  return {
    fogNode,
    /** the haze color ring (64 azimuth bins, uniform array) and its authored values */
    ring: ring.array as Vector3[],
    ringBase,
    airTint,
    hazeColor,
    mistColor,
    mistField,
    transmittance,
    applyHaze,
    applySkyMist,
    setZones(list: MistZone[]) {
      for (let i = 0; i < MAX_MIST_ZONES; i++) {
        const z = list[i];
        (uZones.array[i] as Vector4).set(z ? z.x : 0, z ? z.z : 0, z ? 1 / (z.radius * z.radius) : 1, z ? z.strength : 0);
      }
    },
    uniforms: {
      aerosol: uAerosol, aerosolHeight: uAerosolH, brightness: uBrightness,
      mist: uMist, mistHeight: uMistH, mistNear: uMistNear, mistFade: uMistFade, mistLit: uMistLit,
      mistSun: uMistSun, mistNoise: uMistNoise, mistDrift: uMistDrift, sunColor: uSunColor,
      airSun: uAirSun, airAway: uAirAway,
    },
  };
}

export type Atmosphere = ReturnType<typeof createAtmosphere>;
