// third-person follow, framed like docs/ref1: behind and above the boat, looking a little ahead of it
// along the river so the hull sits in the lower middle of the frame. orbits with the mouse, trails
// the heading smoothly, keeps a level horizon (hull roll/pitch never reach the camera), recenters
// when left alone while under way, ducks under bridge decks, and stays above water, out of terrain
// and out of bank structures.
import { Vector3, type PerspectiveCamera } from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GameContext } from '../core/context';
import { GROUPS, groups } from '../core/physics';
import { ANCHORS } from '../boat/hullSpec';
import { BRIDGES, nearestRiver } from '../world/layout';
import { waterHeight } from '../world/waves';
import { AngleSpring, Spring, damp, wrapPi } from './spring';

export const FOLLOW = {
  fov: 60,
  /** close river framing keeps the canopy and nearby banks prominent */
  distance: 7.0,
  minDistance: 5,
  maxDistance: 32,
  /** orbit elevation above the pivot, radians */
  pitch: 0.34,
  minPitch: 0.04,
  maxPitch: 1.25,
  /** the camera aims this far ahead of the pivot (scaled with zoom), just above the water */
  lookAhead: 3.7,
  lookHeight: 0.3,
  /** heading follow stiffness (rad/s); lower = lazier swing into turns */
  yawOmega: 2.2,
  /** positional lag of the camera body */
  posOmega: 6,
  /** vertical smoothing of the pivot, filters heave from chop and wake */
  heightOmega: 3,
  recenterAfter: 3,
  recenterRate: 0.8,
  waterClearance: 0.45,
  terrainClearance: 0.9,
  /** margin kept under a bridge deck */
  bridgeMargin: 0.8,
};

const _t = new Vector3(), _d = new Vector3(), _p = new Vector3(), _f = new Vector3(), _look = new Vector3();

export class FollowCam {
  yawOffset = 0;
  pitch = FOLLOW.pitch;
  zoom = FOLLOW.distance;
  zoomS = new Spring(FOLLOW.distance);
  base = new AngleSpring(0);
  targetY = new Spring(0);
  occl = new Spring(1);
  px = new Spring();
  py = new Spring();
  pz = new Spring();
  idle = 0;
  snapNext = true;
  last = new Vector3();
  ray: RAPIER.Ray | null = null;

  snap() {
    this.snapNext = true;
  }

  look(dx: number, dy: number) {
    if (dx === 0 && dy === 0) return;
    this.yawOffset = wrapPi(this.yawOffset - dx);
    this.pitch = Math.min(FOLLOW.maxPitch, Math.max(FOLLOW.minPitch, this.pitch + dy));
    this.idle = 0;
  }

