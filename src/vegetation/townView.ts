// keeps the canal view of the town open: trees stay off the buildings and out of the ground between
// the water and the house fronts, so facades, shopfronts, lanterns and noren read from the boat.
// every building site is mapped once into river coordinates (along-river s, side, meters q from the
// water's edge); a tree is tested there, after a coarse world grid rejects the rest of the map.
import { bankPoint, nearestRiver, RIVER_LENGTH, WORLD_SIZE } from '../world/layout';
import { SITES, type SiteKind } from '../world/sites';

const FACADES = new Set<SiteKind>(['machiya', 'machiya-low', 'kura', 'shop', 'shrine', 'pagoda', 'hall', 'teahouse', 'mill', 'town']);

interface Front { side: -1 | 1; s0: number; s1: number; q0: number; q1: number; street: boolean }

/** trees each planter dropped to keep the view open (reported in vegetation stats) */
export const viewStats = { forest: 0, cherryGrid: 0, opening: 0 };

const CELL = 16, BIN = 16, PAD = 4;
let grid: Uint8Array | null = null;
let bins: Front[][] = [];
const GN = Math.ceil(WORLD_SIZE / CELL), HALF = WORLD_SIZE / 2;

function build() {
  const fronts: Front[] = [];
  for (const site of SITES) {
    if (!site.kind || !FACADES.has(site.kind)) continue;
    const c = nearestRiver(site.x, site.z);
    const side = c.lateral < 0 ? -1 : 1, q = Math.abs(c.lateral) - c.width / 2;
    const a = bankPoint(c.s - 1, side, q), b = bankPoint(c.s + 1, side, q);
    const hs = site.hz / (Math.hypot(b.x - a.x, b.z - a.z) / 2 || 1);
    fronts.push({ side, s0: c.s - hs, s1: c.s + hs, q0: q - site.hx, q1: q + site.hx, street: site.kind === 'town' });
  }
  grid = new Uint8Array(GN * GN);
  bins = Array.from({ length: Math.ceil(RIVER_LENGTH / BIN) + 1 }, () => []);
  for (const f of fronts) {
    for (let k = Math.max(0, Math.floor((f.s0 - PAD) / BIN)); k <= Math.min(bins.length - 1, Math.floor((f.s1 + PAD) / BIN)); k++) bins[k].push(f);
    // mark the cells from the water to the back wall (3x3 so a 4 m sampling step cannot miss one)
    for (let s = f.s0 - PAD; s <= f.s1 + PAD; s += 4) for (let q = -2; q <= f.q1 + PAD; q += 4) {
      const p = bankPoint(s, f.side, q);
      const gi = Math.floor((p.x + HALF) / CELL), gj = Math.floor((p.z + HALF) / CELL);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const i = gi + di, j = gj + dj;
        if (i >= 0 && j >= 0 && i < GN && j < GN) grid[j * GN + i] = 1;
      }
    }
  }
}

/**
 * true when a tree of crown radius r at (x, z) would hide a facade from the canal: on a building or
 * anywhere between it and the water. waterfront rows and landmarks stay clear down to the water;
 * `reach` caps that to a margin in front of the inland street rows (accents may stand there)
 */
export function hidesFacade(x: number, z: number, r = 2.5, reach = Infinity) {
  if (!grid) build();
  const gi = Math.floor((x + HALF) / CELL), gj = Math.floor((z + HALF) / CELL);
  if (gi < 0 || gj < 0 || gi >= GN || gj >= GN || !grid![gj * GN + gi]) return false;
  const c = nearestRiver(x, z);
  const side = c.lateral < 0 ? -1 : 1, q = Math.abs(c.lateral) - c.width / 2;
  const bin = bins[Math.floor(c.s / BIN)];
  if (!bin) return false;
  for (const f of bin) {
    if (f.side !== side || c.s < f.s0 - r || c.s > f.s1 + r || q > f.q1 + r) continue;
    if (f.street && q < f.q0 - reach) continue;
    return true;
  }
  return false;
}
