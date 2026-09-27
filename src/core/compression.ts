// fetch already decodes Content-Encoding; static hosts without that header return gzip bytes.
export async function unpackGzip(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const header = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  if (header[0] !== 0x1f || header[1] !== 0x8b) return bytes;
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

// .bin buffers (gltf and raw) and the sky .hdr ship gzipped under their plain names, since static hosts
// do not compress octet-streams. every loader, including three's, fetches them through this.
const PACKED = /\.(bin|hdr)$/i;

export function installGzipFetch() {
  const base = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await base(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (!res.ok || method !== 'GET' || !PACKED.test(new URL(url, location.href).pathname)) return res;
    const raw = await unpackGzip(await res.arrayBuffer());
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(raw, { status: res.status, statusText: res.statusText, headers });
  };
}

/** inverse of the bake's grad16 filter (tools/bake/index.ts) */
export function unGrad16(buf: ArrayBuffer, res: number): ArrayBuffer {
  const n = res * res;
  const bytes = new Uint8Array(buf);
  const out = new Uint16Array(n);
  for (let y = 0, i = 0; y < res; y++) {
    for (let x = 0; x < res; x++, i++) {
      const l = x > 0 ? out[i - 1] : 0, u = y > 0 ? out[i - res] : 0, ul = x > 0 && y > 0 ? out[i - res - 1] : 0;
      out[i] = (bytes[i] | (bytes[n + i] << 8)) + l + u - ul;
    }
  }
  return out.buffer;
}
