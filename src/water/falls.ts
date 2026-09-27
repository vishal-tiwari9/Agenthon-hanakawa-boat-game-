// falling water: hanakawa falls (upstream end), maiden falls (side cascade, left bank) and the thin
// overflow nappe at the old weir. sheets are fitted to the baked terrain: each column leaves its lip on
// a ballistic curve and is pushed clear of the rock face, so the same code follows whatever faces the
// terrain owner carves. the plunge bases feed capsule churn sources to the water shader, and spray
// droplets and local mist live on NO_REFLECT.
import {
  BufferAttribute, BufferGeometry, DoubleSide, Group, InstancedBufferAttribute, Mesh, MeshStandardNodeMaterial, NormalBlending,
  Sprite, SpriteNodeMaterial, Vector3, Vector4,
} from 'three/webgpu';
import { attribute, float, instancedBufferAttribute, mix, positionWorld, cameraPosition, smoothstep, sqrt, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import type { Texture } from 'three/webgpu';
import type { GameContext } from '../core/context';
import { LAYERS } from '../core/layers';
import { uTime, uWindDir } from '../core/uniforms';
import { LANDMARKS, RIVER_LENGTH, nearestRiver, riverFrame } from '../world/layout';

type N = any;
const G = 9.81;

/** lips measured on the terrain owner's valley bake (x, z, crest height y) */
const FALLS_DATA = {
  hanakawa: { x: 109.4, z: -895.8, y: 30.1, width: 15, pool: 17 },
  maiden: { x: -170.1, z: 72, y: 13, width: 3.2 },
};

export interface FoamSource {
  a: [number, number];
  b: [number, number];
  radius: number;
  foam: number;
  churn: number;
}

interface Column {
  pts: Vector3[];
  fall: number[];
}

interface SheetSpec {
  cols: Column[];
  /** meters across the sheet */
  width: number;
  /** max opacity of the sheet (thin nappe < curtain) */
  opacity: number;
}

/** small cpu particle set drawn as instanced soft sprites */
class Particles {
  sprite: Sprite;
  cap: number;
  count = 0;
  pos: Float32Array;
  vel: Float32Array;
  life: Float32Array;
  fade: Float32Array;
  posAttr: InstancedBufferAttribute;
  fadeAttr: InstancedBufferAttribute;
  uColor = uniform(new Vector3(1, 1, 1));
  constructor(cap: number, soft: [number, number], maxAlpha: number, nearFade: number) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 4);
    this.vel = new Float32Array(cap * 4);
    this.life = new Float32Array(cap * 2);
    this.fade = new Float32Array(cap * 4);
    this.posAttr = new InstancedBufferAttribute(this.pos, 4);
    this.fadeAttr = new InstancedBufferAttribute(this.fade, 4);
    const m = new SpriteNodeMaterial();
    m.transparent = true;
    m.depthWrite = false;
    m.blending = NormalBlending;
    const p: N = instancedBufferAttribute(this.posAttr);
    const f: N = instancedBufferAttribute(this.fadeAttr);
    m.positionNode = p.xyz;
    m.scaleNode = p.w;
    const d = uv().sub(0.5).length().mul(2);
    const shape = float(1).sub(smoothstep(soft[0], soft[1], d));
    const near = smoothstep(nearFade * 0.4, nearFade, positionWorld.sub(cameraPosition).length());
    m.colorNode = vec4(this.uColor, 1);
    m.opacityNode = shape.mul(f.x).mul(maxAlpha).mul(near);
    this.sprite = new Sprite(m);
    this.sprite.count = 0;
    this.sprite.frustumCulled = false;
    this.sprite.layers.set(LAYERS.NO_REFLECT);
    this.sprite.renderOrder = 6;
  }
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, grow: number) {
    if (this.count >= this.cap) return;
    const i = this.count++;
    const p = this.pos, v = this.vel;
    p[i * 4] = x; p[i * 4 + 1] = y; p[i * 4 + 2] = z; p[i * 4 + 3] = size;
    v[i * 4] = vx; v[i * 4 + 1] = vy; v[i * 4 + 2] = vz; v[i * 4 + 3] = grow;
    this.life[i * 2] = 0;
    this.life[i * 2 + 1] = life;
  }
  step(dt: number, gravity: number, drag: number, lift: number, windX: number, windZ: number) {
    let w = 0;
    const p = this.pos, v = this.vel, l = this.life;
    const k = Math.exp(-drag * dt);
    for (let i = 0; i < this.count; i++) {
      const age = l[i * 2] + dt, life = l[i * 2 + 1];
      if (age > life) continue;
      let vx = v[i * 4], vy = v[i * 4 + 1], vz = v[i * 4 + 2];
      const grow = v[i * 4 + 3];
      vx = (vx - windX) * k + windX;
      vz = (vz - windZ) * k + windZ;
      vy = vy * k - gravity * dt + lift * dt;
      const x = p[i * 4] + vx * dt, y = p[i * 4 + 1] + vy * dt, z = p[i * 4 + 2] + vz * dt;
      if (gravity > 0 && vy < 0 && y < -0.05) continue;
      p[w * 4] = x; p[w * 4 + 1] = y; p[w * 4 + 2] = z; p[w * 4 + 3] = p[i * 4 + 3] * (1 + grow * dt);
      v[w * 4] = vx; v[w * 4 + 1] = vy; v[w * 4 + 2] = vz; v[w * 4 + 3] = grow;
      l[w * 2] = age; l[w * 2 + 1] = life;
      const t = age / life;
      this.fade[w * 4] = Math.min(1, t * 5) * (1 - t) * (1 - t) * 1.6;
      w++;
    }
    this.count = w;
    this.sprite.count = w;
    this.sprite.visible = w > 0;
    this.posAttr.needsUpdate = true;
    this.fadeAttr.needsUpdate = true;
  }
}

