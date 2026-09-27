// shipped vegetation bakes: the vegetation field (grass / flower / shrub suitability over the world
// grid) and the painted blossom, maple and garden atlases, exported from the running game by
// test/scripts/vegetation-export.mjs into public/assets/vegetation/baked/. each record carries a
// signature; a missing or stale record falls back to building at runtime, so a re-baked world or a
// changed painter never ships a wrong bake, only a slower start.
// re-export after changing field.ts or atlas.ts (bump FIELD_VERSION / ATLAS_VERSION):
//   node test/harness.mjs vegetation-export --tag=veg-perf --quiet
import { ClampToEdgeWrapping, DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType, type Texture } from 'three/webgpu';
import { unpackGzip } from '../core/compression';
import { SITES } from '../world/sites';
import type { WorldData } from '../world/worldData';

/** bump when field.ts changes what it computes */
export const FIELD_VERSION = 1;
/** bump when atlas.ts changes what it paints */
export const ATLAS_VERSION = 1;

const BASE = '/assets/vegetation/baked/';

export interface BakedRecord { file: string; signature: string; size?: number }
export type BakedManifest = Record<string, BakedRecord>;

let manifest: Promise<BakedManifest> | null = null;

export function bakedManifest(): Promise<BakedManifest> {
  if (!manifest) {
    const skip = typeof location !== 'undefined' && new URLSearchParams(location.search).has('vegBake');
    manifest = skip ? Promise.resolve({}) : fetch(`${BASE}manifest.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  }
  return manifest;
}

function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

/** the field depends on the baked world, the building sites and the field code */
export function fieldSignature(world: WorldData, res: number) {
  return `field:${FIELD_VERSION}:${world.meta.version}:${res}:${hashString(JSON.stringify(SITES))}`;
}

export const atlasSignature = (name: string, size: number) => `atlas:${ATLAS_VERSION}:${name}:${size}`;

/** bytes of a shipped record when its signature matches, else null */
export async function loadBaked(key: string, signature: string): Promise<ArrayBuffer | null> {
  const rec = (await bakedManifest())[key];
  if (!rec || rec.signature !== signature) return null;
  try {
    const r = await fetch(BASE + rec.file);
    if (!r.ok) return null;
    return await unpackGzip(await r.arrayBuffer());
  } catch (e) {
    console.warn('[vegetation] baked asset unavailable; building at runtime', key, e);
    return null;
  }
}

/** a shipped rgba8 srgb atlas, sampled exactly like the painted canvas texture */
export function atlasTexture(bytes: ArrayBuffer, size: number): Texture {
  const t = new DataTexture(new Uint8Array(bytes, 0, size * size * 4), size, size, RGBAFormat, UnsignedByteType);
  t.colorSpace = SRGBColorSpace;
  t.flipY = false;
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** a painted atlas: the shipped bake when it matches, else painted now */
export async function loadAtlas(name: string, paint: () => Texture, size = 1024): Promise<Texture> {
  const bytes = await loadBaked(`atlas:${name}`, atlasSignature(name, size));
  return bytes ? atlasTexture(bytes, size) : paint();
}

/** rgba pixels of a painted canvas texture, as the gpu upload sees them (export only) */
export function canvasPixels(t: Texture): { size: number; bytes: Uint8Array } {
  const c = t.image as HTMLCanvasElement;
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  return { size: c.width, bytes: new Uint8Array(d.buffer, d.byteOffset, d.byteLength) };
}