  update(ctx: GameContext, cam: PerspectiveCamera, dt: number, wheel: number) {
    const b = ctx.boat;
    if (!b) return;
    const F = FOLLOW;
    if (wheel) this.zoom = Math.min(F.maxDistance, Math.max(F.minDistance, this.zoom * Math.pow(1.12, wheel)));
    this.idle += dt;

    // heading from the bow direction, flattened: roll and pitch never reach the camera
    _f.set(0, 0, -1).applyQuaternion(b.quaternion);
    const flat = Math.hypot(_f.x, _f.z);
    const behind = flat > 0.2 ? Math.atan2(-_f.x, -_f.z) : this.base.x;
    if (b.position.distanceTo(this.last) > 25) this.snapNext = true;
    this.last.copy(b.position);

    // drift back behind the boat after a while without mouse input, only while under way
    if (this.idle > F.recenterAfter && Math.abs(b.speed) > 0.8) {
      this.yawOffset = damp(this.yawOffset, 0, F.recenterRate, dt);
      this.pitch = damp(this.pitch, F.pitch, F.recenterRate * 0.7, dt);
    }

    // pivot: camera anchor rotated by heading only, heave smoothed
    const fx = flat > 0.2 ? _f.x / flat : 0, fz = flat > 0.2 ? _f.z / flat : -1;
    const a = ANCHORS.cameraTarget;
    // local +x (starboard) in world is (-fz, 0, fx) for a yaw-only frame
    _t.set(b.position.x - fz * a.x - fx * a.z, b.position.y + a.y, b.position.z + fx * a.x - fz * a.z);

    if (this.snapNext) {
      this.base.reset(behind);
      this.targetY.reset(_t.y);
      this.zoomS.reset(this.zoom);
      this.occl.reset(1);
    }
    const yaw = this.base.step(behind, F.yawOmega, dt) + this.yawOffset;
    _t.y = this.targetY.step(_t.y, F.heightOmega, dt);
    const dist = this.zoomS.step(this.zoom, 8, dt);

    // pull in when terrain or a bank structure blocks the line of sight
    _d.set(Math.sin(yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(yaw) * Math.cos(this.pitch));
    const clear = Math.min(this.lineOfSight(ctx, _t, _d, dist), this.structures(ctx, _t, _d, dist));
    const k = clear < this.occl.x ? this.occl.reset(clear) : this.occl.step(clear, 2, dt);
    _p.copy(_d).multiplyScalar(dist * Math.max(0.2, k)).add(_t);
    const ceiling = this.bridgeCeiling(_p.x, _p.z, 0);
    if (_p.y > ceiling) _p.y = ceiling;

    if (this.snapNext) {
      this.px.reset(_p.x);
      this.py.reset(_p.y);
      this.pz.reset(_p.z);
      this.snapNext = false;
    }
    const x = this.px.step(_p.x, F.posOmega, dt);
    let y = this.py.step(_p.y, F.posOmega, dt);
    const z = this.pz.step(_p.z, F.posOmega, dt);
    const floor = this.floorAt(ctx, x, z);
    const hard = this.bridgeCeiling(x, z, 0.4);
    if (y > hard) y = this.py.x = Math.max(floor, hard);
    if (y < floor) {
      y = floor;
      this.py.x = floor;
      if (this.py.v < 0) this.py.v = 0;
    }
    cam.position.set(x, y, z);
    cam.up.set(0, 1, 0);

    // aim ahead of the boat along the view direction; less look-ahead as the camera climbs overhead
    const ahead = F.lookAhead * (dist / F.distance) * Math.max(0, Math.min(1, 1 - (this.pitch - F.pitch) / 0.8));
    _look.set(_t.x - Math.sin(yaw) * ahead, b.position.y + F.lookHeight, _t.z - Math.cos(yaw) * ahead);
    cam.lookAt(_look);
  }

  /** lowest allowed camera height at (x, z): above the moving surface and the ground */
  floorAt(ctx: GameContext, x: number, z: number) {
    let f = waterHeight(x, z, ctx.time.render) + FOLLOW.waterClearance;
    if (ctx.world.has('height')) f = Math.max(f, ctx.world.heightAt(x, z) + FOLLOW.terrainClearance);
    return f;
  }

  /** highest allowed camera height near a bridge: below the deck, easing back up beyond it */
  bridgeCeiling(x: number, z: number, slack: number) {
    const r = nearestRiver(x, z);
    if (Math.abs(r.lateral) > r.width / 2 + 10) return Infinity;
    let c = Infinity;
    for (const br of BRIDGES) {
      const d = Math.abs(r.s - br.s) - br.deckWidth / 2;
      if (d > 12) continue;
      c = Math.min(c, br.clearance - FOLLOW.bridgeMargin + slack + Math.max(0, d) * 0.35);
    }
    return c;
  }

  /** fraction of the desired distance free of terrain along dir from the pivot */
  lineOfSight(ctx: GameContext, from: Vector3, dir: Vector3, dist: number) {
    if (!ctx.world.has('height')) return 1;
    const n = 10;
    for (let i = 1; i <= n; i++) {
      const s = (i / n) * dist;
      const x = from.x + dir.x * s, y = from.y + dir.y * s, z = from.z + dir.z * s;
      if (ctx.world.heightAt(x, z) + 0.6 > y) return Math.max(0, (i - 1) / n);
    }
    return 1;
  }

  /** fraction free of static colliders on the banks (buildings, walls). anything standing in the
   * channel (bridge decks and piers, moored boats) is ignored: the bridge ceiling handles decks */
  structures(ctx: GameContext, from: Vector3, dir: Vector3, dist: number) {
    const R = ctx.physics.RAPIER, w = ctx.physics.world;
    if (!this.ray) this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    this.ray.origin = { x: from.x, y: from.y, z: from.z };
    this.ray.dir = { x: dir.x, y: dir.y, z: dir.z };
    const body = ctx.boat?.body;
    const hit = w.castRay(this.ray, dist, true, undefined, groups(0xffff, GROUPS.STATIC | GROUPS.TERRAIN), undefined, body, (c) => {
      if (((c.collisionGroups() >>> 16) & GROUPS.TERRAIN) !== 0) return true;
      const t = c.translation(), r = nearestRiver(t.x, t.z);
      return Math.abs(r.lateral) > r.width / 2;
    });
    if (!hit) return 1;
    return Math.max(0, (hit.timeOfImpact - 0.5) / dist);
  }
}
