// bridges + river works (owner: bridges): the vermilion, spectacles, covered and heron bridges, the
// landings at every DOCKS entry, the village ishigaki embankments with their water steps, paper
// lanterns and the old weir. everything is placed from src/world/layout.ts and the baked terrain.
// publishes ctx.services.bridges (see ./types) for gameplay, audio and water.
import { Group, Matrix4 } from 'three/webgpu';
import type { GameContext } from '../core/context';
import type { QualityPreset } from '../core/settings';
import { BRIDGES, DOCKS, bankPoint, riverFrame, type Bridge } from '../world/layout';
import { createMaterials, createRoofMaterial } from './materials';
import { buildRed } from './red';
import { buildStone } from './stone';
import { buildCovered } from './covered';
import { buildPlank } from './plank';
import { buildLanding } from './landings';
import { buildWall, type WallRun } from './embank';
import { buildWeir } from './weir';
import { postLantern } from './lanterns';
import { rng } from './geom';
import { Site } from './site';
import type { BridgeInfo, BridgesService, LandingInfo, LanternInfo, PlatformInfo, WeirInfo } from './types';
import type { Slice, Streamer } from '../core/stream';

export type { BridgesService } from './types';

function safe<T>(label: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (e) {
    console.error(`[bridges] ${label} failed`, e);
    return null;
  }
}

const BUILD: Record<string, (ctx: GameContext, b: Bridge) => { site: Site; info: BridgeInfo }> = {
  'red-arch': buildRed,
  'stone-arch': buildStone,
  covered: buildCovered,
  plank: buildPlank,
};

/** sites cull at Site.far (900 m), times up to 1.35 on the high preset */
const CULL_FAR = 900 * 1.35;

