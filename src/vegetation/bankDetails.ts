// small authored gardens at the water's edge. geometry is shared and instanced in spatial buckets;
// only the close clusters draw. the channel, landing approaches and building footprints stay clear.
import {
  Box3, BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Group,
  InstancedBufferAttribute, InstancedBufferGeometry, InstancedMesh, Matrix4, Mesh,
  MeshStandardNodeMaterial, Quaternion, Sphere, Vector3,
} from 'three/webgpu';
import { Fn, attribute, cameraPosition, cameraViewMatrix, cos, faceDirection, float, length, mix, normalLocal, normalize, positionLocal, sin, smoothstep, varyingProperty, vec3, vec4 } from 'three/tsl';
import type { GameContext } from '../core/context';
import { LAYERS } from '../core/layers';
import { uTime } from '../core/uniforms';
import { bankPoint, BRIDGES, DOCKS, riverFrame, RIVER_LENGTH } from '../world/layout';
import { SITES } from '../world/sites';
import { waterHeight } from '../world/waves';
import { footprintDistance, type HeightFn } from './field';
import { FoliageMaterial } from './foliage';
import { hash1 } from './noise';
import { windAt } from './wind';

type V = [number, number, number];
type Kind = 'reed' | 'iris' | 'fern';
interface Plant { x: number; y: number; z: number; yaw: number; scale: number; seed: number }
interface Cluster { mesh: Mesh; center: Vector3; radius: number; count: number }

class GardenGeo {
  private p: number[] = [];
  private c: number[] = [];
  tri(a: V, b: V, c: V, tint: V) {
    this.p.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.c.push(...tint);
  }
  leaf(base: V, yaw: number, reach: number, height: number, width: number, tint: V, curve = 0.28) {
    const segments = 5;
    const p = (t: number, side: number): V => {
      const w = Math.pow(Math.sin(Math.PI * t), 0.72) * width * side;
      const d = reach * t;
      return [base[0] + Math.sin(yaw) * d + Math.cos(yaw) * w, base[1] + height * t - curve * height * t * t, base[2] + Math.cos(yaw) * d - Math.sin(yaw) * w];
    };
    for (let j = 0; j < segments; j++) {
      const a = j / segments, b = (j + 1) / segments;
      const l0 = p(a, -1), r0 = p(a, 1), l1 = p(b, -1), r1 = p(b, 1);
      this.tri(l0, l1, r0, tint); this.tri(r0, l1, r1, tint);
    }
  }
  stem(x: number, z: number, h: number, w: number, tint: V) {
    for (let i = 0; i < 2; i++) {
      const dx = i ? w : 0, dz = i ? 0 : w;
      this.tri([x - dx, 0, z - dz], [x - dx * 0.6, h, z - dz * 0.6], [x + dx, 0, z + dz], tint);
      this.tri([x + dx, 0, z + dz], [x - dx * 0.6, h, z - dz * 0.6], [x + dx * 0.6, h, z + dz * 0.6], tint);
    }
  }
  build() {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.c), 3));
    g.computeVertexNormals();
    return g;
  }
}

