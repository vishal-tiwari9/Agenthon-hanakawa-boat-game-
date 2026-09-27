// rain: thin streaks in a box that travels with the camera. one instanced quad, every drop placed and
// animated in the vertex shader (world-anchored, wrapped around the camera, so nothing swims when the
// boat moves), slanted by the wind. the cpu only sets the instance count and a few uniforms.
import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial, Vector2, Vector3, type Scene } from 'three/webgpu';
import {
  abs, cameraPosition, cross, dot, float, floor, fract, instanceIndex, length, max, normalize, positionGeometry, sin,
  smoothstep, uniform, varying, vec3,
} from 'three/tsl';
import { uTime } from '../core/uniforms';
import { LAYERS } from '../core/layers';

/** drops at full storm; rain alone draws about half */
export const MAX_DROPS = 14000;
/** half width of the box (m) and its height */
const R = 22;
const HGT = 18;
/** drops sit this far below the camera's height at the box bottom */
const BELOW = 5;

// pure expression (built outside a tsl function, so no vars or assignments)
const hash33 = (p: any): any => {
  const a = fract(p.mul(vec3(0.1031, 0.103, 0.0973))) as any;
  const p3 = a.add(dot(a, a.yxz.add(33.33)));
  return fract(p3.xxy.add(p3.yxx).mul(p3.zyx));
};

export class Rain {
  mesh: Mesh;
  /** streak radiance (linear), set from the sky light each frame */
  uColor = uniform(new Vector3(0.5, 0.52, 0.56));
  uOpacity = uniform(0.3);
  /** fall speed (m/s), streak length (m), horizontal drift (m/s, world xz) */
  uSpeed = uniform(9);
  uLen = uniform(0.6);
  uDrift = uniform(new Vector2());
  /** angular size of one pixel (radians): far streaks widen to a pixel and thin out instead of aliasing */
  uPixel = uniform(0.001);

  constructor(scene: Scene) {
    const g = new BufferGeometry();
    // x: across the streak (-1, 1), y: along it (0 = head, 1 = tail)
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]), 3));
    g.setIndex([0, 2, 1, 1, 2, 3]);

    // the camera-facing quad's winding flips with the view side; draw both
    const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
    mat.name = 'render.rain';
    mat.fog = false;
    const idx = float(instanceIndex);
    const h = hash33(vec3(idx, idx.mul(0.37).add(11.3), idx.mul(0.73).add(3.1)));
    const h2 = hash33(h.mul(97.3).add(idx.mul(0.013)));
    const box = vec3(R * 2, HGT, R * 2);
    const speed = (this.uSpeed as any).mul(h2.x.mul(0.3).add(0.85));
    const vel = vec3((this.uDrift as any).x, speed.negate(), (this.uDrift as any).y);
    const dirV = normalize(vel);
    // world-anchored drop, falling along its velocity, wrapped into the box around the camera
    const p = h.mul(box).add(vel.mul(uTime));
    const origin = cameraPosition.sub(vec3(R, BELOW, R));
    const rel = p.sub(origin);
    const wrapped = rel.sub(box.mul(floor(rel.div(box))));
    const center = origin.add(wrapped);
    const toCam = cameraPosition.sub(center);
    const dist = length(toCam);
    const side = normalize(cross(dirV, toCam));
    const thin = float(0.006);
    const width = max(thin, dist.mul(this.uPixel).mul(0.9));
    const len = (this.uLen as any).mul(h2.y.mul(0.5).add(0.75));
    mat.positionNode = center.add(dirV.mul(positionGeometry.y.sub(0.5).mul(len))).add(side.mul(positionGeometry.x.mul(width)));

    // fade: near the lens, toward the box edges (where drops wrap), below the river surface
    const edge = max(abs(wrapped.x.sub(R)), abs(wrapped.z.sub(R)));
    const vFade = varying(
      smoothstep(0.35, 1.8, dist)
        .mul(float(1).sub(smoothstep(R * 0.55, R * 0.95, edge)))
        .mul(smoothstep(0, 1.5, wrapped.y).mul(smoothstep(HGT, HGT - 3, wrapped.y)))
        .mul(smoothstep(-0.05, 0.1, center.y))
        .mul(thin.div(width)),
    );
    const along = positionGeometry.y, across = positionGeometry.x;
    mat.colorNode = vec3(this.uColor as any);
    mat.opacityNode = (this.uOpacity as any).mul(vFade).mul(sin(along.mul(Math.PI))).mul(float(1).sub(across.mul(across)));

    const mesh = new Mesh(g, mat);
    mesh.name = 'render.rain';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // after the water (-50) and the spray sprites, so the river never draws over a falling streak
    mesh.renderOrder = 20;
    mesh.layers.set(LAYERS.NO_REFLECT);
    // hidden until it rains; count 1 so the pipeline warm-up (which shows everything) still builds it
    mesh.count = 1;
    mesh.visible = false;
    this.mesh = mesh;
    scene.add(mesh);
  }

  /** amount 0..1 of MAX_DROPS; 0 hides the mesh (no draw at all) */
  setAmount(k: number) {
    const n = Math.round(Math.max(0, Math.min(1, k)) * MAX_DROPS);
    this.mesh.count = Math.max(1, n);
    this.mesh.visible = n > 0;
  }
}
