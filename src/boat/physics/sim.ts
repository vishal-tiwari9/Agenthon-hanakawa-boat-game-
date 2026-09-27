// the launch's rigid body and every continuous force on it. environment access (waves, terrain)
// is injected so the same code runs in the game and in node unit tests against real rapier.
//
// per fixed step: preStep() resets and recomputes user forces (buoyancy cells, water-relative drag,
// thrust, rudder, trim/bank, docking, boundary, terrain penalty), world.step() integrates, then
// postStep() reads the result for impacts, the wake trail and render interpolation.
import { Quaternion, Vector3 } from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import { ANCHORS, HULL } from '../hullSpec';
import type { WaveSample } from '../../world/waves';
import { buildHydro, cellAt, type Hydro } from './hydro';
import { TUNING } from './tuning';
import { WakeTrail } from './wake';

type Rapier = typeof RAPIER;
type Vec = { x: number; y: number; z: number };

export interface BoatEnv {
  water(x: number, z: number, t: number, out: WaveSample): WaveSample;
  /** terrain height; omit for open ocean */
  ground?: (x: number, z: number) => number;
  groundNormal?: (x: number, z: number, out: Vec) => Vec;
  /** signed distance to the coastline, + inland */
  shore?: (x: number, z: number) => number;
  /** true once a rapier terrain collider exists; the penalty contact then only guards tunneling */
  terrainCollider?: () => boolean;
  /** surface current (m/s) at (x, z); added to the wave particle velocity for drag and rudder */
  flow?: (x: number, z: number, out: { x: number; z: number }) => void;
  /** soft limit: unit direction back into the playable water and how far past the limit (m), or null */
  boundary?: (x: number, z: number) => { dx: number; dz: number; depth: number } | null;
}

export interface BoatHit {
  strength: number;
  x: number;
  y: number;
  z: number;
}

export interface BoatSimOptions {
  x: number;
  z: number;
  headingDeg: number;
  collisionGroups?: number;
  onImpact?: (e: BoatHit) => void;
  onSplash?: (e: BoatHit) => void;
}

const _p = new Vector3(), _a = new Vector3(), _r = new Vector3(), _v = new Vector3(), _f = new Vector3();
const _com = new Vector3(), _up = new Vector3(), _fwd = new Vector3(), _right = new Vector3();
const _lin = new Vector3(), _ang = new Vector3(), _wl = new Vector3(), _ll = new Vector3();
const _tab = [0, 0, 0];
const _n = { x: 0, y: 1, z: 0 };
const _flow = { x: 0, z: 0 };

