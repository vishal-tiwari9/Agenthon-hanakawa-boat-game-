import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { tsImport } from 'tsx/esm/api';

const { loadImpostor } = await tsImport('../../src/vegetation/impostor.ts', import.meta.url);
const { Vector3, LinearMipmapLinearFilter } = await import('three/webgpu');

test('prebuilt impostors preserve colour, normals and fractional coverage exactly', async () => {
  const raw = Uint8Array.from({ length: 4 * 4 * 8 }, (_, i) => (i * 17) % 256);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(gzipSync(raw));
  try {
    const atlas = await loadImpostor({ signature: 'test', file: 'tree.bin.gz', size: 4 }, new Vector3(1, 2, 3), 8, 2);
    assert.deepEqual(atlas.albedo.image.data, raw.subarray(0, 64));
    assert.deepEqual(atlas.normal.image.data, raw.subarray(64));
    assert.equal(atlas.albedo.flipY, false);
    assert.equal(atlas.albedo.colorSpace, '');
    assert.equal(atlas.albedo.minFilter, LinearMipmapLinearFilter);
    assert.equal(atlas.albedo.generateMipmaps, true);
    assert.equal(atlas.targets, undefined);
    atlas.albedo.dispose();
    atlas.normal.dispose();
  } finally { globalThis.fetch = originalFetch; }
});

test('corrupt prebuilt atlases are rejected instead of uploading invalid textures', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(gzipSync(new Uint8Array(3)));
  try {
    await assert.rejects(() => loadImpostor({ signature: 'test', file: 'broken.bin.gz', size: 4 }, new Vector3(), 8, 2), /invalid impostor size/);
  } finally { globalThis.fetch = originalFetch; }
});
