// rapier heightfield for the terrain. samples sit exactly on the height channel's texel centers,
// so physics matches the rendered surface (1 m cells by default).
// rapier layout: rows run along z, columns along x, heights column-major (row + col * (rows + 1)).
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../core/physics';
import { GROUPS } from '../core/physics';

export function addTerrainCollider(physics: PhysicsWorld, data: Float32Array, res: number, size: number, step = 1): RAPIER.Collider {
  const R = physics.RAPIER;
  const cell = size / res;
  const n = Math.floor((res - 1) / step) + 1;
  const heights = new Float32Array(n * n);
  for (let c = 0; c < n; c++) {
    const i = c * step;
    for (let r = 0; r < n; r++) heights[r + c * n] = data[r * step * res + i];
  }
  const span = (n - 1) * step * cell;
  const x0 = -size / 2 + cell * 0.5;
  const desc = R.ColliderDesc.heightfield(n - 1, n - 1, heights, { x: span, y: 1, z: span }, R.HeightFieldFlags.FIX_INTERNAL_EDGES)
    .setTranslation(x0 + span / 2, 0, x0 + span / 2)
    .setFriction(0.6)
    .setRestitution(0.05);
  return physics.addStatic(desc, GROUPS.TERRAIN);
}
