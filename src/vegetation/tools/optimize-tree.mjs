// offline: turn a poly haven island_tree (1.7-4.7m triangles of modeled leaves) into a game asset.
// - trunk: simplified with meshoptimizer; flat ground slabs baked into the model are dropped
// - branches: twigs below a size threshold are removed (the foliage hides them), the rest simplified
// - leaves: every modeled leaf (a connected component) becomes one alpha-tested quad fitted to its
//   uv rectangle by least squares; a fraction is kept and enlarged to preserve crown density
// the shared leaf atlas gets an alpha channel (black background -> transparent, color dilated).
//
// deps are not project dependencies; install them once into a scratch prefix:
//   npm install --prefix /tmp/vegtools meshoptimizer @gltf-transform/core @gltf-transform/extensions sharp
// run:
//   VEGTOOLS=/tmp/vegtools node src/vegetation/tools/optimize-tree.mjs <src.gltf> <out.gltf|glb> [--keep=0.45] [--trunk=0.35] [--twig=0.3] [--notex]
// --notex strips every texture (far lods reuse the near lod's materials at runtime, matched by name).
// leaf normal / arm maps are always dropped: the runtime shades leaves with crown-spherical normals.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

const TOOLS = process.env.VEGTOOLS || '/tmp/vegtools';
const req = createRequire(join(TOOLS, 'package.json'));
const imp = (m) => import(pathToFileURL(req.resolve(m)).href);
const { NodeIO } = await imp('@gltf-transform/core');
const { ALL_EXTENSIONS } = await imp('@gltf-transform/extensions');
const { MeshoptSimplifier } = await imp('meshoptimizer');
const sharp = (await imp('sharp')).default;

const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? '1']; }));
const [src, out] = args.filter((a) => !a.startsWith('--'));
const KEEP = Number(opt.keep ?? 0.45);
const TRUNK = Number(opt.trunk ?? 0.35);
const TWIG = Number(opt.twig ?? 0.3);
const BRANCH = Number(opt.branch ?? 0.12);

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(src);
const root = doc.getRoot();

let rs = 12345;
const rnd = () => ((rs = (rs * 16807) % 2147483647) / 2147483647);

function components(index, vcount) {
  const parent = new Int32Array(vcount);
  for (let i = 0; i < vcount; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t < index.length; t += 3) {
    const a = find(index[t]), b = find(index[t + 1]), c = find(index[t + 2]);
    if (a !== b) parent[b] = a;
    const a2 = find(a), c2 = find(c);
    if (a2 !== c2) parent[c2] = a2;
  }
  const map = new Map();
  for (let t = 0; t < index.length; t += 3) {
    const r = find(index[t]);
    let arr = map.get(r);
    if (!arr) map.set(r, (arr = []));
    arr.push(t);
  }
  return [...map.values()];
}

function bboxOf(pos, index, tris) {
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const t of tris) for (let k = 0; k < 3; k++) {
    const v = index[t + k];
    for (let c = 0; c < 3; c++) { const x = pos[v * 3 + c]; if (x < mn[c]) mn[c] = x; if (x > mx[c]) mx[c] = x; }
  }
  return { mn, mx };
}

function compact(prim, keepTris) {
  const index = prim.getIndices().getArray();
  const newIdx = [];
  for (const t of keepTris) newIdx.push(index[t], index[t + 1], index[t + 2]);
  prim.getIndices().setArray(new Uint32Array(newIdx));
}

function simplify(prim, ratio, label) {
  const index = prim.getIndices().getArray();
  const pos = prim.getAttribute('POSITION').getArray();
  const nrm = prim.getAttribute('NORMAL')?.getArray();
  const uv = prim.getAttribute('TEXCOORD_0')?.getArray();
  const vc = pos.length / 3;
  const attrs = new Float32Array(vc * 5);
  for (let i = 0; i < vc; i++) {
    if (nrm) { attrs[i * 5] = nrm[i * 3]; attrs[i * 5 + 1] = nrm[i * 3 + 1]; attrs[i * 5 + 2] = nrm[i * 3 + 2]; }
    if (uv) { attrs[i * 5 + 3] = uv[i * 2]; attrs[i * 5 + 4] = uv[i * 2 + 1]; }
  }
  const target = Math.floor((index.length * ratio) / 3) * 3;
  const [res, err] = MeshoptSimplifier.simplifyWithAttributes(new Uint32Array(index), pos, 3, attrs, 5, [0.3, 0.3, 0.3, 1, 1], null, target, 0.02);
  console.log(`  ${label}: ${index.length / 3} -> ${res.length / 3} tris (err ${err.toFixed(4)})`);
  prim.getIndices().setArray(res);
}

