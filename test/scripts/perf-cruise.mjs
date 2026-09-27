// frame rate while actually boating: follow camera, full throttle up the village and under the red bridge
export default async function (g) {
  await g.delay(1200);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(400);
  await g.luma("L.press('interact')");
  await g.luma("L.hold('forward', true)");
  await g.delay(3000);
  const a = await g.stats(); await g.delay(8000); const b = await g.stats();
  const f = (b.frames - a.frames) / 8;
  console.log(`perf cruise: ${f.toFixed(1)} fps (${(1000 / f).toFixed(2)} ms/frame) from s-position ${JSON.stringify(a.boat)} to ${JSON.stringify(b.boat)}`);
  await g.luma('L.releaseAll()');
  const c = await g.stats(); await g.delay(4000); const d = await g.stats();
  console.log(`perf coasting/idle: ${((d.frames - c.frames) / 4).toFixed(1)} fps`);
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 3).join('\n'));
}
