// render tuning shots. screenshots views, optionally under several live render settings.
// node test/harness.mjs render-shots --tag=render [--views=harbor,cove] [--name=suffix]
//   [--variants={"tm":"agx","exp":1.2};{"tm":"neutral"}]   (keys: see window.__lumaRender.set)
//   [--look=x,y,z,tx,ty,tz]   (custom camera instead of named views)
export default async function (g) {
  const views = (g.args.views || 'harbor,open-water,cliffside,cove').split(',');
  const variants = g.args.variants ? g.args.variants.split(';').map((v) => JSON.parse(v)) : [null];
  const suffix = g.args.name ? `-${g.args.name}` : '';
  await g.delay(1500);
  // hide the game ui overlay so the shots show only the scene (pass --ui to keep it)
  if (!g.args.ui) await g.evalJs(`(() => { const s = document.createElement('style'); s.textContent = '#ui, #loading { display: none !important; }'; document.head.appendChild(s); })()`);
  const has = await g.evalJs('!!window.__lumaRender');
  if (!has) console.log('render module did not publish __lumaRender');
  const targets = g.args.look ? [['look', g.args.look.split(',').map(Number)]] : views.map((v) => [v, null]);
  for (const [v, look] of targets) {
    if (look) await g.luma(`L.look(${JSON.stringify(look.slice(0, 3))}, ${JSON.stringify(look.slice(3, 6))})`);
    else await g.luma(`L.view(${JSON.stringify(v)})`);
    await g.delay(1500);
    for (let i = 0; i < variants.length; i++) {
      if (variants[i] && has) await g.evalJs(`__lumaRender.set(${JSON.stringify(variants[i])})`);
      await g.delay(variants[i] ? 700 : 100);
      await g.shot(`${v}${suffix}${variants.length > 1 ? `-v${i}` : ''}`);
    }
  }
  console.log('stats', JSON.stringify(await g.stats()));
}