interface Emitter {
  /** base line of the plunge (world) */
  a: Vector3;
  b: Vector3;
  /** outward (downstream) horizontal direction */
  out: Vector3;
  /** fall height, drives spray energy */
  height: number;
  mist: number;
  spray: number;
}

export class Falls {
  group = new Group();
  sources: FoamSource[] = [];
  /** weir crest (x, z, upstream tangent x, z) and drop of the downstream pool (0 = none) */
  weir = { x: 0, z: 0, tx: 0, tz: -1, halfWidth: 20, drop: 0 };
  budget = 1;
  private mist = new Particles(160, [0.1, 1], 0.1, 7);
  private drops = new Particles(260, [0.3, 1], 0.75, 0.5);
  private emitters: Emitter[] = [];
  private acc = [0, 0];
  private tmp = new Vector3();

  constructor(private ctx: GameContext, foamTex: Texture) {
    this.group.name = 'water.falls';
    const sheets: SheetSpec[] = [];
    const main = this.hanakawa();
    if (main) sheets.push(main);
    const side = this.maiden();
    if (side) sheets.push(side);
    const nappe = this.weirNappe();
    if (nappe) sheets.push(nappe);
    for (const s of sheets) this.group.add(this.sheetMesh(s, foamTex));
    this.group.add(this.mist.sprite, this.drops.sprite);
    ctx.scene.add(this.group);
  }

  private h(x: number, z: number) {
    return this.ctx.world.has('height') ? this.ctx.world.heightAt(x, z) : -3;
  }

  /** distance along dir from p where the rock face drops below height y (0 if already below) */
  private faceExit(px: number, pz: number, dx: number, dz: number, y: number, maxD: number) {
    for (let d = 0; d <= maxD; d += 0.25) if (this.h(px + dx * d, pz + dz * d) < y) return d;
    return maxD;
  }

