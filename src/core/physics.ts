// rapier world wrapper. fixed step lives in loop.ts; this owns the world and static helpers.
import RAPIER from '@dimforge/rapier3d-compat';

export const GROUPS = {
  TERRAIN: 0x0001,
  STATIC: 0x0002, // docks, rocks, buildings, walls
  BOAT: 0x0004, // player hull
  PROPS: 0x0008, // moored boats, buoys (kinematic)
  SENSOR: 0x0010,
} as const;

/** rapier interaction groups: 16 bits membership << 16 | 16 bits filter */
export function groups(membership: number, filter: number) {
  return (membership << 16) | filter;
}

export class PhysicsWorld {
  readonly RAPIER = RAPIER;
  world!: RAPIER.World;
  readonly fixedDt = 1 / 60;
  private fixedBody!: RAPIER.RigidBody;

  async init() {
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = this.fixedDt;
    this.fixedBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  }

  /** attach a static collider to the shared fixed body. pass a world-space translation/rotation on the desc. */
  addStatic(desc: RAPIER.ColliderDesc, membership: number = GROUPS.STATIC): RAPIER.Collider {
    desc.setCollisionGroups(groups(membership, 0xffff));
    return this.world.createCollider(desc, this.fixedBody);
  }

  /** axis-aligned or rotated box helper: center, half extents, yaw in radians */
  addBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw = 0, membership: number = GROUPS.STATIC) {
    const d = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz);
    if (yaw) d.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
    d.setFriction(0.4).setRestitution(0.1);
    return this.addStatic(d, membership);
  }

  step() {
    this.world.step();
  }
}
