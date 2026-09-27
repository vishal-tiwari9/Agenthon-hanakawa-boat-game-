// look variants side by side: each view is set once, then every variant (__lumaRender.dream values
// from a json file: [{ name, ...values }]) is applied and shot. --variants=/path.json --views=a+b
import { readFile } from 'node:fs/promises';

export default async function (g) {
  const variants = JSON.parse(await readFile(g.args.variants, 'utf8'));
  const rp = (s, lat, y) => g.evalJs(`import('/src/world/layout.ts').then((m) => { const f = m.riverFrame(${s}); return [f.x + f.nx * ${lat}, ${y}, f.z + f.nz * ${lat}]; })`);
  await g.delay(1200);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(600);
  await g.evalJs(`(() => { const s = document.createElement('style'); s.textContent = '#ui { display: none !important; }'; document.head.appendChild(s); })()`);
  const views = {
    landing: null,
    town: [[330, 0, 3.2], [470, 0, 5]],
    torii: [[418, 1, 3.4], [440, 8, 0]],
    bridge: [[268, -3, 2.6], [300, 0, 4]],
    castle: [[460, 4, 4], [520, -150, 30]],
  };
  const only = (g.args.views || 'landing+town+torii').split('+');
  for (const name of only) {
    const v = views[name];
    if (v) await g.luma(`L.look(${JSON.stringify(await rp(...v[0]))}, ${JSON.stringify(await rp(...v[1]))})`);
    else await g.luma('L.clearView()');
    await g.delay(1800);
    for (const vr of variants) {
      await g.evalJs(`__lumaRender.dream(${JSON.stringify(vr)})`);
      await g.delay(350);
      await g.shot(`${name}-${vr.name}`);
    }
  }
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 5).join('\n'));
}
