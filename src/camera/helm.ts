// first-person from the helmsman's standing eye at the stern: the eye rides the boat, but the head is stabilized so only a fraction
// of the hull's roll and pitch reaches the view, low-passed so chop never shakes the horizon.
import { Euler, Quaternion, Vector3, type PerspectiveCamera } from 'three/webgpu';
import type { GameContext } from '../core/context';
import { ANCHORS } from '../boat/hullSpec';
import { damp, wrapPi } from './spring';

export const HELM = {
  fov: 62,
  /** share of hull roll/pitch passed to the head */
  tilt: 0.3,
  tiltRate: 5,
  maxYaw: 2.6,
  minPitch: -0.95,
  maxPitch: 0.75,
  restPitch: -0.12,
  recenterAfter: 4,
  recenterRate: 0.7,
};

const _yaw = new Quaternion(), _tilt = new Quaternion(), _look = new Quaternion(), _id = new Quaternion();
const _f = new Vector3(), _up = new Vector3(0, 1, 0), _e = new Euler(0, 0, 0, 'YXZ');

export class HelmCam {
  lookYaw = 0;
  lookPitch = HELM.restPitch;
  idle = 0;
  tilt = new Quaternion();
  snapNext = true;

  snap() {
    this.snapNext = true;
  }

  look(dx: number, dy: number) {
    if (dx === 0 && dy === 0) return;
    this.lookYaw = Math.max(-HELM.maxYaw, Math.min(HELM.maxYaw, wrapPi(this.lookYaw - dx)));
    this.lookPitch = Math.max(HELM.minPitch, Math.min(HELM.maxPitch, this.lookPitch - dy));
    this.idle = 0;
  }

  update(ctx: GameContext, cam: PerspectiveCamera, dt: number) {
    const b = ctx.boat;
    if (!b) return;
    this.idle += dt;
    if (this.idle > HELM.recenterAfter && Math.abs(b.speed) > 1) {
      this.lookYaw = damp(this.lookYaw, 0, HELM.recenterRate, dt);
      this.lookPitch = damp(this.lookPitch, HELM.restPitch, HELM.recenterRate, dt);
    }
    // split the hull orientation into heading and tilt; keep a filtered fraction of the tilt
    _f.set(0, 0, -1).applyQuaternion(b.quaternion);
    _yaw.setFromAxisAngle(_up, Math.atan2(-_f.x, -_f.z));
    _tilt.copy(_yaw).invert().multiply(b.quaternion);
    _id.identity().slerp(_tilt, HELM.tilt);
    if (this.snapNext) {
      this.tilt.copy(_id);
      this.snapNext = false;
    } else this.tilt.slerp(_id, 1 - Math.exp(-HELM.tiltRate * dt));

    cam.position.copy(ANCHORS.helmEye).applyQuaternion(b.quaternion).add(b.position);
    _look.setFromEuler(_e.set(this.lookPitch, this.lookYaw, 0, 'YXZ'));
    cam.quaternion.copy(_yaw).multiply(this.tilt).multiply(_look);
  }
}
