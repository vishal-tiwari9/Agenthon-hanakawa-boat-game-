import { unpackGzip } from '../core/compression';
// baked bounce light over the village / bridge / pagoda stretch: a LightProbeGrid captured with a black sky, so the probes
// hold only light reflected by sunlit / sky-lit surfaces (warm sand and stone, green grass). it is
// added on top of the sky ibl, so a probe that ends up inside terrain only misses some bounce; it
// can never darken anything. the grid exists (zeroed) from init so materials compile once with it.
import { Data3DTexture, HalfFloatType, LinearFilter, Mesh, MeshBasicNodeMaterial, PlaneGeometry, RGBAFormat, type Scene, type WebGPURenderer } from 'three/webgpu';
import { getCurrentStack, vec4 } from 'three/tsl';
import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js';
// @ts-expect-error no bundled declaration for this addon
import { LightProbeGridNode } from 'three/addons/tsl/lighting/LightProbeGridNode.js';
import { SUN, riverFrame } from '../world/layout';
import { TUNE } from './config';

// some custom lighting paths build light nodes outside a tsl stack; the stock node would then log
// an error per material. skip the contribution there instead (that material just gets no bounce).
const skipped = new Set<string>();
class SafeProbeGridNode extends LightProbeGridNode {
  setup(builder: any) {
    // transparent surfaces (water, spray) have no meaningful diffuse; keep their texture slots free
    if (builder.material?.transparent) return;
    if ((getCurrentStack as any)() === null) {
      const m = builder.material;
      const key = `${m?.type}:${m?.name}`;
      if (!skipped.has(key)) { skipped.add(key); console.info(`[render] bounce probes skipped for ${key} (no tsl stack)`); }
      return;
    }
    return super.setup(builder);
  }
}

export class BounceProbes {
  grid: LightProbeGrid;
  baked = false;
  bakeMs = 0;
  loaded = false;
  private cachedTexture: Data3DTexture | null = null;
  private cacheSignature = '';

  constructor(private renderer: WebGPURenderer, private scene: Scene) {
    renderer.library.addLight(SafeProbeGridNode as any, LightProbeGrid as any);
    const p = TUNE.probes;
    // bounds of the covered river stretch, banks included
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let s = p.sRange[0]; s <= p.sRange[1]; s += 10) {
      const f = riverFrame(s);
      const r = f.width / 2 + p.margin;
      x0 = Math.min(x0, f.x - r); x1 = Math.max(x1, f.x + r);
      z0 = Math.min(z0, f.z - r); z1 = Math.max(z1, f.z + r);
    }
    const w = x1 - x0, d = z1 - z0, h = p.yRange[1] - p.yRange[0];
    const nx = Math.min(24, Math.max(2, Math.round(w / p.spacing) + 1));
    const nz = Math.min(24, Math.max(2, Math.round(d / p.spacing) + 1));
    const grid = new LightProbeGrid(w, h, d, nx, p.layers, nz);
    grid.name = 'render.bounceProbes';
    grid.position.set((x0 + x1) / 2, (p.yRange[0] + p.yRange[1]) / 2, (z0 + z1) / 2);
    grid.updateBoundingBox();
    grid.falloff = p.falloff;
    grid.intensity = p.intensity;
    (grid as any)._ensureTextures();
    // allocate the atlas as a render target now: if materials first bound it as a plain sampled
    // texture, the bake would recreate it and leave them pointing at a destroyed texture
    renderer.initRenderTarget((grid as any)._renderTarget);
    this.grid = grid;
    scene.add(grid);
  }

  async loadBaked(worldVersion: number) {
    this.cacheSignature = JSON.stringify({ version: 2, worldVersion, sunDir: SUN, sun: TUNE.sun, sky: TUNE.sky, env: TUNE.env, probes: TUNE.probes });
    if (new URLSearchParams(location.search).has('bakeStartup')) return false;
    try {
      const r = await fetch('/assets/render/bounce/manifest.json');
      if (!r.ok) return false;
      const meta = await r.json();
      if (meta.signature !== this.cacheSignature) return false;
      const source = await fetch(`/assets/render/bounce/${meta.file}`);
      if (!source.ok || !source.body) return false;
      const raw = await unpackGzip(await source.arrayBuffer());
      if (raw.byteLength !== meta.width * meta.height * meta.depth * 8) throw new Error('invalid bounce atlas size');
      const t = new Data3DTexture(new Uint16Array(raw), meta.width, meta.height, meta.depth);
      t.type = HalfFloatType;
      t.format = RGBAFormat;
      t.minFilter = t.magFilter = LinearFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      this.grid.texture = t;
      this.cachedTexture = t;
      this.loaded = this.baked = true;
      return true;
    } catch (e) {
      console.warn('[render] prebuilt bounce unavailable; using environment light', e);
      return false;
    }
  }

  async exportAtlas() {
    const rt = (this.grid as any)._renderTarget;
    const { width, height, depth } = rt;
    const data = new Uint16Array(width * height * depth * 4);
    const row = width * 4;
    for (let z = 0; z < depth; z++) {
      const src = await this.renderer.readRenderTargetPixelsAsync(rt, 0, 0, width, height, 0, z);
      const stride = src.length === row * height ? row : Math.ceil(row * 2 / 256) * 128;
      for (let y = 0; y < height; y++) data.set(src.subarray(y * stride, y * stride + row), (z * height + y) * row);
    }
    return { signature: this.cacheSignature, width, height, depth, bytes: new Uint8Array(data.buffer) };
  }

  /** captures the probes. hides the water (its reflector must not run per cube face) behind a
   *  dark stand-in sea, and swaps the sky for black so only bounced light is recorded. */
  bake(water: { mesh?: { visible: boolean } } | undefined) {
    const { renderer, scene } = this;
    const bg = scene.backgroundNode;
    const waterWas = water?.mesh?.visible;
    // stand-in river: dark jade, roughly what the water reflects back up from a black sky
    const sea = new Mesh(new PlaneGeometry(6000, 6000), new MeshBasicNodeMaterial({ color: 0x0c1f1c }));
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = 0.02;
    sea.name = 'render.bakeSea';
    const t0 = performance.now();
    try {
      scene.backgroundNode = vec4(0, 0, 0, 1);
      if (water?.mesh) water.mesh.visible = false;
      scene.add(sea);
      this.grid.bake(renderer, scene, { cubemapSize: 8, near: 0.25, far: 320, sampleCount: 256 });
      this.baked = true;
    } finally {
      scene.remove(sea);
      sea.geometry.dispose();
      (sea.material as MeshBasicNodeMaterial).dispose();
      if (water?.mesh && waterWas !== undefined) water.mesh.visible = waterWas;
      scene.backgroundNode = bg;
    }
    this.bakeMs = performance.now() - t0;
    return this.bakeMs;
  }

  dispose() {
    this.cachedTexture?.dispose();
    this.scene.remove(this.grid);
    this.grid.dispose();
  }
}
