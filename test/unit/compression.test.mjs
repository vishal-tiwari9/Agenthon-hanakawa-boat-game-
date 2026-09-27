import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { unpackGzip } from '../../src/core/compression.ts';
const raw = new TextEncoder().encode('river terrain and foliage').buffer;
test('static-host gzip payload is decompressed', async () => {
  const compressed = Uint8Array.from(gzipSync(new Uint8Array(raw))).buffer;
  assert.deepEqual(new Uint8Array(await unpackGzip(compressed)), new Uint8Array(raw));
});
test('HTTP-decoded gzip payload is not decompressed twice', async () => {
  assert.equal(await unpackGzip(raw), raw);
});
test('grad16 heightmap filter round-trips', async () => {
  const { unGrad16 } = await import('../../src/core/compression.ts');
  const res = 5, n = res * res;
  const a = Uint16Array.from({ length: n }, (_, i) => (i * 7919 + (i % res) * 311) & 0xffff);
  const planes = new Uint8Array(n * 2);
  for (let y = 0, i = 0; y < res; y++) for (let x = 0; x < res; x++, i++) {
    const l = x > 0 ? a[i - 1] : 0, u = y > 0 ? a[i - res] : 0, ul = x > 0 && y > 0 ? a[i - res - 1] : 0;
    const d = (a[i] - l - u + ul) & 0xffff;
    planes[i] = d & 0xff;
    planes[n + i] = d >> 8;
  }
  assert.deepEqual(new Uint16Array(unGrad16(planes.buffer, res)), a);
});
