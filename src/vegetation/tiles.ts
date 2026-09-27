// camera-centered streaming of instanced vegetation in world-space tiles.
// each tile holds instances sorted by rank; the tile draws the prefix whose rank is below the
// density needed at its distance, and the shader shrinks individual instances as their own
// distance thins them, so there is never a visible ring or tile edge. tile data is generated
// on the cpu within a per-frame time budget, nearest tiles first, and ahead of need: a tile is
// regenerated half a tile before the density it holds runs out, with headroom for a tile and a
// quarter more, so instances never arrive late in a burst while cruising.
import {
  BufferAttribute, BufferGeometry, Box3, InstancedBufferGeometry, InstancedInterleavedBuffer,
  InterleavedBufferAttribute, Mesh, Sphere, Vector3, type Material, type Object3D,
} from 'three/webgpu';

export interface TileData {
  /** interleaved instance floats, sorted by rank ascending */
  data: Float32Array;
  /** rank per instance (ascending) */
  ranks: Float32Array;
  count: number;
  minY: number;
  maxY: number;
}

export interface InstanceAttrib { name: string; size: number; offset: number }

export interface TileLayerSpec {
  name: string;
  tileSize: number;
  /** floats per instance */
  stride: number;
  attribs: InstanceAttrib[];
  /** base geometry per lod (non-instanced; will be cloned per tile) */
  lods: BufferGeometry[];
  material: Material;
  /** max drawn distance in meters */
  maxDistance(): number;
  /** lod index for a tile whose nearest point is at distance d */
  lodFor(d: number): number;
  /** fraction of ranks (0..1] needed at distance d */
  needFor(d: number): number;
  /** quick reject: does the tile possibly contain instances */
  hasContent(tx: number, tz: number): boolean;
  /** approximate ground height at a tile center (for 3d distance before generation) */
  groundAt(x: number, z: number): number;
  generate(tx: number, tz: number, need: number): TileData | null;
  /** extra bounding height above the ground (tallest instance) */
  maxHeight: number;
  /** horizontal bounds margin for instances that spill over the tile edge */
  margin?: number;
  layer: number;
  castShadow?: boolean;
  /** tiles farther than this (m) stop casting; small plants' shadows are invisible far away */
  shadowDistance?: number;
  receiveShadow?: boolean;
  renderOrder?: number;
}

interface Tile {
  key: number;
  tx: number;
  tz: number;
  data: TileData | null;
  /** need the current data was generated with */
  need: number;
  geoms: (InstancedBufferGeometry | null)[];
  mesh: Mesh | null;
  lod: number;
  dist: number;
  used: number;
  queued: boolean;
  empty: boolean;
}

const tileKey = (tx: number, tz: number) => (tx + 4096) * 8192 + (tz + 4096);

export class TileLayer {
  spec: TileLayerSpec;
  root: Object3D;
  tiles = new Map<number, Tile>();
  private queue: Tile[] = [];
  private frame = 0;
  private lastCam = new Vector3(1e9, 0, 1e9);
  private shown = new Set<Tile>();
  stats = { tiles: 0, visible: 0, instances: 0, generatedMs: 0 };

  constructor(spec: TileLayerSpec, root: Object3D) {
    this.spec = spec;
    this.root = root;
  }

  /** drop every tile (quality change, new field) */
  clear() {
    for (const t of this.tiles.values()) this.release(t);
    this.tiles.clear();
    this.queue.length = 0;
  }

