// bridges: screenshots of the named views plus custom poses around the bridges, landings,
// embankments and the weir. --views=opening,red-bridge (named views), --only=red-close,stone,...
// (custom poses below), --suffix=name to keep variants apart.
export default async function (g) {
  await g.delay(2500);
  await g.evalJs(`(() => { const u = document.getElementById('ui'); if (u) u.style.visibility = 'hidden'; })()`);
  const st = await g.luma('L.ctx.services.bridges ? L.ctx.services.bridges.stats() : null');
  console.log('bridges', JSON.stringify(st));
  const suf = g.args.suffix ? '-' + g.args.suffix : '';
  const views = g.args.views ? g.args.views.split(',') : [];
  for (const v of views) await g.viewShot(v, `${v}${suf}`, 2200);
  const only = g.args.only ? g.args.only.split(',') : [];
  if (only.length) {
    const poses = await g.luma(`(async () => {
      const m = await import('/src/bridges/views.ts');
      return m.bridgeViews(L.ctx);
    })()`);
    for (const k of only) {
      const p = poses[k];
      if (!p) { console.log('no pose', k); continue; }
      await g.luma(`L.look(${JSON.stringify(p[0])}, ${JSON.stringify(p[1])})`);
      await g.delay(1800);
      await g.shot(`${k}${suf}`);
    }
  }
  console.log('stats', JSON.stringify(await g.stats()));
  if (g.errors.length) console.log('errors:', g.errors.slice(0, 5).join('\n'));
}
