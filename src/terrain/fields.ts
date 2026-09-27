// gpu-side terrain fields built once from the baked world channels:
// surface: rgba8 at the height resolution (normal.x, normal.z, sky visibility, curvature), mipmapped
// so distant terrain filters its lighting instead of shimmering.
import { DataArrayTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, UnsignedByteType, ClampToEdgeWrapping } from 'three/webgpu';
import type { WorldData } from '../world/worldData';

export function surfaceTexture(world: WorldData) {
  const ch = world.channels.get('height')!;
  const res = ch.res, H = ch.data;
  const cell = world.size / res;
  const out = new Uint8Array(res * res * 4);
  const hasAO = world.has('ao');
  const at = (i: number, j: number) => H[(j < 0 ? 0 : j >= res ? res - 1 : j) * res + (i < 0 ? 0 : i >= res ? res - 1 : i)];
  for (let j = 0; j < res; j++) {
    const z = -world.half + (j + 0.5) * cell;
    for (let i = 0; i < res; i++) {
      const hx = (at(i + 1, j) - at(i - 1, j)) / (2 * cell);
      const hz = (at(i, j + 1) - at(i, j - 1)) / (2 * cell);
      const l = Math.hypot(hx, 1, hz);
      const k = (j * res + i) * 4;
      out[k] = Math.round((-hx / l * 0.5 + 0.5) * 255);
      out[k + 1] = Math.round((-hz / l * 0.5 + 0.5) * 255);
      const x = -world.half + (i + 0.5) * cell;
      out[k + 2] = Math.round((hasAO ? world.sample('ao', x, z) : 1) * 255);
      // convexity at ~3 m: 0.5 flat, > 0.5 ridge/edge (worn, lighter), < 0.5 hollow (damp, darker)
      const ring = (at(i + 3, j) + at(i - 3, j) + at(i, j + 3) + at(i, j - 3)) * 0.25;
      const cv = Math.max(-1, Math.min(1, (at(i, j) - ring) * 0.5));
      out[k + 3] = Math.round((cv * 0.5 + 0.5) * 255);
    }
  }
  const tex = new DataTexture(out, res, res, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/** pack groups of four mask channels (0..1) into the layers of one rgba8 array texture */
export function packMaskArray(world: WorldData, groups: (string | null)[][], res = 1024) {
  const layer = res * res * 4;
  const all = new Uint8Array(layer * groups.length);
  groups.forEach((g, li) => all.set(packMaskData(world, g, res), li * layer));
  const tex = new DataArrayTexture(all, res, res, groups.length);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

function packMaskData(world: WorldData, names: (string | null)[], res: number) {
  const out = new Uint8Array(res * res * 4);
  const cell = world.size / res;
  names.forEach((name, c) => {
    if (!name || !world.has(name)) return;
    const ch = world.channels.get(name)!;
    const same = ch.res === res;
    for (let j = 0; j < res; j++) {
      const z = -world.half + (j + 0.5) * cell;
      for (let i = 0; i < res; i++) {
        const v = same ? ch.data[j * res + i] : world.sample(name, -world.half + (i + 0.5) * cell, z);
        out[(j * res + i) * 4 + c] = Math.round(Math.max(0, Math.min(1, v)) * 255);
      }
    }
  });
  return out;
}
