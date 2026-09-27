// the player's boat: a 7.5 m traditional japanese river boat (wasen) lofted from hullSpec, with a
// woven toma canopy on bamboo hoops, tatami, a paper lantern on a bamboo pole, wooden bitts,
// straw ropes, and a small inboard in a wooden box driving a bronze propeller.
//
// createBoatModel(ctx, { paint?, detail? }) -> { root, setPaint, paints, wheel, propeller, dispose }
//   wheel: invisible proxy at the tiller head. physics rotates it about its local +z
//     (-rudder * 1.5pi, as for a helm wheel); the model turns the tiller and rudder from it.
//   propeller: spin about local +z (runs aft along the shaft).
//   extras: tiller / rudder (the same pivot group, local +y = stock), lantern.
//   paint ids: hull 'natural' | 'dark' | 'vermilion', canopy 'reed' | 'indigo',
//     lantern 'lantern-white' | 'lantern-red'; combine with '+', e.g. 'dark+indigo'.
import { BufferGeometry, Group, Mesh, Object3D, Quaternion, Vector3, type Material } from 'three/webgpu';
import type { GameContext } from '../../core/context';
import { LAYERS } from '../../core/layers';
import { ANCHORS } from '../hullSpec';
import { buildCanopy } from './canopy';
import { SHAFT_DIR, buildFittings } from './fittings';
import { mergeParts } from './geo';
import { buildHull } from './hull';
import { FINISHES, createMaterials, type BoatTextures } from './materials';
import { Parts } from './parts';
import { makeDetailTexture, makeLanternTexture } from './textures';

export type BoatDetail = 'full' | 'simple';

export interface BoatModel {
  root: Group;
  setPaint(id: string): void;
  paints: { id: string; name: string; unlock?: string }[];
  wheel?: Object3D;
  propeller?: Object3D;
  tiller?: Object3D;
  rudder?: Object3D;
  lantern?: Object3D;
  dispose(): void;
}

// default value per custom attribute, per material key (every merged part carries the full set)
const ATTRS: Record<string, Record<string, number[]>> = {
  wood: { wood: [0, 0, 0, 0] },
  bamboo: { seed: [0] },
  lantern: { paper: [1] },
  metal: { tint: [0.1, 0.1, 0.1], mr: [1, 0.5] },
  cloth: { tint: [0.2, 0.2, 0.2] },
};
// small interior parts never show in the water reflection
const NO_REFLECT = new Set(['tatami', 'rope']);

interface Built {
  geos: Record<string, BufferGeometry>;
  rudder: Record<string, BufferGeometry>;
  propeller: BufferGeometry;
  lantern: { hook: Vector3; geo: BufferGeometry };
  refs: number;
  tris: number;
}

const cache = new Map<BoatDetail, Built>();

function mergeAll(parts: Parts) {
  const out: Record<string, BufferGeometry> = {};
  for (const [k, list] of parts.map) {
    const g = mergeParts(list, ATTRS[k] ?? {});
    if (g) out[k] = g;
  }
  return out;
}

