// the town behind the waterfront (s 0-700): from the water, over the rooftops and from above
export default async function (g) {
  await g.delay(2500);
  const logs = g.logs.filter((l) => l.includes('[structures]'));
  for (const l of logs) console.log(l.slice(0, 300));
  const rp = (s, side, off, y) => g.evalJs(`import('/src/world/layout.ts').then((m) => { const p = m.bankPoint(${s}, ${side}, ${off}); return [p.x, ${y}, p.z]; })`);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(800);
  const only = (g.args.only || '').split(',').filter(Boolean);
  const hero = [
    // the landing looks up the dock lane to the temple gate
    ['landing', await rp(190, -1, -5, 2.4), await rp(191, -1, 60, 6)],
    // from the vermilion bridge into the festival lane
    ['festival', await rp(299, -1, -2, 5.6), await rp(303, -1, 34, 1.5)],
    // up the lane to the shrine torii
    ['shrine-lane', await rp(150, 1, -7, 2.4), await rp(150, 1, 56, 4)],
    // along the inland street at eye level
    ['street-l', await rp(392, -1, 50.5, 1.75), await rp(430, -1, 49.5, 2.2)],
    ['street-r', await rp(560, 1, 49.5, 1.75), await rp(520, 1, 50.5, 2.4)],
    ['paddies', await rp(60, -1, 58, 11), await rp(95, -1, 96, 1)],
    ['garden', await rp(116, -1, 62, 9), await rp(133, -1, 80, 0.5)],
  ];
  const views = g.args.set === 'hero' ? hero : [
    // from the boat, looking across the left bank between and over the houses
    ['water-left', await rp(150, 1, -8, 2.6), await rp(175, -1, 70, 6)],
    ['water-right', await rp(520, -1, -6, 2.6), await rp(545, 1, 70, 8)],
    // over the rooftops
    ['roofs-left', await rp(120, -1, 8, 16), await rp(210, -1, 60, 2)],
    ['roofs-right', await rp(470, 1, 10, 18), await rp(560, 1, 60, 2)],
    ['roofs-left-up', await rp(420, -1, 12, 17), await rp(560, -1, 55, 2)],
    // high over the town
    ['aerial', await rp(60, 1, -10, 90), await rp(330, -1, 40, 0)],
  ];
  for (const [name, from, to] of views) {
    if (only.length && !only.includes(name)) continue;
    await g.luma(`L.look(${JSON.stringify(from)}, ${JSON.stringify(to)})`);
    await g.delay(2200);
    await g.shot(name);
    const s = await g.stats();
    console.log(name, 'draws', s.drawCalls ?? s.calls, 'tris', s.triangles, 'fps', s.fps);
  }
  const st = await g.evalJs('JSON.stringify(__luma.ctx.services.structures?.stats?.())');
  console.log('structures stats', st);
  const bs = await g.evalJs('JSON.stringify(__luma.ctx.services.structures?.debug?.backstreets ?? null)');
  console.log('backstreets', bs);
}
