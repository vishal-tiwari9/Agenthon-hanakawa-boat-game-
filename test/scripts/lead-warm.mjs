export default async function (g) {
  await g.delay(4000);
  console.log('startup', JSON.stringify(await g.luma('L.ctx.services.startup')));
}
