// startup prefetch: the modules initialize one after another, so left alone each one's downloads only
// start when its turn comes and the connection idles during cpu work. public/preload.json lists every
// file a cold start fetches (in first-request order); they all start downloading at boot, a few lanes
// at a time so the early ones land first, and the loaders' own fetches pick up the in-flight responses.
const inflight = new Map<string, Promise<Response>>();
const claimed = new Set<string>();

const keyOf = (input: RequestInfo | URL) => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).href;

export function installPrefetch() {
  const base = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET') return base(input, init);
    const key = keyOf(input);
    claimed.add(key);
    const hit = inflight.get(key);
    if (hit) {
      inflight.delete(key);
      return hit;
    }
    return base(input, init);
  };

  return async function prefetch(listUrl: string, lanes = 6) {
    let list: string[];
    try {
      list = await (await base(listUrl)).json();
    } catch {
      return;
    }
    let next = 0;
    const lane = async () => {
      while (next < list.length) {
        const key = keyOf(list[next++]);
        if (claimed.has(key) || inflight.has(key)) continue;
        const res = base(key);
        inflight.set(key, res);
        // wait for the whole body (on a copy) before starting the lane's next file
        await res.then((r) => r.clone().arrayBuffer()).catch(() => inflight.delete(key));
      }
    };
    await Promise.all(Array.from({ length: lanes }, lane));
    // anything nobody asked for within a minute is dropped
    setTimeout(() => inflight.clear(), 60000);
  };
}
