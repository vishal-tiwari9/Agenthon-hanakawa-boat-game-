// perf a/b of the water's weather response: cruise with the storm frozen (worst case) and alternate
// the water's day-cycle response off/on in 4 s windows. run with --query=timelapse:1
export default async function (g) {
  await g.delay(1200);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(400);
  await g.luma(`L.day(17.5, 'storm')`);
  await g.luma("L.press('interact')");
  await g.luma("L.hold('forward', true)");
  await g.delay(3000);
  const win = async (on) => {
    await g.luma(`L.ctx.services.water.debug.weather(${JSON.stringify(on)})`);
    await g.delay(600);
    const a = await g.stats(); await g.delay(4000); const b = await g.stats();
    return +((b.frames - a.frames) / 4).toFixed(1);
  };
  const modes = (g.args.modes || 'true,false,true,false').split(',').map((m) => (m === 'true' ? true : m === 'false' ? false : m));
  const res = {};
  for (const m of modes) (res[String(m)] ??= []).push(await win(m));
  await g.luma('L.releaseAll()');
  console.log(`[wa-perf] storm cruise fps by water weather mode (true = all, false = none): ${JSON.stringify(res)}`);
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 3).join('\n').slice(0, 1500));
}