function plantGeometry(kind: Kind) {
  const g = new GardenGeo();
  if (kind === 'reed') {
    for (let j = 0; j < 6; j++) {
      const a = j * 2.4, x = Math.sin(a) * 0.12, z = Math.cos(a) * 0.12;
      const h = 0.9 + hash1(j, 20) * 0.8;
      g.stem(x, z, h, 0.009, [0.15, 0.26, 0.055]);
      for (let k = 0; k < 3; k++) g.leaf([x, h * (0.19 + k * 0.19), z], a + k * 2.7, 0.35, 0.3, 0.022, [0.18, 0.32, 0.055], 0.8);
      // the open panicle has individual golden spikelets, not a solid cattail cylinder
      for (let k = 0; k < 6; k++) g.leaf([x, h - 0.16 + k * 0.04, z], a + k * 2.4, 0.045 * (1 - k / 8), 0.12, 0.012, [0.35, 0.27, 0.12], 0.25);
    }
  } else if (kind === 'iris') {
    for (let j = 0; j < 7; j++) g.leaf([0, 0, 0], j * 2.3, 0.18 + hash1(j, 30) * 0.19, 0.7 + hash1(j, 31) * 0.25, 0.025, [0.105, 0.255, 0.08], 0.14);
    for (let j = 0; j < 2; j++) {
      const x = j ? 0.075 : -0.065, z = j ? 0.04 : -0.05, h = j ? 0.79 : 0.92;
      g.stem(x, z, h, 0.008, [0.12, 0.24, 0.06]);
      for (let k = 0; k < 3; k++) {
        const a = k * Math.PI * 2 / 3 + j * 0.5;
        g.leaf([x, h, z], a, 0.11, -0.025, 0.04, [0.28, 0.14, 0.47], 0.1);
        g.leaf([x, h, z], a + Math.PI / 3, 0.065, 0.095, 0.033, [0.46, 0.25, 0.58], 0.45);
        g.leaf([x, h + 0.003, z], a, 0.067, -0.01, 0.007, [0.73, 0.54, 0.10], 0.1);
      }
    }
  } else {
    for (let j = 0; j < 6; j++) {
      const a = j * Math.PI / 3 + 0.12, reach = 0.39 + hash1(j, 40) * 0.23;
      const up = 0.40 + hash1(j, 41) * 0.17;
      g.leaf([0, 0, 0], a, reach, up, 0.008, [0.16, 0.25, 0.045], 0.65);
      for (let k = 1; k <= 7; k++) {
        const t = k / 8, d = reach * t, y = up * t - up * 0.65 * t * t;
        const base: V = [Math.sin(a) * d, y, Math.cos(a) * d];
        for (const side of [-1, 1]) g.leaf(base, a + side * 1.0, (0.16 * (1 - t) + 0.025), 0.055, 0.022 * (1 - t) + 0.006, [0.075 + t * 0.07, 0.22 + t * 0.12, 0.035], 0.6);
      }
    }
  }
  return g.build();
}

function gardenMaterial() {
  const root = attribute('aBankRoot', 'vec4') as any;
  const size = attribute('aBankSize', 'vec2') as any;
  const n = varyingProperty('vec3', 'vBankNormal') as any;
  const m = new FoliageMaterial({ side: DoubleSide, roughness: 0.82 });
  m.name = 'bank-garden';
  m.positionNode = Fn(() => {
    const p = positionLocal as any, ca = cos(root.w), sa = sin(root.w);
    const d = length(cameraPosition.sub(root.xyz));
    const grow = float(1).sub(smoothstep(78, 115, d));
    const h = p.y.max(0);
    const w = windAt(root.xz) as any;
    const sway = w.z.mul(0.025).add(sin(uTime.mul(1.4).add(size.y.mul(6.28))).mul(w.w.mul(0.02)));
    const q = vec3(p.x.mul(ca).add(p.z.mul(sa)), p.y, p.z.mul(ca).sub(p.x.mul(sa))).mul(size.x.mul(grow));
    const nl = normalLocal as any;
    n.assign(vec3(nl.x.mul(ca).add(nl.z.mul(sa)), nl.y, nl.z.mul(ca).sub(nl.x.mul(sa))));
    return root.xyz.add(q).add(vec3(w.x, 0, w.y).mul(sway.mul(h).mul(h).mul(grow)));
  })();
  m.colorNode = (attribute('color', 'vec3') as any).mul(size.y.mul(0.15).add(0.9));
  m.normalNode = normalize((cameraViewMatrix as any).mul(vec4(normalize(mix(n.mul(faceDirection), vec3(0, 1, 0), 0.12)), 0)).xyz);
  m.translucencyNode = float(0.28);
  m.translucencyTint = vec3(1.0, 1.13, 0.7);
  return m;
}

/** building footprints with a bounding radius, so most plants skip the exact test */
const SITE_BOUNDS = SITES.map((site) => ({ site: { ...site, margin: 0.7 }, r2: (Math.hypot(site.hx, site.hz) + 0.7) ** 2 }));

function excludes(s: number, side: -1 | 1, x: number, z: number) {
  if (DOCKS.some(d => d.side === side && Math.abs(d.s - s) < 12)) return true;
  if (BRIDGES.some(b => Math.abs(b.s - s) < b.deckWidth * 0.5 + 4)) return true;
  for (const b of SITE_BOUNDS) {
    const dx = x - b.site.x, dz = z - b.site.z;
    if (dx * dx + dz * dz < b.r2 && footprintDistance(b.site, x, z) < 0) return true;
  }
  return false;
}

