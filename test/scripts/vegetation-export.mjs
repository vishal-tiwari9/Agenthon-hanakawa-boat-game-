// development-only: bakes the vegetation field and the painted atlases from the running game into
// public/assets/vegetation/baked/ (see src/vegetation/baked.ts). rerun after changing field.ts,
// atlas.ts, the world bake or the building sites:
//   node test/harness.mjs vegetation-export --tag=veg-perf --quiet
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

export default async function (g) {
  const dir = root + 'public/assets/vegetation/baked/';
  await mkdir(dir, { recursive: true });
  const n = await g.evalJs(`(async () => {
    window.__vegBakes = [];
    for (const r of __luma.ctx.services.vegetation.exportBakes()) {
      const { bytes, ...meta } = r;
      const zipped = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
      let text = '';
      for (let i = 0; i < zipped.length; i += 8192) text += String.fromCharCode(...zipped.subarray(i, i + 8192));
      window.__vegBakes.push({ ...meta, raw: bytes.length, base64: btoa(text) });
    }
    return window.__vegBakes.length;
  })()`);
  const manifest = {};
  for (let i = 0; i < n; i++) {
    const r = await g.evalJs(`window.__vegBakes[${i}]`);
    const file = r.key.replace(':', '-') + '.bin.gz';
    const buf = Buffer.from(r.base64, 'base64');
    await writeFile(dir + file, buf);
    manifest[r.key] = { file, signature: r.signature, ...(r.size ? { size: r.size } : {}) };
    console.log('exported', r.key, file, r.raw, 'bytes raw', buf.length, 'gz');
  }
  await writeFile(dir + 'manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  if (g.errors.length) throw new Error(g.errors.join('\n'));
  console.log('VEGETATION BAKES EXPORTED');
}
