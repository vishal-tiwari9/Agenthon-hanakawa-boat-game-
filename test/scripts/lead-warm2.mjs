export default async function (g) {
  await g.delay(3000);
  const s = await g.luma('L.ctx.services.vegetation.stats()');
  const pick = (o) => Object.fromEntries(Object.entries(o).filter(([k, v]) => /ms|Ms|time/i.test(k) || typeof v === 'number').slice(0, 20));
  console.log('veg', JSON.stringify(pick(s)));
  console.log('forest', JSON.stringify(await g.luma('L.ctx.services.vegetation.forest.stats')));
  console.log('structures', JSON.stringify(await g.luma('L.ctx.services.structures.stats ? L.ctx.services.structures.stats() : null')));
}
