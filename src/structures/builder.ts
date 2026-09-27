// a site (harbor, faro, sable, grotta) accumulates merged geometry per material, colliders and
// instanced prop placements, then emits a handful of meshes. small clutter goes to separate
// buckets that skip the reflection pass and do not cast shadows.
import { Group, Matrix4, Mesh, Vector3 } from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GameContext } from '../core/context';
import { GROUPS } from '../core/physics';
import { LAYERS } from '../core/layers';
import { Bucket, type Part, type PartOpts } from './geom';
import type { Materials } from './materials';

export type MatKey =
  | 'cedar' | 'timber' | 'deck' | 'plaster' | 'stone' | 'dressed' | 'bamboo' | 'linen' | 'kawara'
  | 'namako' | 'shoji' | 'paint' | 'lacquer' | 'paper' | 'bronze' | 'rope' | 'hull' | 'dark'
  | 'koshi' | 'foliage' | 'water' | 'gravel' | 'plain';

// ground-hugging, flat-on-a-wall and thin surfaces: no shadow casting; inland-only and tiny ones skip
// the water's mirror. each flag saves a draw per site in that pass
const NO_CAST = new Set(['shoji', 'paper', 'water', 'gravel', 'plain', 'rope', 'linen', 'koshi', 'namako']);
const NO_MIRROR = new Set(['foliage', 'water', 'gravel', 'plain', 'rope', 'linen']);

/** a stable 0..1 hash of a part's placement (its matrix translation) */
export function placeHash(m: Matrix4) {
  const e = m.elements;
  const h = Math.sin(e[12] * 12.9898 + e[13] * 4.1414 + e[14] * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * night lamp seeds: lantern paper gets a flicker phase (aVar.x) and, when it glows by day, the night
 * lamp flag (aVar.y); shoji and lattice panels get a per-window hash (aVar.w) that decides whether
 * and when their room lights up. none of these channels were read before, so the day look is unchanged
 */
function nightSeed(mat: MatKey, m: Matrix4, o: PartOpts = {}): PartOpts {
  const v: [number, number, number, number] = o.v ? [o.v[0], o.v[1], o.v[2], o.v[3]] : [0, 0, 0, 0];
  const h = placeHash(m);
  if (mat === 'paper') {
    if (!v[0]) v[0] = h;
    if (!v[1] && v[3] > 0) v[1] = 1;
  } else if (!v[3]) v[3] = Math.max(h, 1e-3);
  return { ...o, v };
}

/** props placed as instances of loaded gltf models */
export type PropKind = 'basket' | 'bucket';

export interface PropPlacement {
  kind: PropKind;
  m: Matrix4;
  small?: boolean;
}

/** anything parts can be added to: a site, or a view that routes into another site's buckets */
export interface Adder {
  add(mat: MatKey, part: Part, m: Matrix4, o?: PartOpts, small?: boolean): void;
}

/** a view of a site that puts every part in its small buckets (main pass only, no shadow) */
export function smallOf(site: Site): Adder {
  return { add: (mat, part, m, o) => site.add(mat, part, m, o, true) };
}

export class Site {
  buckets = new Map<string, Bucket>();
  props: PropPlacement[] = [];
  colliders: RAPIER.Collider[] = [];
  bollards: Vector3[] = [];
  group = new Group();

  constructor(public ctx: GameContext, public name: string) {
    this.group.name = `structures:${name}`;
  }

  bucket(mat: MatKey, small = false) {
    const k = small ? `${mat}.s` : mat;
    let b = this.buckets.get(k);
    if (!b) this.buckets.set(k, (b = new Bucket()));
    return b;
  }

  add(mat: MatKey, part: Part, m: Matrix4, o?: PartOpts, small = false) {
    if (mat === 'paper' || mat === 'shoji' || mat === 'koshi') o = nightSeed(mat, m, o);
    this.bucket(mat, small).add(part, m, o);
  }

  prop(kind: PropKind, m: Matrix4, small = false) {
    this.props.push({ kind, m, small });
  }

  /** rotated box collider (yaw about y, three.js convention). rounded edges keep docking forgiving */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw = 0, round = 0.12) {
    const R = this.ctx.physics.RAPIER;
    const d = round > 0 ? R.ColliderDesc.roundCuboid(Math.max(0.01, hx - round), Math.max(0.01, hy - round), Math.max(0.01, hz - round), round) : R.ColliderDesc.cuboid(hx, hy, hz);
    d.setTranslation(cx, cy, cz);
    if (yaw) d.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
    d.setFriction(0.3).setRestitution(0.05);
    this.colliders.push(this.ctx.physics.addStatic(d, GROUPS.STATIC));
  }

  hull(points: number[]) {
    const R = this.ctx.physics.RAPIER;
    const d = R.ColliderDesc.convexHull(new Float32Array(points));
    if (!d) return;
    d.setFriction(0.3).setRestitution(0.05);
    this.colliders.push(this.ctx.physics.addStatic(d, GROUPS.STATIC));
  }

  cylinder(cx: number, cy: number, cz: number, halfH: number, r: number) {
    const R = this.ctx.physics.RAPIER;
    const d = R.ColliderDesc.cylinder(halfH, r).setTranslation(cx, cy, cz).setFriction(0.3).setRestitution(0.05);
    this.colliders.push(this.ctx.physics.addStatic(d, GROUPS.STATIC));
  }

  /** emit merged meshes into the scene, yielding between buckets when a slicer is given */
  async finish(mats: Materials, slice?: () => Promise<void>) {
    for (const [k, b] of this.buckets) {
      if (slice) await slice();
      const geo = b.build();
      b.clear();
      if (!geo) continue;
      geo.userData.releaseCpu = true;
      const [key, small] = k.split('.');
      const mat = (mats as any)[key];
      const mesh = new Mesh(geo, mat);
      mesh.name = `${this.name}:${k}`;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (small) {
        mesh.layers.set(LAYERS.NO_REFLECT);
        mesh.castShadow = false;
        mesh.receiveShadow = true;
      } else {
        mesh.castShadow = !NO_CAST.has(key);
        mesh.receiveShadow = true;
        if (NO_MIRROR.has(key)) mesh.layers.set(LAYERS.NO_REFLECT);
      }
      this.group.add(mesh);
    }
    this.buckets.clear();
    this.ctx.scene.add(this.group);
    return this.group;
  }
}
