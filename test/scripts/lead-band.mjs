// isolate the horizontal band on the water: same paused frame with mist off, reflection off, post off
export default async function (g) {
  await g.delay(1200);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(400);
  await g.luma("L.press('interact')");
  await g.luma("L.hold('forward', true)");
  await g.delay(9000);
  await g.luma('L.releaseAll()');
  // freeze the pose: copy the follow camera into an override
  await g.luma("(L.look(L.ctx.camera.position.toArray(), L.ctx.camera.position.clone().add(L.ctx.camera.getWorldDirection(new L.ctx.camera.position.constructor()).multiplyScalar(50)).toArray()), L.ctx.paused = true, true)");
  await g.delay(600);
  await g.shot('band-base');
  await g.evalJs("__lumaRender.set({ mist: 0 })");
  await g.delay(600);
  await g.shot('band-nomist');
  await g.evalJs("__lumaRender.set({ mist: 2.7e-3 }); __luma.ctx.services.water.setReflectionEnabled(false)");
  await g.delay(600);
  await g.shot('band-norefl');
  console.log('water info', JSON.stringify(await g.luma('L.ctx.services.water.debug.info()')));
}