function makeCluster(base: BufferGeometry, mat: FoliageMaterial, plants: Plant[], name: string): Cluster {
  const geo = new InstancedBufferGeometry();
  for (const key of ['position', 'normal', 'color']) {
    const attr = base.getAttribute(key) as BufferAttribute;
    geo.setAttribute(key, new BufferAttribute((attr.array as Float32Array).slice(), attr.itemSize));
  }
  const roots = new Float32Array(plants.length * 4), sizes = new Float32Array(plants.length * 2);
  const box = new Box3();
  const temp = new Vector3();
  plants.forEach((p, i) => {
    roots.set([p.x, p.y, p.z, p.yaw], i * 4); sizes.set([p.scale, p.seed], i * 2);
    box.expandByPoint(temp.set(p.x, p.y, p.z));
  });
  geo.setAttribute('aBankRoot', new InstancedBufferAttribute(roots, 4));
  geo.setAttribute('aBankSize', new InstancedBufferAttribute(sizes, 2));
  geo.instanceCount = plants.length;
  box.expandByScalar(2.1);
  geo.boundingBox = box;
  geo.boundingSphere = box.getBoundingSphere(new Sphere());
  const mesh = new Mesh(geo, mat);
  mesh.name = name;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  // reed and iris clumps are too small to read in the rippled mirror; skip that pass
  mesh.layers.set(LAYERS.NO_REFLECT);
  const center = box.getCenter(new Vector3());
  return { mesh, center, radius: geo.boundingSphere.radius, count: plants.length };
}

interface PetalSeed { s: number; side: -1 | 1; phase: number; seed: number; falling: boolean }

