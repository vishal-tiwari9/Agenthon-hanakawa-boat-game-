// the player's river boat: dynamic rapier body driven by src/boat/physics, rendered with
// interpolation between fixed steps. publishes ctx.boat (BoatApi).
import {
  BufferGeometry, DoubleSide, Float32BufferAttribute, Group, Mesh, MeshStandardNodeMaterial, Object3D, Quaternion, Vector3,
} from 'three/webgpu';
import type { BoatApi, GameContext } from '../core/context';
import { GROUPS, groups } from '../core/physics';
import { ANCHORS, HULL, halfWidthAt, keelAt, sheerAt, stationZ } from './hullSpec';
import { BRIDGES, RIVER_LENGTH, SPAWN, nearestRiver, riverFrame } from '../world/layout';
import { sampleWater, type WaveSample } from '../world/waves';
import { BoatSim } from './physics/sim';
import { findRiverSpot } from './physics/safeSpot';
import { TUNING } from './physics/tuning';

interface BoatModel {
  root: Group;
  setPaint(id: string): void;
  paints: { id: string; name: string; unlock?: string }[];
  wheel?: Object3D;
  /** tiller boats: the tiller/rudder assembly, turning about its local +y (rudder stock) */
  tiller?: Object3D;
  rudder?: Object3D;
  propeller?: Object3D;
  dispose(): void;
}
type CreateBoatModel = (ctx: GameContext, opts: { paint?: string; detail?: 'full' | 'simple' }) => Promise<BoatModel>;

/** BoatApi plus the extras other modules look for (paint list, model, physics handle) */
export interface PlayerBoat extends BoatApi {
  model: BoatModel | null;
  paints: BoatModel['paints'];
  sim: BoatSim;
  /** engine speed 0..1 for audio/fx */
  rpm: number;
}

// the model module may not exist yet (built concurrently); the glob resolves to {} until it does
const modelModules = import.meta.glob('./model/index.ts');

async function loadModel(ctx: GameContext): Promise<{ create: CreateBoatModel; model: BoatModel } | null> {
  try {
    let create = ctx.services.boatModel as CreateBoatModel | undefined;
    if (typeof create !== 'function') {
      const load = modelModules['./model/index.ts'];
      if (!load) return null;
      const mod = (await load()) as { createBoatModel?: CreateBoatModel };
      create = mod.createBoatModel;
    }
    if (typeof create !== 'function') return null;
    const model = await create(ctx, { detail: 'full' });
    return model?.root ? { create, model } : null;
  } catch (e) {
    console.warn('[boat] model failed, using placeholder hull', e);
    return null;
  }
}