  /**
   * a curtain that leaves `lip` (per column) falling toward `out`; columns are pushed clear of the
   * terrain face. returns the column polylines from the lip down to just under the water surface.
   */
  private curtain(lips: Vector3[], out: Vector3, v0: number, rows: number): Column[] {
    return lips.map((lip) => {
      const pts: Vector3[] = [], fall: number[] = [];
      const H = lip.y;
      for (let r = 0; r <= rows; r++) {
        const f = r / rows;
        const y = H - (H + 0.4) * f * f * 0.35 - (H + 0.4) * f * 0.65;
        const dy = H - y;
        const tau = Math.sqrt((2 * dy) / G);
        let o = v0 * tau;
        // stay in front of the rock face at this height (search back toward the lip side)
        const face = this.faceExit(lip.x - out.x * 3, lip.z - out.z * 3, out.x, out.z, y + 0.1, 30);
        o = Math.max(o, face - 3 + 0.4);
        pts.push(new Vector3(lip.x + out.x * o, y, lip.z + out.z * o));
        fall.push(dy);
      }
      return { pts, fall };
    });
  }

  private hanakawa(): SheetSpec | null {
    const f = riverFrame(RIVER_LENGTH - 1);
    const lipC = FALLS_DATA.hanakawa;
    const out = new Vector3(-f.tx, 0, -f.tz);
    const width = FALLS_DATA.hanakawa.width;
    const cols = 26;
    const lips: Vector3[] = [];
    for (let c = 0; c < cols; c++) {
      const u = (c / (cols - 1) - 0.5) * width;
      // the crest bows slightly downstream in the middle, like a worn lip
      const bow = 0.6 * (1 - (2 * c / (cols - 1) - 1) ** 2);
      lips.push(new Vector3(lipC.x + f.nx * u + out.x * bow, lipC.y + 0.05, lipC.z + f.nz * u + out.z * bow));
    }
    const columns = this.curtain(lips, out, 2.4, 36);
    const base = columns.map((c) => c.pts[c.pts.length - 1]);
    const a = base[0], b = base[base.length - 1];
    this.sources.push({ a: [a.x + out.x * 2, a.z + out.z * 2], b: [b.x + out.x * 2, b.z + out.z * 2], radius: Math.min(lipC.pool, 14), foam: 0.95, churn: 1 });
    this.emitters.push({ a: a.clone(), b: b.clone(), out, height: lipC.y, mist: 1, spray: 1 });
    return { cols: columns, width, opacity: 0.94 };
  }

  private maiden(): SheetSpec | null {
    const lip = FALLS_DATA.maiden;
    // toward the river: from the lip to the nearest centerline point
    const nr = nearestRiver(lip.x, lip.z);
    const f = riverFrame(nr.s);
    let ox = f.x - lip.x, oz = f.z - lip.z;
    const ol = Math.hypot(ox, oz) || 1;
    ox /= ol;
    oz /= ol;
    const out = new Vector3(ox, 0, oz);
    const width = lip.width;
    const cols = 8, rows = 30;
    // distance from the lip to the water's edge along `out`, plus 2 m into the pool
    let span = 4;
    for (let d = 0; d < 60; d += 0.5) {
      span = d;
      if (this.h(lip.x + ox * d, lip.z + oz * d) < -0.2) break;
    }
    span += 2;
    const columns: Column[] = [];
    for (let c = 0; c < cols; c++) {
      const u = (c / (cols - 1) - 0.5) * width;
      const lx = lip.x - oz * u, lz = lip.z + ox * u;
      const pts: Vector3[] = [], fall: number[] = [];
      let yPrev = lip.y + 0.05;
      for (let r = 0; r <= rows; r++) {
        const d = (r / rows) ** 1.25 * span;
        const x = lx + ox * d, z = lz + oz * d;
        // leaves the lip at ~1.6 m/s: free fall where the rock drops away, a film over it elsewhere
        const tau = d / 1.6;
        const ball = lip.y + 0.05 - 0.5 * G * tau * tau;
        const y = Math.min(yPrev, Math.max(this.h(x, z) + 0.14, ball, -0.3));
        yPrev = y;
        pts.push(new Vector3(x, y, z));
        fall.push(Math.max(0, lip.y - y) + d * 0.25);
      }
      columns.push({ pts, fall });
    }
    const a = columns[0].pts[rows], b = columns[cols - 1].pts[rows];
    this.sources.push({ a: [a.x - ox, a.z - oz], b: [b.x - ox, b.z - oz], radius: 4.5, foam: 0.85, churn: 0.8 });
    this.emitters.push({ a: a.clone(), b: b.clone(), out, height: lip.y, mist: 0.4, spray: 0.5 });
    return { cols: columns, width, opacity: 0.9 };
  }

