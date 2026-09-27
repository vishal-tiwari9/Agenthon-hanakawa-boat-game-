// water: find who creates a small rgba16float texture that later triggers "destroyed texture" errors
export default async function (g) {
  await g.delay(1000);
  await g.luma(`(() => {
    const d = L.ctx.renderer.backend.device;
    const orig = d.createTexture.bind(d);
    window.__texLog = [];
    d.createTexture = (desc) => {
      const s = desc.size; const w = s.width ?? s[0], h = s.height ?? s[1], z = s.depthOrArrayLayers ?? s[2] ?? 1;
      if (w <= 64 && desc.format === 'rgba16float') window.__texLog.push(w + 'x' + h + 'x' + z + ' ' + (new Error().stack || '').split('\\n').slice(2, 9).join(' | '));
      return orig(desc);
    };
    const od = GPUTexture.prototype.destroy;
    GPUTexture.prototype.destroy = function () {
      if (this.format === 'rgba16float' && this.width <= 64) window.__texLog.push('DESTROY ' + this.width + 'x' + this.height + 'x' + this.depthOrArrayLayers + ' mips ' + this.mipLevelCount + ' ' + (new Error().stack || '').split('\\n').slice(2, 12).join(' | '));
      return od.call(this);
    };
    return true;
  })()`);
  await g.luma(`(() => { document.querySelector('.title-start')?.click(); L.ctx.input.gameplayEnabled = true; return true; })()`);
  await g.delay(2500);
  const log = await g.luma('window.__texLog.slice(0, 6)');
  for (const l of log) console.log('TEX', l.slice(0, 900));
  console.log('errors so far', g.errors.length);
}
