// night lamps with the sun and sky light forced down (debug only), to judge window and lantern glows
// before the render's night lighting lands. node test/harness.mjs nightlights-dark --tag=nightlights --quiet
export default async function (g) {
  await g.delay(1500);
  await g.evalJs(`(() => { const s = document.createElement('style'); s.textContent = '#ui, #loading { display: none !important; }'; document.head.appendChild(s); })()`);
  for (const view of ['opening', 'village']) {
    await g.luma(`L.view(${JSON.stringify(view)})`);
    await g.luma(`L.day(1, 'clear')`);
    await g.delay(2500);
    await g.evalJs(`__lumaRender.set({ sun: 0.01, env: 0.04, probe: 0.04, mist: 0 })`);
    await g.delay(800);
    await g.shot(`${view}-night-dark`);
  }
  await g.luma('L.day(null)');
}
