// look check in one browser run: landing, cruise, town past the bridge, torii shallows, red bridge
export default async function (g) {
  await g.delay(1200);
  const rp = (s, lat, y) => g.evalJs(`import('/src/world/layout.ts').then((m) => { const f = m.riverFrame(${s}); return [f.x + f.nx * ${lat}, ${y}, f.z + f.nz * ${lat}]; })`);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(500);
  await g.luma('L.clearView()');
  await g.delay(700);
  await g.shot('landing');
  await g.luma("L.press('interact')");
  await g.delay(400);
  await g.luma("L.hold('forward', true)");
  await g.delay(9000);
  await g.shot('cruise');
  await g.luma('L.releaseAll()');
  const views = [
    ['town-past-bridge', [330, 0, 3.2], [470, 0, 5]],
    ['torii-shallows', [418, 1, 3.4], [440, 8, 0]],
    ['bridge', [268, -3, 2.6], [300, 0, 4]],
  ];
  const only = g.args.views ? g.args.views.split('+') : null;
  for (const [name, a, b] of views) {
    if (only && !only.includes(name)) continue;
    await g.luma(`L.look(${JSON.stringify(await rp(...a))}, ${JSON.stringify(await rp(...b))})`);
    await g.delay(2200);
    await g.shot(name);
  }
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 5).join('\n'));
}
