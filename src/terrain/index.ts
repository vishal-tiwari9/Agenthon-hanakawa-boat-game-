// terrain (owner: terrain): cdlod heightfield rendering of the baked valley, layered pbr ground and
// rock materials, the rapier heightfield collider, and the terrain service other modules use.
import { Mesh, Vector3 } from 'three/webgpu';
import type { GameContext } from '../core/context';
import type { QualityPreset } from '../core/settings';
import { CDLOD, heightNode, heightTexture } from './cdlod';
import { surfaceTexture, packMaskArray } from './fields';
import { noiseData } from './noiseTex';
import { loadLayers, type LayerSource } from './layers';
import { createTerrainMaterial, createRockMaterial, terrainTuning, GROUND, ROCK } from './material';
import { addTerrainCollider } from './collider';
import { createRocks } from './rocks';

const BASE = '/assets/terrain/';
const src = (id: string, res: string): LayerSource => ({
  id,
  diffuse: `${BASE}${id}/${id}_diffuse_${res}.jpg`,
  normal: `${BASE}${id}/${id}_nor_gl_${res}.jpg`,
  arm: `${BASE}${id}/${id}_arm_${res}.jpg`,
});

export async function init(ctx: GameContext) {
  const t0 = performance.now();
  const world = ctx.world;
  const hc = world.channels.get('height')!;
  const hs = { data: hc.data, res: hc.res, size: world.size };

  const cdlod = new CDLOD(hs, ctx.quality.terrainDetail);
  cdlod.minLevel = ctx.quality.terrainDetail < 0.8 ? 1 : 0;
  const hTex = heightTexture(hs);
  const hNode = heightNode(hTex, hs);

  // every layer at 1k in two shared arrays, masks in a third: 5 sampled textures for the whole terrain
  const layers = await loadLayers(ctx.assets, [...GROUND.map((id) => src(id, '1k')), ...ROCK.map((id) => src(id, '1k'))], 1024, [noiseData(512, 11)], 512);
  const textures = {
    surface: surfaceTexture(world),
    masks: packMaskArray(world, [['grass', 'pebbles', 'rock', 'trees'], ['sand', 'moss', 'path', 'wet']]),
    albedo: layers.albedo,
    layerSurface: layers.surface,
    size: world.size,
  };
  const material = createTerrainMaterial(textures, cdlod.positionNode(hNode));
  const mesh = new Mesh(cdlod.geometry, material);
  mesh.name = 'terrain';
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.matrixAutoUpdate = false;
  ctx.scene.add(mesh);

  // rapier heightfield at the height channel's 1 m spacing
  const collider = addTerrainCollider(ctx.physics, hc.data, hc.res, world.size, 1);

  const rocks = await createRocks(ctx, createRockMaterial(textures));

  const cam = new Vector3();
  const updateShadowDir = () => {
    const d = ctx.sun.direction;
    const hl = Math.hypot(d.x, d.z) || 1;
    cdlod.shadowDir.x = -d.x / hl;
    cdlod.shadowDir.z = -d.z / hl;
    cdlod.shadowDir.k = Math.min(3, hl / Math.max(0.2, d.y));
  };
  updateShadowDir();
  ctx.onUpdate((c) => {
    c.camera.updateMatrixWorld();
    c.camera.getWorldPosition(cam);
    updateShadowDir();
    cdlod.update(c.camera, cam);
  }, 55);

  ctx.events.on('quality', (q: QualityPreset) => {
    cdlod.setDetail(q.terrainDetail);
    cdlod.minLevel = q.terrainDetail < 0.8 ? 1 : 0;
  });

  ctx.services.terrain = {
    mesh,
    material,
    collider,
    rocks,
    cdlod,
    tuning: terrainTuning,
    heightAt: (x: number, z: number) => world.heightAt(x, z),
    normalAt: (x: number, z: number) => world.normalAt(x, z),
    stats: () => ({ nodes: cdlod.count, triangles: cdlod.count * 2048 }),
  };
  console.info(`[terrain] ready in ${(performance.now() - t0).toFixed(0)} ms (${hc.res}^2 height, collider ${hc.res}^2)`);
}
