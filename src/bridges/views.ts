// camera poses for the bridges screenshots (test/scripts/bridges-shots.mjs), derived from the layout.
import type { GameContext } from '../core/context';
import { BRIDGES, DOCKS, headingToForward, riverFrame } from '../world/layout';

/** point at along-river s, `lat` meters right of the centerline (facing upstream), height y */
function rp(s: number, lat: number, y: number): number[] {
  const f = riverFrame(s);
  return [f.x + f.nx * lat, y, f.z + f.nz * lat];
}

export function bridgeViews(_ctx: GameContext): Record<string, [number[], number[]]> {
  const sOf = (id: string) => BRIDGES.find((b) => b.id === id)!.s;
  const red = sOf('red-bridge'), stone = sOf('stone-bridge'), cov = sOf('covered-bridge'), plank = sOf('plank-bridge');
  const v: Record<string, [number[], number[]]> = {
    // ref1 composition: low behind the boat, the arch spanning the frame
    'red-ref1': [rp(red - 34, 6, 3.6), rp(red, -1, 3.2)],
    'red-close': [rp(red - 16, 5, 1.5), rp(red, -3, 3.4)],
    'red-under': [rp(red - 6, 2, 1.3), rp(red + 4, -8, 3.5)],
    'red-rail': [rp(red - 5, -14, 5.2), rp(red, -4, 4.4)],
    'red-side': [rp(red - 40, -18, 2.2), rp(red, -8, 2.6)],
    'stone-front': [rp(stone - 38, 0, 2.2), rp(stone, 0, 3.2)],
    'stone-close': [rp(stone - 14, 6, 1.6), rp(stone, 7, 3.2)],
    'stone-side': [rp(stone - 30, -12, 3.5), rp(stone, 0, 3)],
    'covered-front': [rp(cov - 45, 0, 3), rp(cov, 0, 8)],
    'covered-close': [rp(cov - 16, 4, 2), rp(cov, 0, 9)],
    'plank-front': [rp(plank - 30, 4, 2.2), rp(plank, 0, 2.6)],
    'weir': [rp(30, 6, 3.2), rp(8, -4, 0)],
    'weir-down': [rp(-8, -6, 3), rp(8, 0, 0)],
    'embank-left': [rp(150, -8, 2.2), rp(205, -22, 1)],
    'embank-right': [rp(230, 10, 2.2), rp(270, 22, 1)],
    'embank-steps': [rp(128, -10, 2.4), rp(146, -22, 0.8)],
  };
  for (const d of DOCKS) {
    const fwd = headingToForward(d.headingDeg);
    const f = riverFrame(d.s);
    // from the open water, a little astern, looking at the moored boat and the landing
    const out = -d.side;
    const px = d.moorX + f.nx * out * 9 - fwd.x * 7, pz = d.moorZ + f.nz * out * 9 - fwd.z * 7;
    v['landing-' + d.id] = [[px, 2.6, pz], [d.moorX - f.nx * out * 2, 0.9, d.moorZ - f.nz * out * 2]];
  }
  return v;
}
