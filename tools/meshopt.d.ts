declare module 'three/examples/jsm/libs/meshopt_simplifier.module.js' {
  export const MeshoptSimplifier: {
    ready: Promise<void>;
    simplify(indices: Uint32Array, positions: Float32Array, stride: number, target: number, error: number, flags?: string[]): [Uint32Array, number];
  };
}
