// moored boats: lofted round-bilge hulls with raked stems and transoms, painted in the hull's own
// frame (antifouling, boot-top, topsides), gunwales, thwarts or a deck and wheelhouse. each rides
// the shared gerstner field (sampled at bow, stern and both sides) and owns a kinematic collider.
import { Group, Matrix4, Mesh, Quaternion, Euler, Vector3 } from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GameContext } from '../core/context';
import { LAYERS } from '../core/layers';
import { GROUPS, groups } from '../core/physics';
import { sampleWater, type WaveSample } from '../world/waves';
import { Bucket, chamferBox, cylinder, trs, type Part, type RGB } from './geom';
import { BOARDS, type Materials } from './materials';
import type { MatKey } from './builder';

export interface HullSpec {
  L: number;
  B: number;
  draft: number;
  sheer: [number, number, number];
  transom: number;
  /** tint of the planking and of the inside */
  topside: RGB;
  inside: RGB;
  /** a rolled straw mat and a punting pole aboard */
  gear?: boolean;
}

function hullFns(h: HullSpec) {
  const hb = (s: number) => {
    // s: 0 at the stem, 1 at the transom
    if (s < 0.5) return (h.B / 2) * Math.sin((s / 0.5) * (Math.PI / 2)) ** 0.75;
    const t = (s - 0.5) / 0.5;
    return (h.B / 2) * (1 + (h.transom - 1) * t * t);
  };
  const keel = (s: number) => {
    if (s < 0.28) return -h.draft * (0.1 + 0.9 * Math.sin((s / 0.28) * (Math.PI / 2)) ** 1.2);
    return -h.draft * (1 - 0.25 * Math.max(0, s - 0.8) / 0.2);
  };
  const sheer = (s: number) => {
    const [b, m, st] = h.sheer;
    if (s < 0.55) {
      const t = s / 0.55;
      return b + (m - b) * (1 - (1 - t) * (1 - t));
    }
    const t = (s - 0.55) / 0.45;
    return m + (st - m) * t * t;
  };
  const z = (s: number) => -h.L / 2 + h.L * s;
  // stem rakes forward above the waterline
  const zAt = (s: number, y: number) => z(s) - (s < 0.08 ? (1 - s / 0.08) * Math.max(0, y) * 0.35 : 0);
  const point = (s: number, t: number, side: number): [number, number, number] => {
    const k = keel(s), sh = sheer(s);
    const a = t * (Math.PI / 2);
    const x = hb(s) * Math.sin(a) ** 0.85;
    const y = k + (sh - k) * (1 - Math.cos(a)) ** 0.8;
    return [x * side, y, zAt(s, y)];
  };
  return { hb, keel, sheer, z, point };
}

const NS = 30, NT = 10;
function stationS(i: number) {
  const u = i / NS;
  return u ** 1.25;
}

