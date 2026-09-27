// vegetation (owner: vegetation): the forested valley walls (cedar, broadleaf, cherry in bloom,
// japanese maple) with baked impostors, procedural grass, wildflowers and understory shrubs, all
// placed from the baked world and swayed by one shared wind field. grass and flowers live on
// LAYERS.NO_REFLECT and never cast shadows; shrubs and trees cast and are reflected.
// everything scales with quality.vegetationDensity / grassDistance.
// init returns quickly: the field and the painted atlases load from shipped bakes (baked.ts; stale or
// missing bakes are rebuilt here, rows nearest the camera first), then the forest, garden trees and
// bank details build in the background in slices of at most ~30 ms, and ctx.services.vegetation.ready
// resolves when all of it is in (main awaits it before the pipeline warm-up and game:ready).
import { Group, Vector3, type Mesh } from 'three/webgpu';
import { mix, positionWorld, vec3 } from 'three/tsl';
import type { GameContext } from '../core/context';
import type { QualityPreset } from '../core/settings';
import { LAYERS } from '../core/layers';
import { VegetationField, footprintDistance, type Footprint, type HeightFn } from './field';
import { fillFieldTexture, vegetationBloomTexture, vegetationFieldNode, vegetationGroundAlbedo } from './palette';
import { TileLayer } from './tiles';
import {
  GRASS_ATTRIBS, GRASS_LOD, GRASS_STRIDE, buildTuftGeometry, createGrassMaterial, densityAtCPU, generateGrassTile, grassDist,
} from './grass';
import {
  FLOWER_ATTRIBS, FLOWER_LOD, FLOWER_STRIDE, buildFlowerGeometry, createFlowerMaterial, flowerDensityCPU, flowerDist, generateFlowerTile,
} from './flowers';
import { SHRUB_ATTRIBS, SHRUB_LOD, SHRUB_LODS, SHRUB_SHADOW, SHRUB_STRIDE, buildShrubGeometry, createShrubMaterial, generateShrubTile, shrubDist } from './shrubs';
import { Forest, forestDist, planForest, uViewPos, type SpeciesDef } from './forest';
import { blossomAtlas, gardenAtlas, mapleAtlas } from './atlas';
import { atlasSignature, canvasPixels, fieldSignature, loadAtlas, loadBaked } from './baked';
import { createBankDetails } from './bankDetails';
import { GardenTrees, planGarden } from './gardenTrees';
import { viewStats } from './townView';
import { createAirPetals } from './petals';

const TILE = 24;
// shrubs are sparse (about one per 30 m tile): large tiles keep them to a handful of draws
const SHRUB_TILE = 200;
const LEAF_ATLAS = '/assets/vegetation/island_tree_01/island_tree_01_leaves_diff_1k.png';

