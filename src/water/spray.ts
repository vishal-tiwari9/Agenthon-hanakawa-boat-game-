// speed-dependent spray: droplets and sheets thrown off the stem and bow shoulders, side spray on the
// outside of turns, churn at the transom, bursts when the throttle kicks and on 'boat:splash'.
// cpu simulated (a budgeted few hundred), drawn as instanced soft sprites on NO_REFLECT.
import { InstancedBufferAttribute, NormalBlending, Sprite, SpriteNodeMaterial, Vector3 } from 'three/webgpu';
import { float, instancedBufferAttribute, smoothstep, uniform, uv, vec3, vec4 } from 'three/tsl';
import type { GameContext } from '../core/context';
import { LAYERS } from '../core/layers';
import { ANCHORS, HULL } from '../boat/hullSpec';
import { waterHeight } from '../world/waves';

const CAP = 720;

export class Spray {
  sprite: Sprite;
  private pos = new Float32Array(CAP * 4);
  private vel = new Float32Array(CAP * 3);
  private life = new Float32Array(CAP * 2);
  private alpha = new Float32Array(CAP);
  private fade = new Float32Array(CAP * 4);
  private posAttr = new InstancedBufferAttribute(this.pos, 4);
  private fadeAttr = new InstancedBufferAttribute(this.fade, 4);
  private count = 0;
  private acc = 0;
  private tmp = new Vector3();
  private side = new Vector3();
  private fwd = new Vector3();
  private prevThr = 0;
  budget = 1;
  uLight = uniform(new Vector3(1, 1, 1));

  constructor(ctx: GameContext) {
    const m = new SpriteNodeMaterial();
    m.transparent = true;
    m.depthWrite = false;
    m.blending = NormalBlending;
    const p: any = instancedBufferAttribute(this.posAttr);
    const f: any = instancedBufferAttribute(this.fadeAttr);
    m.positionNode = p.xyz;
    m.scaleNode = p.w;
    const d = uv().sub(0.5).length().mul(2);
    const soft = float(1).sub(smoothstep(0.35, 1, d));
    m.colorNode = vec4(vec3(0.86, 0.9, 0.92).mul(this.uLight), 1);
    m.opacityNode = soft.mul(f.x);
    this.sprite = new Sprite(m);
    this.sprite.count = 0;
    this.sprite.frustumCulled = false;
    this.sprite.layers.set(LAYERS.NO_REFLECT);
    this.sprite.renderOrder = 5;
    ctx.scene.add(this.sprite);
    ctx.events.on('boat:splash', (e: { strength: number; x: number; y: number; z: number }) => this.burst(e.x, e.y, e.z, e.strength));
  }

