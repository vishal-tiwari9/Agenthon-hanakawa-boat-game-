// rain debug: state of the rain mesh under a frozen rain, plus a shot with loud streaks
export default async function (g) {
  await g.delay(1500);
  await g.evalJs(`(() => { const s = document.createElement('style'); s.textContent = '#ui, #loading { display: none !important; }'; document.head.appendChild(s); })()`);
  await g.luma(`L.view('opening')`);
  await g.luma(`L.day(15, 'rain')`);
  await g.delay(2000);
  console.log(JSON.stringify(await g.evalJs(`(() => { const r = __lumaRender.service.rain; const m = r.mesh;
    return { visible: m.visible, count: m.count, layers: m.layers.mask, parent: !!m.parent, color: r.uColor.value.toArray(), op: r.uOpacity.value, px: r.uPixel.value, speed: r.uSpeed.value,
      cam: __luma.ctx.camera.position.toArray().map(v => +v.toFixed(1)), camLayers: __luma.ctx.camera.layers.mask, info: __luma.ctx.renderer.info.render }; })()`)));
  await g.evalJs(`(() => { const r = __lumaRender.service.rain; r.uColor.value.set(3, 0, 0); r.uOpacity.value = 1; })()`);
  await g.delay(300);
  await g.shot('rain-debug');
}
