// camera-centred geometry clipmap for the ocean.
// level 0 is a full (2M)^2 grid of spacing s0; level L > 0 is a ring of spacing s0 * 2^L around it.
// every level snaps to twice its own spacing, so vertices only ever sit on their world grid (no swimming).
// the inner level can sit at one of two offsets inside the ring's (M + 1)-cell hole; the ring's hole-edge
// vertices are clamped onto the inner level's actual border, which keeps the seam watertight.
// near its outer border each level geomorphs (cdlod style) odd vertices onto the next level's grid.
// s0 is a power of two so every snapped coordinate is exact in float32.
import { BufferAttribute, BufferGeometry, Vector3 } from 'three/webgpu';
import { abs, attribute, clamp, float, floor, fract, max, mix, positionGeometry, saturate, uniform, vec2 } from 'three/tsl';

type N = any;

export const S0 = 0.25;

export interface ClipmapSpec {
  /** cells per half side of each level (even) */
  m: number;
  levels: number;
  extent: number;
}

export function clipmapSpec(detail: number, farExtent = 6000): ClipmapSpec {
  const m = Math.max(16, 2 * Math.round(24 * detail));
  let levels = 1;
  while (m * S0 * 2 ** (levels - 1) < farExtent) levels++;
  return { m, levels, extent: m * S0 * 2 ** (levels - 1) };
}

export function buildClipmapGeometry(spec: ClipmapSpec): BufferGeometry {
  const { m, levels } = spec;
  const lo = -m / 2, hi = m / 2 + 1;
  const pos: number[] = [];
  const info: number[] = [];
  const idx: number[] = [];
  let base = 0;
  for (let L = 0; L < levels; L++) {
    const s = S0 * 2 ** L;
    const map = new Map<number, number>();
    const key = (i: number, j: number) => (i + m) * (2 * m + 1) + (j + m);
    const inHole = (i: number, j: number) => L > 0 && i > lo && i < hi && j > lo && j < hi;
    const onEdge = (i: number, j: number) => L > 0 && i >= lo && i <= hi && j >= lo && j <= hi && (i === lo || i === hi || j === lo || j === hi);
    let count = 0;
    for (let j = -m; j <= m; j++) {
      for (let i = -m; i <= m; i++) {
        if (inHole(i, j)) continue;
        map.set(key(i, j), base + count++);
        pos.push(i, L, j);
        info.push(s, onEdge(i, j) ? 1 : 0);
      }
    }
    for (let j = -m; j < m; j++) {
      for (let i = -m; i < m; i++) {
        if (L > 0 && i >= lo && i + 1 <= hi && j >= lo && j + 1 <= hi) continue;
        const a = map.get(key(i, j)), b = map.get(key(i, j + 1)), c = map.get(key(i + 1, j + 1)), d = map.get(key(i + 1, j));
        if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
        idx.push(a, b, c, a, c, d);
      }
    }
    base += count;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aInfo', new BufferAttribute(new Float32Array(info), 2));
  const n = new Float32Array((pos.length / 3) * 3);
  for (let i = 1; i < n.length; i += 3) n[i] = 1;
  g.setAttribute('normal', new BufferAttribute(n, 3));
  g.setIndex(new BufferAttribute(new Uint32Array(idx), 1));
  return g;
}

/** camera world position the clipmap centres on (updated per frame) */
export const uClipCam = uniform(new Vector3());
/** x = cells per half side (M), y = morph start (cells), z = morph end (cells) */
export const uClipParams = uniform(new Vector3(48, 27, 46));

export function setClipParams(spec: ClipmapSpec) {
  const m = spec.m;
  const start = Math.max(m / 2 + 3, m * 0.58);
  (uClipParams.value as Vector3).set(m, start, m - 2);
}

/** vertex-stage rest position (world xz) and effective spacing for lod fading */
export function clipmapRest(): { rest: N; spacing: N } {
  const g = positionGeometry;
  const inf = attribute('aInfo', 'vec2');
  const s = inf.x;
  const edge = inf.y;
  const ij = vec2(g.x, g.z);
  const cam = vec2(uClipCam.x, uClipCam.z);
  const s2 = s.mul(2);
  const center = floor(cam.div(s2)).mul(s2);
  const raw = center.add(ij.mul(s));
  // hole-edge vertices land exactly on the inner level's border
  const inner = floor(cam.div(s)).mul(s);
  const half = s.mul(uClipParams.x).mul(0.5);
  const clamped = clamp(raw, inner.sub(half), inner.add(half));
  const snapped = mix(raw, clamped, edge);
  // geomorph toward the next level's grid near the outer border (never on hole edges)
  const d = max(abs(snapped.x.sub(cam.x)), abs(snapped.y.sub(cam.y))).div(s);
  const k = saturate(d.sub(uClipParams.y).div(uClipParams.z.sub(uClipParams.y))).mul(float(1).sub(edge));
  const rest = snapped.sub(fract(ij.mul(0.5)).mul(s2).mul(k));
  return { rest, spacing: s.mul(k.add(1)) };
}
