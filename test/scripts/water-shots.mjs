// water: screenshots of named views plus custom looks (--looks=name:x,y,z:tx,ty,tz;...)
export default async function (g) {
  const b = g.args.backend || 'webgpu';
  const q = g.args.quality || 'balanced';
  await g.delay(1500);
  // dismiss the title card so it does not cover the water
  if (!g.args.title) await g.luma(`(() => { document.querySelector('.title-start')?.click(); return true; })()`);
  const info = await g.luma('L.ctx.services.water ? L.ctx.services.water.debug.info() : null');
  console.log('water', JSON.stringify(info));
  if (g.args.debug) await g.luma(`L.ctx.services.water.uniforms.uDebug.value = ${Number(g.args.debug)}`);
  const sfx = g.args.debug ? `-dbg${g.args.debug}` : '';
  const views = (g.args.views || 'harbor,open-water,cove').split(',').filter(Boolean);
  for (const v of views) await g.viewShot(v, `${v}-${b}-${q}${sfx}`, Number(g.args.settle) || 2000);
  if (g.args.looks) {
    for (const l of g.args.looks.split(';')) {
      const [name, p, t] = l.split(':');
      await g.luma(`L.look([${p}],[${t}])`);
      await g.delay(Number(g.args.settle) || 2000);
      await g.shot(`${name}-${b}-${q}${sfx}`);
    }
  }
  console.log('stats', JSON.stringify(await g.stats()));
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 8).join('\n').slice(0, 3000));
}
