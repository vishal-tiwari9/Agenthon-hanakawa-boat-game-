// sakura petals drifting through the air across the whole town. one instanced draw, animated on the
// gpu: every petal has a fixed place in a world-anchored pattern that the wind carries downwind while
// it sinks and tumbles, wrapped into a box around the camera, so petals never swim with the view and
// the box edges are invisible (petals shrink to nothing there). denser in the town (s 0-760).
// NO_REFLECT, no shadows.
import { BufferAttribute, DoubleSide, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, Vector3 } from 'three/webgpu';
import {
  Fn, attribute, cameraPosition, cameraViewMatrix, cos, cross, faceDirection, float, fract, length, max, mix, normalLocal,
  normalize, positionGeometry, sin, smoothstep, uniform, varyingProperty, vec3, vec4,
} from 'three/tsl';
import type { GameContext } from '../core/context';
import { LAYERS } from '../core/layers';
import { uTime, uWindDir, uWindStrength } from '../core/uniforms';
import { nearestRiver } from '../world/layout';
import { FoliageMaterial } from './foliage';

type N = any;

const BOX = new Vector3(64, 16, 64);

export function createAirPetals(ctx: GameContext, pixelAngle: N) {
  const count = Math.round(1100 * Math.max(0.5, ctx.quality.particles ?? 1));
  // a petal: a shallow cupped oval with the notch at its tip
  const pos = [0, 0, -0.5, -0.36, 0.04, -0.2, 0.36, 0.04, -0.2, -0.42, 0.08, 0.18, 0.42, 0.08, 0.18, -0.1, 0.03, 0.5, 0.1, 0.03, 0.5, 0, 0.05, 0.4];
  const geo = new InstancedBufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(pos.map((_, i) => (i % 3 === 1 ? 1 : 0))), 3));
  geo.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 7, 3, 7, 4, 4, 7, 6]);
  const seeds = new Float32Array(count * 4), seeds2 = new Float32Array(count * 4);
  let s = 90417;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < count; i++) {
    seeds.set([rnd(), rnd(), rnd(), rnd()], i * 4);
    seeds2.set([rnd(), rnd(), rnd(), rnd()], i * 4);
  }
  geo.setAttribute('aPetal', new InstancedBufferAttribute(seeds, 4));
  geo.setAttribute('aPetal2', new InstancedBufferAttribute(seeds2, 4));
  geo.instanceCount = count;

  const uTown = uniform(1);
  const uCam = uniform(new Vector3());
  const a1 = attribute('aPetal', 'vec4') as N, a2 = attribute('aPetal2', 'vec4') as N;
  const vN = varyingProperty('vec3', 'vPetN') as N;
  const vTint = varyingProperty('float', 'vPetTint') as N;
  const m = new FoliageMaterial({ side: DoubleSide, roughness: 0.55 });
  m.name = 'air-petals';
  m.positionNode = Fn(() => {
    const t = uTime as N;
    const box = vec3(BOX.x, BOX.y, BOX.z);
    const wind = uWindStrength.clamp(0.2, 1.5);
    const speed = a2.x.mul(0.7).add(0.8).mul(wind);
    const fall = a2.y.mul(0.22).add(0.26);
    const ph = a1.w.mul(6.283);
    // where the pattern has carried this petal: downwind, sinking, with a lazy spiral
    const drift = vec3((uWindDir as N).x.mul(speed).mul(t), fall.negate().mul(t), (uWindDir as N).y.mul(speed).mul(t))
      .add(vec3(sin(t.mul(0.9).add(ph)).mul(0.9), sin(t.mul(1.7).add(ph.mul(2))).mul(0.25), cos(t.mul(0.7).add(ph)).mul(0.9)));
    const p0 = a1.xyz.mul(box).add(drift);
    // wrap into the box around the camera (world-anchored, so petals keep their place as the view moves)
    const lo = (uCam as N).sub(box.mul(vec3(0.5, 0.25, 0.5)));
    const rel = fract(p0.sub(lo).div(box)) as N;
    const centre = rel.sub(vec3(0.5, 0.25, 0.5)).mul(2).abs();
    // shrink to nothing near the box faces so wrapping never pops
    const edge = float(1).sub(smoothstep(0.72, 0.98, max(centre.x, centre.z))).mul(float(1).sub(smoothstep(0.62, 0.98, centre.y)));
    const wp = lo.add(rel.mul(box));
    const d = length(cameraPosition.sub(wp));
    const size = max(a2.z.mul(0.012).add(0.024), d.mul(pixelAngle).mul(1.1)).mul(edge).mul(smoothstep(0.25, 1.2, d)).mul(uTown)
      .mul(float(1).sub(smoothstep(24, 34, d)).mul(0.75).add(0.25));
    // tumble about a per-petal axis
    const ax = normalize(vec3(a2.w.sub(0.5), 0.6, a1.w.sub(0.5)));
    const ang = t.mul(a2.x.mul(2.4).add(1.3)).add(ph);
    const g = positionGeometry as N;
    const c = cos(ang), sn = sin(ang);
    const rot = (v: N): N => (v as N).mul(c).add((cross(ax, v) as N).mul(sn)).add((ax as N).mul((ax as N).dot(v)).mul(float(1).sub(c)));
    const local = rot(g.mul(size));
    const n = rot(vec3(0, 1, 0));
    normalLocal.assign(n);
    vN.assign(n);
    vTint.assign(a2.z);
    return wp.add(local);
  })();
  // pale somei-yoshino pink to near white
  m.colorNode = mix(vec3(0.86, 0.6, 0.66), vec3(0.88, 0.8, 0.8), vTint);
  m.normalNode = normalize((cameraViewMatrix as N).mul(vec4(normalize(vN.mul(faceDirection)) as N, float(0))).xyz);
  m.translucencyNode = float(0.85);
  m.translucencyTint = vec3(1.1, 0.92, 0.95);
  const mesh = new Mesh(geo, m);
  mesh.name = 'air-petals';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.layers.set(LAYERS.NO_REFLECT);
  mesh.matrixAutoUpdate = false;
  ctx.scene.add(mesh);

  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const update = (cam: Vector3) => {
    (uCam.value as Vector3).copy(cam);
    // thick over the town and temple, a light scatter up the valley
    const r = nearestRiver(cam.x, cam.z);
    const town = 1 - Math.min(1, Math.max(0, (r.s - 760) / 160)) * 0.7;
    uTown.value = reduced ? 0 : town;
    mesh.visible = !reduced;
  };
  return { mesh, update, count };
}
