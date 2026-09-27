// evaluate a snippet in the page (after boot), wait, then screenshot a view.
// node test/harness.mjs render-eval --tag=render --js="__lumaRender.postOptions({ao:true})" [--view=harbor] [--name=x]
export default async function (g) {
  const view = g.args.view || 'harbor';
  await g.delay(1200);
  await g.evalJs(`(() => { const s = document.createElement('style'); s.textContent = '#ui, #loading { display: none !important; }'; document.head.appendChild(s); })()`);
  await g.luma(`L.view(${JSON.stringify(view)})`);
  if (g.args.js) console.log('eval ->', JSON.stringify(await g.evalJs(g.args.js)));
  await g.delay(Number(g.args.wait) || 2500);
  await g.shot(`eval-${g.args.name || view}`);
  console.log('stats', JSON.stringify(await g.stats()));
}