// fit p(u, v) = c + du * A + dv * B over the leaf's vertices (least squares), emit its uv-rect quad
function leafQuads(prim) {
  const index = prim.getIndices().getArray();
  const pos = prim.getAttribute('POSITION').getArray();
  const nrm = prim.getAttribute('NORMAL').getArray();
  const uv = prim.getAttribute('TEXCOORD_0').getArray();
  const comps = components(index, pos.length / 3);
  const P = [], N = [], U = [], I = [], CEN = [];
  let kept = 0;
  const scale = Math.min(Number(opt.maxscale ?? 1.8), 0.92 / Math.sqrt(KEEP));
  for (const tris of comps) {
    if (rnd() > KEEP) continue;
    const vs = new Set();
    for (const t of tris) { vs.add(index[t]); vs.add(index[t + 1]); vs.add(index[t + 2]); }
    const ids = [...vs];
    if (ids.length < 3) continue;
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9, uc = 0, vc = 0;
    for (const i of ids) { const u = uv[i * 2], v = uv[i * 2 + 1]; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); uc += u; vc += v; }
    uc /= ids.length; vc /= ids.length;
    // normal equations for [1, du, dv]
    let s00 = 0, s01 = 0, s02 = 0, s11 = 0, s12 = 0, s22 = 0;
    const r0 = [0, 0, 0], r1 = [0, 0, 0], r2 = [0, 0, 0];
    const nAvg = [0, 0, 0];
    for (const i of ids) {
      const du = uv[i * 2] - uc, dv = uv[i * 2 + 1] - vc;
      s00 += 1; s01 += du; s02 += dv; s11 += du * du; s12 += du * dv; s22 += dv * dv;
      for (let c = 0; c < 3; c++) { const p = pos[i * 3 + c]; r0[c] += p; r1[c] += p * du; r2[c] += p * dv; nAvg[c] += nrm[i * 3 + c]; }
    }
    const m = [[s00, s01, s02], [s01, s11, s12], [s02, s12, s22]];
    const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if (Math.abs(det) < 1e-18) continue;
    const inv = [
      [(m[1][1] * m[2][2] - m[1][2] * m[2][1]) / det, (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / det, (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / det],
      [(m[1][2] * m[2][0] - m[1][0] * m[2][2]) / det, (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / det, (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / det],
      [(m[1][0] * m[2][1] - m[1][1] * m[2][0]) / det, (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / det, (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / det],
    ];
    const C = [0, 0, 0], A = [0, 0, 0], B = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      C[c] = inv[0][0] * r0[c] + inv[0][1] * r1[c] + inv[0][2] * r2[c];
      A[c] = inv[1][0] * r0[c] + inv[1][1] * r1[c] + inv[1][2] * r2[c];
      B[c] = inv[2][0] * r0[c] + inv[2][1] * r1[c] + inv[2][2] * r2[c];
    }
    const nl = Math.hypot(...nAvg) || 1;
    const n = nAvg.map((x) => x / nl);
    // pad the uv rect slightly so the alpha edge is not clipped
    const pu = (u1 - u0) * 0.04, pv = (v1 - v0) * 0.04;
    const corners = [[u0 - pu, v0 - pv], [u1 + pu, v0 - pv], [u1 + pu, v1 + pv], [u0 - pu, v1 + pv]];
    const base = P.length / 3;
    for (const [u, v] of corners) {
      const du = (u - uc) * scale, dv = (v - vc) * scale;
      for (let c = 0; c < 3; c++) P.push(C[c] + du * A[c] + dv * B[c]);
      N.push(n[0], n[1], n[2]);
      U.push(u, v);
      // card center, so the runtime can grow or shrink cards in place (blossom crowns, far lods)
      CEN.push(C[0], C[1], C[2]);
    }
    I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    kept++;
  }
  console.log(`  leaves: ${comps.length} leaves, kept ${kept} as quads (${I.length / 3} tris), scale ${scale.toFixed(2)}`);
  prim.getAttribute('POSITION').setArray(new Float32Array(P));
  prim.getAttribute('NORMAL').setArray(new Float32Array(N));
  prim.getAttribute('TEXCOORD_0').setArray(new Float32Array(U));
  for (const sem of prim.listSemantics()) if (!['POSITION', 'NORMAL', 'TEXCOORD_0'].includes(sem)) prim.setAttribute(sem, null);
  const cen = doc.createAccessor().setType('VEC3').setArray(new Float32Array(CEN)).setBuffer(root.listBuffers()[0]);
  prim.setAttribute('_CENTER', cen);
  prim.getIndices().setArray(new Uint32Array(I));
}

// drop unreferenced vertices after index edits
function compactVertices(prim) {
  const index = prim.getIndices().getArray();
  const semantics = prim.listSemantics();
  const vc = prim.getAttribute('POSITION').getCount();
  const remap = new Int32Array(vc).fill(-1);
  let n = 0;
  const newIdx = new Uint32Array(index.length);
  for (let i = 0; i < index.length; i++) {
    const v = index[i];
    if (remap[v] < 0) remap[v] = n++;
    newIdx[i] = remap[v];
  }
  for (const sem of semantics) {
    const acc = prim.getAttribute(sem);
    const size = acc.getElementSize();
    const src = acc.getArray();
    const dst = new src.constructor(n * size);
    for (let v = 0; v < vc; v++) if (remap[v] >= 0) for (let c = 0; c < size; c++) dst[remap[v] * size + c] = src[v * size + c];
    acc.setArray(dst);
  }
  prim.getIndices().setArray(newIdx);
}

for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const mat = prim.getMaterial();
    const name = mat?.getName() || '';
    const index = prim.getIndices().getArray();
    const pos = prim.getAttribute('POSITION').getArray();
    console.log(name, index.length / 3, 'tris');
    if (/_(leaves|twigs)$/.test(name)) {
      leafQuads(prim);
      mat.setAlphaMode('MASK');
      mat.setAlphaCutoff(0.5);
      mat.setDoubleSided(true);
    } else if (/_branches/.test(name)) {
      const comps = components(index, pos.length / 3);
      const keep = [];
      let dropped = 0;
      for (const tris of comps) {
        const { mn, mx } = bboxOf(pos, index, tris);
        const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
        if (diag < TWIG) { dropped++; continue; }
        keep.push(...tris);
      }
      console.log(`  branches: ${comps.length} parts, dropped ${dropped} twigs`);
      compact(prim, keep);
      simplify(prim, BRANCH, 'branches');
    } else {
      // trunk: drop wide flat slabs near the ground (baked-in rock / sand bases)
      const comps = components(index, pos.length / 3);
      const keep = [];
      for (const tris of comps) {
        const { mn, mx } = bboxOf(pos, index, tris);
        const flat = mx[1] - mn[1] < 0.45 && Math.max(mx[0] - mn[0], mx[2] - mn[2]) > 0.8 && mn[1] < 0.2;
        if (flat) { console.log('  dropped ground slab', tris.length, 'tris'); continue; }
        keep.push(...tris);
      }
      compact(prim, keep);
      simplify(prim, TRUNK, 'trunk');
    }
    compactVertices(prim);
  }
}

// leaf atlas with alpha: background is black, leaves are not
const outDir = dirname(out);
mkdirSync(outDir, { recursive: true });
for (const tex of root.listTextures()) {
  const uri = tex.getURI();
  if (!/(leaves|twigs)_diff/.test(uri)) continue;
  const img = tex.getImage();
  const { data, info } = await sharp(Buffer.from(img)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const m = Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    alpha[i] = m < 10 ? 0 : m > 34 ? 255 : Math.round(((m - 10) / 24) * 255);
  }
  // dilate leaf color into the transparent background so mips do not darken the edges
  const rgb = new Uint8Array(w * h * 3);
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (alpha[i] > 128) { filled[i] = 1; rgb[i * 3] = data[i * 4]; rgb[i * 3 + 1] = data[i * 4 + 1]; rgb[i * 3 + 2] = data[i * 4 + 2]; }
  for (let pass = 0; pass < 24; pass++) {
    const next = filled.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (filled[i]) continue;
      let r = 0, g = 0, b = 0, c = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (filled[j]) { r += rgb[j * 3]; g += rgb[j * 3 + 1]; b += rgb[j * 3 + 2]; c++; }
      }
      if (c) { rgb[i * 3] = r / c; rgb[i * 3 + 1] = g / c; rgb[i * 3 + 2] = b / c; next[i] = 1; }
    }
    filled.set(next);
  }
  const avg = [0, 0, 0]; let cnt = 0;
  for (let i = 0; i < w * h; i++) if (filled[i]) { avg[0] += rgb[i * 3]; avg[1] += rgb[i * 3 + 1]; avg[2] += rgb[i * 3 + 2]; cnt++; }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const f = filled[i];
    rgba[i * 4] = f ? rgb[i * 3] : avg[0] / cnt;
    rgba[i * 4 + 1] = f ? rgb[i * 3 + 1] : avg[1] / cnt;
    rgba[i * 4 + 2] = f ? rgb[i * 3 + 2] : avg[2] / cnt;
    rgba[i * 4 + 3] = alpha[i];
  }
  const png = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  tex.setImage(new Uint8Array(png)).setMimeType('image/png').setURI(basename(uri).replace(/\.jpg$/, '.png'));
  console.log('  leaf atlas alpha', w, 'x', h, (png.length / 1024).toFixed(0), 'KB');
}

for (const mat of root.listMaterials()) {
  if (/_(leaves|twigs)$/.test(mat.getName())) {
    mat.setNormalTexture(null);
    mat.setMetallicRoughnessTexture(null);
    mat.setOcclusionTexture(null);
  }
  if (opt.notex) {
    mat.setBaseColorTexture(null);
    mat.setNormalTexture(null);
    mat.setMetallicRoughnessTexture(null);
    mat.setOcclusionTexture(null);
  }
}
for (const tex of root.listTextures()) if (tex.listParents().length <= 1) tex.dispose();
for (const acc of root.listAccessors()) if (acc.getCount() === 0) acc.dispose();
await io.write(out, doc);
console.log('wrote', out, existsSync(out));
