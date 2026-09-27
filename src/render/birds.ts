// a few distant birds: small flocks of kites / herons circling high over the valley at a handful of
// river stations. one instanced mesh (a thin body with two wings), wings flapped in the vertex
// shader, positions advanced on the cpu (a few dozen matrices). they read as dark silhouettes
// against the sky and pick up the haze like everything else.
import {
  BufferAttribute, BufferGeometry, DoubleSide, InstancedMesh, Matrix4, MeshBasicNodeMaterial, Quaternion, Vector3,
  type Scene,
} from 'three/webgpu';
import { abs, float, instanceIndex, positionLocal, sin, vec3 } from 'three/tsl';
import { uTime } from '../core/uniforms';
import { LAYERS } from '../core/layers';
import { riverFrame } from '../world/layout';

interface Bird {
  cx: number; cy: number; cz: number;
  radius: number; speed: number; phase: number; bank: number; bob: number;
}

// flock stations: along-river s, height above the river, birds
const FLOCKS: [number, number, number][] = [[360, 62, 3], [760, 95, 4], [1280, 80, 2], [1720, 60, 4], [2020, 100, 3]];

function birdGeometry() {
  // span ~1.6 m, seen from afar; x = span, z = along the body (nose toward -z)
  const v = [
    // left wing
    0, 0, -0.12, -0.8, 0.02, 0.05, 0, 0, 0.18,
    // right wing
    0, 0, -0.12, 0, 0, 0.18, 0.8, 0.02, 0.05,
    // body + tail
    0, 0.01, -0.3, -0.06, 0, 0.3, 0.06, 0, 0.3,
  ];
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(v), 3));
  g.computeVertexNormals();
  return g;
}

export class Birds {
  mesh: InstancedMesh;
  private birds: Bird[] = [];
  private m = new Matrix4();
  private q = new Quaternion();
  private p = new Vector3();
  private s = new Vector3(1, 1, 1);
  private up = new Vector3(0, 1, 0);
  private fwd = new Vector3();
  private zero = new Vector3();
  private zAxis = new Vector3(0, 0, 1);
  private bankQ = new Quaternion();

  constructor(scene: Scene) {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const [s, h, n] of FLOCKS) {
      const f = riverFrame(s);
      for (let i = 0; i < n; i++) {
        this.birds.push({
          cx: f.x + (rnd() - 0.5) * 60, cy: h + (rnd() - 0.5) * 25, cz: f.z + (rnd() - 0.5) * 60,
          radius: 25 + rnd() * 45, speed: (0.12 + rnd() * 0.1) * (rnd() < 0.5 ? -1 : 1), phase: rnd() * Math.PI * 2,
          bank: 0.25 + rnd() * 0.2, bob: rnd() * 10,
        });
      }
    }
    const mat = new MeshBasicNodeMaterial({ color: 0x1d2024, side: DoubleSide });
    mat.name = 'render.birds';
    // flap: wing tips (|x| large) move up and down; a slow glide phase every few seconds
    const idx = float(instanceIndex);
    const t = uTime.add(idx.mul(1.37));
    const glide = sin(t.mul(0.35)).mul(0.5).add(0.5).smoothstep(0.55, 0.9);
    const flap = sin(t.mul(9.0)).mul(float(1).sub(glide)).add(glide.mul(0.12));
    const tip = abs(positionLocal.x);
    mat.positionNode = positionLocal.add(vec3(0, tip.mul(tip).mul(0.55).mul(flap), 0));
    this.mesh = new InstancedMesh(birdGeometry(), mat, this.birds.length);
    this.mesh.name = 'render.birds';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // tiny and far: skip the planar reflection
    this.mesh.layers.set(LAYERS.NO_REFLECT);
    scene.add(this.mesh);
    this.update(0);
  }

  update(time: number) {
    const { m, q, p, s, up, fwd, zero, zAxis, bankQ } = this;
    for (let i = 0; i < this.birds.length; i++) {
      const b = this.birds[i];
      const a = b.phase + time * b.speed;
      p.set(b.cx + Math.cos(a) * b.radius, b.cy + Math.sin(time * 0.2 + b.bob) * 3, b.cz + Math.sin(a) * b.radius);
      // tangent of the circle, nose along it (the model's nose is -z)
      const dir = Math.sign(b.speed);
      fwd.set(-Math.sin(a) * dir, 0, Math.cos(a) * dir);
      // lookAt(eye, target) aims +z from target to eye; eye = origin, target = fwd puts -z (the nose) on fwd
      m.lookAt(zero, fwd, up);
      q.setFromRotationMatrix(m);
      // bank into the turn
      q.multiply(bankQ.setFromAxisAngle(zAxis, b.bank * dir));
      s.setScalar(1.15);
      m.compose(p, q, s);
      this.mesh.setMatrixAt(i, m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
  }
}
