// chunked lod terrain (cdlod): one shared grid patch drawn instanced per selected quadtree node.
// vertices morph toward the next coarser grid as they approach the end of their lod range, so
// neighboring levels always meet exactly (no cracks, no popping). morphing uses a fixed camera
// uniform so the shadow and reflection passes see the same surface as the main view.
import {
  Box3, BufferAttribute, Frustum, InstancedBufferAttribute, InstancedBufferGeometry, Matrix4, Vector3,
  DataTexture, FloatType, NearestFilter, RedFormat, ClampToEdgeWrapping, DynamicDrawUsage,
} from 'three/webgpu';
import { Fn, attribute, clamp, floor, fract, ivec2, mix, positionLocal, textureLoad, uniform, vec2, vec3 } from 'three/tsl';
import type { Camera } from 'three/webgpu';

// tsl node typing is too strict for composed math; the codebase aliases nodes loosely
type N = any;

/** quads per patch side */
export const PATCH = 32;

export interface HeightSource {
  data: Float32Array;
  res: number;
  size: number;
}

/** gpu height field (exact float32, fetched with manual bilinear in the vertex stage) */
export function heightTexture(src: HeightSource) {
  const tex = new DataTexture(src.data, src.res, src.res, RedFormat, FloatType);
  tex.magFilter = tex.minFilter = NearestFilter;
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/** tsl: terrain height at a world xz (bilinear over texel centers) */
export function heightNode(tex: DataTexture, src: HeightSource) {
  const cell = src.size / src.res, half = src.size / 2, m = src.res - 1;
  const fn: any = Fn(([xz]: [N]) => {
    const t: N = vec2(xz).add(half).div(cell).sub(0.5);
    const i0: N = floor(t);
    const f: N = t.sub(i0);
    const a0: N = clamp(i0, vec2(0), vec2(m));
    const a1: N = clamp(i0.add(1), vec2(0), vec2(m));
    const load = (a: N, b: N): N => (textureLoad as any)(tex, ivec2(a, b)).r;
    const h00 = load(a0.x, a0.y), h10 = load(a1.x, a0.y), h01 = load(a0.x, a1.y), h11 = load(a1.x, a1.y);
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  });
  return (xz: N): N => fn(xz);
}

interface Level {
  size: number;
  n: number;
  /** per node [min, max] height */
  mm: Float32Array;
}

export class CDLOD {
  readonly geometry: InstancedBufferGeometry;
  readonly uCam = uniform(new Vector3());
  readonly maxNodes = 2048;
  private aNode: InstancedBufferAttribute;
  private aMorph: InstancedBufferAttribute;
  private levels: Level[] = [];
  private ranges: number[] = [];
  private frustum = new Frustum();
  private m4 = new Matrix4();
  private box = new Box3();
  private sbox = new Box3();
  private cam = new Vector3();
  minLevel = 0;
  /** horizontal shadow offset per meter of height (toward -sun); keeps off-screen casters */
  shadowDir = { x: 0, z: 0, k: 0 };
  count = 0;

  constructor(private src: HeightSource, detail = 1) {
    const g = new InstancedBufferGeometry();
    const n = PATCH + 1;
    const pos = new Float32Array(n * n * 3);
    const nor = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 3;
      pos[k] = i; pos[k + 1] = 0; pos[k + 2] = j;
      nor[k + 1] = 1;
    }
    const idx: number[] = [];
    for (let j = 0; j < PATCH; j++) for (let i = 0; i < PATCH; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      // one diagonal everywhere: a fully morphed patch then collapses onto exactly the coarser
      // patch's triangles, so lod switches never flip a diagonal
      idx.push(a, c, d, a, d, b);
    }
    g.setIndex(idx);
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('normal', new BufferAttribute(nor, 3));
    this.aNode = new InstancedBufferAttribute(new Float32Array(this.maxNodes * 4), 4);
    this.aMorph = new InstancedBufferAttribute(new Float32Array(this.maxNodes * 2), 2);
    this.aNode.setUsage(DynamicDrawUsage);
    this.aMorph.setUsage(DynamicDrawUsage);
    g.setAttribute('aNode', this.aNode);
    g.setAttribute('aMorph', this.aMorph);
    g.instanceCount = 0;
    this.geometry = g;
    this.buildLevels();
    this.setDetail(detail);
  }

  private buildLevels() {
    const { data, res, size } = this.src;
    const cell = size / res;
    let nodeSize = PATCH * cell;
    let n = Math.round(size / nodeSize);
    // level 0 min/max straight from the height data (patch borders included)
    const leafTexels = PATCH;
    const mm0 = new Float32Array(n * n * 2);
    for (let nj = 0; nj < n; nj++) for (let ni = 0; ni < n; ni++) {
      let lo = 1e9, hi = -1e9;
      for (let j = nj * leafTexels; j <= Math.min(res - 1, (nj + 1) * leafTexels); j++)
        for (let i = ni * leafTexels; i <= Math.min(res - 1, (ni + 1) * leafTexels); i++) {
          const v = data[j * res + i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      mm0[(nj * n + ni) * 2] = lo;
      mm0[(nj * n + ni) * 2 + 1] = hi;
    }
    this.levels.push({ size: nodeSize, n, mm: mm0 });
    while (n > 1) {
      const prev = this.levels[this.levels.length - 1];
      const n2 = n >> 1;
      const mm = new Float32Array(n2 * n2 * 2);
      for (let j = 0; j < n2; j++) for (let i = 0; i < n2; i++) {
        let lo = 1e9, hi = -1e9;
        for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) {
          const k = ((j * 2 + b) * n + i * 2 + a) * 2;
          lo = Math.min(lo, prev.mm[k]);
          hi = Math.max(hi, prev.mm[k + 1]);
        }
        mm[(j * n2 + i) * 2] = lo;
        mm[(j * n2 + i) * 2 + 1] = hi;
      }
      nodeSize *= 2;
      n = n2;
      this.levels.push({ size: nodeSize, n, mm });
    }
  }

  /** lod range scale; kept above the crack-free minimum (range >= 2.5x the parent node diagonal) */
  setDetail(detail: number) {
    const r0 = Math.max(150, 150 * detail);
    this.ranges = this.levels.map((_, L) => r0 * 2 ** L);
  }

  /** the vertex stage: morphed grid position with the sampled height, in world space */
  positionNode(height: (xz: N) => N): N {
    const uCam = this.uCam;
    return (Fn(() => {
      const node: N = attribute('aNode', 'vec4');
      const morph: N = attribute('aMorph', 'vec2');
      const grid: N = positionLocal.xz;
      const p0: N = node.xy.add(grid.mul(node.z));
      const h0: N = height(p0);
      const d: N = (uCam as N).sub(vec3(p0.x, h0, p0.y)).length();
      const k: N = d.sub(morph.x).div(morph.y.sub(morph.x).max(0.001)).clamp(0, 1);
      const g2: N = grid.sub(fract(grid.mul(0.5)).mul(2).mul(k));
      const p: N = node.xy.add(g2.mul(node.z));
      return vec3(p.x, height(p), p.y);
    }) as any)();
  }

  /** quadtree selection against the camera frustum; call once per frame before rendering */
  update(camera: Camera, camPos: Vector3) {
    this.cam.copy(camPos);
    (this.uCam.value as Vector3).copy(camPos);
    this.m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m4);
    this.count = 0;
    const top = this.levels.length - 1;
    this.select(top, 0, 0);
    this.aNode.needsUpdate = true;
    this.aMorph.needsUpdate = true;
    this.aNode.clearUpdateRanges();
    this.aMorph.clearUpdateRanges();
    this.aNode.addUpdateRange(0, this.count * 4);
    this.aMorph.addUpdateRange(0, this.count * 2);
    this.geometry.instanceCount = this.count;
  }

  private nodeBox(L: number, i: number, j: number, out: Box3) {
    const lv = this.levels[L];
    const half = this.src.size / 2;
    const cell = this.src.size / this.src.res;
    // patches start on texel centers
    const x0 = -half + cell * 0.5 + i * lv.size, z0 = -half + cell * 0.5 + j * lv.size;
    const k = (j * lv.n + i) * 2;
    out.min.set(x0, lv.mm[k], z0);
    out.max.set(x0 + lv.size, lv.mm[k + 1], z0 + lv.size);
    return out;
  }

  private visible(b: Box3) {
    if (this.frustum.intersectsBox(b)) return true;
    // shadow casters just outside the view
    const sd = this.shadowDir;
    if (sd.k <= 0) return false;
    const len = Math.max(0, b.max.y - Math.min(b.min.y, 0)) * sd.k;
    this.sbox.copy(b);
    this.sbox.expandByPoint(new Vector3(b.min.x + sd.x * len, b.min.y, b.min.z + sd.z * len));
    this.sbox.expandByPoint(new Vector3(b.max.x + sd.x * len, b.min.y, b.max.z + sd.z * len));
    return this.frustum.intersectsBox(this.sbox);
  }

  private select(L: number, i: number, j: number) {
    const b = this.nodeBox(L, i, j, this.box);
    if (!this.visible(b)) return;
    const d = b.distanceToPoint(this.cam);
    if (L <= this.minLevel || d > this.ranges[L - 1]) {
      this.add(L, b);
      return;
    }
    for (let q = 0; q < 4; q++) this.select(L - 1, i * 2 + (q & 1), j * 2 + (q >> 1));
  }

  private add(L: number, b: Box3) {
    if (this.count >= this.maxNodes) return;
    const c = this.count++;
    const spacing = this.levels[L].size / PATCH;
    const a = this.aNode.array as Float32Array, m = this.aMorph.array as Float32Array;
    a[c * 4] = b.min.x;
    a[c * 4 + 1] = b.min.z;
    a[c * 4 + 2] = spacing;
    a[c * 4 + 3] = L;
    const top = L >= this.levels.length - 1;
    const end = this.ranges[L], prev = L > 0 ? this.ranges[L - 1] : 0;
    m[c * 2] = top ? 1e9 : prev + (end - prev) * 0.8;
    m[c * 2 + 1] = top ? 1e9 + 1 : end;
  }
}

