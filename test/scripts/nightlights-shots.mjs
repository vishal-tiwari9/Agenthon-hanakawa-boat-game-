// night lamps (lanterns, windows, boat lights) at the opening view: night, dusk and the authored day.
// node test/harness.mjs nightlights-shots --tag=nightlights --quiet [--view=opening]
const SHOTS = [['night', 1, 'clear'], ['dusk', 19.3, 'clear'], ['day', 8.62, 'clear']];

export default async function (g) {
  const view = g.args.view || 'opening';
  await g.delay(1500);
  await g.evalJs(`(() => { const s = document.createElement('style'); s.textContent = '#ui, #loading { display: none !important; }'; document.head.appendChild(s); })()`);
  await g.luma(`L.view(${JSON.stringify(view)})`);
  await g.delay(2500);
  for (const [name, h, w] of SHOTS) {
    await g.luma(`L.day(${h}, ${JSON.stringify(w)})`);
    await g.delay(2000);
    await g.shot(`${view}-${name}`);
  }
  await g.luma('L.day(null)');
  console.log('stats', JSON.stringify(await g.stats()));
}