  private weirNappe(): SheetSpec | null {
    const l = LANDMARKS.find((x) => x.id === 'weir');
    const s = l ? l.s : 8;
    const f = riverFrame(s);
    const width = f.width - 1.5;
    // lower the pool downstream of the crest if the bed there is deep enough to hold it
    let bed = 0;
    for (let d = 6; d <= 30; d += 6) bed += this.h(f.x - f.tx * d, f.z - f.tz * d);
    bed /= 5;
    const drop = bed < -2.2 ? 1.2 : 0;
    this.weir = { x: f.x, z: f.z, tx: f.tx, tz: f.tz, halfWidth: width / 2 + 4, drop };
    const out = new Vector3(-f.tx, 0, -f.tz);
    const cols = 30, rows = 10;
    const columns: Column[] = [];
    for (let c = 0; c < cols; c++) {
      const u = (c / (cols - 1) - 0.5) * width;
      const lx = f.x + f.nx * u, lz = f.z + f.nz * u;
      const pts: Vector3[] = [], fall: number[] = [];
      const H = 0.03, bottom = -(drop + 0.35);
      for (let r = 0; r <= rows; r++) {
        const t = r / rows;
        const dy = (H - bottom) * t;
        const tau = Math.sqrt((2 * dy) / G);
        const o = 0.55 * tau + 0.04;
        pts.push(new Vector3(lx + out.x * o, H - dy, lz + out.z * o));
        fall.push(dy);
      }
      columns.push({ pts, fall });
    }
    const a = columns[0].pts[rows], b = columns[cols - 1].pts[rows];
    this.sources.push({ a: [a.x + out.x * 1.2, a.z + out.z * 1.2], b: [b.x + out.x * 1.2, b.z + out.z * 1.2], radius: 2.2, foam: drop > 0 ? 0.75 : 0.35, churn: drop > 0 ? 0.6 : 0.3 });
    if (drop > 0) this.emitters.push({ a: a.clone(), b: b.clone(), out, height: drop, mist: 0.12, spray: 0.25 });
    return { cols: columns, width, opacity: 0.62 };
  }

  private sheetMesh(spec: SheetSpec, foamTex: Texture) {
    const cols = spec.cols.length, rows = spec.cols[0].pts.length;
    const pos = new Float32Array(cols * rows * 3);
    const info = new Float32Array(cols * rows * 3);
    const idx: number[] = [];
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const i = c * rows + r;
        const p = spec.cols[c].pts[r];
        pos.set([p.x, p.y, p.z], i * 3);
        info.set([spec.cols[c].fall[r], (c / (cols - 1)) * spec.width, c / (cols - 1)], i * 3);
        if (c < cols - 1 && r < rows - 1) {
          const a = i, b = i + 1, d = i + rows, e = i + rows + 1;
          idx.push(a, d, b, b, d, e);
        }
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aFall', new BufferAttribute(info, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new MeshStandardNodeMaterial({ roughness: 0.32, metalness: 0 });
    m.transparent = true;
    m.depthWrite = false;
    m.side = DoubleSide;
    const inf: N = attribute('aFall', 'vec3');
    const dy = inf.x, across = inf.y, u01 = inf.z;
    // parcels move with the water: the pattern is indexed by emission time (t - time of flight)
    const tof = sqrt(dy.mul(2 / G));
    const emit = uTime.sub(tof);
    const lace = texture(foamTex, vec2(across.div(1.3), emit.mul(0.9))).r;
    const fine = texture(foamTex, vec2(across.div(0.45).add(0.3), emit.mul(2.1))).r;
    const strands = texture(foamTex, vec2(across.div(4.5), 0.13)).b;
    const white = smoothstep(0.15, 3.5, dy);
    const edge = smoothstep(0, 0.12, u01).mul(smoothstep(1, 0.88, u01));
    const body = smoothstep(0.18, 0.62, strands.mul(0.7).add(lace.mul(0.3)));
    m.colorNode = mix(vec3(0.2, 0.33, 0.3), vec3(0.8, 0.83, 0.84), white.mul(fine.mul(0.35).add(0.65)));
    m.opacityNode = body.mul(mix(float(0.55), float(1), lace)).mul(edge).mul(mix(0.5, 1, white)).mul(spec.opacity);
    const mesh = new Mesh(g, m);
    mesh.name = 'water.fallSheet';
    mesh.renderOrder = 4;
    return mesh;
  }

