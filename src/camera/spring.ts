// critically damped springs, exact for any frame dt (no overshoot, frame-rate independent).

export class Spring {
  x = 0;
  v = 0;

  constructor(x = 0) {
    this.x = x;
  }

  reset(x: number) {
    this.x = x;
    this.v = 0;
    return x;
  }

  step(target: number, omega: number, dt: number) {
    const d = this.x - target;
    const e = Math.exp(-omega * dt);
    const tmp = (this.v + omega * d) * dt;
    this.x = target + (d + tmp) * e;
    this.v = (this.v - omega * tmp) * e;
    return this.x;
  }
}

export function wrapPi(a: number) {
  return a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;
}

/** spring on an angle: follows the shortest way round */
export class AngleSpring extends Spring {
  step(target: number, omega: number, dt: number) {
    const t = this.x + wrapPi(target - this.x);
    super.step(t, omega, dt);
    const w = wrapPi(this.x);
    this.x = w;
    return w;
  }
}

/** exponential approach, frame-rate independent */
export function damp(x: number, target: number, rate: number, dt: number) {
  return target + (x - target) * Math.exp(-rate * dt);
}
