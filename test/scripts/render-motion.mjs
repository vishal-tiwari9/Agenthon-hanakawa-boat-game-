// temporal stability check: the camera pans and dollies continuously (driven inside the page every
// 16 ms) and screenshots are taken mid-motion, to spot taa ghosting on water / thin geometry and
// shadow shimmer. node test/harness.mjs render-motion --tag=render [--quality=high] [--name=x]
export default async function (g) {
  const name = g.args.name || g.args.quality || 'balanced';
  await g.delay(1200);
  await g.evalJs(`(() => { const s = document.createElement('style'); s.textContent = '#ui, #loading { display: none !important; }'; document.head.appendChild(s); })()`);
  // harbor: slide sideways along the jetty while yawing
  await g.evalJs(`(() => {
    const L = window.__luma; const t0 = performance.now();
    window.__mover = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      const x = -190 + t * 4, z = 50 - t * 2.5;
      L.look([x, 4.5, z], [x + 60, 1.5 + Math.sin(t) * 2, z - 60 + t * 6]);
    }, 16);
  })()`);
  await g.delay(1500);
  await g.shot(`motion-${name}-a`);
  await g.delay(700);
  await g.shot(`motion-${name}-b`);
  await g.evalJs('clearInterval(window.__mover)');
  await g.delay(1200);
  await g.shot(`motion-${name}-still`);
}
