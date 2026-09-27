// compile ASSETS.md from every provenance.json under public/assets (and any other listed roots).
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const rows = [];
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else if (e.name === 'provenance.json') rows.push({ dir: relative(root, dir), ...JSON.parse(await readFile(p, 'utf8')) });
  }
}
await walk(join(root, 'public/assets'));
rows.sort((a, b) => a.dir.localeCompare(b.dir));
let md = '# Asset provenance\n\nEvery third-party file shipped in `public/assets` is listed here, compiled from the per-asset `provenance.json` files by `node tools/assets-report.mjs`. Procedurally generated content (terrain bake, boat hull, buildings, synthesized audio) is produced by code in this repo and is not listed.\n\n| Asset | Type | License | Source | Authors | Local path |\n|---|---|---|---|---|---|\n';
for (const r of rows) md += `| ${r.name || r.id} | ${r.type} | ${r.license} | ${r.source} | ${(r.authors || []).join(', ')} | \`${r.dir}\` |\n`;
await writeFile(join(root, 'ASSETS.md'), md);
console.log(`ASSETS.md: ${rows.length} assets`);
