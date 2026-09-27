import { unpackGzip } from '../core/compression';
import { dropAfterUpload } from '../core/memory';
// shipped hemi-octahedral impostors (development fallback can bake them). every tree variant is rendered from N x N view
// directions over the upper hemisphere into two atlases: albedo (sqrt-encoded rgb, coverage alpha)
// and tree-space normal. at runtime a far tree is one quad that faces the atlas frame nearest to the
// view direction, lit with the baked normals, so distant slopes stay coherent (prefiltered mips,
// no alpha-card shimmer) at 4 vertices per tree.
import {
  Color, DataTexture, Mesh, MeshBasicNodeMaterial, Object3D, OrthographicCamera, RenderTarget, Scene, UnsignedByteType,
  LinearFilter, LinearMipmapLinearFilter, RGBAFormat, Vector3, Vector4, type BufferGeometry, type Material, type Texture,
  type WebGPURenderer,
} from 'three/webgpu';
import { abs, clamp, cross, float, floor, max, normalize, smoothstep, vec2, vec3, vec4 } from 'three/tsl';

type N = any;

/** hemi-octahedral decode of a grid point (u, v in [-1, 1]) to a unit direction with y >= 0 */
export function hemiOctDecode(u: number, v: number, out = new Vector3()) {
  const px = (u + v) / 2, pz = (u - v) / 2;
  const py = 1 - Math.abs(px) - Math.abs(pz);
  return out.set(px, py, pz).normalize();
}

/** capture "up" for a view direction; must match impostorUpNode() exactly */
export function impostorUp(d: Vector3, out = new Vector3()) {
  const t = Math.min(1, Math.max(0, (d.y - 0.85) / 0.15));
  const s = t * t * (3 - 2 * t);
  return out.set(0, 1 - s, -s).normalize();
}

export function impostorUpNode(d: N): N {
  const s = smoothstep(0.85, 1.0, d.y);
  return normalize(vec3(0, float(1).sub(s), s.negate()));
}

/** tsl: frame index (ivec-ish vec2) and frame direction for a local view direction */
export function impostorFrame(vLocal: N, frames: number) {
  const v = normalize(vec3(vLocal.x, max(vLocal.y, 0.0), vLocal.z));
  const sum = abs(v.x).add(abs(v.y)).add(abs(v.z));
  const px = v.x.div(sum), pz = v.z.div(sum);
  const u = px.add(pz), w = px.sub(pz);
  const fi = clamp(floor(u.mul(0.5).add(0.5).mul(frames)), 0, frames - 1);
  const fj = clamp(floor(w.mul(0.5).add(0.5).mul(frames)), 0, frames - 1);
  const uc = fi.add(0.5).div(frames).mul(2).sub(1), vc = fj.add(0.5).div(frames).mul(2).sub(1);
  const dx = uc.add(vc).mul(0.5), dz = uc.sub(vc).mul(0.5);
  const dy = float(1).sub(abs(dx)).sub(abs(dz));
  const D = normalize(vec3(dx, dy, dz));
  const up0 = impostorUpNode(D);
  const right = normalize(cross(up0, D));
  const up = cross(D, right);
  return { cell: vec2(fi, fj), D, right, up };
}

export interface ImpostorAtlas {
  albedo: Texture;
  normal: Texture;
  frames: number;
  /** capture sphere in tree-local space */
  center: Vector3;
  radius: number;
  /** development bake targets, absent when loaded from shipped atlases */
  targets?: [RenderTarget, RenderTarget];
}

export interface CapturePart {
  geometry: BufferGeometry;
  albedo: Material;
  normal: Material;
}

/**
 * render one tree (parts in tree-local space, capture materials supplied by the caller) into
 * albedo and normal atlases. call during init, before the game loop runs.
 */
