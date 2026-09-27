// quick look: title-free follow view from the landing, and a view while cruising under way
export default async function (g) {
  await g.delay(1200);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(500);
  await g.luma('L.clearView()');
  await g.delay(700);
  await g.shot('landing');
  await g.luma("L.press('interact')");
  await g.delay(400);
  await g.luma("L.hold('forward', true)");
  await g.delay(9000);
  console.log('cruise', JSON.stringify((await g.stats()).boat));
  await g.shot('cruise');
  await g.luma('L.releaseAll()');
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 5).join('\n'));
}
