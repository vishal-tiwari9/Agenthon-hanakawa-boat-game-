// mooring lines: dynamic tubes between moving boat cleats and fixed bollards, sagging in a
// catenary-like parabola set by rope length. all lines share one geometry and one draw call.
import { BufferAttribute, BufferGeometry, Mesh, Vector3 } from 'three/webgpu';
import { LAYERS } from '../core/layers';
import type { Materials } from './materials';

const SEG = 18, RAD = 6;

export interface Line {
  a: Vector3;
  b: Vector3;
  /** extra length beyond the straight span (meters) */
  slack: number;
  r: number;
  visible: boolean;
}

export class RopeSet {
  lines: Line[] = [];
  mesh: Mesh;
  private geo: BufferGeometry;
  private pos: Float32Array;
  private nor: Float32Array;

  constructor(mats: Materials, max: number) {
    const verts = max * SEG * RAD * 6;
    this.geo = new BufferGeometry();
    this.pos = new Float32Array(verts * 3);
    this.nor = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const col = new Float32Array(verts * 3).fill(1);
    const vv = new Float32Array(verts * 4);
    // rope colour: weathered manila / faded blue polyester alternating per line
    for (let l = 0; l < max; l++) {
      const c = l % 3 === 1 ? [0.12, 0.2, 0.3] : [0.5, 0.43, 0.32];
      for (let i = 0; i < SEG * RAD * 6; i++) col.set(c, (l * SEG * RAD * 6 + i) * 3);
    }
    let k = 0;
    for (let l = 0; l < max; l++) for (let s = 0; s < SEG; s++) for (let r = 0; r < RAD; r++) {
      for (const [ds, dr] of [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]]) {
        uv[k * 2] = (r + dr) / RAD;
        uv[k * 2 + 1] = (s + ds) * 0.1;
        k++;
      }
    }
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.geo.setAttribute('normal', new BufferAttribute(this.nor, 3));
    this.geo.setAttribute('uv', new BufferAttribute(uv, 2));
    this.geo.setAttribute('aCol', new BufferAttribute(col, 3));
    this.geo.setAttribute('aVar', new BufferAttribute(vv, 4));
    this.geo.setDrawRange(0, 0);
    this.mesh = new Mesh(this.geo, mats.rope);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.layers.set(LAYERS.NO_REFLECT);
    this.mesh.name = 'structures:ropes';
    for (let i = 0; i < max; i++) this.lines.push({ a: new Vector3(), b: new Vector3(), slack: 0.3, r: 0.014, visible: false });
  }

  update() {
    const P: Vector3[] = [];
    for (let s = 0; s <= SEG; s++) P.push(new Vector3());
    const T = new Vector3(), N = new Vector3(), Bn = new Vector3(), up = new Vector3(0, 1, 0);
    let k = 0;
    const ring: number[][][] = [];
    for (const ln of this.lines) {
      if (!ln.visible) continue;
      const span = ln.a.distanceTo(ln.b);
      const L = span + ln.slack;
      // parabolic sag from rope length: L ~ S + 8 d^2 / (3 S)
      const sag = Math.sqrt(Math.max(0, (3 * span * (L - span)) / 8));
      for (let s = 0; s <= SEG; s++) {
        const t = s / SEG;
        P[s].lerpVectors(ln.a, ln.b, t);
        P[s].y -= 4 * sag * t * (1 - t);
      }
      ring.length = 0;
      for (let s = 0; s <= SEG; s++) {
        const p0 = P[Math.max(0, s - 1)], p1 = P[Math.min(SEG, s + 1)];
        T.subVectors(p1, p0).normalize();
        N.crossVectors(T, up);
        if (N.lengthSq() < 1e-6) N.set(1, 0, 0);
        N.normalize();
        Bn.crossVectors(N, T).normalize();
        const rr: number[][] = [];
        for (let r = 0; r <= RAD; r++) {
          const a = (r / RAD) * Math.PI * 2;
          const c = Math.cos(a), sn = Math.sin(a);
          const nx = N.x * c + Bn.x * sn, ny = N.y * c + Bn.y * sn, nz = N.z * c + Bn.z * sn;
          rr.push([P[s].x + nx * ln.r, P[s].y + ny * ln.r, P[s].z + nz * ln.r, nx, ny, nz]);
        }
        ring.push(rr);
      }
      for (let s = 0; s < SEG; s++) for (let r = 0; r < RAD; r++) {
        for (const [ds, dr] of [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]]) {
          const v = ring[s + ds][r + dr];
          this.pos[k * 3] = v[0]; this.pos[k * 3 + 1] = v[1]; this.pos[k * 3 + 2] = v[2];
          this.nor[k * 3] = v[3]; this.nor[k * 3 + 1] = v[4]; this.nor[k * 3 + 2] = v[5];
          k++;
        }
      }
    }
    this.geo.setDrawRange(0, k);
    this.mesh.visible = k > 0;
    (this.geo.attributes.position as BufferAttribute).needsUpdate = true;
    (this.geo.attributes.normal as BufferAttribute).needsUpdate = true;
  }
}
