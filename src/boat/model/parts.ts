// collects geometry per material key before merging
import type { BufferGeometry } from 'three/webgpu';

export class Parts {
  map = new Map<string, BufferGeometry[]>();

  add(key: string, g: BufferGeometry | null | undefined) {
    if (!g) return;
    let list = this.map.get(key);
    if (!list) this.map.set(key, (list = []));
    list.push(g);
  }
}
