// structures: stats + screenshots of the named river views and close-ups of each building type.
// --only=opening,village,pagoda,lake,teahouse,house,shrine,pagoda-close,torii,mill to limit.
export default async function (g) {
  await g.delay(2500);
  await g.evalJs(`(() => { const u = document.getElementById('ui'); if (u) u.style.visibility = 'hidden'; })()`);
  const only = g.args.only ? g.args.only.split(',') : null;
  const want = (k) => !only || only.includes(k);
  const tag = g.args.backend || 'webgpu';
  console.log('structures', JSON.stringify(await g.luma('L.ctx.services.structures ? L.ctx.services.structures.stats() : null')));
  const look = async (name, pos, tgt, settle = 1400) => {
    await g.luma(`L.look(${JSON.stringify(pos)}, ${JSON.stringify(tgt)})`);
    await g.delay(settle);
    await g.shot(`${name}-${tag}`);
  };
  for (const v of ['opening', 'village', 'pagoda', 'lake', 'teahouse']) if (want(v)) await g.viewShot(v, `${v}-${tag}`, 2000);
  // river-relative camera helper evaluated in the page: [s, lateral from centerline, y]
  const rp = (s, lat, y) => g.luma(`(async () => { const m = await import('/src/world/layout.ts'); const f = m.riverFrame(${s}); return [f.x + f.nx * (${lat}), ${y}, f.z + f.nz * (${lat})]; })()`);
  const bank = (s, side, off, y) => g.luma(`(async () => { const m = await import('/src/world/layout.ts'); const p = m.bankPoint(${s}, ${side}, ${off}); return [p.x, ${y}, p.z]; })()`);
  if (want('house')) await look('house-close', await rp(205, -6, 2.2), await bank(222, -1, 9, 4.5));
  if (want('houses-right')) await look('houses-right', await rp(215, -4, 2.4), await bank(250, 1, 8, 4));
  if (want('shrine')) await look('shrine-close', await rp(262, -8, 2.2), await bank(272, -1, 14, 2.2));
  if (want('pagoda-close')) await look('pagoda-close', await rp(372, 6, 3), await bank(392, 1, 42, 16));
  if (want('torii')) await look('torii-close', await rp(425, -5, 2), await bank(440, 1, -2, 3.5));
  if (want('mill')) await look('mill-close', await rp(1975, 4, 2.5), await bank(1992, -1, 4, 2.5));
  if (want('teahouse-close')) await look('teahouse-close', await rp(1685, 20, 2.5), await bank(1702, 1, -6, 2.5));
  console.log('stats', JSON.stringify(await g.stats()));
  if (g.errors.length) console.log('errors:', g.errors.slice(0, 5).join('\n'));
}