/** simple lofted hull from hullSpec so the waterline and trim are readable before the real model lands */
function placeholderHull() {
  const ns = 28, nh = 10;
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= ns; i++) {
    const s = i / ns, z = stationZ(s), k = keelAt(s), top = sheerAt(s);
    for (let j = -nh; j <= nh; j++) {
      const f = Math.abs(j) / nh;
      const y = k + (top - k) * f;
      pos.push(Math.sign(j) * halfWidthAt(s, y), y, z);
    }
  }
  const row = nh * 2 + 1;
  for (let i = 0; i < ns; i++) {
    for (let j = 0; j < row - 1; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  // transom
  const base = pos.length / 3;
  pos.push(0, (keelAt(1) + sheerAt(1)) / 2, HULL.sternZ);
  for (let j = 0; j < row - 1; j++) idx.push(base, ns * row + j, ns * row + j + 1);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const hull = new Mesh(g, new MeshStandardNodeMaterial({ color: 0xe9e2d0, roughness: 0.45, side: DoubleSide }));
  hull.castShadow = true;
  hull.receiveShadow = true;
  const group = new Group();
  group.add(hull);
  group.name = 'boat-placeholder';
  return group;
}

export async function init(ctx: GameContext) {
  const R = ctx.physics.RAPIER;
  const world = ctx.world;
  const hasWorld = world.has('height');
  const hasShore = world.has('shore');
  const hasFlow = world.has('flowX') && world.has('flowZ');
  // the weir (downstream) and the falls (upstream) close the river: past these s the boat is
  // eased back along the channel
  const S_MIN = 14, S_MAX = RIVER_LENGTH - 28;
  const limit = { dx: 0, dz: 0, depth: 0 };

  // terrain collider appears when the terrain module builds it; until then the sim uses a
  // penalty contact against the height/shore fields
  let terrainCollider = false, nextColliderCheck = 0;
  const checkTerrainCollider = () => {
    if (terrainCollider || ctx.time.real < nextColliderCheck) return terrainCollider;
    nextColliderCheck = ctx.time.real + 2;
    ctx.physics.world.forEachCollider((c) => {
      if (((c.collisionGroups() >>> 16) & GROUPS.TERRAIN) !== 0) terrainCollider = true;
    });
    if (terrainCollider) console.info('[boat] terrain collider found; ground penalty is now a tunneling guard');
    return terrainCollider;
  };

  const sim = new BoatSim(R, ctx.physics.world, {
    water: (x: number, z: number, t: number, out: WaveSample) => sampleWater(x, z, t, out),
    ground: hasWorld ? (x, z) => world.heightAt(x, z) : undefined,
    groundNormal: hasWorld ? (x, z, out) => world.normalAt(x, z, out, 1) : undefined,
    shore: hasShore ? (x, z) => world.sample('shore', x, z) : undefined,
    terrainCollider: checkTerrainCollider,
    flow: hasFlow ? (x, z, out) => { out.x = world.sample('flowX', x, z); out.z = world.sample('flowZ', x, z); } : undefined,
    boundary: (x, z) => {
      const r = nearestRiver(x, z);
      if (r.s > S_MIN && r.s < S_MAX) return null;
      const f = riverFrame(r.s);
      const up = r.s <= S_MIN ? 1 : -1;
      limit.dx = f.tx * up;
      limit.dz = f.tz * up;
      // past the spline ends the nearest point clamps; add the distance beyond it
      const beyond = Math.sqrt(Math.max(0, r.dist * r.dist - r.lateral * r.lateral));
      limit.depth = (up > 0 ? S_MIN - r.s : r.s - S_MAX) + (r.s <= 0.5 || r.s >= RIVER_LENGTH - 0.5 ? beyond : 0);
      return limit;
    },
  }, {
    x: SPAWN.x,
    z: SPAWN.z,
    headingDeg: SPAWN.headingDeg,
    collisionGroups: groups(GROUPS.BOAT, 0xffff & ~GROUPS.BOAT),
    onImpact: (e) => ctx.events.emit('boat:impact', e),
    onSplash: (e) => ctx.events.emit('boat:splash', e),
  });
  sim.teleport(SPAWN.x, SPAWN.z, SPAWN.headingDeg, ctx.time.sim);

  const root = new Group();
  root.name = 'player-boat';
  ctx.scene.add(root);
  let model: BoatModel | null = null;
  let placeholder: Group | null = placeholderHull();
  root.add(placeholder);
  let pendingPaint: string | null = null;
  const wheelRest = new Quaternion(), propRest = new Quaternion(), tillerRest = new Quaternion();
  const _q = new Quaternion(), _axis = new Vector3(0, 0, 1), _stock = new Vector3(0, 1, 0);
  let propAngle = 0;

  const boat: PlayerBoat = {
    object: root,
    body: sim.body,
    position: root.position,
    quaternion: root.quaternion,
    velocity: new Vector3(),
    angularVelocity: new Vector3(),
    speed: 0,
    throttle: 0,
    rudder: 0,
    submersion: 1,
    controlsEnabled: true,
    docked: false,
    anchors: { ...ANCHORS },
    model: null,
    paints: [],
    sim,
    rpm: 0,
    reset() {
      const t = ctx.time.sim;
      const p = sim.pos;
      const avoid = BRIDGES.map((b) => [b.s, b.deckWidth / 2 + 10] as [number, number]);
      const depth = hasWorld ? (x: number, z: number) => world.depthAt(x, z) : () => 10;
      const spot = findRiverSpot(nearestRiver(p.x, p.z).s, (s) => riverFrame(s), depth, { sMin: S_MIN + 20, sMax: S_MAX - 20, avoid });
      boat.undock();
      if (spot) sim.teleport(spot.x, spot.z, spot.headingDeg, t);
      else sim.teleport(SPAWN.x, SPAWN.z, SPAWN.headingDeg, t);
      syncRender(1);
    },
    teleport(x, z, headingDeg) {
      boat.undock();
      sim.teleport(x, z, headingDeg, ctx.time.sim);
      syncRender(1);
    },
    dockTo(pose) {
      sim.dockTo(pose.x, pose.z, pose.headingDeg);
      boat.docked = true;
    },
    undock() {
      sim.undock();
      boat.docked = false;
    },
    setPaint(id) {
      pendingPaint = id;
      model?.setPaint(id);
    },
  };

  const loaded = await loadModel(ctx);
  if (loaded) {
    model = loaded.model;
    ctx.services.boatModel = loaded.create;
    ctx.services.boatModelInstance = model;
    ctx.services.boatPaints = model.paints;
    root.remove(placeholder);
    placeholder.traverse((o) => (o as Mesh).geometry?.dispose());
    placeholder = null;
    root.add(model.root);
    boat.model = model;
    boat.paints = model.paints;
    if (model.wheel) wheelRest.copy(model.wheel.quaternion);
    const helm = model.tiller ?? (!model.wheel ? model.rudder : undefined);
    if (helm) tillerRest.copy(helm.quaternion);
    if (model.propeller) propRest.copy(model.propeller.quaternion);
    if (pendingPaint) model.setPaint(pendingPaint);
  }
  ctx.services.boatWake = sim.wake;
  ctx.services.boatPhysics = sim;

  const controlsLive = () => boat.controlsEnabled && !ctx.paused && ctx.cameraRig?.mode !== 'photo';

  ctx.onFixed((c, dt) => {
    let th = 0, rud = 0;
    if (controlsLive()) {
      const i = c.input;
      th = (i.isDown('forward') ? 1 : 0) - (i.isDown('reverse') ? 1 : 0);
      rud = (i.isDown('right') ? 1 : 0) - (i.isDown('left') ? 1 : 0);
    }
    sim.setControls(th, rud);
    sim.preStep(c.time.sim, dt);
  }, 10);

  let tunnelTime = 0;
  ctx.onPostFixed((c, dt) => {
    sim.postStep(c.time.sim, dt);
    // physics handed the hull a state it cannot recover from (inside terrain, nan): unstick it
    tunnelTime = sim.tunneled ? tunnelTime + dt : 0;
    if (tunnelTime > 0.5 || !Number.isFinite(sim.pos.x + sim.pos.y + sim.pos.z)) {
      tunnelTime = 0;
      console.warn('[boat] hull stuck in terrain or invalid; resetting');
      boat.reset();
    }
  }, 10);

  ctx.events.on('input:reset', () => {
    if (!controlsLive() || boat.docked) return;
    boat.reset();
  });

  const _fwd = new Vector3();
  function syncRender(alpha: number) {
    sim.interpolate(alpha, root.position, root.quaternion, boat.velocity, boat.angularVelocity);
    _fwd.set(0, 0, -1).applyQuaternion(root.quaternion);
    boat.speed = boat.velocity.dot(_fwd);
    boat.throttle = sim.throttle;
    boat.rudder = sim.rudder;
    boat.submersion = sim.submersion;
    boat.docked = sim.docked;
    boat.rpm = Math.min(1, 0.18 + 0.82 * Math.abs(sim.throttle));
    root.updateMatrixWorld();
  }

  ctx.onUpdate((c) => {
    syncRender(c.time.alpha);
    const m = model;
    if (!m) return;
    if (m.wheel) {
      // a turn and a half lock to lock; clockwise (seen from the helm) for starboard
      m.wheel.quaternion.copy(wheelRest).multiply(_q.setFromAxisAngle(_axis, -boat.rudder * Math.PI * 1.5));
    }
    const helm = m.tiller ?? (!m.wheel ? m.rudder : undefined);
    if (helm) {
      // blade trailing edge to starboard for a starboard turn; the tiller arm swings to port
      helm.quaternion.copy(tillerRest).multiply(_q.setFromAxisAngle(_stock, boat.rudder * TUNING.rudderMaxRad));
    }
    if (m.propeller && !c.paused) {
      // visual spin rate kept below strobing; sign follows the gear
      propAngle = (propAngle + Math.sign(sim.throttle || 0) * (6 + 30 * Math.abs(sim.throttle)) * c.time.frameDt) % (Math.PI * 2);
      m.propeller.quaternion.copy(propRest).multiply(_q.setFromAxisAngle(_axis, propAngle));
    }
  }, 10);

  syncRender(1);
  ctx.boat = boat;
}
