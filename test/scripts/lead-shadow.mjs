// shadow stability under motion: cruise past the village and grab consecutive frames
export default async function (g) {
  await g.delay(1200);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(400);
  await g.luma("L.press('interact')");
  await g.luma("L.hold('forward', true)");
  await g.delay(6000);
  for (let i = 0; i < 4; i++) { await g.shot('seq-' + i); await g.delay(120); }
  console.log('boat', JSON.stringify((await g.stats()).boat));
  console.log('forest', JSON.stringify(await g.luma('L.ctx.services.vegetation.forest.stats')));
  await g.luma('L.releaseAll()');
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 5).join('\n'));
}
