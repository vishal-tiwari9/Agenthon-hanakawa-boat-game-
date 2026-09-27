// the town past the bridge from the water, and the castle across the rooftops
export default async function (g) {
  await g.delay(2500);
  const rp = (s, lat, y) => g.evalJs(`import('/src/world/layout.ts').then((m) => { const f = m.riverFrame(${s}); return [f.x + f.nx * ${lat}, ${y}, f.z + f.nz * ${lat}]; })`);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(800);
  await g.luma(`L.look(${JSON.stringify(await rp(330, 0, 3.2))}, ${JSON.stringify(await rp(470, 0, 5))})`);
  await g.delay(2500);
  await g.shot('town-past-bridge');
  await g.luma(`L.look(${JSON.stringify(await rp(460, 4, 4))}, ${JSON.stringify(await rp(520, -150, 30))})`);
  await g.delay(2500);
  await g.shot('castle');
}
