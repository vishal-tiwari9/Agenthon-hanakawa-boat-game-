// smoke test: boot, report stats, screenshot the named views (default: harbor).
export default async function (g) {
  await g.delay(1500);
  const views = (g.args.views || 'harbor').split(',');
  for (const v of views) await g.viewShot(v, `${v}-${g.args.backend || 'webgpu'}`);
  console.log('stats', JSON.stringify(await g.stats()));
}
