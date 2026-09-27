// render layers. the main camera sees 0 and NO_REFLECT; the planar reflection camera sees only 0,
// so objects placed only on NO_REFLECT (grass, tiny props, particles) skip the reflection pass.
export const LAYERS = {
  DEFAULT: 0,
  NO_REFLECT: 1,
} as const;
