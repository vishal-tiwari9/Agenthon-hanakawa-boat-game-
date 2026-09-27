// baked boulder instances: one instanced draw per piece and lod, re-bucketed by camera distance and
// frustum a few times a second; convex hull colliders for the ones the boat can reach.
// the draws are plain meshes over instanced geometry, placed by the material from two per-instance
// vec4s (position + scale, rotation). three keys every InstancedMesh's shader build by its uuid, so 30
// InstancedMeshes cost 30 full sets of pipeline builds at startup; these 30 meshes share one set.
import {
  BufferAttribute, BufferGeometry, DynamicDrawUsage, Frustum, InstancedBufferGeometry, InstancedInterleavedBuffer, InterleavedBufferAttribute,
  Matrix4, Mesh, Quaternion, Sphere, Vector3, type Material,
} from 'three/webgpu';
import { Fn, attribute, cross, normalLocal, positionLocal } from 'three/tsl';
import type { GameContext } from '../core/context';
import { GROUPS } from '../core/physics';

interface PieceMeta { id: string; dims: number[]; lods: { vOff: number; vCount: number; iOff: number; iCount: number }[] }

export async function createRocks(ctx: GameContext, material: Material) {
  const [meta, bin, placed] = await Promise.all([
    ctx.assets.json<{ pieces: PieceMeta[]; vertexCount: number; indexCount: number }>('/assets/terrain/rocks/rocks.json'),
    ctx.assets.binary('/assets/terrain/rocks/rocks.bin'),
    ctx.assets.json<{ pieces: string[]; stride: number; count: number; instances: number[] }>('/world/rocks.json?v=' + ctx.world.meta.version),
  ]);
  const V = meta.vertexCount;
  const P = new Float32Array(bin, 0, V * 3), Nn = new Float32Array(bin, V * 12, V * 3), I = new Uint32Array(bin, V * 24, meta.indexCount);
  const pieces = placed.pieces.map((id) => meta.pieces.find((p) => p.id === id)!);
  const geos = pieces.map((pc) => pc.lods.map((l) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(P.slice(l.vOff * 3, (l.vOff + l.vCount) * 3), 3));
    g.setAttribute('normal', new BufferAttribute(Nn.slice(l.vOff * 3, (l.vOff + l.vCount) * 3), 3));
    g.setIndex(new BufferAttribute(I.slice(l.iOff, l.iOff + l.iCount), 1));
    g.computeBoundingSphere();
    return g;
  }));

  // instances
  const st = placed.stride, n = placed.count, A = placed.instances;
  const mats: Matrix4[] = [], spheres: Sphere[] = [], pieceOf: number[] = [];
  // per instance: x, y, z, scale, qx, qy, qz, qw (what the material reads)
  const inst = new Float32Array(Math.max(1, n) * 8);
  const q = new Quaternion(), v = new Vector3(), sc = new Vector3();
  const counts = new Array(pieces.length).fill(0);
  for (let k = 0; k < n; k++) {
    const o = k * st;
    const pi = A[o];
    v.set(A[o + 1], A[o + 2], A[o + 3]);
    q.set(A[o + 4], A[o + 5], A[o + 6], A[o + 7]);
    const s = A[o + 8];
    sc.set(s, s, s);
    mats.push(new Matrix4().compose(v, q, sc));
    inst.set([v.x, v.y, v.z, s, q.x, q.y, q.z, q.w], k * 8);
    spheres.push(new Sphere(v.clone(), s * 0.9));
    pieceOf.push(pi);
    counts[pi]++;
  }

  // the instance transform: p' = q * (p * scale) + position, normals rotate with q (scale is uniform)
  const aP = attribute('aRockP', 'vec4') as any, aQ = attribute('aRockQ', 'vec4') as any;
  const rot = (p: any) => p.add(cross(aQ.xyz, cross(aQ.xyz, p).add(p.mul(aQ.w))).mul(2));
  (material as any).positionNode = Fn(() => {
    normalLocal.assign(rot(normalLocal));
    return rot((positionLocal as any).mul(aP.w)).add(aP.xyz);
  })();

  // one instanced draw per piece per lod
  interface Draw { mesh: Mesh; geo: InstancedBufferGeometry; buf: InstancedInterleavedBuffer; n: number }
  const meshes: Draw[][] = pieces.map((_, pi) => geos[pi].map((g, li) => {
    const geo = new InstancedBufferGeometry();
    geo.setIndex(g.index);
    geo.setAttribute('position', g.getAttribute('position'));
    geo.setAttribute('normal', g.getAttribute('normal'));
    const buf = new InstancedInterleavedBuffer(new Float32Array(Math.max(1, counts[pi]) * 8), 8, 1);
    buf.setUsage(DynamicDrawUsage);
    geo.setAttribute('aRockP', new InterleavedBufferAttribute(buf, 4, 0));
    geo.setAttribute('aRockQ', new InterleavedBufferAttribute(buf, 4, 4));
    geo.instanceCount = 0;
    geo.boundingSphere = new Sphere(new Vector3(), 1e6);
    const m = new Mesh(geo, material);
    m.name = `rocks.${pi}.${li}`;
    m.frustumCulled = false;
    // every lod casts, so a boulder's shadow never vanishes when it drops to its far mesh
    m.castShadow = true;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    ctx.scene.add(m);
    return { mesh: m, geo, buf, n: 0 };
  }));

  // colliders: convex hulls from the coarsest lod
  let colliders = 0;
  const R = ctx.physics.RAPIER;
  for (let k = 0; k < n; k++) {
    if (!A[k * st + 9]) continue;
    const l = pieces[pieceOf[k]].lods[2];
    const pts = new Float32Array(l.vCount * 3);
    for (let i = 0; i < l.vCount; i++) {
      v.set(P[(l.vOff + i) * 3], P[(l.vOff + i) * 3 + 1], P[(l.vOff + i) * 3 + 2]).applyMatrix4(mats[k]);
      pts[i * 3] = v.x; pts[i * 3 + 1] = v.y; pts[i * 3 + 2] = v.z;
    }
    const d = R.ColliderDesc.convexHull(pts);
    if (!d) continue;
    d.setFriction(0.5).setRestitution(0.1);
    ctx.physics.addStatic(d, GROUPS.STATIC);
    colliders++;
  }

  const frustum = new Frustum(), m4 = new Matrix4(), cam = new Vector3(), last = new Vector3(1e9, 0, 0);
  let lastQuat = new Quaternion(), frame = 0;
  let dist = [55, 170, 520];
  const setDetail = (d: number) => { dist = [55 * d, 170 * d, 520 * Math.max(0.8, d)]; };
  setDetail(ctx.quality.terrainDetail);
  ctx.events.on('quality', (qp: { terrainDetail: number }) => { setDetail(qp.terrainDetail); last.set(1e9, 0, 0); });

  const rebucket = () => {
    for (const row of meshes) for (const d of row) d.n = 0;
    for (let k = 0; k < n; k++) {
      const sp = spheres[k];
      if (!frustum.intersectsSphere(sp)) continue;
      const d = sp.center.distanceTo(cam) - sp.radius;
      // screen size cull: small stones vanish first
      if (d > dist[2] * Math.min(1, sp.radius * 1.2)) continue;
      const li = d < dist[0] ? 0 : d < dist[1] ? 1 : 2;
      const draw = meshes[pieceOf[k]][li];
      const a = draw.buf.array, o = draw.n++ * 8, src = k * 8;
      for (let j = 0; j < 8; j++) a[o + j] = inst[src + j];
    }
    for (const row of meshes) for (const d of row) {
      d.geo.instanceCount = d.n;
      if (!d.n) continue;
      d.buf.clearUpdateRanges();
      d.buf.addUpdateRange(0, d.n * 8);
      d.buf.needsUpdate = true;
    }
  };
  ctx.onUpdate((c) => {
    frame++;
    c.camera.getWorldPosition(cam);
    const moved = cam.distanceToSquared(last) > 9 || c.camera.quaternion.angleTo(lastQuat) > 0.05;
    if (!moved && frame % 30) return;
    last.copy(cam);
    lastQuat = c.camera.quaternion.clone();
    m4.multiplyMatrices(c.camera.projectionMatrix, c.camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(m4, c.camera.coordinateSystem);
    rebucket();
  }, 56);

  return { count: n, colliders, meshes: meshes.map((row) => row.map((d) => d.mesh)) };
}