/** outer skin (and optional inner skin) as a triangle soup with meter uvs */
function hullSkin(h: HullSpec, inner: boolean): { outer: Part; inner: Part | null } {
  const F = hullFns(h);
  const outer: Part = { pos: [], nor: [], uv: [] };
  const inn: Part | null = inner ? { pos: [], nor: [], uv: [] } : null;
  const grid: number[][][][] = [];
  for (const side of [-1, 1]) {
    const g: number[][][] = [];
    for (let i = 0; i <= NS; i++) {
      const row: number[][] = [];
      for (let j = 0; j <= NT; j++) row.push(F.point(stationS(i), j / NT, side));
      g.push(row);
    }
    grid.push(g);
  }
  const normalAt = (g: number[][][], i: number, j: number, side: number) => {
    const i0 = Math.max(0, i - 1), i1 = Math.min(NS, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(NT, j + 1);
    const a = g[i1][j], b = g[i0][j], c = g[i][j1], d = g[i][j0];
    const tz = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const tt = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
    let n = [tz[1] * tt[2] - tz[2] * tt[1], tz[2] * tt[0] - tz[0] * tt[2], tz[0] * tt[1] - tz[1] * tt[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map((v) => v / l);
    // make it point outward (away from the centerline / down at the keel)
    const p = g[i][j];
    const out = [p[0], p[1] - (F.sheer(stationS(i)) + F.keel(stationS(i))) / 2, 0];
    if (n[0] * out[0] + n[1] * out[1] < 0) n = n.map((v) => -v);
    if (Math.abs(p[0]) < 1e-4) n[0] = 0;
    void side;
    return n;
  };
  grid.forEach((g, gi) => {
    const side = gi === 0 ? -1 : 1;
    // girth arc length for uvs
    for (let i = 0; i < NS; i++) {
      for (let j = 0; j < NT; j++) {
        const quad = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
        const order = side > 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
        for (const k of order) {
          const [ii, jj] = quad[k];
          const p = g[ii][jj];
          const n = normalAt(g, ii, jj, side);
          outer.pos.push(p[0], p[1], p[2]);
          outer.nor.push(n[0], n[1], n[2]);
          outer.uv.push(p[1] + Math.abs(p[0]), p[2]);
          if (inn) {
            const th = 0.03;
            inn.pos.push(p[0] - n[0] * th, p[1] - n[1] * th, p[2] - n[2] * th);
            inn.nor.push(-n[0], -n[1], -n[2]);
            inn.uv.push(p[1] + Math.abs(p[0]), p[2]);
          }
        }
      }
    }
  });
  if (inn) {
    // flip inner winding
    for (let i = 0; i < inn.pos.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const a = i + 3 + k, b = i + 6 + k;
        [inn.pos[a], inn.pos[b]] = [inn.pos[b], inn.pos[a]];
        [inn.nor[a], inn.nor[b]] = [inn.nor[b], inn.nor[a]];
      }
      const ua = (i / 3 + 1) * 2, ub = (i / 3 + 2) * 2;
      [inn.uv[ua], inn.uv[ub]] = [inn.uv[ub], inn.uv[ua]];
      [inn.uv[ua + 1], inn.uv[ub + 1]] = [inn.uv[ub + 1], inn.uv[ua + 1]];
    }
  }
  // transom: fan across the last station
  const g0 = grid[0][NS], g1 = grid[1][NS];
  const tr: number[][] = [...g0.slice().reverse(), ...g1.slice(1)];
  const c = [0, (F.keel(1) + F.sheer(1)) / 2, tr[0][2]];
  for (let k = 0; k < tr.length - 1; k++) {
    for (const p of [c, tr[k], tr[k + 1]]) {
      outer.pos.push(p[0], p[1], p[2]);
      outer.nor.push(0, 0, 1);
      outer.uv.push(p[0], p[1]);
    }
  }
  return { outer, inner: inn };
}

export interface BoatBuild {
  group: Group;
  spec: HullSpec;
  /** local points for mooring lines */
  bow: Vector3;
  stern: Vector3;
}

export function buildBoat(mats: Materials, h: HullSpec, seed: number): BoatBuild {
  const F = hullFns(h);
  let r = seed >>> 0;
  const rand = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  const buckets = new Map<MatKey, Bucket>();
  const B = (k: MatKey) => {
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = new Bucket()));
    return b;
  };
  const I = new Matrix4();
  const skin = hullSkin(h, true);
  B('hull').add(skin.outer, I, { col: h.topside });
  if (skin.inner) B('hull').add(skin.inner, I, { col: h.inside });

  // gunwale rail following the sheer
  const rail: RGB = [0.8, 0.75, 0.7];
  for (const side of [-1, 1]) {
    for (let i = 0; i < NS; i++) {
      const s0 = stationS(i), s1 = stationS(i + 1);
      const a = F.point(s0, 1, side), b = F.point(s1, 1, side);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const yaw = Math.atan2(b[0] - a[0], b[2] - a[2]);
      const pitch = -Math.asin((b[1] - a[1]) / (len || 1));
      const m = trs((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.02, (a[2] + b[2]) / 2, yaw, pitch);
      B('timber').add(chamferBox(0.06, 0.06, len + 0.01, 0.01, 'z'), m, { col: rail, uvo: [BOARDS.timber[1], 0] });
    }
  }
  // transom cap and a tall stem post at the bow
  {
    const a = F.point(1, 1, -1), b = F.point(1, 1, 1);
    B('timber').add(chamferBox(Math.abs(b[0] - a[0]) + 0.06, 0.06, 0.08, 0.012, 'x'), trs(0, a[1] + 0.02, a[2] - 0.02), { col: rail });
    const st = F.point(0, 1, 1);
    B('timber').add(chamferBox(0.08, 0.5, 0.1, 0.01), trs(0, st[1] + 0.1, st[2] + 0.02, 0, -0.35), { col: rail });
  }
  const bow = new Vector3(0, F.sheer(0.03) + 0.05, F.z(0.05));
  const stern = new Vector3(0, F.sheer(0.98) + 0.05, F.z(0.97));
  // thwarts and floorboards
  for (const s of [0.3, 0.55, 0.82]) {
    const y = F.sheer(s) - 0.16;
    const hw = F.hb(s) * 0.9;
    B('deck').add(chamferBox(hw * 2 - 0.06, 0.035, 0.2, 0.008, 'x'), trs(0, y, F.z(s)), { col: [1.1, 1.0, 0.9], uvo: [BOARDS.grey[2], rand()] });
  }
  for (let i = -2; i <= 2; i++) {
    B('deck').add(chamferBox(0.1, 0.02, h.L * 0.6, 0.005, 'z'), trs(i * 0.11, F.keel(0.6) + 0.08, F.z(0.58)), { col: [0.9, 0.85, 0.78], uvo: [BOARDS.grey[i + 2], 0] });
  }
  if (h.gear) {
    // a rolled straw mat and a bamboo punting pole
    B('bamboo').add(cylinder(0.14, 0.14, 0.9, 10), trs(-0.1, F.keel(0.45) + 0.28, F.z(0.45), 0, 0, Math.PI / 2 + 0.1).multiply(trs(0, -0.45, 0)), { col: [1.2, 1.1, 0.85] });
    B('bamboo').add(cylinder(0.025, 0.02, h.L * 0.9, 6), trs(0.25, F.sheer(0.5) - 0.05, F.z(0.05), 0, Math.PI / 2 - 0.02), { col: [1.1, 1.0, 0.7] });
  }

  const group = new Group();
  for (const [k, b] of buckets) {
    const geo = b.build();
    if (!geo) continue;
    const mesh = new Mesh(geo, (mats as any)[k]);
    // the hull carries the silhouette in the mirror and the shadow; rails, boards and gear are too
    // thin to read there and would cost a draw each in both passes
    const hull = k === 'hull';
    mesh.castShadow = hull;
    mesh.receiveShadow = true;
    if (!hull) mesh.layers.set(LAYERS.NO_REFLECT);
    group.add(mesh);
  }
  return { group, spec: h, bow, stern };
}

// ---------------------------------------------------------------------------------------------

const _ws: WaveSample = { height: 0, nx: 0, ny: 1, nz: 0, vx: 0, vy: 0, vz: 0 };
const _e = new Euler(0, 0, 0, 'YXZ');
const _q = new Quaternion();
const _v = new Vector3();

export class MooredBoat {
  body: RAPIER.RigidBody;
  heave = 0;
  pitch = 0;
  roll = 0;
  yawOff = 0;
  phase: number;
  constructor(public ctx: GameContext, public build: BoatBuild, public x: number, public z: number, public yaw: number) {
    const R = ctx.physics.RAPIER;
    const h = build.spec;
    this.body = ctx.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, 0, z));
    const cd = R.ColliderDesc.roundCuboid(h.B * 0.42, 0.3, h.L * 0.44, 0.12).setTranslation(0, 0.1, 0);
    cd.setCollisionGroups(groups(GROUPS.PROPS, 0xffff)).setFriction(0.3).setRestitution(0.1);
    ctx.physics.world.createCollider(cd, this.body);
    this.phase = (x * 0.37 + z * 0.11) % 6.28;
    build.group.name = 'structures:boat';
    build.group.position.set(x, 0, z);
    build.group.rotation.set(0, yaw, 0, 'YXZ');
    ctx.scene.add(build.group);
  }

  /** instantaneous target pose from the wave field at time t */
  private target(t: number, out: { y: number; pitch: number; roll: number; yaw: number }) {
    const h = this.build.spec;
    const yaw = this.yaw + Math.sin(t * 0.13 + this.phase) * 0.03;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const hl = h.L * 0.38, hb = h.B * 0.4;
    const hB = sampleWater(this.x + fx * hl, this.z + fz * hl, t, _ws).height;
    const hS = sampleWater(this.x - fx * hl, this.z - fz * hl, t, _ws).height;
    const hP = sampleWater(this.x - rx * hb, this.z - rz * hb, t, _ws).height;
    const hR = sampleWater(this.x + rx * hb, this.z + rz * hb, t, _ws).height;
    out.y = (hB + hS + hP + hR) / 4;
    // hulls damp short waves: scale the tilts down a touch
    out.pitch = Math.atan2(hB - hS, hl * 2) * 0.8;
    out.roll = Math.atan2(hR - hP, hb * 2) * 0.7 + Math.sin(t * 0.9 + this.phase) * 0.012;
    out.yaw = yaw;
    return out;
  }

  private tgt = { y: 0, pitch: 0, roll: 0, yaw: 0 };
  private initd = false;

  update(t: number, dt: number) {
    const g = this.target(t, this.tgt);
    if (!this.initd) {
      this.heave = g.y; this.pitch = g.pitch; this.roll = g.roll; this.initd = true;
    }
    // first-order lag stands in for hull inertia
    const k = 1 - Math.exp(-dt / 0.35);
    this.heave += (g.y - this.heave) * k;
    this.pitch += (g.pitch - this.pitch) * k;
    this.roll += (g.roll - this.roll) * k;
    this.yawOff = g.yaw;
    const grp = this.build.group;
    grp.position.set(this.x, this.heave, this.z);
    grp.rotation.set(this.pitch, this.yawOff, this.roll, 'YXZ');
  }

  fixed(t: number) {
    const g = this.target(t, this.tgt);
    this.body.setNextKinematicTranslation({ x: this.x, y: g.y, z: this.z });
    _q.setFromEuler(_e.set(g.pitch, g.yaw, g.roll, 'YXZ'));
    this.body.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
  }

  /** world position of a local point on the hull (for mooring lines) */
  worldPoint(local: Vector3, out = _v) {
    return out.copy(local).applyMatrix4(this.build.group.matrixWorld);
  }
}
