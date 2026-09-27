// asset loading with progress tracking and correct color spaces.
// color textures (albedo/diffuse) are sRGB; data textures (normal, arm, rough, disp) are linear.
import { ImageBitmapLoader, RepeatWrapping, SRGBColorSpace, NoColorSpace, Texture, TextureLoader, LinearMipmapLinearFilter } from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { EventBus } from './events';

export interface TextureOptions {
  srgb?: boolean;
  repeat?: boolean;
  anisotropy?: number;
}

export class AssetLoader {
  private textureLoader = new TextureLoader();
  /** webgpu only: decode jpeg/png off the main thread (createImageBitmap). the upload flips with
   *  texture.flipY just like an image element; webgl2 ignores flipY for bitmaps, so it keeps images */
  useImageBitmap = false;
  private bitmapLoader: ImageBitmapLoader | null = null;
  private gltfLoader = new GLTFLoader();
  private cache = new Map<string, Promise<unknown>>();
  private total = 0;
  private done = 0;
  private labels = new Set<string>();
  maxAnisotropy = 8;

  constructor(private events: EventBus) {}

  get progress() {
    return this.total === 0 ? 1 : this.done / this.total;
  }

  /** register any async work so the loading bar accounts for it */
  track<T>(label: string, p: Promise<T>, weight = 1): Promise<T> {
    this.total += weight;
    this.labels.add(label);
    this.emit(label);
    return p.finally(() => {
      this.done += weight;
      this.labels.delete(label);
      this.emit(label);
    });
  }

  private emit(label: string) {
    this.events.emit('loading:progress', { progress: this.progress, label, pending: [...this.labels] });
  }

  texture(url: string, opts: TextureOptions = {}): Promise<Texture> {
    const key = `tex:${url}:${opts.srgb ? 's' : 'l'}`;
    if (!this.cache.has(key)) {
      const load = (): Promise<Texture> => {
        if (!this.useImageBitmap || typeof createImageBitmap === 'undefined') return this.textureLoader.loadAsync(url);
        if (!this.bitmapLoader) this.bitmapLoader = new ImageBitmapLoader().setOptions({ imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        return this.bitmapLoader.loadAsync(url).then((bmp) => {
          const tex = new Texture(bmp as any);
          tex.needsUpdate = true;
          return tex;
        });
      };
      const p = load().then((t) => {
        t.colorSpace = opts.srgb ? SRGBColorSpace : NoColorSpace;
        if (opts.repeat !== false) t.wrapS = t.wrapT = RepeatWrapping;
        t.anisotropy = opts.anisotropy ?? this.maxAnisotropy;
        t.minFilter = LinearMipmapLinearFilter;
        t.generateMipmaps = true;
        return t;
      });
      this.cache.set(key, this.track(url.split('/').pop() || url, p));
    }
    return this.cache.get(key) as Promise<Texture>;
  }

  gltf(url: string): Promise<GLTF> {
    const key = `gltf:${url}`;
    if (!this.cache.has(key)) this.cache.set(key, this.track(url.split('/').pop() || url, this.gltfLoader.loadAsync(url), 2));
    return this.cache.get(key) as Promise<GLTF>;
  }

  async json<T = unknown>(url: string): Promise<T> {
    const key = `json:${url}`;
    if (!this.cache.has(key)) this.cache.set(key, this.track(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); })));
    return this.cache.get(key) as Promise<T>;
  }

  async binary(url: string): Promise<ArrayBuffer> {
    const key = `bin:${url}`;
    if (!this.cache.has(key)) this.cache.set(key, this.track(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.arrayBuffer(); }), 3));
    return this.cache.get(key) as Promise<ArrayBuffer>;
  }
}