export async function init(ctx: GameContext) {
  const t0 = performance.now();
  // textures load while the geometry builds
  const matsP = createMaterials(ctx);
  // near-first: a bridge or landing nobody can see from the river around the start is built after the
  // reveal (ctx.services.stream), and so are its textures (the covered bridge's shingles)
  const stream = ctx.services.stream as Streamer | undefined;
  const isLate = (x: number, z: number, top: number, radius: number) => !!stream && !stream.seen(x, z, top, CULL_FAR, radius);
  const lateBridges: Bridge[] = [];
  const lateDocks: typeof DOCKS = [];
  const sites: Site[] = [];
  const bridges: BridgeInfo[] = [];
  const landings: Record<string, LandingInfo> = {};
  const platforms: PlatformInfo[] = [];
  const lanterns: LanternInfo[] = [];
  let weir: WeirInfo | null = null;
  const embankments: BridgesService['embankments'] = [];

  // ---- bridges ----
  for (const b of BRIDGES) {
    const f = riverFrame(b.s);
    if (isLate(f.x, f.z, b.type === 'covered' ? 9 : 6, f.width / 2 + 8)) {
      lateBridges.push(b);
      continue;
    }
    const r = safe(b.id, () => BUILD[b.type]?.(ctx, b) ?? null);
    if (r) {
      sites.push(r.site);
      bridges.push(r.info);
    }
  }

  // ---- village waterfront: embankment runs, gaps for the landing stairs and the bridge abutments ----
  const red = BRIDGES.find((b) => b.type === 'red-arch');
  const abut = red ? [red.s - red.deckWidth / 2 - 1.0, red.s + red.deckWidth / 2 + 1.0] as [number, number] : null;
  const village = DOCKS.find((d) => d.id === 'village');
  const landingGap = (s: number): [number, number] => [s - 1.75, s + 1.75];
  const runs: WallRun[] = [
    {
      id: 'embank-left', side: -1, s0: 60, s1: 330,
      gaps: [...(village && village.side === -1 ? [landingGap(village.s)] : []), ...(abut ? [abut] : [])],
      gangi: [{ s: 94, platform: false }, { s: 138, platform: true }, { s: 231, platform: false }, { s: 258, platform: true }],
    },
    {
      id: 'embank-right', side: 1, s0: 60, s1: abut ? abut[0] : 296,
      gaps: [],
      gangi: [{ s: 108, platform: true }, { s: 221, platform: true }],
    },
    // the town continues past the vermilion bridge: stone banks both sides up to the stone bridge,
    // leaving the temple precinct's natural bank (torii, temple steps) open
    {
      id: 'embank-left-2', side: -1, s0: abut ? abut[1] : 304, s1: 664,
      gaps: [],
      gangi: [{ s: 360, platform: true }, { s: 470, platform: false }, { s: 560, platform: true }, { s: 630, platform: false }],
    },
    { id: 'embank-right-2', side: 1, s0: abut ? abut[1] : 304, s1: 372, gaps: [], gangi: [{ s: 340, platform: false }] },
    { id: 'embank-right-3', side: 1, s0: 468, s1: 664, gaps: [], gangi: [{ s: 520, platform: true }, { s: 600, platform: false }] },
    { id: 'weir-left', side: -1, s0: 0.5, s1: 16, gaps: [], gangi: [] },
    { id: 'weir-right', side: 1, s0: 0.5, s1: 16, gaps: [], gangi: [] },
  ];
  // every wall run, its steps, platforms and lanterns merge into one waterfront site: a handful of
  // draws for the whole town reach instead of one set per 45 m chunk
  const waterfront = new Site('waterfront', new Matrix4());
  {
    const c = riverFrame(330);
    waterfront.center.set(c.x, 1, c.z);
    waterfront.far = 1100;
    waterfront.noShadow.add('paper').add('plain');
    waterfront.noReflect.add('plain');
  }
  sites.push(waterfront);
  const walls = new Map<string, ReturnType<typeof buildWall>>();
  for (const run of runs) {
    const w = safe(run.id, () => buildWall(ctx, run, waterfront));
    if (!w) continue;
    walls.set(run.id, w);
    platforms.push(...w.platforms);
    if (run.id.startsWith('embank')) embankments.push({ side: run.side, s0: run.s0, s1: run.s1 });
  }

  // lanterns along the embankment tops, a red one now and then
  {
    const R = rng(4242);
    const spots: [string, number[]][] = [['embank-left', [72, 110, 127, 166, 212, 247, 284]], ['embank-right', [82, 130, 170, 206, 246, 280]], ['embank-left-2', [330, 392, 452, 512, 588, 648]], ['embank-right-2', [322, 358]], ['embank-right-3', [490, 548, 616]]];
    for (const [id, ss] of spots) {
      const w = walls.get(id);
      const run = runs.find((r) => r.id === id)!;
      if (!w) continue;
      for (const [i, s] of ss.entries()) {
        const site = w.sites[Math.min(w.sites.length - 1, Math.floor(((s - run.s0) / (run.s1 - run.s0)) * w.sites.length))];
        const p = bankPoint(s, run.side, 0.5);
        const q = bankPoint(s, run.side, -1);
        const dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz) || 1;
        const info = safe('lantern', () => postLantern(site, p.x, w.top(s), p.z, [dx / l, dz / l], R, { red: i % 3 === 1 }));
        if (info) lanterns.push(info);
      }
    }
  }

  // ---- landings ----
  for (const d of DOCKS) {
    const w = d.id === 'village' ? walls.get(d.side === -1 ? 'embank-left' : 'embank-right') : undefined;
    const lp = bankPoint(d.s, d.side, 2);
    if (!w && isLate(lp.x, lp.z, 4, 12)) {
      lateDocks.push(d);
      continue;
    }
    const r = safe('landing ' + d.id, () => buildLanding(ctx, d, w
      ? { embanked: true, wallTop: w.top(d.s), wallFace: -w.face(d.s), hero: true }
      : { embanked: false }));
    if (!r) continue;
    sites.push(r.site);
    landings[d.id] = r.info;
    lanterns.push(r.lantern);
  }

  // ---- the weir ----
  {
    const r = safe('weir', () => buildWeir(ctx));
    if (r) {
      sites.push(r.site);
      weir = r.info;
    }
  }

  const tMats = performance.now();
  const roofP = sites.some((s) => s.name === 'covered-bridge') ? createRoofMaterial(ctx) : null;
  const mats = await matsP;
  if (roofP) mats.roof = await roofP.catch((e) => { console.error('[bridges] roof failed', e); return null; });
  const waitMats = performance.now() - tMats;
  const root = new Group();
  root.name = 'bridges';
  let triangles = 0, colliders = 0;
  const finishSite = (s: Site) => {
    // lantern paper, black fittings and bronze finials are too small to matter in the shadow maps
    s.noShadow.add('paper').add('plain').add('bronze');
    triangles += s.build(ctx, mats);
    colliders += s.colliders.length;
    s.group.updateMatrixWorld(true);
    s.group.traverse((o) => { o.matrixAutoUpdate = false; });
  };
  for (const s of sites) {
    finishSite(s);
    root.add(s.group);
  }
  root.updateMatrixWorld(true);
  root.traverse((o) => { o.matrixAutoUpdate = false; });
  ctx.scene.add(root);

  // the far pieces, after the reveal: build, merge, warm their pipelines out of sight, then join the
  // distance culling below (their cull distance is shorter than their distance from the start)
  const late = async (slice: Slice, label: string, make: () => { site: Site } | null, done: (r: any) => void) => {
    const r = safe(label, make);
    if (!r) return;
    await slice();
    if (r.site.geos.has('roof') && !mats.roof) mats.roof = await slice.wait(createRoofMaterial(ctx).catch((e) => { console.error('[bridges] roof failed', e); return null; }));
    finishSite(r.site);
    await slice();
    await slice.wait(stream!.warm(r.site.group, root, () => sites.push(r.site)));
    done(r);
  };
  for (const b of lateBridges) {
    void stream!.add({ label: b.id, s: b.s, run: (slice) => late(slice, b.id, () => BUILD[b.type]?.(ctx, b) ?? null, (r) => bridges.push(r.info)) });
  }
  for (const d of lateDocks) {
    void stream!.add({
      label: 'landing-' + d.id, s: d.s,
      run: (slice) => late(slice, 'landing ' + d.id, () => buildLanding(ctx, d, { embanked: false }), (r) => {
        landings[d.id] = r.info;
        lanterns.push(r.lantern);
      }),
    });
  }

  // distance culling: whole sites far away, near detail (railing infill, finials, boards) sooner
  let detailScale = 1;
  const applyQuality = (q: QualityPreset) => {
    detailScale = q.name === 'low' ? 0.6 : q.name === 'high' ? 1.35 : 1;
  };
  applyQuality(ctx.quality);
  ctx.events.on('quality', applyQuality);
  let visible = sites.length;
  ctx.onUpdate(() => {
    const cam = ctx.camera.position;
    visible = 0;
    for (const s of sites) {
      const d = cam.distanceTo(s.center);
      const on = d < s.far * Math.max(1, detailScale);
      s.group.visible = on;
      if (s.detail) s.detail.visible = on && d < s.detailFar * detailScale;
      if (on) visible++;
    }
  }, 70);

  const ms = performance.now() - t0 - waitMats;
  const service: BridgesService = {
    bridges, landings, platforms, lanterns, weir, embankments,
    stats: () => ({ sites: sites.length, visible, triangles, colliders, ms: +ms.toFixed(1), late: lateBridges.length + lateDocks.length }),
  };
  ctx.services.bridges = service;
  console.info(`[bridges] ${sites.length} sites (+${lateBridges.length + lateDocks.length} after the reveal), ${(triangles / 1000).toFixed(0)}k tris, ${colliders} colliders in ${ms.toFixed(0)} ms cpu (+${waitMats.toFixed(0)} ms waiting for textures)`);
}
