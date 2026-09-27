// cpu copies that outlive their gpu upload. merged static geometry (flagged with
// geometry.userData.releaseCpu) and one-shot data textures are only read by the gpu after the first
// upload, yet three keeps their arrays: at full density that was several hundred mb of js heap.
import { StaticDrawUsage, type BufferAttribute, type Texture } from 'three/webgpu';
import type { GameContext } from './context';

/** frees the arrays of flagged geometry the gpu already holds; call again later for late builds */
export function releaseUploaded(ctx: GameContext) {
  const backend = (ctx.renderer as any).backend;
  let bytes = 0;
  ctx.scene.traverse((o: any) => {
    const g = o.isMesh ? o.geometry : null;
    if (!g?.userData?.releaseCpu || !g.boundingSphere) return;
    const attrs = [...(Object.values(g.attributes) as BufferAttribute[]), g.index as BufferAttribute | null];
    // every attribute must already be on the gpu, or a pass that has not drawn it yet would upload nothing
    if (attrs.some((a) => a && !backend.get(a)?.buffer)) return;
    for (const a of attrs) {
      if (!a || a.usage !== StaticDrawUsage || a.version !== 0 || !a.array.length) continue;
      bytes += a.array.byteLength;
      (a as { array: ArrayLike<number> }).array = new (a.array.constructor as Float32ArrayConstructor)(0);
    }
    delete g.userData.releaseCpu;
  });
  return bytes;
}

/** drop a data texture's pixels right after its upload (it must never be updated again) */
export function dropAfterUpload<T extends Texture>(tex: T): T {
  const prev = tex.onUpdate;
  tex.onUpdate = (t: Texture) => {
    prev?.call(tex, t);
    const img = t.image as { data?: unknown } | null;
    if (img && 'data' in img) img.data = null;
  };
  return tex;
}
