// free photo camera: WASD fly on the horizontal plane, Space/Q up and down, Shift fast, mouse look,
// wheel zooms the lens. never dips under the sea surface or into the ground.
import { Euler, Vector3, type PerspectiveCamera } from 'three/webgpu';
import type { GameContext } from '../core/context';
import { waterHeight } from '../world/waves';
import { damp } from './spring';

export const PHOTO = {
  fov: 55,
  minFov: 18,
  maxFov: 80,
  speed: 6,
  fastSpeed: 24,
  accel: 6,
  maxHeight: 450,
};

const _e = new Euler(0, 0, 0, 'YXZ'), _v = new Vector3();

export class PhotoCam {
  yaw = 0;
  pitch = 0;
  fov = PHOTO.fov;
  vel = new Vector3();
  pos = new Vector3();

  /** start from wherever the camera is now */
  enter(cam: PerspectiveCamera) {
    _e.setFromQuaternion(cam.quaternion, 'YXZ');
    this.yaw = _e.y;
    this.pitch = _e.x;
    this.pos.copy(cam.position);
    this.vel.set(0, 0, 0);
    this.fov = cam.fov;
  }

  look(dx: number, dy: number) {
    this.yaw -= dx;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - dy));
  }

  update(ctx: GameContext, cam: PerspectiveCamera, dt: number, wheel: number) {
    const i = ctx.input;
    if (wheel) this.fov = Math.max(PHOTO.minFov, Math.min(PHOTO.maxFov, this.fov * Math.pow(1.08, wheel)));
    const fwd = (i.isDown('forward') ? 1 : 0) - (i.isDown('reverse') ? 1 : 0);
    const side = (i.isDown('right') ? 1 : 0) - (i.isDown('left') ? 1 : 0);
    const up = (i.isDown('photoUp') ? 1 : 0) - (i.isDown('photoDown') ? 1 : 0);
    const speed = i.isDown('photoFast') ? PHOTO.fastSpeed : PHOTO.speed;
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    // yaw-only frame: forward (-sin, 0, -cos), right (cos, 0, -sin)
    _v.set(-s * fwd + c * side, up, -c * fwd - s * side);
    if (_v.lengthSq() > 1) _v.normalize();
    _v.multiplyScalar(speed);
    const k = 1 - Math.exp(-PHOTO.accel * dt);
    this.vel.lerp(_v, k);
    this.pos.addScaledVector(this.vel, dt);
    let floor = waterHeight(this.pos.x, this.pos.z, ctx.time.render) + 0.3;
    if (ctx.world.has('height')) floor = Math.max(floor, ctx.world.heightAt(this.pos.x, this.pos.z) + 0.5);
    if (this.pos.y < floor) {
      this.pos.y = damp(this.pos.y, floor, 20, dt);
      if (this.vel.y < 0) this.vel.y = 0;
    }
    this.pos.y = Math.min(PHOTO.maxHeight, this.pos.y);
    cam.position.copy(this.pos);
    cam.quaternion.setFromEuler(_e.set(this.pitch, this.yaw, 0, 'YXZ'));
    if (cam.fov !== this.fov) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }
}
