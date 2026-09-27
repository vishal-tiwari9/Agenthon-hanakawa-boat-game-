// terrain: boot, report terrain stats and errors, screenshot a few views.
// --views=opening,gorge  --hide=vegetation,structures (optional isolation)
export default async function (g) {
  await g.delay(2000);
  const tag = g.args.backend || 'webgpu';
  if (g.args.hide) {
    for (const n of g.args.hide.split(',')) {
      await g.luma(`(() => { const s = L.ctx.services[${JSON.stringify(n)}]; const r = s && (s.root || s.mesh || s.group); if (r) r.visible = false; return !!r; })()`);
    }
  }
  console.log('terrain', JSON.stringify(await g.luma('L.ctx.services.terrain ? L.ctx.services.terrain.stats() : null')));
  for (const v of (g.args.views || 'opening').split(',')) {
    await g.viewShot(v, `${v}-${tag}`, 2500);
    console.log(v, JSON.stringify(await g.luma('L.ctx.services.terrain.stats()')), JSON.stringify((await g.stats()).calls));
  }
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 8).join('\n'));
}
