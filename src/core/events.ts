// tiny typed-ish event bus. event names and payloads are listed in ARCHITECTURE.md.
type Handler = (payload?: any) => void;

export class EventBus {
  private map = new Map<string, Set<Handler>>();

  on(name: string, fn: Handler): () => void {
    let set = this.map.get(name);
    if (!set) this.map.set(name, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  once(name: string, fn: Handler): () => void {
    const off = this.on(name, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  emit(name: string, payload?: any) {
    const set = this.map.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[events] handler for "${name}" threw`, e);
      }
    }
  }
}