function build(detail: BoatDetail): Built {
  const full = detail === 'full';
  const parts = new Parts();
  buildHull(parts, full ? { ns: 170, nt: 24, fine: true } : { ns: 70, nt: 9, fine: false });
  buildCanopy(parts, full);
  const f = buildFittings(parts, full);
  const geos = mergeAll(parts);
  const rudder = mergeAll(f.rudder);
  const propeller = mergeParts(f.propeller, ATTRS.metal)!;
  // hang the lantern from its cord top
  const lanternG = mergeParts(f.lantern.geo.map((g) => g.translate(0, -0.13, 0)), ATTRS.lantern)!;
  const count = (g: BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  let tris = count(propeller) + count(lanternG);
  for (const rec of [geos, rudder]) for (const k in rec) tris += count(rec[k]);
  return { geos, rudder, propeller, lantern: { hook: f.lantern.hook, geo: lanternG }, refs: 0, tris: Math.round(tris) };
}

let texPromise: Promise<BoatTextures> | null = null;

function loadTextures(ctx: GameContext): Promise<BoatTextures> {
  if (!texPromise) {
    const base = '/assets/boat';
    const t = (p: string, srgb: boolean) => ctx.assets.texture(`${base}/${p}`, { srgb });
    texPromise = Promise.all([
      t('brown_planks_03/brown_planks_03_diffuse_2k.jpg', true),
      t('brown_planks_03/brown_planks_03_nor_gl_2k.jpg', false),
      t('brown_planks_03/brown_planks_03_arm_2k.jpg', false),
      t('tatami_mat/tatami_mat_diffuse_2k.jpg', true),
      t('tatami_mat/tatami_mat_nor_gl_2k.jpg', false),
      t('tatami_mat/tatami_mat_arm_2k.jpg', false),
      t('thatch_roof_angled/thatch_roof_angled_diffuse_1k.jpg', true),
      t('thatch_roof_angled/thatch_roof_angled_nor_gl_1k.jpg', false),
      t('hessian_380/hessian_380_diffuse_1k.jpg', true),
      t('hessian_380/hessian_380_nor_gl_1k.jpg', false),
    ]).then(([plankD, plankN, plankA, tatamiD, tatamiN, tatamiA, thatchD, thatchN, clothD, clothN]) => ({
      detail: makeDetailTexture(256),
      lantern: makeLanternTexture(),
      plankD, plankN, plankA, tatamiD, tatamiN, tatamiA, thatchD, thatchN, clothD, clothN,
    }));
    texPromise.catch(() => (texPromise = null));
  }
  return texPromise;
}

export const PAINTS = FINISHES.map(({ id, name, unlock }) => (unlock ? { id, name, unlock } : { id, name }));

export async function createBoatModel(ctx: GameContext, opts: { paint?: string; detail?: BoatDetail } = {}): Promise<BoatModel> {
  const detail: BoatDetail = opts.detail === 'simple' ? 'simple' : 'full';
  const tex = await loadTextures(ctx);
  let built = cache.get(detail);
  if (!built) cache.set(detail, (built = build(detail)));
  built.refs++;
  const B = built;
  const mats = createMaterials(tex);
  const M = mats.materials;

  const root = new Group();
  root.name = `wasen-${detail}`;
  const mesh = (key: string, geo: BufferGeometry, mat: Material = M[key]) => {
    const m = new Mesh(geo, mat);
    m.name = `wasen-${key}`;
    m.castShadow = true;
    m.receiveShadow = true;
    if (NO_REFLECT.has(key)) m.layers.set(LAYERS.NO_REFLECT);
    return m;
  };
  for (const k in B.geos) root.add(mesh(k, B.geos[k]));

  // rudder + tiller pivot; the meshes keep boat-local coordinates (the materials grade by height)
  const rudder = new Group();
  rudder.name = 'wasen-rudder';
  rudder.position.set(0, 0, ANCHORS.rudder.z);
  for (const k in B.rudder) {
    const m = mesh(k, B.rudder[k]);
    m.position.set(0, 0, -ANCHORS.rudder.z);
    rudder.add(m);
  }
  root.add(rudder);

  // proxy the physics module rotates like a helm wheel
  const wheel = new Object3D();
  wheel.name = 'wasen-wheel-proxy';
  wheel.position.copy(ANCHORS.wheel);
  root.add(wheel);

  const propeller = new Group();
  propeller.name = 'wasen-propeller';
  propeller.position.copy(ANCHORS.propeller);
  propeller.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), SHAFT_DIR);
  propeller.add(mesh('metal', B.propeller));
  root.add(propeller);

  const lantern = new Group();
  lantern.name = 'wasen-lantern';
  lantern.position.copy(B.lantern.hook);
  lantern.add(mesh('lantern', B.lantern.geo));
  root.add(lantern);

  const setPaint = (id: string) => {
    for (const part of String(id || '').split('+')) if (part && !mats.set(part)) console.warn('[boat model] unknown paint', part);
  };
  if (opts.paint) setPaint(opts.paint);

  // per frame: tiller and rudder follow the wheel proxy, the lantern swings with the boat
  const invRest = wheel.quaternion.clone().invert(), wq = new Quaternion(), yAxis = new Vector3(0, 1, 0);
  const prevV = new Vector3(), vel = new Vector3(), pos = new Vector3(), prevP = new Vector3(), acc = new Vector3(), rq = new Quaternion();
  let swingX = 0, swingZ = 0, vX = 0, vZ = 0, first = true;
  const unsub = ctx.onUpdate((c) => {
    wq.copy(invRest).multiply(wheel.quaternion);
    const ang = 2 * Math.atan2(wq.z, wq.w);
    const r01 = Math.max(-1, Math.min(1, -ang / (Math.PI * 1.5)));
    rudder.quaternion.setFromAxisAngle(yAxis, r01 * ((35 * Math.PI) / 180));
    if (c.paused) return;
    const dt = Math.min(0.05, Math.max(1e-3, c.time.frameDt));
    root.getWorldPosition(pos);
    if (first) { prevP.copy(pos); first = false; }
    vel.subVectors(pos, prevP).divideScalar(dt);
    acc.subVectors(vel, prevV).divideScalar(dt).clampLength(0, 20);
    prevV.copy(vel);
    prevP.copy(pos);
    // acceleration in the boat frame drives a damped pendulum (cord ~0.13 m + lantern)
    root.getWorldQuaternion(rq).invert();
    acc.applyQuaternion(rq);
    const w2 = 9.81 / 0.3, damp = 2.2;
    vX += (-w2 * swingX - damp * vX - acc.z / 0.3) * dt;
    vZ += (-w2 * swingZ - damp * vZ + acc.x / 0.3) * dt;
    swingX = Math.max(-0.5, Math.min(0.5, swingX + vX * dt));
    swingZ = Math.max(-0.5, Math.min(0.5, swingZ + vZ * dt));
    lantern.rotation.set(swingX, 0, swingZ);
  }, 12);

  let disposed = false;
  return {
    root,
    setPaint,
    paints: PAINTS,
    wheel,
    propeller,
    tiller: rudder,
    rudder,
    lantern,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsub();
      root.removeFromParent();
      mats.dispose();
      if (--B.refs <= 0) {
        cache.delete(detail);
        for (const rec of [B.geos, B.rudder]) for (const k in rec) rec[k].dispose();
        B.propeller.dispose();
        B.lantern.geo.dispose();
      }
    },
  };
}

/** triangle count of a built detail level (for reports) */
export function boatStats(detail: BoatDetail = 'full') {
  const b = cache.get(detail);
  return b ? { tris: b.tris, meshes: Object.keys(b.geos).length + Object.keys(b.rudder).length + 2 } : null;
}

export { FINISHES };
