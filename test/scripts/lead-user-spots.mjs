// the user's complaint spots: the red bridge from the water, and the shallows by the water torii
export default async function (g) {
  await g.delay(2000);
  const rp = (s, lat, y) => g.evalJs(`import('/src/world/layout.ts').then((m) => { const f = m.riverFrame(${s}); return [f.x + f.nx * ${lat}, ${y}, f.z + f.nz * ${lat}]; })`);
  await g.luma(`L.look(${JSON.stringify(await rp(268, -3, 2.6))}, ${JSON.stringify(await rp(300, 0, 4))})`);
  await g.delay(2200);
  await g.shot('bridge');
  await g.luma(`L.look(${JSON.stringify(await rp(418, 1, 3.4))}, ${JSON.stringify(await rp(440, 8, 0))})`);
  await g.delay(2200);
  await g.shot('torii-shallows');
  await g.luma(`L.look(${JSON.stringify(await rp(250, 0, 5))}, ${JSON.stringify(await rp(420, 0, 6))})`);
  await g.delay(2200);
  await g.shot('past-bridge');
}
