// a site is one bridge / landing / wall run: geometry buckets per material (merged into one draw call
// each), an optional near-detail set hidden with distance, and forgiving static colliders.
import { Group, Matrix4, Mesh, Quaternion, Vector3 } from 'three/webgpu';
import type { GameContext } from '../core/context';
import { GROUPS } from '../core/physics';
import { LAYERS } from '../core/layers';
import { Geo } from './geom';
import type { BridgeMats } from './materials';

export type MatKey = keyof BridgeMats;

export interface ColliderSpec {
  c: Vector3;
  half: Vector3;
  q: Quaternion;
  r: number;
}

export class Site {
  readonly geos = new Map<string, Geo>();
  readonly colliders: ColliderSpec[] = [];
  group = new Group();
  detail: Group | null = null;
  center = new Vector3();
  /** hide the whole site beyond this camera distance */
  far = 900;
  /** hide the near-detail set beyond this distance */
  detailFar = 260;
  /** meshes that go on the no-reflect layer (tiny clutter) */
  noReflect = new Set<string>();
  noShadow = new Set<string>();

  constructor(readonly name: string, public frame: Matrix4 = new Matrix4()) {
    this.center.setFromMatrixPosition(frame);
  }

  /**
   * geometry bucket for a material. near detail used to be a separate set hidden with distance; it now
   * merges into the main bucket (one draw fewer per material, and nothing pops in as the boat nears)
   */
  g(mat: MatKey, detail = false): Geo {
    void detail;
    const k = mat as string;
    let g = this.geos.get(k);
    if (!g) {
      g = new Geo();
      g.at(this.frame);
      this.geos.set(k, g);
    }
    return g;
  }

  /** a collider box centered at a site-local point, aligned with the site frame (plus yaw about y), rounded by r */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, r = 0.12, yaw = 0) {
    const c = new Vector3(cx, cy, cz).applyMatrix4(this.frame);
    const q = new Quaternion().setFromRotationMatrix(this.frame);
    if (yaw) q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw));
    this.boxWorld(c, new Vector3(hx, hy, hz), q, r);
  }

  /** a collider box in world space */
  boxWorld(c: Vector3, half: Vector3, q: Quaternion, r = 0.12) {
    this.colliders.push({ c, half, q, r: Math.min(r, half.x * 0.9, half.y * 0.9, half.z * 0.9) });
  }

  build(ctx: GameContext, mats: BridgeMats) {
    this.group.name = 'bridges:' + this.name;
    let tris = 0;
    for (const [k, geo] of this.geos) {
      const detail = k.startsWith('d:');
      const mk = (detail ? k.slice(2) : k) as MatKey;
      const mat = mats[mk];
      if (!mat) {
        console.warn(`[bridges] ${this.name}: material ${mk} not loaded`);
        continue;
      }
      const bg = geo.build();
      if (!bg) continue;
      tris += bg.attributes.position.count / 3;
      bg.userData.releaseCpu = true;
      const mesh = new Mesh(bg, mat);
      mesh.name = `${this.name}:${k}`;
      mesh.castShadow = !this.noShadow.has(mk);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      if (this.noReflect.has(mk)) mesh.layers.set(LAYERS.NO_REFLECT);
      if (detail) {
        if (!this.detail) {
          this.detail = new Group();
          this.detail.name = this.group.name + ':detail';
          this.group.add(this.detail);
        }
        this.detail.add(mesh);
      } else this.group.add(mesh);
    }
    const R = ctx.physics.RAPIER;
    for (const s of this.colliders) {
      const d = s.r > 0.01
        ? R.ColliderDesc.roundCuboid(Math.max(0.01, s.half.x - s.r), Math.max(0.01, s.half.y - s.r), Math.max(0.01, s.half.z - s.r), s.r)
        : R.ColliderDesc.cuboid(s.half.x, s.half.y, s.half.z);
      d.setTranslation(s.c.x, s.c.y, s.c.z).setRotation({ x: s.q.x, y: s.q.y, z: s.q.z, w: s.q.w });
      d.setFriction(0.15).setRestitution(0.05);
      ctx.physics.addStatic(d, GROUPS.STATIC);
    }
    return tris;
  }

  /** world position of a site-local point */
  world(x: number, y: number, z: number) {
    return new Vector3(x, y, z).applyMatrix4(this.frame);
  }
}
