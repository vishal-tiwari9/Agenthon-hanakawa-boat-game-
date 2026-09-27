// download a poly haven (cc0) asset into the project and record provenance.
// usage:
//   node tools/polyhaven.mjs <asset_id> --out=public/assets/<owner> [--res=2k] [--maps=Diffuse,nor_gl,arm] [--format=jpg]
//   node tools/polyhaven.mjs search <term> [--type=textures|models|hdris]
// textures: downloads the listed maps (default Diffuse,nor_gl,arm) as <out>/<id>/<id>_<map>_<res>.<fmt>
// models:   downloads the gltf and its included textures preserving relative paths
// hdris:    downloads the .hdr (or --format=exr) at --res
// every download writes <out>/<id>/provenance.json; `node tools/assets-report.mjs` compiles ASSETS.md.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const API = 'https://api.polyhaven.com';
const UA = { 'User-Agent': 'luma-coast-game-dev/0.1 (local project asset fetch)' };
const argv = process.argv.slice(2);
const opts = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? '1']; }));
const pos = argv.filter((a) => !a.startsWith('--'));

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function download(url, file, md5) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (md5) {
    const got = createHash('md5').update(buf).digest('hex');
    if (got !== md5) throw new Error(`md5 mismatch for ${url}`);
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, buf);
  return buf.length;
}

if (pos[0] === 'search') {
  const term = (pos[1] || '').toLowerCase();
  const all = await getJson(`${API}/assets${opts.type ? `?t=${opts.type}` : ''}`);
  const hits = Object.entries(all).filter(([id, a]) => id.includes(term) || (a.name || '').toLowerCase().includes(term) || (a.tags || []).some((t) => t.includes(term)) || Object.keys(a.categories || {}).some((c) => c.includes(term)) || (a.categories || []).some?.((c) => c.includes(term)));
  for (const [id, a] of hits.slice(0, 80)) console.log(id.padEnd(36), ['hdri', 'texture', 'model'][a.type], '|', (a.categories || []).join(','), '|', (a.tags || []).slice(0, 8).join(','));
  console.log(hits.length, 'hits');
  process.exit(0);
}

const id = pos[0];
if (!id || !opts.out) {
  console.error('usage: node tools/polyhaven.mjs <asset_id> --out=public/assets/<owner> [--res=2k] [--maps=...] [--format=jpg]');
  process.exit(1);
}
const res = opts.res || '2k';
const info = await getJson(`${API}/info/${id}`);
const files = await getJson(`${API}/files/${id}`);
const type = ['hdri', 'texture', 'model'][info.type];
const dir = join(opts.out, id);
const got = [];

if (type === 'texture') {
  const fmt = opts.format || 'jpg';
  const maps = (opts.maps || 'Diffuse,nor_gl,arm').split(',');
  for (const m of maps) {
    const entry = files[m]?.[res]?.[fmt];
    if (!entry) { console.warn(`  missing map ${m} ${res} ${fmt}; available maps: ${Object.keys(files).join(',')}`); continue; }
    const name = `${id}_${m.toLowerCase()}_${res}.${fmt}`;
    const size = await download(entry.url, join(dir, name), entry.md5);
    got.push({ file: name, url: entry.url, size });
  }
} else if (type === 'model') {
  const g = files.gltf?.[res]?.gltf;
  if (!g) throw new Error(`no gltf at ${res}; available: ${Object.keys(files.gltf || {}).join(',')}`);
  const main = `${id}_${res}.gltf`;
  got.push({ file: main, url: g.url, size: await download(g.url, join(dir, main), g.md5) });
  for (const [rel, e] of Object.entries(g.include || {})) got.push({ file: rel, url: e.url, size: await download(e.url, join(dir, rel), e.md5) });
} else {
  const fmt = opts.format || 'hdr';
  const e = files.hdri?.[res]?.[fmt];
  if (!e) throw new Error(`no hdri ${res} ${fmt}`);
  const name = `${id}_${res}.${fmt}`;
  got.push({ file: name, url: e.url, size: await download(e.url, join(dir, name), e.md5) });
}

const prov = {
  id,
  name: info.name,
  type,
  source: `https://polyhaven.com/a/${id}`,
  license: 'CC0 1.0 (Poly Haven)',
  authors: Object.keys(info.authors || {}),
  resolution: res,
  downloaded: new Date().toISOString(),
  files: got,
};
await writeFile(join(dir, 'provenance.json'), JSON.stringify(prov, null, 2));
const total = got.reduce((s, f) => s + f.size, 0);
console.log(`${id} (${type}) -> ${dir}: ${got.length} files, ${(total / 1e6).toFixed(1)} MB`);
