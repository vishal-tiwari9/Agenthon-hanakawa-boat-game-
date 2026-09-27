(() => {
  const B = { rgba8unorm: 4, 'rgba8unorm-srgb': 4, bgra8unorm: 4, rgba16float: 8, r16float: 2, rg16float: 4, r32float: 4, rg32float: 8, rgba32float: 16, depth32float: 4, depth24plus: 4, 'depth24plus-stencil8': 4, r8unorm: 1, rg8unorm: 2 };
  const log = (window.__gpuAlloc = { tex: [], buf: 0, bufs: 0, bySrc: {} });
  const where = () => {
    const st = new Error().stack.split('\n').map((x) => x.trim());
    const own = st.find((x) => /\/src\/(?!core\/)/.test(x)) || st[3] || '?';
    return own.replace(/^at /, '').replace(/https?:\/\/[^/]+/, '').replace(/\?[^:]*/, '');
  };
  const ct = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function (d) {
    const s = d.size, w = s.width ?? s[0], h = s.height ?? s[1] ?? 1, l = s.depthOrArrayLayers ?? s[2] ?? 1;
    const px = w * h * l * ((d.mipLevelCount || 1) > 1 ? 1.333 : 1) * (d.sampleCount || 1);
    log.tex.push([Math.round((px * (B[d.format] ?? 4)) / 104857.6) / 10, w + 'x' + h + 'x' + l, d.format, d.mipLevelCount || 1, where()]);
    return ct.call(this, d);
  };
  const cb = GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer = function (d) {
    log.buf += d.size; log.bufs++;
    const k = where();
    log.bySrc[k] = (log.bySrc[k] || 0) + d.size;
    return cb.call(this, d);
  };
})();