  update(ctx: GameContext) {
    const dt = ctx.paused ? 0 : Math.min(ctx.time.frameDt, 0.05);
    const wind = uWindDir.value as any;
    const cam = ctx.camera.position;
    // emit only near the camera; far falls keep their standing mist
    for (const e of this.emitters) {
      const mx = (e.a.x + e.b.x) / 2, mz = (e.a.z + e.b.z) / 2;
      const d = Math.hypot(cam.x - mx, cam.z - mz);
      if (d > 700) continue;
      const len = e.a.distanceTo(e.b);
      this.acc[0] += dt * e.mist * 9 * this.budget * Math.max(0.5, len / 12);
      this.acc[1] += dt * e.spray * 60 * this.budget * Math.max(0.4, len / 12) * (d < 250 ? 1 : 0.2);
      while (this.acc[0] >= 1) {
        this.acc[0] -= 1;
        const t = Math.random();
        this.tmp.lerpVectors(e.a, e.b, t);
        const s = 2 + Math.random() * 3 * Math.min(1, e.height / 10);
        this.mist.emit(this.tmp.x + e.out.x * (1 + Math.random() * 4), 0.4 + Math.random() * 1.5, this.tmp.z + e.out.z * (1 + Math.random() * 4),
          e.out.x * (0.6 + Math.random()), 0.35 + Math.random() * 0.6, e.out.z * (0.6 + Math.random()), s, 5 + Math.random() * 4, 0.35);
      }
      while (this.acc[1] >= 1) {
        this.acc[1] -= 1;
        const t = Math.random();
        this.tmp.lerpVectors(e.a, e.b, t);
        const v = Math.sqrt(2 * G * Math.min(e.height, 30)) * (0.12 + Math.random() * 0.18);
        const a = (Math.random() - 0.5) * 2.2;
        const ox = e.out.x * Math.cos(a) - e.out.z * Math.sin(a), oz = e.out.x * Math.sin(a) + e.out.z * Math.cos(a);
        this.drops.emit(this.tmp.x, 0.1, this.tmp.z, ox * v * 0.8, v * (0.6 + Math.random() * 0.6), oz * v * 0.8, 0.05 + Math.random() * 0.12, 0.8 + Math.random() * 0.9, 0.2);
      }
    }
    this.acc[0] = Math.min(this.acc[0], 4);
    this.acc[1] = Math.min(this.acc[1], 20);
    const wx = wind.x * 0.6, wz = wind.y * 0.6;
    this.mist.step(dt, 0, 0.6, 0.05, wx, wz);
    this.drops.step(dt, G, 0.9, 0, wx, wz);
    const s = ctx.sun;
    const k = s.intensity * 0.16;
    (this.mist.uColor.value as Vector3).set(s.color.r * k + 0.62, s.color.g * k + 0.68, s.color.b * k + 0.74);
    (this.drops.uColor.value as Vector3).set(s.color.r * k + 0.55, s.color.g * k + 0.6, s.color.b * k + 0.64);
  }

  /** capsule sources packed for the water shader */
  packSources(a: Vector4[], b: Vector4[]) {
    for (let i = 0; i < a.length; i++) {
      const s = this.sources[i];
      if (s) {
        a[i].set(s.a[0], s.a[1], s.b[0], s.b[1]);
        b[i].set(s.radius, s.foam, s.churn, 0);
      } else {
        a[i].set(1e5, 1e5, 1e5, 1e5);
        b[i].set(0.001, 0, 0, 0);
      }
    }
  }
}