export async function init(ctx: GameContext) {
  const terrain = ctx.services.terrain as { heightAt?: (x: number, z: number) => number } | undefined;
  const heightAt: HeightFn = typeof terrain?.heightAt === 'function'
    ? (x, z) => terrain.heightAt!(x, z)
    : (x, z) => ctx.world.heightAt(x, z);

  // *Ms are wall times (other modules build alongside); cpuMs sums vegetation's own main-thread slices
  const times = { fieldMs: 0, forestMs: 0, planMs: 0, gardenMs: 0, banksMs: 0, buildMs: 0, sliceMaxMs: 0, cpuMs: 0, fieldBaked: false, atlasesBaked: 0 };
  const tInit = performance.now();
  const field = new VegetationField(ctx.world, heightAt, true);
  let fieldReady = false;
  const pause = () => new Promise<void>((r) => setTimeout(r, 0));

  const cam = new Vector3();
  const root = new Group();
  root.name = 'vegetation';
  root.matrixAutoUpdate = false;
  ctx.scene.add(root);

  let footprints: Footprint[] = [];
  const excluded = (x: number, z: number, r = 0) => {
    for (const f of footprints) if (footprintDistance(f, x, z) < r) return true;
    return false;
  };

  const params = { grassDensity: 30, flowerDensity: 44, shrubAccept: 0.4 };
  const applyQuality = (q: QualityPreset) => {
    grassDist.end.value = q.grassDistance;
    grassDist.full.value = Math.max(14, q.grassDistance * 0.2);
    params.grassDensity = 30 * q.vegetationDensity;
    flowerDist.end.value = Math.min(95, q.grassDistance * 0.62);
    flowerDist.full.value = Math.max(10, q.grassDistance * 0.12);
    params.flowerDensity = 44 * Math.sqrt(q.vegetationDensity);
    shrubDist.end.value = 180 + 260 * q.vegetationDensity;
    params.shrubAccept = 0.4 * Math.sqrt(q.vegetationDensity);
    forestDist.near.value = q.name === 'low' ? 48 : q.name === 'high' ? 90 : 68;
    forestDist.lod0.value = q.name === 'low' ? 18 : q.name === 'high' ? 36 : 26;
    forestDist.shadowFar.value = q.shadowDistance * 0.9;
  };
  applyQuality(ctx.quality);

  const grass = new TileLayer({
    name: 'grass',
    tileSize: TILE,
    stride: GRASS_STRIDE,
    attribs: GRASS_ATTRIBS,
    lods: [buildTuftGeometry(18, 4, 11), buildTuftGeometry(18, 2, 11), buildTuftGeometry(18, 1, 11)],
    material: createGrassMaterial(),
    maxDistance: () => grassDist.end.value as number,
    lodFor: (d) => (d < GRASS_LOD[0] ? 0 : d < GRASS_LOD[1] ? 1 : 2),
    needFor: (d) => densityAtCPU(d),
    hasContent: (tx, tz) => field.maxOver(field.density, tx * TILE, tz * TILE, (tx + 1) * TILE, (tz + 1) * TILE) > 0.004,
    groundAt: (x, z) => Math.max(0, ctx.world.heightAt(x, z)),
    generate: (tx, tz, need) => generateGrassTile({ field, heightAt, tileSize: TILE, maxDensity: params.grassDensity, excluded }, tx, tz, need),
    maxHeight: 1.2,
    layer: LAYERS.NO_REFLECT,
    castShadow: false,
    receiveShadow: true,
  }, root);

  const flowers = new TileLayer({
    name: 'flowers',
    tileSize: TILE,
    stride: FLOWER_STRIDE,
    attribs: FLOWER_ATTRIBS,
    lods: [buildFlowerGeometry(3, true), buildFlowerGeometry(2, false)],
    material: createFlowerMaterial(),
    maxDistance: () => flowerDist.end.value as number,
    lodFor: (d) => (d < FLOWER_LOD ? 0 : 1),
    needFor: (d) => flowerDensityCPU(d),
    hasContent: (tx, tz) => field.maxOver(field.flower, tx * TILE, tz * TILE, (tx + 1) * TILE, (tz + 1) * TILE) > 0.01,
    groundAt: (x, z) => Math.max(0, ctx.world.heightAt(x, z)),
    generate: (tx, tz, need) => generateFlowerTile({ field, heightAt, tileSize: TILE, maxDensity: params.flowerDensity, excluded }, tx, tz, need),
    maxHeight: 0.7,
    layer: LAYERS.NO_REFLECT,
    castShadow: false,
    receiveShadow: true,
  }, root);

  let shrubs: TileLayer | null = null;
  const makeShrubs = async () => {
    const leafTex = await ctx.assets.texture(LEAF_ATLAS, { srgb: true });
    // atlas uvs are in image space (y down), like gltf
    leafTex.flipY = false;
    leafTex.needsUpdate = true;
    shrubs = new TileLayer({
      name: 'shrubs',
      tileSize: SHRUB_TILE,
      stride: SHRUB_STRIDE,
      attribs: SHRUB_ATTRIBS,
      lods: SHRUB_LODS.map((l) => buildShrubGeometry(l.cards)),
      material: createShrubMaterial(leafTex),
      maxDistance: () => shrubDist.end.value as number,
      lodFor: (d) => (d < SHRUB_LOD[0] ? 0 : d < SHRUB_LOD[1] ? 1 : 2),
      needFor: () => 1,
      hasContent: (tx, tz) => field.maxOver(field.shrub, tx * SHRUB_TILE, tz * SHRUB_TILE, (tx + 1) * SHRUB_TILE, (tz + 1) * SHRUB_TILE) > 0.03,
      groundAt: (x, z) => Math.max(0, ctx.world.heightAt(x, z)),
      generate: (tx, tz) => generateShrubTile({ field, heightAt, tileSize: SHRUB_TILE, spacing: 5, accept: params.shrubAccept, excluded }, tx, tz),
      maxHeight: 2.5,
      margin: 5,
      // low mounds read nowhere in the rippled mirror; keep them out of that pass
      layer: LAYERS.NO_REFLECT,
      castShadow: true,
      shadowDistance: SHRUB_SHADOW,
      receiveShadow: true,
    }, root);
  };

  // the forest: cedar / fir, broadleaf, cherry, maple. assets load while the field builds
  let forest: Forest | null = null;
  const cedarNodes = ['fir_sapling_medium_a_LOD0', 'fir_sapling_medium_b_LOD0', 'fir_sapling_medium_c_LOD0'];
  const baked = (t: unknown) => { if (!(t as any).isCanvasTexture) times.atlasesBaked++; return t as any; };
  const loadForest = async () => {
    const t1 = performance.now();
    const f = new Forest(ctx);
    const [blossom, maple] = (await Promise.all([loadAtlas('blossom', () => blossomAtlas()), loadAtlas('maple', () => mapleAtlas())])).map(baked);
    const defs: SpeciesDef[] = [
      { id: 'cedar', asset: 'fir_sapling_medium', nodes: cedarNodes, leafAtlas: null, leafTint: [0.72, 0.8, 0.62], barkTint: [0.62, 0.55, 0.5], cardScale: 1.08, translucency: 0.25, frames: 8, framePx: 160 },
      { id: 'broadleaf', asset: 'island_tree_01', nodes: [], leafAtlas: null, leafTint: [0.8, 0.95, 0.66], barkTint: [0.75, 0.72, 0.68], cardScale: 1, translucency: 0.5, frames: 8, framePx: 112 },
      { id: 'cherry', asset: 'island_tree_01', nodes: [], leafAtlas: blossom, leafTint: [1, 1, 1], barkTint: [0.42, 0.34, 0.31], cardScale: 1.55, translucency: 0.3, frames: 8, framePx: 128 },
      { id: 'cherry', asset: 'island_tree_02', nodes: [], leafAtlas: blossom, leafTint: [1, 1, 1], barkTint: [0.42, 0.34, 0.31], cardScale: 1.55, translucency: 0.3, frames: 8, framePx: 128, variantOffset: 1 },
      { id: 'maple', asset: 'island_tree_02', nodes: [], leafAtlas: maple, leafTint: [1, 1, 1], barkTint: [0.55, 0.5, 0.46], cardScale: 1.15, translucency: 0.65, frames: 8, framePx: 112 },
    ];
    await f.load(defs);
    times.forestMs = performance.now() - t1;
    return f;
  };
  const forestLoading = loadForest().catch((e) => { console.error('[vegetation] forest failed', e); return null; });
  const gardenAtlasLoading = loadAtlas('garden', () => gardenAtlas()).then(baked);
  const fieldLoading = loadBaked('field', fieldSignature(ctx.world, field.res));
  const shrubsLoading = makeShrubs().catch((e) => { console.error('[vegetation] shrubs failed', e); });

  let garden: GardenTrees | null = null;
  const petals = createAirPetals(ctx, grassDist.pixelAngle);
  let bankDetails: ReturnType<typeof createBankDetails> | null = null;
  // background build, near-first, in short slices
  const slice = async (fn: () => void) => {
    const t = performance.now();
    fn();
    const dt = performance.now() - t;
    times.sliceMaxMs = Math.max(times.sliceMaxMs, dt);
    times.cpuMs += dt;
    await pause();
  };
  const build = (async () => {
    const tb = performance.now();
    ctx.camera.getWorldPosition(cam);
    const fieldBytes = await fieldLoading;
    if (fieldBytes) {
      await slice(() => field.unpack(fieldBytes));
      for (let j = 0; j < field.res; j += 256) await slice(() => field.fillNormals(j, j + 256));
      times.fieldBaked = true;
    } else {
      await field.buildAsync(cam.z, 24);
      times.cpuMs += field.busyMs;
    }
    await slice(() => {
      fillFieldTexture(field.packRGBA(), field.res, field.size);
      fillFieldTexture(field.bloom, field.res, field.size, vegetationBloomTexture);
      fieldReady = true;
      times.fieldMs = performance.now() - tb;
    });
    await shrubsLoading;
    const f = await forestLoading;
    if (f) {
      try {
        const t2 = performance.now();
        const planBusy = { ms: 0 };
        const trees = await planForest(ctx, { heightAt, density: 2.2 * Math.max(0.6, ctx.quality.vegetationDensity), excluded, busy: planBusy }, (id) => (id === 'cedar' ? cedarNodes.length : 1));
        times.planMs = performance.now() - t2;
        times.cpuMs += planBusy.ms;
        await slice(() => {
          f.build(trees);
          root.add(f.root);
          forest = f;
        });
      } catch (e) {
        console.error('[vegetation] forest failed', e);
      }
    }
    const gardenTex = await gardenAtlasLoading;
    await slice(() => {
      const t3 = performance.now();
      try {
        garden = new GardenTrees(ctx, planGarden(ctx, heightAt), gardenTex);
        root.add(garden.root);
      } catch (e) {
        console.error('[vegetation] garden trees failed', e);
      }
      times.gardenMs = performance.now() - t3;
    });
    await slice(() => {
      const t4 = performance.now();
      bankDetails = createBankDetails(ctx, heightAt);
      times.banksMs = performance.now() - t4;
    });
    times.buildMs = performance.now() - tb;
  })();
  const size = { h: ctx.canvas.height || 1080 };
  ctx.events.on('resize', () => { size.h = ctx.canvas.height || 1080; });

  ctx.onUpdate(() => {
    const c = ctx.camera;
    c.getWorldPosition(cam);
    // the player camera for every lod and visibility decision (shadow passes included)
    (uViewPos.value as Vector3).copy(cam);
    const pa = (2 * Math.tan(((c.fov * Math.PI) / 180) / 2)) / Math.max(1, size.h);
    grassDist.pixelAngle.value = pa;
    flowerDist.pixelAngle.value = pa;
    if (fieldReady) {
      grass.update(cam, 2.5);
      flowers.update(cam, 1);
      shrubs?.update(cam, 1);
    }
    (forest as Forest | null)?.update(cam);
    (garden as GardenTrees | null)?.update(cam);
    petals.update(cam);
  }, 65);

  const clearAll = () => {
    grass.clear();
    flowers.clear();
    (shrubs as TileLayer | null)?.clear();
  };
  ctx.events.on('quality', (q: QualityPreset) => {
    applyQuality(q);
    clearAll();
  });

  // structures come up after vegetation; clear vegetation from any footprints they publish
  ctx.events.on('game:ready', () => {
    const s = ctx.services.structures as { footprints?: Footprint[] } | undefined;
    if (s && Array.isArray(s.footprints) && s.footprints.length) {
      footprints = s.footprints;
      clearAll();
      (garden as GardenTrees | null)?.exclude(footprints);
    }
  });

  // test-only: preview vegetationGroundAlbedo on the current terrain meshes (never called by the game)
  const previewGround = (strength = 0.9) => {
    let n = 0;
    ctx.scene.traverse((o: any) => {
      if (!o.isMesh || o.parent === root || root.children.includes(o) || !o.receiveShadow) return;
      const g = (o as Mesh).geometry as any;
      if (!g?.attributes?.position || g.attributes.position.count < 100000) return;
      const m = o.material as any;
      if (!m?.isNodeMaterial || m.userData.vegPreview) return;
      const base = m.colorNode ?? vec3(m.color.r, m.color.g, m.color.b);
      const dens = (vegetationFieldNode(positionWorld.xz) as any).r;
      m.colorNode = mix(base as any, vegetationGroundAlbedo(positionWorld) as any, dens.mul(1.6).clamp(0, 1).mul(strength));
      m.userData.vegPreview = true;
      m.needsUpdate = true;
      n++;
    });
    return n;
  };

  /** test/scripts/vegetation-export.mjs only: a fresh field and fresh paintings, as shippable bytes */
  const exportBakes = () => {
    const f = new VegetationField(ctx.world, heightAt, false);
    const out: { key: string; signature: string; size?: number; bytes: Uint8Array }[] = [{ key: 'field', signature: fieldSignature(ctx.world, f.res), bytes: f.pack() }];
    for (const [name, paint] of [['blossom', blossomAtlas], ['maple', mapleAtlas], ['garden', gardenAtlas]] as const) {
      const t = paint();
      const { size, bytes } = canvasPixels(t);
      t.dispose();
      out.push({ key: `atlas:${name}`, signature: atlasSignature(name, size), size, bytes });
    }
    return out;
  };

  ctx.services.vegetation = {
    ready: build,
    exportBakes,
    previewGround,
    field,
    grass,
    flowers,
    root,
    get shrubs() { return shrubs; },
    get forest() { return forest; },
    get garden() { return garden; },
    stats: () => ({
      ...times,
      initMs,
      garden: garden ? { ...(garden as GardenTrees).stats, species: (garden as GardenTrees).species.map((s) => `${s.id}:${s.count}`) } : null,
      view: { ...viewStats },
      forest: forest ? { ...(forest as Forest).stats } : null,
      banks: bankDetails ? (bankDetails as ReturnType<typeof createBankDetails>).stats() : null,
      grass: { ...grass.stats },
      flowers: { ...flowers.stats },
      shrubs: shrubs ? { ...(shrubs as TileLayer).stats } : null,
    }),
  };
  const initMs = performance.now() - tInit;
}