  update(cam: Vector3, budgetMs: number) {
    const s = this.spec;
    const T = s.tileSize;
    const maxD = s.maxDistance();
    this.frame++;
    // after a teleport, spend more time so the view fills quickly
    const jumped = cam.distanceToSquared(this.lastCam) > 60 * 60;
    this.lastCam.copy(cam);
    if (jumped) budgetMs = Math.max(budgetMs, 40);

    const ctx = Math.floor(cam.x / T), ctz = Math.floor(cam.z / T);
    const r = Math.ceil(maxD / T) + 1;
    let visible = 0, instances = 0;
    const wasShown = this.shown;
    wasShown.clear();
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const tx = ctx + dx, tz = ctz + dz;
        const x0 = tx * T, z0 = tz * T;
        const hx = cam.x < x0 ? x0 - cam.x : cam.x > x0 + T ? cam.x - x0 - T : 0;
        const hz = cam.z < z0 ? z0 - cam.z : cam.z > z0 + T ? cam.z - z0 - T : 0;
        const hd = Math.hypot(hx, hz);
        if (hd > maxD) continue;
        const key = tileKey(tx, tz);
        let t = this.tiles.get(key);
        if (!t) {
          const empty = !s.hasContent(tx, tz);
          t = { key, tx, tz, data: null, need: 0, geoms: [], mesh: null, lod: -1, dist: 0, used: 0, queued: false, empty };
          this.tiles.set(key, t);
        }
        t.used = this.frame;
        if (t.empty) continue;
        // 3d distance to the tile's height band
        const gy0 = t.data ? t.data.minY : s.groundAt(x0 + T / 2, z0 + T / 2) - 4;
        const gy1 = t.data ? t.data.maxY + s.maxHeight : gy0 + 8;
        const vy = cam.y > gy1 ? cam.y - gy1 : cam.y < gy0 ? gy0 - cam.y : 0;
        const d = Math.hypot(hd, vy);
        t.dist = d;
        if (d > maxD) {
          if (t.mesh) t.mesh.visible = false;
          continue;
        }
        const need = s.needFor(d);
        const soon = s.needFor(Math.max(0, d - T * 0.5));
        if ((!t.data || t.need < soon - 1e-3) && !t.queued) {
          t.queued = true;
          this.queue.push(t);
        }
        if (t.data && t.data.count > 0) {
          const n = countBelow(t.data.ranks, t.data.count, need);
          if (n > 0) {
            this.show(t, s.lodFor(d), n);
            wasShown.add(t);
            visible++;
            instances += n;
          } else if (t.mesh) t.mesh.visible = false;
        }
      }
    }

    // generate, nearest first, within budget
    if (this.queue.length) {
      this.queue.sort((a, b) => a.dist - b.dist);
      const t0 = performance.now();
      let i = 0;
      while (i < this.queue.length) {
        const t = this.queue[i++];
        t.queued = false;
        if (t.used !== this.frame) continue;
        // headroom so an approaching camera does not regenerate every few meters
        const need = Math.min(1, s.needFor(Math.max(0, t.dist - T * 1.25)) * 1.2 + 0.03);
        const data = s.generate(t.tx, t.tz, need);
        this.setData(t, data, need);
        // show the new data this frame: a regenerated tile must never drop out for a frame
        const n = t.data && t.dist <= maxD ? countBelow(t.data.ranks, t.data.count, s.needFor(t.dist)) : 0;
        if (n > 0) {
          this.show(t, s.lodFor(t.dist), n);
          if (!wasShown.has(t)) { visible++; instances += n; }
        } else if (t.mesh) t.mesh.visible = false;
        if (performance.now() - t0 > budgetMs) break;
      }
      this.queue.splice(0, i);
      this.stats.generatedMs = performance.now() - t0;
    }

    // evict tiles that fell well outside the range
    if (this.frame % 30 === 0) {
      for (const [k, t] of this.tiles) {
        if (this.frame - t.used > 90) {
          this.release(t);
          this.tiles.delete(k);
        }
      }
    }
    this.stats.tiles = this.tiles.size;
    this.stats.visible = visible;
    this.stats.instances = instances;
  }

  private setData(t: Tile, data: TileData | null, need: number) {
    // keep the mesh: show() swaps in the new geometry in the same frame, so the tile never blinks
    for (const g of t.geoms) g?.dispose();
    t.geoms = [];
    t.need = need;
    if (!data || data.count === 0) {
      t.data = data ?? { data: new Float32Array(0), ranks: new Float32Array(0), count: 0, minY: 0, maxY: 0 };
      if (!data || need >= 0.999) t.empty = t.data.count === 0;
      if (t.mesh) t.mesh.visible = false;
      return;
    }
    t.data = data;
  }

  private buildGeom(t: Tile, lod: number) {
    const s = this.spec;
    const d = t.data!;
    const base = s.lods[lod];
    const g = new InstancedBufferGeometry();
    g.index = base.index ? new BufferAttribute((base.index.array as Uint16Array).slice(), 1) : null;
    for (const name of Object.keys(base.attributes)) {
      const a = base.getAttribute(name) as BufferAttribute;
      g.setAttribute(name, new BufferAttribute((a.array as Float32Array).slice(), a.itemSize, a.normalized));
    }
    const ib = new InstancedInterleavedBuffer(d.data, s.stride, 1);
    for (const at of s.attribs) g.setAttribute(at.name, new InterleavedBufferAttribute(ib, at.size, at.offset));
    g.instanceCount = 0;
    const T = s.tileSize;
    const cx = (t.tx + 0.5) * T, cz = (t.tz + 0.5) * T;
    const y0 = d.minY, y1 = d.maxY + s.maxHeight;
    const mg = 1 + (s.margin ?? 0);
    g.boundingBox = new Box3(new Vector3(t.tx * T - mg, y0 - 0.5, t.tz * T - mg), new Vector3((t.tx + 1) * T + mg, y1 + 0.5, (t.tz + 1) * T + mg));
    g.boundingSphere = new Sphere(new Vector3(cx, (y0 + y1) / 2, cz), Math.hypot(T * 0.5 + mg, T * 0.5 + mg, (y1 - y0) / 2 + 0.5));
    return g;
  }

  private show(t: Tile, lod: number, n: number) {
    const s = this.spec;
    let g = t.geoms[lod];
    if (!g) g = t.geoms[lod] = this.buildGeom(t, lod);
    g.instanceCount = n;
    if (!t.mesh) {
      const m = new Mesh(g, s.material);
      m.matrixAutoUpdate = false;
      m.layers.set(s.layer);
      m.castShadow = !!s.castShadow;
      m.receiveShadow = s.receiveShadow !== false;
      m.renderOrder = s.renderOrder ?? 0;
      m.name = `${s.name}:${t.tx},${t.tz}`;
      t.mesh = m;
      this.root.add(m);
    }
    if (t.mesh.geometry !== g) t.mesh.geometry = g;
    t.mesh.castShadow = !!s.castShadow && (s.shadowDistance === undefined || t.dist < s.shadowDistance);
    t.lod = lod;
    t.mesh.visible = true;
  }

  private disposeGeoms(t: Tile) {
    for (const g of t.geoms) g?.dispose();
    t.geoms = [];
    if (t.mesh) {
      this.root.remove(t.mesh);
      t.mesh = null;
    }
  }

  private release(t: Tile) {
    this.disposeGeoms(t);
    t.data = null;
  }
}

/** number of ranks below `need` in an ascending array (binary search) */
function countBelow(ranks: Float32Array, count: number, need: number) {
  let lo = 0, hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranks[mid] < need) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** sort interleaved instance records by rank; returns sorted data and ranks */
export function sortByRank(buf: Float32Array, ranks: Float32Array, count: number, stride: number) {
  const idx = new Uint32Array(count);
  for (let i = 0; i < count; i++) idx[i] = i;
  idx.sort((a, b) => ranks[a] - ranks[b]);
  const data = new Float32Array(count * stride);
  const r = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const src = idx[i];
    data.set(buf.subarray(src * stride, src * stride + stride), i * stride);
    r[i] = ranks[src];
  }
  return { data, ranks: r };
}