export function createBankDetails(ctx: GameContext, heightAt: HeightFn) {
  const root = new Group();
  root.name = 'bank-details';
  const material = gardenMaterial();
  const bases = { reed: plantGeometry('reed'), iris: plantGeometry('iris'), fern: plantGeometry('fern') };
  const buckets = new Map<string, { kind: Kind; plants: Plant[] }>();
  let plantCount = 0;
  // elongated, irregular pockets, with larger gaps left for the buildings, paths and views
  for (let s = 46; s < RIVER_LENGTH - 36; s += 14) {
    for (const side of [-1, 1] as const) {
      const seed = Math.floor(s) * 17 + side * 237;
      if (hash1(seed, 1) > (s < 550 ? 0.8 : 0.58)) continue;
      const kind: Kind = hash1(seed, 2) < 0.42 ? 'iris' : hash1(seed, 3) < 0.6 ? 'reed' : 'fern';
      const number = kind === 'reed' ? 14 : kind === 'iris' ? 21 : 12;
      for (let i = 0; i < number; i++) {
        const ps = s + (hash1(seed + i, 4) - 0.5) * 10;
        const inset = kind === 'fern' ? 2.0 + hash1(seed + i, 5) * 3.8 : 0.15 + hash1(seed + i, 5) * 2.6;
        const p = bankPoint(ps, side, inset);
        const y = heightAt(p.x, p.z);
        if (!Number.isFinite(y) || y < 0.08 || y > (kind === 'fern' ? 10 : 4.5)) continue;
        if (excludes(ps, side, p.x, p.z)) continue;
        if (ctx.world.normalAt(p.x, p.z).y < 0.72) continue;
        if (ctx.world.has('path') && ctx.world.sample('path', p.x, p.z) > 0.25) continue;
        // long buckets: a few draws cover the whole visible bank (plants shrink away past ~100 m)
        const key = `${kind}:${Math.floor(ps / 200)}`;
        let b = buckets.get(key);
        if (!b) { b = { kind, plants: [] }; buckets.set(key, b); }
        b.plants.push({ x: p.x, y: y - 0.025, z: p.z, yaw: hash1(seed + i, 6) * Math.PI * 2, scale: 0.65 + hash1(seed + i, 7) * 0.6, seed: hash1(seed + i, 8) });
        plantCount++;
      }
    }
  }
  const clusters: Cluster[] = [];
  for (const [key, b] of buckets) {
    const c = makeCluster(bases[b.kind], material, b.plants, `bank-${key}`);
    root.add(c.mesh); clusters.push(c);
  }
  for (const b of Object.values(bases)) b.dispose();

  // petals gather only below the cherry-lined village and temple, never across the whole valley
  const petalSeeds: PetalSeed[] = [];
  for (const s of [96, 148, 212, 260, 345, 380, 490, 535, 1615, 1770]) {
    for (const side of [-1, 1] as const) for (let i = 0; i < 8; i++) {
      const seed = Math.floor(s) * 31 + i * 59 + side * 307;
      if (DOCKS.some(d => d.side === side && Math.abs(d.s - s) < 16)) continue;
      petalSeeds.push({ s, side, phase: hash1(seed, 0), seed, falling: i < 3 });
    }
  }
  const petalGeo = new BufferGeometry();
  petalGeo.setAttribute('position', new BufferAttribute(new Float32Array([0,0,-0.027, -0.016,0.002,-0.004, 0.016,0.002,-0.004, -0.012,0.004,0.019, 0.012,0.004,0.019, 0,0.003,0.028]),3));
  petalGeo.setIndex([0,1,2, 1,3,2, 2,3,4, 3,5,4]);
  petalGeo.computeVertexNormals();
  const petalMat = new MeshStandardNodeMaterial({ side: DoubleSide, roughness: 0.8, color: 0xf3b6c8 });
  const petals = new InstancedMesh(petalGeo, petalMat, petalSeeds.length);
  petals.name = 'drifting-cherry-petals';
  petals.layers.set(LAYERS.NO_REFLECT);
  petals.instanceMatrix.setUsage(DynamicDrawUsage);
  petals.frustumCulled = false;
  const tint = new Color();
  petalSeeds.forEach((p, i) => petals.setColorAt(i, tint.setRGB(1, 0.76 + hash1(p.seed, 9) * 0.19, 0.83 + hash1(p.seed, 10) * 0.13)));
  root.add(petals);
  ctx.scene.add(root);

  let density = ctx.quality.vegetationDensity;
  ctx.events.on('quality', q => { density = q.vegetationDensity; });
  const matrix = new Matrix4(), position = new Vector3(), rotation = new Quaternion(), scale = new Vector3(), axis = new Vector3(0, 1, 0);
  const cam = new Vector3();
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let nextPetal = -1, visible = 0;
  ctx.onUpdate(() => {
    ctx.camera.getWorldPosition(cam);
    visible = 0;
    for (const c of clusters) {
      c.mesh.visible = c.center.distanceTo(cam) < 260 + c.radius;
      (c.mesh.geometry as InstancedBufferGeometry).instanceCount = Math.max(1, Math.floor(c.count * Math.min(1, density + 0.25)));
      if (c.mesh.visible) visible++;
    }
    if (ctx.time.render < nextPetal && ctx.time.render >= nextPetal - 0.1) return;
    nextPetal = ctx.time.render + 0.05;
    const t = reduced ? 0 : ctx.time.render;
    petalSeeds.forEach((p, i) => {
      const life = (p.phase + t * (p.falling ? 0.055 : 0.024)) % 1;
      const s = p.s + (0.5 - life) * 9;
      const water = bankPoint(s, p.side, -1.0 - hash1(p.seed, 2) * 3.0);
      const f = riverFrame(s);
      let x = water.x, z = water.z;
      let y = waterHeight(x, z, ctx.time.render) + 0.018;
      if (p.falling) {
        x += Math.sin(t * 0.7 + p.phase * 6.28) * 0.45;
        z += Math.cos(t * 0.43 + p.phase * 6.28) * 0.32;
        y += (1 - life) * 2.6;
      } else {
        // current-dependent drift stays in the near-bank strip, outside the navigation corridor
        const flowX = ctx.world.sample('flowX', x, z), flowZ = ctx.world.sample('flowZ', x, z);
        const v = Math.max(0.05, Math.hypot(flowX, flowZ));
        x -= f.tx * (life - 0.5) * Math.min(2, v * 5);
        z -= f.tz * (life - 0.5) * Math.min(2, v * 5);
        y = waterHeight(x, z, ctx.time.render) + 0.018;
      }
      position.set(x, y, z);
      const on = position.distanceTo(cam) < 65 && ctx.world.heightAt(x, z) < -0.06 && hash1(p.seed, 11) < density + 0.2;
      const fade = Math.min(1, life * 12, (1 - life) * 12);
      const sz = on ? (0.9 + hash1(p.seed, 8) * 0.5) * Math.max(0, fade) : 0;
      scale.setScalar(sz);
      rotation.setFromAxisAngle(axis, p.phase * 6.28 + t * (p.falling ? 0.65 : 0.08));
      matrix.compose(position, rotation, scale);
      petals.setMatrixAt(i, matrix);
    });
    petals.instanceMatrix.needsUpdate = true;
  }, 66);
  return { root, stats: () => ({ plants: plantCount, clusters: clusters.length, visible, petals: petalSeeds.length }) };
}
