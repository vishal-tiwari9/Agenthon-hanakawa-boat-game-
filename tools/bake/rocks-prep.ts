// one-time asset prep: poly haven rock scans -> welded, decimated boulder pieces (3 lods each).
// only geometry is kept; the game shades rocks with the terrain's triplanar rock layers so every
// boulder matches the valley. sources (cc0) are fetched with tools/polyhaven.mjs into a cache:
//   for id in rock_moss_set_01 rock_moss_set_02 boulder_01 namaqualand_boulder_05 namaqualand_boulder_02; do
//     node tools/polyhaven.mjs $id --out=/tmp/rocksrc --res=1k; done
//   npx tsx tools/bake/rocks-prep.ts [/tmp/rocksrc]
// writes public/assets/terrain/rocks/rocks.bin + rocks.json and a provenance.json per source.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';

const SRC = process.argv[2] || '/tmp/rocksrc';
const OUT = join(import.meta.dirname, '../../public/assets/terrain/rocks');
const SOURCES = ['rock_moss_set_01', 'rock_moss_set_02', 'boulder_01', 'namaqualand_boulder_05', 'namaqualand_boulder_02'];
const LOD_TRIS = [2600, 640, 150];

interface Piece { id: string; source: string; pos: Float32Array; idx: Uint32Array }

function readAccessor(g: any, bin: Buffer, i: number): Float32Array | Uint32Array {
  const a = g.accessors[i], bv = g.bufferViews[a.bufferView];
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type as string]!;
  const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const stride = bv.byteStride || 0;
  const n = a.count * comps;
  if (a.componentType === 5126) {
    const out = new Float32Array(n);
    const es = stride || comps * 4;
    for (let k = 0; k < a.count; k++) for (let c = 0; c < comps; c++) out[k * comps + c] = bin.readFloatLE(off + k * es + c * 4);
    return out;
  }
  const out = new Uint32Array(n);
  const size = a.componentType === 5125 ? 4 : a.componentType === 5123 ? 2 : 1;
  for (let k = 0; k < n; k++) out[k] = size === 4 ? bin.readUInt32LE(off + k * 4) : size === 2 ? bin.readUInt16LE(off + k * 2) : bin[off + k];
  return out;
}

function nodeMatrix(n: any) {
  const m = new Matrix4();
  if (n.matrix) return m.fromArray(n.matrix);
  const t = new Vector3(...(n.translation || [0, 0, 0]));
  const r = new Quaternion(...(n.rotation || [0, 0, 0, 1]));
  const s = new Vector3(...(n.scale || [1, 1, 1]));
  return m.compose(t, r, s);
}

function load(id: string): Piece[] {
  const g = JSON.parse(readFileSync(join(SRC, id, `${id}_1k.gltf`), 'utf8'));
  const bin = readFileSync(join(SRC, id, g.buffers[0].uri));
  const pieces: Piece[] = [];
  const visit = (ni: number, parent: Matrix4) => {
    const n = g.nodes[ni];
    const m = parent.clone().multiply(nodeMatrix(n));
    if (n.mesh !== undefined) {
      for (const prim of g.meshes[n.mesh].primitives) {
        const p = readAccessor(g, bin, prim.attributes.POSITION) as Float32Array;
        const idx = prim.indices !== undefined ? (readAccessor(g, bin, prim.indices) as Uint32Array) : Uint32Array.from({ length: p.length / 3 }, (_, i) => i);
        const v = new Vector3();
        for (let k = 0; k < p.length; k += 3) { v.set(p[k], p[k + 1], p[k + 2]).applyMatrix4(m); p[k] = v.x; p[k + 1] = v.y; p[k + 2] = v.z; }
        pieces.push({ id: `${id}_${pieces.length}`, source: id, pos: p, idx });
      }
    }
    for (const c of n.children || []) visit(c, m);
  };
  for (const ni of g.scenes[g.scene || 0].nodes) visit(ni, new Matrix4());
  return pieces;
}

/** weld by position only (uv seams would otherwise tear during simplification) */
function weld(pos: Float32Array, idx: Uint32Array) {
  let lo = Infinity, hi = -Infinity;
  for (const v of pos) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const q = (hi - lo) * 1e-5 || 1e-6;
  const map = new Map<string, number>();
  const remap = new Uint32Array(pos.length / 3);
  const out: number[] = [];
  for (let i = 0; i < pos.length / 3; i++) {
    const key = `${Math.round(pos[i * 3] / q)},${Math.round(pos[i * 3 + 1] / q)},${Math.round(pos[i * 3 + 2] / q)}`;
    let r = map.get(key);
    if (r === undefined) { r = out.length / 3; map.set(key, r); out.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); }
    remap[i] = r;
  }
  const ni = new Uint32Array(idx.length);
  for (let k = 0; k < idx.length; k++) ni[k] = remap[idx[k]];
  return { pos: new Float32Array(out), idx: ni };
}

