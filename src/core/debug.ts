// window.__luma: hooks for the headless harness and manual debugging.
import { Vector3 } from 'three/webgpu';
import type { GameContext } from './context';
import type { Action } from './input';
import { DOCKS, POIS, SPAWN, nearestRiver, riverFrame } from '../world/layout';

/** point at along-river s, `lat` meters right of the centerline (facing upstream), height y */
function rp(sAlong: number, lat: number, y: number): number[] {
  const f = riverFrame(sAlong);
  return [f.x + f.nx * lat, y, f.z + f.nz * lat];
}

const spawnLat = nearestRiver(SPAWN.x, SPAWN.z).lateral;

/** named screenshot viewpoints: [camera position, look-at target], derived from the river layout */
export const VIEWS: Record<string, [number[], number[]]> = {
  // the reference composition: behind and above the moored boat, looking upstream at the red bridge
  opening: [rp(176, spawnLat + 3, 5.2), rp(300, 0, 2.5)],
  village: [rp(120, 8, 7), rp(230, -20, 3)],
  'red-bridge': [rp(262, 4, 2.2), rp(300, 0, 4)],
  pagoda: [rp(350, -6, 2.5), rp(392, 45, 16)],
  'stone-bridge': [rp(640, 0, 2.5), rp(680, 0, 3)],
  gorge: [rp(900, 0, 3), rp(1000, 0, 6)],
  lake: [rp(1560, 0, 3), rp(1760, 30, 2)],
  teahouse: [rp(1660, -20, 3), rp(1702, 60, 3)],
  falls: [rp(2050, 0, 4), rp(2119, 0, 12)],
  aerial: [rp(500, -250, 420), rp(700, 0, 0)],
};
// legacy names used by older scripts
VIEWS.harbor = VIEWS.opening;
VIEWS['harbor-wide'] = VIEWS.village;
VIEWS['open-water'] = VIEWS.lake;
VIEWS.cliffside = VIEWS.gorge;
VIEWS.cove = VIEWS.teahouse;
VIEWS.lighthouse = VIEWS.pagoda;
VIEWS.grotta = VIEWS.falls;

export function installDebug(ctx: GameContext) {
  const held = new Set<Action>();
  // a camera teleport builds the far pieces around where it lands right away (see core/stream.ts)
  const forceAt = (pos: number[], target: number[]) => {
    const stream = ctx.services.stream as { force?(s: number): void } | undefined;
    stream?.force?.(nearestRiver(pos[0], pos[2]).s);
    stream?.force?.(nearestRiver(target[0], target[2]).s);
  };
  const api = {
    ctx,
    views: VIEWS,
    docks: DOCKS,
    pois: POIS,
    spawn: SPAWN,
    view(name: string) {
      const v = VIEWS[name];
      if (!v || !ctx.cameraRig) return false;
      forceAt(v[0], v[1]);
      ctx.cameraRig.setOverride(new Vector3(...v[0]), new Vector3(...v[1]));
      return true;
    },
    look(pos: number[], target: number[]) {
      forceAt(pos, target);
      ctx.cameraRig?.setOverride(new Vector3(...pos), new Vector3(...target));
    },
    clearView() {
      ctx.cameraRig?.setOverride(null);
    },
    /** hold a time of day and weather for tests and screenshots: day(21, 'storm'); day(null) releases */
    day(hours: number | null, weather: 'clear' | 'cloudy' | 'rain' | 'storm' = 'clear') {
      (ctx.services.day as { freeze(h: number | null, w?: string): void } | undefined)?.freeze(hours, weather as never);
    },
    /** river centerline at along-river s (test scripts fly the camera with it) */
    river(s: number) {
      const f = riverFrame(s);
      return { s: f.s, x: f.x, z: f.z, width: f.width };
    },
    hold(a: Action, on = true) {
      ctx.input.setHeld(a, on);
      if (on) held.add(a);
      else held.delete(a);
    },
    releaseAll() {
      for (const a of held) ctx.input.setHeld(a, false);
      held.clear();
    },
    press(a: Action) {
      ctx.input.setHeld(a, true);
      ctx.events.emit('input:' + a);
      setTimeout(() => ctx.input.setHeld(a, false), 50);
    },
    setQuality(name: 'low' | 'balanced' | 'high') {
      ctx.events.emit('settings:change', { quality: name });
    },
    stats() {
      const loop = ctx.services.loop as any;
      const info = (ctx.renderer as any).info;
      const b = ctx.boat;
      return {
        backend: ctx.backend,
        quality: ctx.quality.name,
        fps: +loop.stats.fps.toFixed(1),
        frameMs: +loop.stats.frameMs.toFixed(2),
        frames: loop.stats.frames,
        calls: info?.render?.calls,
        triangles: info?.render?.triangles,
        failed: ctx.services.failedModules,
        sim: +ctx.time.sim.toFixed(2),
        paused: ctx.paused,
        boat: b ? { x: +b.position.x.toFixed(2), y: +b.position.y.toFixed(3), z: +b.position.z.toFixed(2), speed: +b.speed.toFixed(2), docked: b.docked } : null,
        camera: ctx.cameraRig?.mode,
      };
    },
  };
  (window as any).__luma = api;
  return api;
}
