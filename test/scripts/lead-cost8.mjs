// at the slow village pose: water surface, post, and resolution sensitivity
export default async function (g) {
  await g.delay(1200);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(400);
  await g.luma("L.press('interact')");
  await g.luma("L.hold('forward', true)");
  await g.delay(7000);
  await g.luma('L.releaseAll()');
  await g.luma("(L.look(L.ctx.camera.position.toArray(), L.ctx.camera.position.clone().add(L.ctx.camera.getWorldDirection(new L.ctx.camera.position.constructor()).multiplyScalar(40)).toArray()), L.ctx.paused = true, true)");
  const fps = async (label, settle = 1500) => { await g.delay(settle); const a = await g.stats(); await g.delay(3000); const b = await g.stats(); const f = (b.frames - a.frames) / 3; console.log(label.padEnd(30), f.toFixed(1), 'fps', (1000 / f).toFixed(2), 'ms'); };
  await fps('baseline');
  await g.luma("(L.ctx.scene.getObjectByName('water').visible = false, true)"); await fps('no water surface', 4000); await g.luma("(L.ctx.scene.getObjectByName('water').visible = true, true)");
  await g.evalJs('__lumaRender.bypassPost(true)'); await fps('no post (after compile)', 8000); await g.evalJs('__lumaRender.bypassPost(false)');
  await g.shot('slow-pose');
  await g.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await g.evalJs("window.dispatchEvent(new Event('resize'))");
  await fps('baseline at 1280x720', 4000);
}
