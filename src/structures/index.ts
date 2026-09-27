// structures: hanakawa village (machiya, kura, shops), the riverside shrine, the temple terrace with
// the five-storey pagoda and main hall, the water torii, the lakeside teahouse, the water mill and
// moored boats. every position comes from src/world/layout.ts and src/world/sites.ts.
import { Vector3, type Mesh, type Object3D } from 'three/webgpu';
import type { GameContext } from '../core/context';
import { LANDMARKS, bankPoint, landmarkPoint, riverFrame, riverHeading } from '../world/layout';
import { SITES, type Site as SiteDef } from '../world/sites';
import { slicer, trs, clearPartCache } from './geom';
import { createMaterials } from './materials';
import { Site } from './builder';
import { buildHouse } from './machiya';
import { buildHall, buildPagoda, terraceWall } from './temple';
import { buildShrine, waterTorii } from './shrine';
import { buildMill, buildTeahouse } from './riverside';
import { instanceProps, preloadProps, stake } from './props';
import { RopeSet } from './ropes';
import { buildBoat, MooredBoat, type HullSpec } from './boats';
import { createFrontageDecor } from './decor';
import { createRiverLife } from './life';
import { buildCastle, buildHillShrine } from './landmarks';
import { buildTown, createCritters, type TownService } from './town';
import type { Slice, Streamer } from '../core/stream';

export interface StructuresService {
  sites: SiteDef[];
  /** mooring stake tops (for anything that wants to tie up) */
  stakes: Vector3[];
  pagodaTop: Vector3 | null;
  colliders: number;
  debug: Record<string, unknown>;
  /** resolves once the reach around the start is in, prop models included (main.ts waits for it) */
  nearReady: Promise<void>;
  /** resolves once the far pieces have streamed in too (after the reveal) */
  ready: Promise<void>;
  stats(): { meshes: number; triangles: number; boats: number; colliders: number };
}

/** the lake and mill sites cull at this camera distance (see the update below) */
const CULL_FAR = 700;

/** three.js yaw so local +z faces the river from a bank at along-river s */
function facingRiver(s: number, side: -1 | 1) {
  const f = riverFrame(s);
  const dx = -side * f.nx, dz = -side * f.nz;
  return Math.atan2(dx, dz);
}


