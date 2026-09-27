// toro nagashi: small floating paper lanterns marking the lantern run on the lake. a dark timber
// base and frame, washi paper walls lit from a candle near the bottom, each bobbing and slowly
// turning on the shared water surface. two instanced meshes for the whole run.
import { BoxGeometry, BufferGeometry, Color, DoubleSide, InstancedMesh, Matrix4, MeshStandardNodeMaterial, Quaternion, Vector3 } from 'three/webgpu';
import { color, float, hash, instanceIndex, mix, positionLocal, sin, smoothstep } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameContext } from '../core/context';
import { uRealTime } from '../core/uniforms';
import { sampleWater, type WaveSample } from '../world/waves';
import type { GatePoint } from './types';

const W = 0.34; // base width
const P = 0.28; // paper wall width
const H = 0.3; // paper height

function frameGeometry() {
  const parts: BufferGeometry[] = [];
  const add = (g: BufferGeometry, x: number, y: number, z: number) => parts.push(g.translate(x, y, z));
  add(new BoxGeometry(W, 0.04, W), 0, 0.0, 0);
  const post = P / 2 + 0.006;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(new BoxGeometry(0.018, H + 0.02, 0.018), sx * post, 0.02 + H / 2, sz * post);
  // top rim
  add(new BoxGeometry(P + 0.03, 0.016, 0.016), 0, 0.03 + H, post);
  add(new BoxGeometry(P + 0.03, 0.016, 0.016), 0, 0.03 + H, -post);
  add(new BoxGeometry(0.016, 0.016, P + 0.03), post, 0.03 + H, 0);
  add(new BoxGeometry(0.016, 0.016, P + 0.03), -post, 0.03 + H, 0);
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  parts.forEach((p) => p.dispose());
  return g;
}

function paperGeometry() {
  // open-topped paper box; the candle sits inside
  const g = new BoxGeometry(P, H, P).translate(0, 0.02 + H / 2, 0);
  const pos = g.getAttribute('position');
  const keep: number[] = [];
  const idx = g.index!;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
    const top = pos.getY(a) > 0.3 && pos.getY(b) > 0.3 && pos.getY(c) > 0.3;
    if (!top) keep.push(a, b, c);
  }
  g.setIndex(keep);
  return g;
}

interface Lantern {
  x: number;
  z: number;
  yaw: number;
  spin: number;
  phase: number;
  q: Quaternion;
}

const Y = new Vector3(0, 1, 0);
const _m = new Matrix4(), _p = new Vector3(), _s = new Vector3(1, 1, 1), _up = new Vector3(), _qt = new Quaternion(), _qy = new Quaternion();
const _w: WaveSample = { height: 0, nx: 0, ny: 1, nz: 0, vx: 0, vy: 0, vz: 0 };

export class LanternRun {
  private frame?: InstancedMesh;
  private paper?: InstancedMesh;
  private lanterns: Lantern[] = [];

  constructor(private ctx: GameContext) {}

  /** two lanterns at each side of every gate */
  build(gates: GatePoint[]) {
    const pts: Lantern[] = [];
    gates.forEach((g, gi) => {
      const rx = -g.dz, rz = g.dx;
      for (const side of [-1, 1]) {
        for (const k of [0, 1]) {
          const along = (k ? 0.55 : -0.35) * (side > 0 ? 1 : -1);
          const out = g.half + (k ? 0.7 : 0);
          const x = g.x + rx * side * out + g.dx * along, z = g.z + rz * side * out + g.dz * along;
          const seed = gi * 7.31 + side * 3.17 + k * 1.93;
          pts.push({ x, z, yaw: seed % 6.283, spin: 0.04 + (Math.abs(Math.sin(seed)) * 0.06), phase: seed, q: new Quaternion() });
        }
      }
    });
    this.lanterns = pts;
    const n = pts.length;
    if (!n) return;

    const wood = new MeshStandardNodeMaterial({ color: new Color('#3b2a1e'), roughness: 0.78, metalness: 0 });
    // washi lit from inside: brightest just above the candle, fading toward the rim, with a soft
    // per-lantern flicker. emissive stays modest so it reads as paper in daylight, not neon.
    const paper = new MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0, side: DoubleSide });
    const id = float(instanceIndex);
    const flicker = float(0.86).add(sin(uRealTime.mul(7.3).add(hash(id).mul(40))).mul(0.06)).add(sin(uRealTime.mul(13.1).add(id)).mul(0.04));
    const glow = smoothstep(float(0.34), float(0.04), positionLocal.y);
    paper.colorNode = mix(color('#efe3c8'), color('#f6d6a0'), glow.mul(0.6));
    paper.emissiveNode = color('#ff9d4d').mul(glow.mul(1.6).add(0.25)).mul(flicker).mul(1.3);

    this.frame = new InstancedMesh(frameGeometry(), wood, n);
    this.paper = new InstancedMesh(paperGeometry(), paper, n);
    for (const m of [this.frame, this.paper]) {
      m.name = 'lantern-run';
      m.castShadow = false;
      m.receiveShadow = true;
      this.ctx.scene.add(m);
    }
    this.place(0, 1);
    for (const m of [this.frame, this.paper]) {
      m.computeBoundingSphere();
      if (m.boundingSphere) m.boundingSphere.radius += 3;
    }
  }

  private place(t: number, k: number) {
    if (!this.frame || !this.paper) return;
    this.lanterns.forEach((l, i) => {
      sampleWater(l.x, l.z, t, _w);
      _up.set(_w.nx, _w.ny, _w.nz).lerp(Y, 0.3).normalize();
      _qt.setFromUnitVectors(Y, _up);
      l.q.slerp(_qt, k);
      _qy.setFromAxisAngle(Y, l.yaw + t * l.spin + Math.sin(t * 0.4 + l.phase) * 0.2);
      _p.set(l.x + Math.sin(t * 0.23 + l.phase) * 0.12, _w.height - 0.012 + Math.sin(t * 1.7 + l.phase) * 0.008, l.z + Math.cos(t * 0.19 + l.phase) * 0.12);
      _m.compose(_p, _qt.copy(l.q).multiply(_qy), _s);
      this.frame!.setMatrixAt(i, _m);
      this.paper!.setMatrixAt(i, _m);
    });
    this.frame.instanceMatrix.needsUpdate = true;
    this.paper.instanceMatrix.needsUpdate = true;
  }

  update(t: number, dt: number) {
    this.place(t, 1 - Math.exp(-dt * 3));
  }
}
