// terrain material layers packed into two texture arrays so the whole terrain shader stays well
// under the 16 sampled-texture limit (shadow cascades, environment and caustics need slots too):
//   albedo  (srgb rgba8):   diffuse color
//   surface (linear rgba8): normal.x, normal.y (opengl convention), roughness, ambient occlusion
import { dropAfterUpload } from '../core/memory';
import { DataArrayTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping, SRGBColorSpace, NoColorSpace, UnsignedByteType } from 'three/webgpu';
import type { AssetLoader } from '../core/assets';

export interface LayerSource {
  id: string;
  diffuse: string;
  normal: string;
  /** poly haven arm: r = ao, g = roughness, b = metal */
  arm?: string;
  /** fallback roughness when no arm map */
  rough?: number;
}

async function pixels(url: string, size: number): Promise<Uint8ClampedArray> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none', resizeWidth: size, resizeHeight: size, resizeQuality: 'high' });
  const cv = new OffscreenCanvas(size, size);
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0, size, size);
  bmp.close();
  return g.getImageData(0, 0, size, size).data;
}

/**
 * extra: raw rgba8 layers appended to the surface array only (e.g. tileable noise).
 * surfSize: the normal/roughness array's size (the shipped normal maps are 512, so more is wasted memory)
 */
export async function loadLayers(assets: AssetLoader, layers: LayerSource[], size: number, extra: Uint8Array[] = [], surfSize = size) {
  const n = layers.length;
  const albedo = new Uint8Array(size * size * 4 * n);
  const surface = new Uint8Array(surfSize * surfSize * 4 * (n + extra.length));
  extra.forEach((e, i) => surface.set(e, (n + i) * surfSize * surfSize * 4));
  const px = size * size, sp = surfSize * surfSize;
  await Promise.all(layers.map((L, li) => assets.track(`terrain ${L.id}`, (async () => {
    const [d, nm, arm] = await Promise.all([pixels(L.diffuse, size), pixels(L.normal, surfSize), L.arm ? pixels(L.arm, surfSize) : Promise.resolve(null)]);
    albedo.set(d, li * px * 4);
    const o = li * sp * 4;
    for (let p = 0; p < sp; p++) {
      const q = p * 4;
      surface[o + q] = nm[q];
      surface[o + q + 1] = nm[q + 1];
      surface[o + q + 2] = arm ? arm[q + 1] : Math.round((L.rough ?? 0.85) * 255);
      surface[o + q + 3] = arm ? arm[q] : 255;
    }
  })(), 2)));
  const make = (data: Uint8Array, srgb: boolean, size: number) => {
    const t = dropAfterUpload(new DataArrayTexture(data, size, size, data.length / (size * size * 4)));
    t.format = RGBAFormat;
    t.type = UnsignedByteType;
    t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
    t.wrapS = t.wrapT = RepeatWrapping;
    t.magFilter = LinearFilter;
    t.minFilter = LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.flipY = false;
    t.needsUpdate = true;
    return t;
  };
  return { albedo: make(albedo, true, size), surface: make(surface, false, surfSize), index: Object.fromEntries(layers.map((l, i) => [l.id, i])) as Record<string, number> };
}
