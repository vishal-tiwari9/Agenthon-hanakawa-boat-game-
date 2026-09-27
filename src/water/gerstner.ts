// gpu side of the shared gerstner field (src/world/waves.ts). same components, same world
// coordinates, same phases (uWavePhases), same waveScale channel at the rest position.
// the component loop is unrolled at build time; constants are baked into the shader.
import { cos, float, sin, smoothstep, vec3 } from 'three/tsl';
import { WAVES } from '../world/waves';
import { uWavePhases } from '../core/uniforms';

type N = any;

/** per-component lod weight: 1 while the component is resolved, fading to 0 when it is not */
function weight(lambda: number, size: N, lo: number, hi: number): N {
  return float(1).sub(smoothstep(lambda * lo, lambda * hi, size));
}

function theta(rest: N, i: number): N {
  const w = WAVES[i];
  return rest.x.mul(w.k * w.dirX).add(rest.y.mul(w.k * w.dirZ)).sub(uWavePhases.element(i)).add(w.phi0);
}

/**
 * displacement [dx, dy, dz] of rest point `rest` (vec2 world xz) with amplitude scale `s`
 * (waveScale * uWaveAmp). `spacing` (meters between vertices) fades components the mesh cannot
 * resolve; with spacing <= 1 m every component has weight exactly 1, matching displacement() on the cpu.
 */
export function gerstnerDisplacement(rest: N, s: N, spacing?: N): N {
  let dx: N = float(0), dy: N = float(0), dz: N = float(0);
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i];
    const th = theta(rest, i);
    const a = spacing ? s.mul(weight(w.wavelength, spacing, 1 / 6, 1 / 2.5)) : s;
    const h = cos(th).mul(a).mul(w.qa);
    dx = dx.add(h.mul(w.dirX));
    dz = dz.add(h.mul(w.dirZ));
    dy = dy.add(sin(th).mul(a).mul(w.amplitude));
  }
  return vec3(dx, dy, dz);
}

/**
 * analytic surface normal (unnormalized) at the rest point, the same formula as sampleWater().
 * `footprint` (meters per pixel) fades unresolved components; their slope variance is returned in
 * `lost` so the shader can widen the specular lobe instead of aliasing.
 */
export function gerstnerNormal(rest: N, s: N, footprint: N): { n: N; lost: N } {
  let nx: N = float(0), nz: N = float(0), ny: N = float(1), lost: N = float(0);
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i];
    const th = theta(rest, i);
    const wt = weight(w.wavelength, footprint, 1 / 10, 1 / 3.5);
    const wa = s.mul(w.k * w.amplitude);
    const waw = wa.mul(wt);
    const c = cos(th), sn = sin(th);
    nx = nx.sub(c.mul(waw).mul(w.dirX));
    nz = nz.sub(c.mul(waw).mul(w.dirZ));
    ny = ny.sub(sn.mul(waw).mul(w.steepness));
    lost = lost.add(wa.mul(wa).mul(float(1).sub(wt.mul(wt))).mul(0.5));
  }
  return { n: vec3(nx, ny, nz), lost };
}