  private emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, alpha = 1) {
    if (this.count >= CAP) return;
    const i = this.count++;
    this.pos.set([x, y, z, size], i * 4);
    this.vel.set([vx, vy, vz], i * 3);
    this.life[i * 2] = 0;
    this.life[i * 2 + 1] = life;
    this.alpha[i] = alpha;
  }

  burst(x: number, y: number, z: number, strength: number) {
    const n = Math.min(80, Math.round(strength * 10 * this.budget));
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, r = 0.6 + Math.random() * 1.6;
      this.emit(x, y + 0.1, z, Math.cos(a) * r, 1.2 + Math.random() * strength * 0.5, Math.sin(a) * r, 0.05 + Math.random() * 0.1, 0.6 + Math.random() * 0.6);
    }
  }

  update(ctx: GameContext) {
    const dt = Math.min(ctx.time.frameDt, 0.05);
    const b = ctx.boat;
    if (b && !ctx.paused && this.budget > 0) {
      const v = Math.max(0, b.speed);
      const thr = Math.abs(b.throttle);
      const kick = dt > 0 ? Math.max(0, (thr - this.prevThr) / dt) : 0;
      this.prevThr = thr;
      const yaw = Math.abs(b.angularVelocity.y);
      // steady bow spray from walking pace up, side spray when carving a turn, a burst when the throttle kicks
      const rate = (Math.max(0, v - 1.4) ** 1.4 * 8 + yaw * v * 34 + Math.min(kick, 3) * 70) * this.budget;
      this.acc = Math.min(this.acc + rate * dt, 60);
      this.fwd.set(0, 0, -1).applyQuaternion(b.quaternion);
      this.side.set(1, 0, 0).applyQuaternion(b.quaternion);
      const turnW = Math.min(0.6, (yaw * v) / 4);
      // the hull skids toward the outside of the turn, so that side throws the water
      const outer = b.rudder > 0 ? -1 : 1;
      const kickW = Math.min(0.5, kick * 0.25);
      while (this.acc >= 1) {
        this.acc -= 1;
        const u = Math.random();
        const sgn = Math.random() < 0.5 ? -1 : 1;
        if (u < kickW) {
          // throttle kick: churned water heaved up off the prop
          this.tmp.copy(ANCHORS.propeller).setY(0.02).setX((Math.random() - 0.5) * 0.9).applyQuaternion(b.quaternion).add(b.position);
          this.emit(this.tmp.x, this.tmp.y, this.tmp.z,
            b.velocity.x * 0.3 + (Math.random() - 0.5) * 1.8, 0.9 + Math.random() * 1.8, b.velocity.z * 0.3 + (Math.random() - 0.5) * 1.8,
            0.05 + Math.random() * 0.12, 0.45 + Math.random() * 0.45);
        } else if (u < kickW + turnW) {
          // turn: a sheet off the outer side along the forward half of the hull
          const s = 0.8 + Math.random() * 3.2;
          this.tmp.set(outer * (HULL.beam * 0.48), 0.04, HULL.bowZ + s).applyQuaternion(b.quaternion).add(b.position);
          const out = 1.2 + Math.random() * 1.6 + v * 0.18;
          this.emit(this.tmp.x, this.tmp.y, this.tmp.z,
            this.side.x * outer * out + b.velocity.x * 0.7, 0.8 + Math.random() * (0.6 + v * 0.2), this.side.z * outer * out + b.velocity.z * 0.7,
            0.04 + Math.random() * 0.1, 0.5 + Math.random() * 0.5);
        } else if (u < 0.9) {
          // bow: droplets thrown off the stem and shoulders, outward and up, the odd mist puff
          const s = 0.3 + Math.random() * 1.4;
          this.tmp.set(sgn * (HULL.beam * 0.2 + Math.random() * HULL.beam * 0.22), 0.05, HULL.bowZ + s).applyQuaternion(b.quaternion).add(b.position);
          const out = 0.8 + Math.random() * 1.8 + v * 0.14;
          const up = 0.8 + Math.random() * (0.6 + v * 0.22);
          const keep = 0.72 + Math.random() * 0.14;
          const puff = Math.random() < 0.12;
          this.emit(this.tmp.x, this.tmp.y, this.tmp.z,
            this.side.x * sgn * out + b.velocity.x * keep, up, this.side.z * sgn * out + b.velocity.z * keep,
            puff ? 0.22 + Math.random() * 0.25 : 0.035 + Math.random() * 0.08, puff ? 0.4 + Math.random() * 0.3 : 0.45 + Math.random() * 0.55, puff ? 0.35 : 1);
        } else {
          // churned droplets at the transom
          this.tmp.copy(ANCHORS.propeller).setY(0.02).setX((Math.random() - 0.5) * 0.9).applyQuaternion(b.quaternion).add(b.position);
          this.emit(this.tmp.x, this.tmp.y, this.tmp.z,
            b.velocity.x * 0.35 + (Math.random() - 0.5) * 1.2, 0.4 + Math.random() * 1.1, b.velocity.z * 0.35 + (Math.random() - 0.5) * 1.2,
            0.05 + Math.random() * 0.08, 0.35 + Math.random() * 0.35);
        }
      }
    }
    const t = ctx.time.render;
    let w = 0;
    for (let i = 0; i < this.count; i++) {
      let age = this.life[i * 2] + dt;
      const life = this.life[i * 2 + 1];
      let x = this.pos[i * 4], y = this.pos[i * 4 + 1], z = this.pos[i * 4 + 2], size = this.pos[i * 4 + 3];
      let vx = this.vel[i * 3], vy = this.vel[i * 3 + 1], vz = this.vel[i * 3 + 2];
      vy -= 9.81 * dt;
      const drag = Math.exp(-1.6 * dt);
      vx *= drag;
      vz *= drag;
      x += vx * dt;
      y += vy * dt;
      z += vz * dt;
      size *= 1 + dt * 0.6;
      if (age > life || (vy < 0 && y < waterHeight(x, z, t) - 0.02)) continue;
      this.pos[w * 4] = x;
      this.pos[w * 4 + 1] = y;
      this.pos[w * 4 + 2] = z;
      this.pos[w * 4 + 3] = size;
      this.vel[w * 3] = vx;
      this.vel[w * 3 + 1] = vy;
      this.vel[w * 3 + 2] = vz;
      this.life[w * 2] = age;
      this.life[w * 2 + 1] = life;
      this.alpha[w] = this.alpha[i];
      const k = age / life;
      this.fade[w * 4] = Math.min(1, k * 8) * (1 - k) * 0.85 * this.alpha[i];
      w++;
    }
    this.count = w;
    this.sprite.count = w;
    this.posAttr.needsUpdate = true;
    this.fadeAttr.needsUpdate = true;
    const s = ctx.sun;
    (this.uLight.value as Vector3).set(s.color.r * s.intensity * 0.28 + 0.35, s.color.g * s.intensity * 0.28 + 0.4, s.color.b * s.intensity * 0.28 + 0.45);
  }
}