/** keep only referenced vertices, compute area-weighted smooth normals */
function compact(pos: Float32Array, idx: Uint32Array) {
  const used = new Int32Array(pos.length / 3).fill(-1);
  const p: number[] = [];
  const ni = new Uint32Array(idx.length);
  for (let k = 0; k < idx.length; k++) {
    let r = used[idx[k]];
    if (r < 0) { r = used[idx[k]] = p.length / 3; p.push(pos[idx[k] * 3], pos[idx[k] * 3 + 1], pos[idx[k] * 3 + 2]); }
    ni[k] = r;
  }
  const P = new Float32Array(p);
  const nrm = new Float32Array(P.length);
  for (let k = 0; k < ni.length; k += 3) {
    const a = ni[k] * 3, b = ni[k + 1] * 3, c = ni[k + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { nrm[o] += nx; nrm[o + 1] += ny; nrm[o + 2] += nz; }
  }
  for (let k = 0; k < nrm.length; k += 3) {
    const l = Math.hypot(nrm[k], nrm[k + 1], nrm[k + 2]) || 1;
    nrm[k] /= l; nrm[k + 1] /= l; nrm[k + 2] /= l;
  }
  return { pos: P, nrm, idx: ni };
}

await MeshoptSimplifier.ready;
mkdirSync(OUT, { recursive: true });
const posAll: number[] = [], nrmAll: number[] = [], idxAll: number[] = [];
const meta: any[] = [];
for (const id of SOURCES) {
  if (!existsSync(join(SRC, id))) { console.warn('missing source', id); continue; }
  for (const pc of load(id)) {
    const w = weld(pc.pos, pc.idx);
    // origin: center of the footprint, a quarter up from the bottom (instances sink that much)
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < w.pos.length; k += 3) {
      x0 = Math.min(x0, w.pos[k]); x1 = Math.max(x1, w.pos[k]);
      y0 = Math.min(y0, w.pos[k + 1]); y1 = Math.max(y1, w.pos[k + 1]);
      z0 = Math.min(z0, w.pos[k + 2]); z1 = Math.max(z1, w.pos[k + 2]);
    }
    const size = Math.max(x1 - x0, y1 - y0, z1 - z0);
    // normalize to a 1 m largest dimension; instances carry their own scale
    const cxm = (x0 + x1) / 2, czm = (z0 + z1) / 2, cym = y0 + (y1 - y0) * 0.22;
    for (let k = 0; k < w.pos.length; k += 3) {
      w.pos[k] = (w.pos[k] - cxm) / size;
      w.pos[k + 1] = (w.pos[k + 1] - cym) / size;
      w.pos[k + 2] = (w.pos[k + 2] - czm) / size;
    }
    const lods: any[] = [];
    let prevIdx: Uint32Array = w.idx;
    for (const tris of LOD_TRIS) {
      const target = Math.min(prevIdx.length, tris * 3);
      const [simp] = MeshoptSimplifier.simplify(prevIdx, w.pos, 3, target - (target % 3), 0.08, []);
      const c = compact(w.pos, simp as Uint32Array);
      lods.push({ vOff: posAll.length / 3, vCount: c.pos.length / 3, iOff: idxAll.length, iCount: c.idx.length });
      for (const v of c.pos) posAll.push(v);
      for (const v of c.nrm) nrmAll.push(v);
      for (const v of c.idx) idxAll.push(v);
      prevIdx = simp as Uint32Array;
    }
    meta.push({ id: pc.id, source: id, dims: [(x1 - x0) / size, (y1 - y0) / size, (z1 - z0) / size], lods });
    console.log(pc.id, 'tris', pc.idx.length / 3, '->', lods.map((l) => l.iCount / 3).join('/'));
  }
  const prov = join(SRC, id, 'provenance.json');
  if (existsSync(prov)) {
    mkdirSync(join(OUT, id), { recursive: true });
    const pj = JSON.parse(readFileSync(prov, 'utf8'));
    pj.note = 'geometry only, welded and decimated to three lods by tools/bake/rocks-prep.ts; textures not shipped';
    pj.files = [];
    writeFileSync(join(OUT, id, 'provenance.json'), JSON.stringify(pj, null, 2));
  }
}
const P = new Float32Array(posAll), Nn = new Float32Array(nrmAll), I = new Uint32Array(idxAll);
const buf = Buffer.concat([Buffer.from(P.buffer), Buffer.from(Nn.buffer), Buffer.from(I.buffer)]);
writeFileSync(join(OUT, 'rocks.bin'), buf);
writeFileSync(join(OUT, 'rocks.json'), JSON.stringify({ vertexCount: P.length / 3, indexCount: I.length, pieces: meta }, null, 1));
console.log('rocks', meta.length, 'pieces', (buf.length / 1e6).toFixed(2), 'MB');
void copyFileSync;
