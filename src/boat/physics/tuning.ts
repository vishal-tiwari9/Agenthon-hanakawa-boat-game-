// every hand-tuned number of the launch's handling lives here. forces are hull totals at the
// design draft; the sim distributes them over the buoyancy cells so moments come out naturally.
export const TUNING = {
  /** fresh river water */
  rho: 1000,
  g: 9.81,
  /** scale buoyancy so the hull rests exactly at its design waterline (hullSpec volume vs mass) */
  calibrateDisplacement: true,

  // engine: thrust at the propeller along the keel line
  thrustAhead: 1600, // N at full throttle from standstill: a small quiet inboard
  thrustAstern: 680,
  /** fraction of ahead thrust lost at top speed (propeller advance) */
  thrustFalloff: 0.15,
  spoolUp: 1.6, // throttle units per second
  spoolDown: 1.2,
  /** seconds held at idle when shifting between ahead and astern */
  gearDelay: 0.35,
  propDiskArea: 0.07,
  /** share of the slipstream that reaches the rudder */
  washEfficiency: 0.5,
  /** stern walks to port under astern thrust (right-handed prop), fraction of thrust */
  propWalk: 0.04,

  // rudder
  rudderMaxRad: 0.6,
  rudderRate: 1.1, // per second toward full lock
  rudderReturn: 1.8,
  /** 0.5 * rho * area * lift slope, N per (m/s)^2 per rad */
  rudderLift: 260,
  rudderStall: 0.62,
  rudderDrag: 0.45,

  // hull drag, water relative (N per m/s and N per (m/s)^2)
  surgeLin: 30,
  surgeQuad: 23,
  surgeQuadAstern: 60,
  /** wave-making resistance hump near hull speed: the bow lifts and it slows to climb over */
  humpDrag: 120,
  humpSpeed: 3.2,
  humpWidth: 1.3,
  swayLin: 350,
  swayQuad: 1400,
  /** hull acting as a low aspect ratio foil: lateral force ~ speed * sideslip */
  swayLift: 600,
  heaveLin: 6500,
  heaveQuad: 1500,
  /** extra lateral area weighting aft; the hullSpec keel/skeg profile already provides most of it */
  skegBias: 0,

  // angular damping (local axes, N m s)
  rollDamp: 700,
  rollDampQuad: 400,
  pitchDamp: 3500,
  yawDamp: 700,
  yawDampQuad: 900,

  /** speed the wake amplitude is normalized to (the boat's top speed) */
  wakeRefSpeed: 7.6,

  // speed dependent attitude
  /** bow-up torque at hump speed (N m); the flat bottom lifts the bow ~1.5 deg */
  trimTorque: 6000,
  /** extra lean into turns: roll torque per (forward speed * yaw rate). the flat bottom keeps the
   * river boat nearly level, so none by default */
  bankK: 0,

  // mass properties
  gyration: { roll: 0.6, pitch: 2.0, yaw: 2.05 },
  /** hydrodynamic added inertia multipliers */
  addedInertia: { roll: 1.25, pitch: 1.35, yaw: 1.3 },

  // contact
  friction: 0.12,
  restitution: 0.04,

  // docking pull (critically damped spring on the berth pose)
  dockOmega: 1.0,
  dockZeta: 1.0,
  dockMaxForce: 2200,
  dockYawOmega: 1.0,
  dockMaxTorque: 4000,

  // soft world boundary
  boundaryForce: 3400,
  boundaryTurn: 5500,
  boundaryRamp: 20,

  // temporary terrain penalty contact (until the heightfield collider exists)
  groundK: 40000,
  /** near critical for the hull mass so contacts stop the boat without bouncing it back */
  groundC: 10000,
  groundMaxPen: 1,
  groundMaxForce: 40000,
  groundFriction: 0.4,
  shoreMargin: 0.4,

  // events
  impactMin: 0.3, // m/s closing speed
  splashRate: 0.9, // m/s bow immersion rate
  splashMinSpeed: 2,
};

export type Tuning = typeof TUNING;