export async function init(ctx: GameContext) {
  const t0 = performance.now();
  // textures and prop models load while the geometry builds; long loops yield every ~24 ms so the
  // title scene keeps drawing
  const matsP = createMaterials(ctx);
  preloadProps(ctx);
  const slice = slicer(24);
  const world = ctx.world;
  let cpu = 0, tc = performance.now();
  const pause = async () => { cpu += performance.now() - tc; await slice(); tc = performance.now(); };

  const villageA = new Site(ctx, 'village-a');
  const villageB = new Site(ctx, 'village-b');
  const temple = new Site(ctx, 'temple');
  const lake = new Site(ctx, 'lake');
  const millSite = new Site(ctx, 'mill');
  // distant heroes (castle keep, hillside shrine and its torii path): one site, a few merged draws
  const landmarks = new Site(ctx, 'landmarks');
  // near-first: the teahouse and the mill are built after the reveal (ctx.services.stream) unless they can
  // be seen from the river around the start (a save that resumes at their docks). the town, temple and
  // landmarks are always built first: the town's decor, life and critters are woven through them
  const stream = ctx.services.stream as Streamer | undefined;
  const isLate = (x: number, z: number) => !!stream && !stream.seen(x, z, 9, CULL_FAR, 20);
  const lateJobs: Promise<void>[] = [];
  let lateTeahouse: (() => void) | null = null;
  let lateMill = false;
  const sites = [villageA, villageB, temple, landmarks];
  let buildings = 0;
  const debug: Record<string, unknown> = {};
  let pagodaTop: Vector3 | null = null;
  let millWheel: Object3D | null = null;

  const safe = (label: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      console.error(`[structures] ${label} failed`, e);
    }
  };

  const mills: SiteDef[] = [];
  for (const sd of SITES) {
    const kind = sd.kind;
    if (!kind || sd.s === undefined || !sd.side) continue;
    await pause();
    const yaw = facingRiver(sd.s, sd.side);
    if (kind === 'machiya' || kind === 'machiya-low' || kind === 'kura' || kind === 'shop') {
      const target = sd.s < 200 ? villageA : villageB;
      safe(sd.id, () => buildHouse(target, { kind, x: sd.x, z: sd.z, y: sd.y, yaw, w: sd.w!, d: sd.d!, seed: Math.round(sd.s! * 13 + sd.side! * 7), veranda: sd.veranda, front: sd.front }));
      buildings++;
    } else if (kind === 'shrine') {
      const l = LANDMARKS.find((m) => m.id === 'shrine')!;
      safe('shrine', () => buildShrine(villageB, { x: sd.x, z: sd.z, y: sd.y, yaw, toEdge: l.offset }));
      buildings++;
    } else if (kind === 'pagoda') {
      const l = LANDMARKS.find((m) => m.id === 'pagoda')!;
      const p = landmarkPoint(l);
      safe('pagoda', () => {
        const r = buildPagoda(temple, { x: p.x, z: p.z, y: sd.y, yaw });
        pagodaTop = new Vector3(p.x, sd.y + r.top, p.z);
      });
      // granite terrace walls on the edges where the ground falls away, a stair on the pagoda axis
      safe('terrace', () => {
        const r = (sd.yawDeg * Math.PI) / 180;
        const ax: [number, number] = [Math.cos(r), -Math.sin(r)];
        const az: [number, number] = [Math.sin(r), Math.cos(r)];
        const c = (lx: number, lz: number): [number, number] => [sd.x + ax[0] * lx + az[0] * lz, sd.z + ax[1] * lx + az[1] * lz];
        const riverX = -sd.side! * sd.hx; // edge toward the river
        const out: [number, number] = [ax[0] * -sd.side!, ax[1] * -sd.side!];
        const a = c(riverX, -sd.hz), b = c(riverX, sd.hz);
        // stair where the pagoda axis meets the wall
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const along = ((p.x - a[0]) * (b[0] - a[0]) + (p.z - a[1]) * (b[1] - a[1])) / L;
        terraceWall(temple, world, a[0], a[1], b[0], b[1], sd.y, out[0], out[1], along);
        for (const sz of [-1, 1]) {
          const e0 = c(riverX, sz * sd.hz), e1 = c(-riverX, sz * sd.hz);
          terraceWall(temple, world, e0[0], e0[1], e1[0], e1[1], sd.y, az[0] * sz, az[1] * sz);
        }
      });
      buildings++;
    } else if (kind === 'hall') {
      safe('hall', () => buildHall(temple, { x: sd.x, z: sd.z, y: sd.y, yaw }));
      buildings++;
    } else if (kind === 'teahouse') {
      const l = LANDMARKS.find((m) => m.id === 'teahouse')!;
      const p = landmarkPoint(l);
      // the teahouse faces the open lake: its +z points away from the bank
      const tyaw = facingRiver(l.s, (l.side || 1) as -1 | 1);
      const build = () => safe('teahouse', () => buildTeahouse(lake, world, { x: p.x, z: p.z, y: 0, yaw: tyaw }, Math.max(1, -l.offset - 3.5)));
      if (isLate(p.x, p.z)) lateTeahouse = build;
      else {
        build();
        sites.push(lake);
      }
      buildings++;
    } else if (kind === 'castle') {
      safe('castle', () => { debug.castle = buildCastle(landmarks, { x: sd.x, z: sd.z, y: sd.y, yaw }); });
      buildings++;
    } else if (kind === 'hillshrine') {
      safe('hill shrine', () => {
        const r = buildHillShrine(landmarks, world, { x: sd.x, z: sd.z, y: sd.y, yaw }, sd.s!);
        debug.hillShrine = { gates: r.gates };
      });
      buildings++;
    } else if (kind === 'mill') {
      // the wheel needs the materials: built once they are in
      mills.push(sd);
      if (isLate(sd.x, sd.z)) lateMill = true;
      else sites.push(millSite);
      buildings++;
    }
  }

  // the town behind the waterfront merges into one village site, so the materials it shares with the
  // waterfront add no draws (?noTown skips it, for a/b checks)
  let town: TownService | null = null;
  if (!new URLSearchParams(location.search).has('noTown')) {
    try {
      const r = await buildTown(ctx, null, () => villageB, pause);
      town = r.svc;
      ctx.services.town = r.svc;
      debug.town = r.svc.stats;
    } catch (e) {
      console.error('[structures] town failed', e);
    }
  }

  const tMats = performance.now();
  cpu += tMats - tc;
  const mats = await matsP;
  tc = performance.now();
  const waitMats = tc - tMats;
  const buildMills = () => {
    for (const sd of mills) {
      safe('mill', () => {
        const toEdge = bankPoint(sd.s!, sd.side!, 0);
        const dist = Math.hypot(toEdge.x - sd.x, toEdge.z - sd.z);
        const r = buildMill(millSite, mats, { x: sd.x, z: sd.z, y: sd.y, yaw: facingRiver(sd.s!, sd.side!) }, dist);
        ctx.scene.add(r.wheel);
        millWheel = r.wheel;
      });
    }
  };
  if (!lateMill) buildMills();

  // water torii standing in the shallows, its gate facing across the river
  safe('water torii', () => {
    const l = LANDMARKS.find((m) => m.id === 'torii');
    if (!l) return;
    const p = landmarkPoint(l);
    const yaw = facingRiver(l.s, (l.side || 1) as -1 | 1);
    waterTorii(temple, trs(p.x, 0, p.z, yaw));
    // colliders for the two posts
    const f = riverFrame(l.s);
    for (const sx of [-1, 1]) {
      const x = p.x + f.tx * sx * 2.3, z = p.z + f.tz * sx * 2.3;
      temple.cylinder(x, 1, z, 3, 0.4);
    }
  });

  // moored boats along the village embankment, tied to stakes
  const boats: MooredBoat[] = [];
  const links: { boat: MooredBoat; local: Vector3; anchor: Vector3; slack: number }[] = [];
  const stakes: Vector3[] = [];
  const specs: HullSpec[] = [
    { L: 6.4, B: 1.35, draft: 0.2, sheer: [0.82, 0.46, 0.52], transom: 0.7, topside: [1, 1, 1], inside: [0.95, 0.92, 0.88], gear: true },
    { L: 5.4, B: 1.25, draft: 0.18, sheer: [0.74, 0.42, 0.48], transom: 0.68, topside: [0.85, 0.82, 0.8], inside: [1, 0.96, 0.9] },
    { L: 6.0, B: 1.3, draft: 0.2, sheer: [0.8, 0.44, 0.5], transom: 0.7, topside: [1.1, 1.02, 0.95], inside: [0.9, 0.88, 0.85], gear: true },
  ];
  const berths: [number, -1 | 1][] = [[153, -1], [224, -1], [252, 1]];
  berths.forEach(([s, side], i) => safe(`boat ${i}`, () => {
    const h = specs[i % specs.length];
    const p = bankPoint(s, side, -(h.B / 2 + 0.6));
    const yaw = -(riverHeading(s) * Math.PI) / 180;
    const bt = new MooredBoat(ctx, buildBoat(mats, h, 40 + i), p.x, p.z, yaw + (i % 2 ? 0.04 : -0.03));
    boats.push(bt);
    const f = riverFrame(s);
    for (const da of [-h.L / 2 - 0.6, h.L / 2 + 0.4]) {
      const q = bankPoint(s + da, side, -0.35);
      const bed = world.heightAt(q.x, q.z);
      const top = 1.05;
      const target = villageA;
      stake(target, q.x, q.z, Math.min(bed, -0.5) - 0.8, top);
      const v = new Vector3(q.x, top - 0.35, q.z);
      stakes.push(v);
      links.push({ boat: bt, local: da < 0 ? bt.build.stern : bt.build.bow, anchor: v, slack: 0.35 + i * 0.1 });
    }
    void f;
  }));

  const phase: Record<string, number> = {};
  let tp = performance.now();
  const mark = (k: string) => { const n = performance.now(); phase[k] = Math.round(n - tp); tp = n; };
  mark('sites');
  await pause();
  // frontage decor and the river life's static parts merge into the village sites before they finish
  try {
    const frontage = createFrontageDecor(ctx, mats, (s) => (s < 200 ? villageA : villageB));
    ctx.services.frontage = frontage;
    debug.frontage = frontage.stats();
  } catch (e) {
    console.error('[structures] frontage failed', e);
  }
  mark('frontage');
  await pause();
  try {
    const life = createRiverLife(ctx, mats, villageB);
    ctx.services.life = life;
    debug.life = life.stats();
  } catch (e) {
    console.error('[structures] river life failed', e);
  }
  mark('life');
  if (town) {
    try {
      debug.critters = createCritters(ctx, town).counts;
    } catch (e) {
      console.error('[structures] critters failed', e);
    }
  }
  for (const s of sites) await s.finish(mats, pause);
  mark('finish');
  // the prop models may still be decoding: add them in the background, main.ts waits on `nearReady`
  const nearReady = instanceProps(ctx, sites).then(() => undefined, (e) => console.error('[structures] props failed', e));
  debug.phase = phase;
  const ropes = new RopeSet(mats, Math.max(1, links.length));
  ctx.scene.add(ropes.mesh);

  const colliders = sites.reduce((n, s) => n + s.colliders.length, 0) + boats.length;
  const service: StructuresService = {
    sites: SITES,
    stakes,
    pagodaTop,
    colliders,
    debug,
    nearReady,
    ready: nearReady,
    stats() {
      let meshes = 0, triangles = 0;
      ctx.scene.traverse((o: Object3D) => {
        const m = o as Mesh;
        if (!m.isMesh) return;
        let p: Object3D | null = o;
        let mine = false;
        while (p) {
          if (p.name.startsWith('structures') || p.name.startsWith('prop:')) { mine = true; break; }
          p = p.parent;
        }
        if (!mine) return;
        meshes++;
        const g = m.geometry;
        const n = g.index ? g.index.count : g.attributes.position.count;
        triangles += (n / 3) * ((m as any).count ?? 1);
      });
      return { meshes, triangles: Math.round(triangles), boats: boats.length, colliders };
    },
  };
  ctx.services.structures = service;

  // distance culling: whole sites only, far away. small clutter is merged per site and stays on (it is
  // kept out of the mirror and shadow passes instead), so nothing pops in or out near the player
  const centerOf = (s: Site) => {
    const c = new Vector3();
    let n = 0;
    s.group.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh && m.geometry.boundingSphere) { c.add(m.geometry.boundingSphere.center); n++; }
    });
    return n ? c.divideScalar(n) : c;
  };
  const centers = sites.map(centerOf);

  // the far pieces, after the reveal: build, merge, warm their pipelines out of sight, then join the
  // distance culling (they are farther from the start than CULL_FAR, so they arrive hidden)
  const addLate = async (site: Site, slice: Slice, extra: Object3D[] = []) => {
    await site.finish(mats, slice);
    await slice.wait(stream!.warm(site.group, ctx.scene, () => {
      sites.push(site);
      centers.push(centerOf(site));
    }));
    for (const o of extra) await slice.wait(stream!.warm(o, ctx.scene));
    // instanceProps adds its group to the scene as it returns; it goes straight to the warm-up
    if (site.props.length) {
      const props = await slice.wait(instanceProps(ctx, [site]));
      await slice.wait(stream!.warm(props, ctx.scene));
    }
  };
  if (lateTeahouse) {
    const l = LANDMARKS.find((m) => m.id === 'teahouse')!;
    const build = lateTeahouse as () => void;
    lateJobs.push(stream!.add({ label: 'teahouse', s: l.s, run: async (slice) => { build(); await slice(); await addLate(lake, slice); } }));
  }
  if (lateMill) {
    const sd = mills[0];
    lateJobs.push(stream!.add({
      label: 'mill', s: sd.s!,
      run: async (slice) => {
        buildMills();
        // the wheel waits for the warm-up with the rest of the mill
        millWheel?.removeFromParent();
        await slice();
        await addLate(millSite, slice, millWheel ? [millWheel] : []);
      },
    }));
  }
  // every site is built once the late jobs finish; the shared part cache is only needed until then
  service.ready = Promise.all([nearReady, ...lateJobs]).then(() => clearPartCache());

  ctx.onUpdate((c) => {
    const t = c.time.render;
    const dt = Math.min(0.1, c.time.frameDt);
    for (const b of boats) {
      b.update(t, dt);
      b.build.group.updateMatrixWorld();
    }
    let li = 0;
    for (const lk of links) {
      const ln = ropes.lines[li++];
      lk.boat.worldPoint(lk.local, ln.a);
      ln.b.copy(lk.anchor);
      ln.slack = lk.slack;
      ln.visible = true;
    }
    ropes.update();
    // the mill wheel turns with the current, about 4 rpm
    if (millWheel && !c.paused) millWheel.rotateX(dt * 0.42);
    const cam = c.camera.position;
    for (let i = 0; i < sites.length; i++) {
      // the temple terrace stays visible from far down the valley; the rest culls past ~700 m
      const far = sites[i] === landmarks ? 2400 : sites[i] === temple ? 1600 : 700;
      sites[i].group.visible = cam.distanceTo(centers[i]) < far;
    }
    if (millWheel) millWheel.visible = millSite.group.visible;
  }, 20);

  ctx.onFixed((c, dt) => {
    const t = c.time.sim + dt;
    for (const b of boats) b.fixed(t);
  }, 5);

  const st = service.stats();
  debug.buildings = buildings;
  debug.boats = boats.length;
  cpu += performance.now() - tc;
  debug.cpuMs = Math.round(cpu);
  console.info(`[structures] built in ${(performance.now() - t0).toFixed(0)} ms (${cpu.toFixed(0)} ms cpu, ${waitMats.toFixed(0)} ms waiting for textures, town ${(debug.town as { ms?: number } | undefined)?.ms ?? 0} ms): ${buildings} buildings, ${st.meshes} meshes, ${st.triangles} tris, ${st.colliders} colliders, ${boats.length} moored boats`);
}