export function bakeImpostor(renderer: WebGPURenderer, parts: CapturePart[], center: Vector3, radius: number, frames: number, framePx: number): ImpostorAtlas {
  const size = frames * framePx;
  const mk = () => {
    const rt = new RenderTarget(size, size, { type: UnsignedByteType, format: RGBAFormat, depthBuffer: true });
    rt.texture.generateMipmaps = true;
    rt.texture.minFilter = LinearMipmapLinearFilter;
    rt.texture.magFilter = LinearFilter;
    rt.texture.anisotropy = 4;
    return rt;
  };
  const rtA = mk(), rtN = mk();
  const scene = new Scene();
  const root = new Object3D();
  scene.add(root);
  const meshes = parts.map((p) => {
    const m = new Mesh(p.geometry, p.albedo);
    m.frustumCulled = false;
    root.add(m);
    return m;
  });
  const cam = new OrthographicCamera(-radius, radius, radius, -radius, 0.05, radius * 6);
  const d = new Vector3(), up = new Vector3();

  const prevTarget = renderer.getRenderTarget();
  const prevAuto = renderer.autoClear;
  const prevColor = new Color();
  renderer.getClearColor(prevColor);
  const prevAlpha = renderer.getClearAlpha();
  const prevShadow = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = false;
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;

  for (const [rt, pass] of [[rtA, 'albedo'], [rtN, 'normal']] as const) {
    meshes.forEach((m, k) => (m.material = pass === 'albedo' ? parts[k].albedo : parts[k].normal));
    renderer.setRenderTarget(rt);
    rt.viewport.set(0, 0, size, size);
    renderer.clear(true, true, true);
    for (let j = 0; j < frames; j++) {
      for (let i = 0; i < frames; i++) {
        hemiOctDecode(((i + 0.5) / frames) * 2 - 1, ((j + 0.5) / frames) * 2 - 1, d);
        impostorUp(d, up);
        cam.position.copy(center).addScaledVector(d, radius * 3);
        cam.up.copy(up);
        cam.lookAt(center);
        cam.updateMatrixWorld(true);
        rt.viewport.copy(new Vector4(i * framePx, j * framePx, framePx, framePx));
        renderer.render(scene, cam);
      }
    }
    rt.viewport.set(0, 0, size, size);
  }

  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAuto;
  renderer.setClearColor(prevColor, prevAlpha);
  renderer.shadowMap.enabled = prevShadow;
  for (const m of meshes) root.remove(m);
  return { albedo: rtA.texture, normal: rtN.texture, frames, center: center.clone(), radius, targets: [rtA, rtN] };
}

/** capture material pair built from shared albedo / tree-space normal / alpha nodes */
export function captureMaterials(opts: { position?: N; albedo: N; normal: N; alphaTest?: number; coverage?: boolean }): { albedo: Material; normal: Material } {
  const a = new MeshBasicNodeMaterial();
  const n = new MeshBasicNodeMaterial();
  for (const m of [a, n]) {
    m.side = 2;
    m.alphaTest = opts.coverage ? 0.015 : opts.alphaTest ?? 0;
    m.transparent = !!opts.coverage;
    m.depthWrite = !opts.coverage;
    m.toneMapped = false;
    m.fog = false;
    if (opts.position) m.positionNode = opts.position;
  }
  // albedo is stored as sqrt(rgb) so 8 bits keep dark foliage free of banding
  a.colorNode = vec4(opts.albedo.rgb.max(0).sqrt(), opts.albedo.a);
  n.colorNode = vec4(normalize(opts.normal).mul(0.5).add(0.5), opts.albedo.a);
  return { albedo: a, normal: n };
}


export interface AtlasRecord {
  signature: string;
  file: string;
  size: number;
}

/** shipped lossless RGBA atlases avoid hundreds of tree captures during every startup */
export async function loadImpostor(record: AtlasRecord, center: Vector3, radius: number, frames: number): Promise<ImpostorAtlas> {
  const response = await fetch(`/assets/vegetation/impostors/${record.file}`);
  if (!response.ok || !response.body) throw new Error(`impostor ${record.file}: ${response.status}`);
  const raw = await unpackGzip(await response.arrayBuffer());
  const length = record.size * record.size * 4;
  if (raw.byteLength !== length * 2) throw new Error(`invalid impostor size: ${record.file}`);
  const make = (offset: number) => {
    const t = dropAfterUpload(new DataTexture(new Uint8Array(raw, offset, length), record.size, record.size, RGBAFormat, UnsignedByteType));
    t.generateMipmaps = true;
    t.minFilter = LinearMipmapLinearFilter;
    t.magFilter = LinearFilter;
    t.anisotropy = 4;
    t.flipY = false;
    t.needsUpdate = true;
    return t;
  };
  return { albedo: make(0), normal: make(length), center: center.clone(), radius, frames };
}

/** offline exporter only; the regular game never reads GPU pixels back */
export async function exportImpostor(renderer: WebGPURenderer, atlas: ImpostorAtlas) {
  if (!atlas.targets) throw new Error('reload with ?bakeStartup=1 before exporting');
  const size = atlas.targets[0].width;
  const bytes = new Uint8Array(size * size * 8);
  for (let i = 0; i < 2; i++) {
    const src = await renderer.readRenderTargetPixelsAsync(atlas.targets[i], 0, 0, size, size);
    const packed = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    const row = size * 4;
    const stride = packed.length === row * size ? row : Math.ceil(row / 256) * 256;
    for (let y = 0; y < size; y++) bytes.set(packed.subarray(y * stride, y * stride + row), size * size * 4 * i + y * row);
  }
  return { size, bytes };
}
