// integration tour: the four views the brief asks to inspect, plus the opening shot as the player sees it.
export default async function (g) {
  const b = g.args.backend || 'webgpu';
  const q = g.args.quality || 'balanced';
  await g.delay(2500);
  await g.shot(`opening-${b}-${q}`);
  for (const v of (g.args.views || 'opening,village,red-bridge,pagoda,gorge,lake,teahouse,falls').split(',')) await g.viewShot(v, `${v}-${b}-${q}`, 2200);
  await g.luma('L.clearView()');
  console.log('stats', JSON.stringify(await g.stats()));
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 10).join('\n'));
}