function makeSample(): WaveSample {
  return { height: 0, nx: 0, ny: 1, nz: 0, vx: 0, vy: 0, vz: 0 };
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function approach(v: number, target: number, rate: number) {
  return v < target ? Math.min(target, v + rate) : Math.max(target, v - rate);
}

function wrapPi(a: number) {
  return a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;
}

/** rotation about +y that points the bow (local -z) at a compass heading */
export function headingQuat(headingDeg: number, out = new Quaternion()) {
  return out.setFromAxisAngle(_up.set(0, 1, 0), (-headingDeg * Math.PI) / 180);
}

export class BoatSim {
  R: Rapier;
  world: RAPIER.World;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  hydro: Hydro;
  env: BoatEnv;
  wake: WakeTrail;
  onImpact?: (e: BoatHit) => void;
  onSplash?: (e: BoatHit) => void;

  // controls: targets from input, smoothed actuals
  throttleTarget = 0;
  rudderTarget = 0;
  throttle = 0;
  rudder = 0;
  gearTimer = 0;

  docked = false;
  dockX = 0;
  dockZ = 0;
  dockYaw = 0;

  // telemetry
  /** forward speed over the ground (m/s) */
  speed = 0;
  /** forward speed through the water (m/s) */
  waterSpeed = 0;
  thrust = 0;
  submergedVolume = 0;
  submersion = 1;
  propDepth = 0.36;
  /** largest own-wake offset under any buoyancy cell this step */
  wakeHeight = 0;
  inContact = false;
  grounded = false;
  /** set when the hull ends up deep inside terrain despite the collider */
  tunneled = false;

  // interpolation snapshots (after each step)
  prevPos = new Vector3();
  prevQuat = new Quaternion();
  prevVel = new Vector3();
  prevAng = new Vector3();
  pos = new Vector3();
  quat = new Quaternion();
  vel = new Vector3();
  ang = new Vector3();

  // internals
  q = new Quaternion();
  qi = new Quaternion();
  sample = makeSample();
  sample2 = makeSample();
  levels: Float64Array;
  prevBowLevel = Number.NaN;
  vPre = new Vector3();
  sumF = new Vector3();
  impactCooldown = 0;
  splashCooldown = 0;
  groundContact = false;
  groundImpact = 0;
  groundPoint = new Vector3();

  constructor(R: Rapier, world: RAPIER.World, env: BoatEnv, opts: BoatSimOptions) {
    this.R = R;
    this.world = world;
    this.env = env;
    this.onImpact = opts.onImpact;
    this.onSplash = opts.onSplash;
    this.hydro = buildHydro();
    this.levels = new Float64Array(this.hydro.cells.length);
    this.wake = new WakeTrail({ refSpeed: TUNING.wakeRefSpeed });
    const h = this.hydro;
    const q0 = headingQuat(opts.headingDeg);
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(opts.x, 0, opts.z)
      .setRotation({ x: q0.x, y: q0.y, z: q0.z, w: q0.w })
      .setAdditionalMassProperties(HULL.mass, { x: HULL.com.x, y: HULL.com.y, z: HULL.com.z }, h.inertia, { x: 0, y: 0, z: 0, w: 1 })
      .setLinearDamping(0)
      .setAngularDamping(0)
      .setCanSleep(false)
      .setCcdEnabled(true);
    this.body = world.createRigidBody(desc);
    const cd = (R.ColliderDesc.convexHull(h.colliderPoints) ?? R.ColliderDesc.cuboid(HULL.beam / 2, 0.5, HULL.length / 2))
      .setDensity(0)
      .setFriction(TUNING.friction)
      .setRestitution(TUNING.restitution)
      .setFrictionCombineRule(R.CoefficientCombineRule.Min)
      .setRestitutionCombineRule(R.CoefficientCombineRule.Min);
    if (opts.collisionGroups !== undefined) cd.setCollisionGroups(opts.collisionGroups);
    this.collider = world.createCollider(cd, this.body);
    this.body.recomputeMassPropertiesFromColliders();
    this.snapshot(true);
  }

  get mass() {
    return HULL.mass;
  }

  setControls(throttle: number, rudder: number) {
    this.throttleTarget = Math.max(-1, Math.min(1, throttle));
    this.rudderTarget = Math.max(-1, Math.min(1, rudder));
  }

  /** place the hull on the water at rest */
  teleport(x: number, z: number, headingDeg: number, t: number) {
    const b = this.body;
    const y = this.env.water(x, z, t, this.sample).height;
    const q = headingQuat(headingDeg);
    b.setTranslation({ x, y, z }, true);
    b.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.resetForces(true);
    b.resetTorques(true);
    this.throttle = this.throttleTarget = 0;
    this.rudder = this.rudderTarget = 0;
    this.gearTimer = 0;
    this.prevBowLevel = Number.NaN;
    this.tunneled = false;
    this.wake.clear();
    this.snapshot(true);
  }

  dockTo(x: number, z: number, headingDeg: number) {
    this.docked = true;
    this.dockX = x;
    this.dockZ = z;
    this.dockYaw = (-headingDeg * Math.PI) / 180;
  }

  undock() {
    this.docked = false;
  }

  force(fx: number, fy: number, fz: number, p: Vec) {
    this.body.addForceAtPoint({ x: fx, y: fy, z: fz }, { x: p.x, y: p.y, z: p.z }, true);
    this.sumF.x += fx;
    this.sumF.y += fy;
    this.sumF.z += fz;
  }

  forceAtCom(fx: number, fy: number, fz: number) {
    this.body.addForce({ x: fx, y: fy, z: fz }, true);
    this.sumF.x += fx;
    this.sumF.y += fy;
    this.sumF.z += fz;
  }

  /** point velocity of the hull at world point p (uses the current step state) */
  flowAt(x: number, z: number) {
    _flow.x = 0;
    _flow.z = 0;
    this.env.flow?.(x, z, _flow);
  }

  pointVel(p: Vec, out: Vector3) {
    _r.set(p.x - _com.x, p.y - _com.y, p.z - _com.z);
    return out.crossVectors(_ang, _r).add(_lin);
  }

  preStep(t: number, dt: number) {
    const T = TUNING, b = this.body, h = this.hydro;
    b.resetForces(true);
    b.resetTorques(true);
    this.sumF.set(0, 0, 0);

    const tr = b.translation(), ro = b.rotation(), lv = b.linvel(), av = b.angvel();
    const pos = _p.set(tr.x, tr.y, tr.z);
    const q = this.q.set(ro.x, ro.y, ro.z, ro.w);
    const qi = this.qi.copy(q).invert();
    _lin.set(lv.x, lv.y, lv.z);
    _ang.set(av.x, av.y, av.z);
    this.vPre.copy(_lin);
    _com.copy(HULL.com).applyQuaternion(q).add(pos);
    _up.set(0, 1, 0).applyQuaternion(q);
    _fwd.set(0, 0, -1).applyQuaternion(q);
    _right.set(1, 0, 0).applyQuaternion(q);
    _wl.copy(_ang).applyQuaternion(qi);
    this.speed = -_ll.copy(_lin).applyQuaternion(qi).z;
    // hydrodynamics see the hull speed through the water, not over the ground
    this.flowAt(_com.x, _com.z);
    const cfx = _flow.x, cfz = _flow.z;
    _ll.set(_lin.x - cfx, _lin.y, _lin.z - cfz).applyQuaternion(qi);
    const U = -_ll.z;
    const Uabs = Math.abs(U);
    this.waterSpeed = U;

    this.updateControls(dt);

    // buoyancy + water-relative drag per cell
    this.wake.prepare(pos.x, pos.z, t, HULL.length * 0.6);
    const upY = Math.max(0.3, _up.y);
    const s = this.sample;
    let vSub = 0, wakeMax = 0;
    const cells = h.cells;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      _a.set(c.x, 0, c.zRef).applyQuaternion(q).add(pos);
      this.env.water(_a.x, _a.z, t, s);
      const wh = this.wake.heightAt(_a.x, _a.z, t);
      if (Math.abs(wh) > Math.abs(wakeMax)) wakeMax = wh;
      const surface = s.height + wh;
      const level = (surface - _a.y) / upY;
      this.levels[i] = level;
      cellAt(c, level, _tab);
      const V = _tab[0];
      if (V <= 1e-7) continue;
      vSub += V;
      _a.set(c.x, _tab[1], _tab[2]).applyQuaternion(q).add(pos);
      this.force(0, T.rho * T.g * V * h.scale, 0, _a);

      const f = Math.min(2, V / c.vDesign);
      this.pointVel(_a, _v);
      this.flowAt(_a.x, _a.z);
      _v.x -= s.vx * 0.9 + _flow.x;
      _v.y -= s.vy * 0.9;
      _v.z -= s.vz * 0.9 + _flow.z;
      _v.applyQuaternion(qi);
      const sx = _v.x, hy = _v.y, az = _v.z;
      const fx = -(T.swayLin * sx + T.swayQuad * sx * Math.abs(sx) + T.swayLift * Uabs * sx) * c.lat * f;
      const fy = -(T.heaveLin * hy + T.heaveQuad * hy * Math.abs(hy)) * c.w * f;
      const fz = -(T.surgeLin * az + (az > 0 ? T.surgeQuadAstern : T.surgeQuad) * az * Math.abs(az)) * c.w * f;
      _f.set(fx, fy, fz).applyQuaternion(q);
      this.force(_f.x, _f.y, _f.z, _a);
    }
    this.submergedVolume = vSub;
    this.wakeHeight = wakeMax;
    const sub = Math.min(1, vSub / h.vDesign);
    this.submersion = sub;

    // wave-making hump
    if (U > 0.5 && sub > 0) {
      const d = (U - T.humpSpeed) / T.humpWidth;
      const hump = T.humpDrag * Math.exp(-d * d) * sub;
      this.forceAtCom(-_fwd.x * hump, -_fwd.y * hump, -_fwd.z * hump);
    }

    // propulsion at the propeller, along the keel line
    _a.copy(ANCHORS.propeller).applyQuaternion(q).add(pos);
    this.env.water(_a.x, _a.z, t, this.sample2);
    const w2 = this.sample2;
    this.propDepth = w2.height - _a.y;
    const vent = Math.min(1, Math.max(0, (this.propDepth + 0.02) / 0.2));
    const th = this.throttle;
    let thrust = th >= 0
      ? th * T.thrustAhead * (1 - T.thrustFalloff * Math.min(1, Math.max(0, U / 9)))
      : th * T.thrustAstern;
    thrust *= vent;
    this.thrust = thrust;
    if (thrust !== 0) {
      this.force(_fwd.x * thrust, _fwd.y * thrust, _fwd.z * thrust, _a);
      if (thrust < 0) {
        const walk = -T.propWalk * -thrust;
        this.force(_right.x * walk, _right.y * walk, _right.z * walk, _a);
      }
    }

    // rudder: lift from the flow at the blade, prop wash only when driving ahead
    _a.copy(ANCHORS.rudder).applyQuaternion(q).add(pos);
    this.pointVel(_a, _v);
    this.flowAt(_a.x, _a.z);
    _v.x -= w2.vx * 0.9 + _flow.x;
    _v.y -= w2.vy * 0.9;
    _v.z -= w2.vz * 0.9 + _flow.z;
    _v.applyQuaternion(qi);
    const ur = -_v.z, sr = _v.x;
    const wash = thrust > 0 ? (T.washEfficiency * 2 * thrust) / (T.rho * T.propDiskArea) : 0;
    const V2 = ur * Math.abs(ur) + wash;
    const delta = this.rudder * T.rudderMaxRad;
    let alpha = V2 >= 0 ? delta + Math.atan2(sr, Math.max(0.5, Math.sqrt(V2))) : delta;
    alpha = Math.max(-T.rudderStall, Math.min(T.rudderStall, alpha));
    const rsub = vent;
    if (rsub > 0 && V2 !== 0) {
      const lat = -T.rudderLift * alpha * V2 * rsub;
      const drag = T.rudderLift * T.rudderDrag * alpha * alpha * V2 * rsub;
      _f.set(lat, 0, drag).applyQuaternion(q);
      this.force(_f.x, _f.y, _f.z, _a);
    }

    // attitude torques in the hull frame: dynamic trim, banking, angular damping
    const wx = _wl.x, wy = _wl.y, wz = _wl.z;
    const trim = U > 0 ? smoothstep(1, 4.5, U) * (1 - 0.3 * smoothstep(5, 9, U)) : 0;
    const tx = T.trimTorque * trim * sub - T.pitchDamp * wx * sub;
    const ty = -(T.yawDamp * wy + T.yawDampQuad * wy * Math.abs(wy)) * sub;
    const tz = (T.bankK * U * wy - T.rollDamp * wz - T.rollDampQuad * wz * Math.abs(wz)) * sub;
    _f.set(tx, ty, tz).applyQuaternion(q);
    b.addTorque({ x: _f.x, y: _f.y, z: _f.z }, true);

    if (this.docked) this.dockForces();
    this.boundaryForces(pos);
    this.groundForces(pos, q);

    // bow immersion rate drives spray events
    const bowLevel = this.levels[1];
    if (this.splashCooldown > 0) this.splashCooldown -= dt;
    if (!Number.isNaN(this.prevBowLevel)) {
      const rate = (bowLevel - this.prevBowLevel) / dt;
      // only when the bow bottom is actually in the water (raked bows ride clear of it)
      const wet = bowLevel > h.cells[1].yMin + 0.01;
      if (rate > T.splashRate && U > T.splashMinSpeed && this.splashCooldown <= 0 && wet) {
        _a.copy(ANCHORS.bow).applyQuaternion(q).add(pos);
        this.onSplash?.({ strength: +(rate * Math.min(1, U / 8)).toFixed(3), x: _a.x, y: _a.y, z: _a.z });
        this.splashCooldown = 0.35;
      }
    }
    this.prevBowLevel = bowLevel;
  }

  updateControls(dt: number) {
    const T = TUNING;
    const target = this.docked ? 0 : this.throttleTarget;
    const th = this.throttle;
    if (th !== 0 && Math.sign(target) !== Math.sign(th)) {
      // back to idle first; hold briefly in neutral before engaging the other gear
      this.throttle = approach(th, 0, T.spoolDown * dt);
      if (this.throttle === 0 && target !== 0) this.gearTimer = T.gearDelay;
    } else if (th === 0 && this.gearTimer > 0) {
      this.gearTimer -= dt;
    } else {
      this.throttle = approach(th, target, (Math.abs(target) > Math.abs(th) ? T.spoolUp : T.spoolDown) * dt);
    }
    const rt = this.docked ? 0 : this.rudderTarget;
    this.rudder = approach(this.rudder, rt, (rt === 0 || Math.sign(rt) !== Math.sign(this.rudder) ? T.rudderReturn : T.rudderRate) * dt);
  }

  dockForces() {
    const T = TUNING, m = HULL.mass;
    const tr = this.body.translation();
    const w = T.dockOmega, z = T.dockZeta;
    let fx = m * (w * w * (this.dockX - tr.x) - 2 * z * w * _lin.x);
    let fz = m * (w * w * (this.dockZ - tr.z) - 2 * z * w * _lin.z);
    const mag = Math.hypot(fx, fz);
    if (mag > T.dockMaxForce) {
      fx *= T.dockMaxForce / mag;
      fz *= T.dockMaxForce / mag;
    }
    this.forceAtCom(fx, 0, fz);
    const yaw = Math.atan2(-_fwd.x, -_fwd.z);
    const err = wrapPi(this.dockYaw - yaw);
    const I = this.hydro.inertia.y, wy = T.dockYawOmega;
    let ty = I * (wy * wy * err - 2 * wy * _ang.y);
    ty = Math.max(-T.dockMaxTorque, Math.min(T.dockMaxTorque, ty));
    this.body.addTorque({ x: 0, y: ty, z: 0 }, true);
  }

  boundaryForces(pos: Vector3) {
    const T = TUNING;
    const lim = this.env.boundary?.(pos.x, pos.z);
    if (!lim || lim.depth <= 0) return;
    const k = Math.min(1, lim.depth / T.boundaryRamp);
    const nx = lim.dx, nz = lim.dz;
    this.forceAtCom(nx * T.boundaryForce * k, 0, nz * T.boundaryForce * k);
    // yaw the bow back toward the playable water
    const fl = Math.hypot(_fwd.x, _fwd.z) || 1;
    const fx = _fwd.x / fl, fz = _fwd.z / fl;
    const cross = fz * nx - fx * nz;
    const dot = fx * nx + fz * nz;
    const steer = dot > 0 ? cross : cross >= 0 ? 1 : -1;
    this.body.addTorque({ x: 0, y: T.boundaryTurn * k * steer, z: 0 }, true);
  }

  groundForces(pos: Vector3, q: Quaternion) {
    const env = this.env;
    if (!env.ground) return;
    const T = TUNING;
    const collider = env.terrainCollider?.() ?? false;
    let touching = false, deep = 0;
    let approachMax = 0;
    for (const pr of this.hydro.probes) {
      _a.set(pr.x, pr.y, pr.z).applyQuaternion(q).add(pos);
      if (pr.bottom) {
        const pen = env.ground(_a.x, _a.z) - _a.y;
        if (collider) {
          if (pen > 1) deep++;
          continue;
        }
        if (pen > 0) {
          _n.x = 0;
          _n.y = 1;
          _n.z = 0;
          const n = env.groundNormal ? env.groundNormal(_a.x, _a.z, _n) : _n;
          // vertical overlap -> distance to the local tangent plane, so steep faces stay soft
          approachMax = Math.max(approachMax, this.penalty(_a, n, Math.min(pen * n.y, T.groundMaxPen)));
          touching = true;
        }
      } else if (!collider && env.shore) {
        const d = env.shore(_a.x, _a.z) + T.shoreMargin;
        // ignore shore-field noise over clearly deep water
        if (d <= 0 || env.ground(_a.x, _a.z) < _a.y - 4) continue;
        const e = 1;
        let gx = env.shore(_a.x + e, _a.z) - env.shore(_a.x - e, _a.z);
        let gz = env.shore(_a.x, _a.z + e) - env.shore(_a.x, _a.z - e);
        const gl = Math.hypot(gx, gz);
        if (gl < 1e-4) continue;
        _n.x = -gx / gl;
        _n.y = 0;
        _n.z = -gz / gl;
        approachMax = Math.max(approachMax, this.penalty(_a, _n, Math.min(d, T.groundMaxPen)));
        touching = true;
      }
    }
    this.tunneled = deep >= 2;
    if (touching && !this.groundContact && approachMax > T.impactMin) {
      this.groundImpact = approachMax;
      this.groundPoint.copy(_com);
    }
    this.groundContact = touching;
    this.grounded = touching;
  }

  /** spring-damper contact at world point p along normal n; returns the approach speed */
  penalty(p: Vector3, n: Vec, pen: number) {
    const T = TUNING;
    this.pointVel(p, _v);
    const vn = _v.x * n.x + _v.y * n.y + _v.z * n.z;
    const fn = Math.min(T.groundMaxForce, Math.max(0, T.groundK * pen - T.groundC * vn));
    let tx = _v.x - vn * n.x, ty = _v.y - vn * n.y, tz = _v.z - vn * n.z;
    const tl = Math.hypot(tx, ty, tz);
    let ft = 0;
    if (tl > 1e-4) {
      ft = Math.min(T.groundFriction * fn, 1500 * tl) / tl;
      tx *= -ft;
      ty *= -ft;
      tz *= -ft;
    } else tx = ty = tz = 0;
    this.force(n.x * fn + tx, n.y * fn + ty, n.z * fn + tz, p);
    return -vn;
  }

  postStep(t: number, dt: number) {
    const b = this.body;
    const v = b.linvel();
    const g = this.world.gravity;
    const m = HULL.mass;
    // velocity change the user forces cannot explain came from contacts
    const dvx = v.x - (this.vPre.x + dt * (this.sumF.x / m + g.x));
    const dvy = v.y - (this.vPre.y + dt * (this.sumF.y / m + g.y));
    const dvz = v.z - (this.vPre.z + dt * (this.sumF.z / m + g.z));
    const dv = Math.hypot(dvx, dvy, dvz);
    let contact = false;
    let cx = 0, cy = 0, cz = 0;
    this.world.contactPairsWith(this.collider, (other) => {
      this.world.contactPair(this.collider, other, (man) => {
        if (man.numSolverContacts() > 0) {
          const p = man.solverContactPoint(0);
          if (p && !contact) {
            cx = p.x;
            cy = p.y;
            cz = p.z;
          }
          contact = true;
        }
      });
    });
    if (this.impactCooldown > 0) this.impactCooldown -= dt;
    if (contact && dv > TUNING.impactMin && (!this.inContact || dv > 1) && this.impactCooldown <= 0) {
      this.onImpact?.({ strength: +dv.toFixed(3), x: cx, y: cy, z: cz });
      this.impactCooldown = 0.3;
    }
    this.inContact = contact;
    if (this.groundImpact > 0) {
      if (this.impactCooldown <= 0) {
        const p = this.groundPoint;
        this.onImpact?.({ strength: +this.groundImpact.toFixed(3), x: p.x, y: p.y, z: p.z });
        this.impactCooldown = 0.3;
      }
      this.groundImpact = 0;
    }

    this.snapshot(false);
    // wake trail from the transom
    _a.copy(ANCHORS.propeller).applyQuaternion(this.quat).add(this.pos);
    const fwdSpeed = -_ll.copy(this.vel).applyQuaternion(this.qi.copy(this.quat).invert()).z;
    this.wake.record(_a.x, _a.z, t, fwdSpeed);
  }

  /** keep the previous and current body state for render interpolation */
  snapshot(both: boolean) {
    const b = this.body;
    if (!both) {
      this.prevPos.copy(this.pos);
      this.prevQuat.copy(this.quat);
      this.prevVel.copy(this.vel);
      this.prevAng.copy(this.ang);
    }
    const tr = b.translation(), ro = b.rotation(), lv = b.linvel(), av = b.angvel();
    this.pos.set(tr.x, tr.y, tr.z);
    this.quat.set(ro.x, ro.y, ro.z, ro.w);
    this.vel.set(lv.x, lv.y, lv.z);
    this.ang.set(av.x, av.y, av.z);
    if (both) {
      this.prevPos.copy(this.pos);
      this.prevQuat.copy(this.quat);
      this.prevVel.copy(this.vel);
      this.prevAng.copy(this.ang);
    }
  }

  interpolate(alpha: number, pos: Vector3, quat: Quaternion, vel: Vector3, ang: Vector3) {
    pos.lerpVectors(this.prevPos, this.pos, alpha);
    quat.slerpQuaternions(this.prevQuat, this.quat, alpha);
    vel.lerpVectors(this.prevVel, this.vel, alpha);
    ang.lerpVectors(this.prevAng, this.ang, alpha);
  }

  dispose() {
    this.world.removeRigidBody(this.body);
  }
}
