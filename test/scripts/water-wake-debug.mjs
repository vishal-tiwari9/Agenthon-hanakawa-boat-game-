// water: is the wave sim reaching the image? debug views (6 = wake: r height, g turbulence, b slope; 4 = normal)
export default async function (g) {
  const U = 'L.ctx.services.water.uniforms.uDebug';
  await g.delay(1200);
  await g.luma('L.clearView()');
  await g.luma(`(() => { document.querySelector('.title-start')?.click(); L.ctx.input.gameplayEnabled = true; const B = L.ctx.boat; if (B && B.docked) B.undock(); return true; })()`);
  await g.delay(600);
  await g.luma("L.hold('forward', true)");
  await g.delay(4000);
  await g.luma('L.releaseAll()');
  await g.delay(1500);
  console.log('probe', JSON.stringify(await g.luma('L.ctx.services.water.debug.wakeProbe()')));
  await g.luma(`${U}.value = 6`);
  await g.delay(100);
  await g.shot('dbg-follow-6');
  await g.luma(`${U}.value = 4`);
  await g.delay(100);
  await g.shot('dbg-follow-4');
  const [x, z] = await g.luma('[L.ctx.boat.position.x, L.ctx.boat.position.z]');
  await g.luma(`${U}.value = 6`);
  await g.luma(`L.look([${x}, 30, ${z + 0.5}], [${x}, 0, ${z}])`);
  await g.delay(150);
  await g.shot('dbg-top-6');
  await g.luma(`${U}.value = 0`);
  await g.delay(100);
  await g.shot('dbg-top-0');
  await g.luma('L.clearView()');
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 5).join('\n').slice(0, 2000));
}
