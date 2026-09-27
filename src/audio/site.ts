// where the listener is along the river, refreshed a few times a second: along-river s, distance
// to the water, current speed, how rocky the nearby banks are, the bamboo gorge, tree cover. every
// layer reads this instead of sampling the world itself. channels the bake has not filled yet
// (all zero) fall back to plausible values so the soundscape still works on a stub world.
import type { WorldData } from '../world/worldData';
import { bankPoint, nearestRiver, riverFrame } from '../world/layout';
import { clamp, smoothstep } from './dsp';

export interface Site {
  s: number;
  /** signed lateral offset from the centerline (+ right bank) */
  lateral: number;
  width: number;
  /** horizontal meters from the listener to the water's edge (0 over water) */
  toWater: number;
  /** listener height above the river surface */
  height: number;
  /** surface current at the nearest channel point, m/s */
  flow: number;
  /** 0..1 rockiness of the nearby banks */
  rock: number;
  /** 0..1 inside the bamboo gorge */
  gorge: number;
  /** 0..1 tree cover on the nearby valley sides */
  trees: number;
  /** 0..1 bamboo on the left / right bank near the listener (gorge, plus the baked bamboo channel) */
  bambooL: number;
  bambooR: number;
}

export const GORGE = { from: 820, to: 1180 };

export function createSite(): Site {
  return { s: 190, lateral: 0, width: 40, toWater: 0, height: 3, flow: 0.4, rock: 0, gorge: 0, trees: 0.6, bambooL: 0, bambooR: 0 };
}

const filled = new Map<string, boolean>();
/** true when a world channel exists and is not all zeros (stub bakes) */
export function channelHasData(world: WorldData | null | undefined, name: string): boolean {
  if (!world || !world.has(name)) return false;
  let v = filled.get(name);
  if (v === undefined) {
    const d = world.channels.get(name)!.data;
    v = false;
    for (let i = 0; i < d.length; i += 97) if (Math.abs(d[i]) > 0.02) { v = true; break; }
    filled.set(name, v);
  }
  return v;
}

export function gorgeAt(s: number) {
  return smoothstep(GORGE.from - 30, GORGE.from + 30, s) * (1 - smoothstep(GORGE.to - 30, GORGE.to + 30, s));
}

export function updateSite(world: WorldData | null | undefined, x: number, y: number, z: number, site: Site) {
  const nr = nearestRiver(x, z);
  if (!Number.isFinite(nr.s)) return site;
  site.s = nr.s;
  site.lateral = nr.lateral;
  site.width = nr.width;
  site.toWater = Math.max(0, Math.abs(nr.lateral) - nr.width / 2);
  site.height = Math.max(0, y);
  site.gorge = gorgeAt(nr.s);
  const f = riverFrame(nr.s);
  if (world && channelHasData(world, 'flowX')) {
    site.flow = Math.hypot(world.sample('flowX', f.x, f.z), world.sample('flowZ', f.x, f.z));
  } else {
    site.flow = nr.width > 80 ? 0.05 : 0.45;
  }
  if (world && channelHasData(world, 'rock')) {
    let r = 0;
    for (const ds of [-25, 0, 25]) for (const side of [-1, 1] as const) {
      const p = bankPoint(nr.s + ds, side, 1.5);
      r = Math.max(r, world.sample('rock', p.x, p.z));
    }
    site.rock = clamp(r * 1.6);
  } else site.rock = site.gorge * 0.6;
  // forests start some way up the valley sides: take the densest ring on each side, then average
  if (world && channelHasData(world, 'trees')) {
    let t = 0;
    for (const side of [-1, 1] as const) {
      let m = 0;
      for (const ds of [-30, 0, 30]) for (const off of [20, 50, 90]) {
        const p = bankPoint(nr.s + ds, side, off);
        m = Math.max(m, world.sample('trees', p.x, p.z) * (off > 60 ? 0.7 : 1));
      }
      t += m / 2;
    }
    site.trees = clamp(0.15 + t);
  } else site.trees = 0.6;
  const bamboo = world && channelHasData(world, 'bamboo');
  for (const side of [-1, 1] as const) {
    let b = site.gorge * 0.8;
    if (bamboo) {
      for (const ds of [-20, 0, 20]) for (const off of [6, 20, 45]) {
        const p = bankPoint(nr.s + ds, side, off);
        b = Math.max(b, world!.sample('bamboo', p.x, p.z));
      }
    }
    if (side < 0) site.bambooL = clamp(b);
    else site.bambooR = clamp(b);
  }
  return site;
}
