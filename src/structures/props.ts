// village props: bamboo fences, mooring stakes, and instanced poly haven models (baskets, buckets).
// kept sparse and placed with intent: gear where people work, nothing strewn about.
import { Group, InstancedMesh, Mesh, type Matrix4, type Object3D } from 'three/webgpu';
import type { GameContext } from '../core/context';
import { LAYERS } from '../core/layers';
import { chamferBox, cylinder, trs } from './geom';
import type { PropKind, Site } from './builder';

const MODEL_URL: Record<PropKind, string> = {
  basket: '/assets/structures/wicker_basket_02/wicker_basket_02_1k.gltf',
  bucket: '/assets/structures/wooden_bucket_01/wooden_bucket_01_1k.gltf',
};
/** uniform scale per model so they read at a believable size */
const MODEL_SCALE: Record<PropKind, number> = { basket: 1.9, bucket: 1.0 };

/** a woven bamboo fence panel (misugaki style) between two ground points, with posts and ties */
export function bambooFence(site: Site, ax: number, ay: number, az: number, bx: number, bz: number, h = 1.2) {
  const len = Math.hypot(bx - ax, bz - az);
  const yaw = Math.atan2(bx - ax, bz - az) - Math.PI / 2;
  const cx = (ax + bx) / 2, cz = (az + bz) / 2;
  const m = trs(cx, ay, cz, yaw);
  site.add('bamboo', chamferBox(len, h, 0.03, 0, 'y'), m.clone().multiply(trs(0, h / 2 + 0.05, 0)), { col: [1, 0.95, 0.85] }, true);
  const posts = Math.max(2, Math.round(len / 1.8) + 1);
  for (let i = 0; i < posts; i++) {
    const x = -len / 2 + (i * len) / (posts - 1);
    site.add('timber', cylinder(0.05, 0.05, h + 0.25, 8), m.clone().multiply(trs(x, -0.1, 0.03)), { col: [1.2, 1.1, 1] }, true);
  }
  for (const y of [0.3, h - 0.15]) {
    site.add('bamboo', cylinder(0.022, 0.022, len, 6, false), m.clone().multiply(trs(-len / 2, y, 0.035, 0, 0, -Math.PI / 2)), { col: [0.9, 0.8, 0.6] }, true);
    site.add('bamboo', cylinder(0.022, 0.022, len, 6, false), m.clone().multiply(trs(-len / 2, y, -0.035, 0, 0, -Math.PI / 2)), { col: [0.9, 0.8, 0.6] }, true);
  }
}

/** a wooden mooring stake (kui) standing in the river, top at y = top */
export function stake(site: Site, x: number, z: number, bed: number, top: number) {
  site.add('timber', cylinder(0.08, 0.07, top - bed, 8), trs(x, bed, z), { col: [1.1, 1.05, 1] });
  site.add('rope', cylinder(0.085, 0.085, 0.1, 8), trs(x, top - 0.35, z), { col: [0.42, 0.34, 0.2] }, true);
}

/** start fetching the prop models early so they arrive while the geometry builds */
export function preloadProps(ctx: GameContext) {
  for (const url of Object.values(MODEL_URL)) ctx.assets.gltf(url).catch(() => {});
}

/** load the gltf props that a list of sites needs and add them as instanced meshes */
export async function instanceProps(ctx: GameContext, sites: Site[]) {
  const byKind = new Map<PropKind, { m: Matrix4; small?: boolean }[]>();
  for (const s of sites) for (const p of s.props) {
    if (!byKind.has(p.kind)) byKind.set(p.kind, []);
    byKind.get(p.kind)!.push(p);
  }
  const root = new Group();
  root.name = 'structures:props';
  await Promise.all([...byKind.entries()].map(async ([kind, list]) => {
    let gltf;
    try {
      gltf = await ctx.assets.gltf(MODEL_URL[kind]);
    } catch (e) {
      console.warn('[structures] prop failed', kind, e);
      return;
    }
    gltf.scene.updateMatrixWorld(true);
    const meshes: Mesh[] = [];
    gltf.scene.traverse((o: Object3D) => {
      if ((o as Mesh).isMesh) meshes.push(o as Mesh);
    });
    const sc = MODEL_SCALE[kind];
    for (const small of [false, true]) {
      const sub = list.filter((p) => !!p.small === small);
      if (!sub.length) continue;
      for (const mesh of meshes) {
        const im = new InstancedMesh(mesh.geometry, mesh.material, sub.length);
        sub.forEach((p, i) => im.setMatrixAt(i, p.m.clone().multiply(trs(0, 0, 0, 0, 0, 0, sc, sc, sc)).multiply(mesh.matrixWorld)));
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.castShadow = !small;
        im.receiveShadow = true;
        if (small) im.layers.set(LAYERS.NO_REFLECT);
        im.name = `prop:${kind}`;
        root.add(im);
      }
    }
  }));
  ctx.scene.add(root);
  return root;
}
