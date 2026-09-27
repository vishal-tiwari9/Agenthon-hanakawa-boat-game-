// vegetation smoke check: boots on the given backend, shoots the close-up at the current quality,
// switches quality low -> high (tiles rebuild on the 'quality' event), and reports errors.
// usage: node test/harness.mjs vegetation-check --tag=vegetation [--backend=webgl]
export default async function (g) {
  await g.evalJs(`(() => { const s = document.createElement('style'); s.textContent = '#ui, #loading { display: none !important; }'; document.head.appendChild(s); })()`);
  const b = g.args.backend || 'webgpu';
  // meadow near the harbor: eye 1.7 m above the ground, looking across the grass toward the sea
  const look = `(() => { const w = L.ctx.world, ex = -139.5, ez = 146.6; L.look([ex, w.heightAt(ex, ez) + 1.7, ez], [-120, w.heightAt(-127.5, 158.6) - 1, 170]); })()`;
  await g.luma(look);
  await g.delay(2500);
  await g.shot(`check-${b}-${await g.luma('L.ctx.quality.name')}`);
  console.log('veg', JSON.stringify(await g.luma('L.ctx.services.vegetation.stats()')));
  const before = g.errors.length;
  for (const q of ['low', 'high']) {
    await g.luma(`L.setQuality(${JSON.stringify(q)})`);
    await g.delay(3000);
    await g.shot(`check-${b}-${q}`);
    console.log(q, JSON.stringify(await g.luma('L.ctx.services.vegetation.stats()')), JSON.stringify(await g.stats()));
  }
  await g.luma(`L.setQuality('balanced')`);
  await g.luma(`L.view('harbor-wide')`);
  await g.delay(2000);
  await g.shot(`check-${b}-harbor-wide`);
  const veg = g.errors.filter((e) => /vegetation|grass|flower|shrub|tree/i.test(e));
  console.log(`errors: ${g.errors.length} total, ${g.errors.length - before} after quality switches, ${veg.length} mentioning vegetation`);
  for (const e of veg.slice(0, 5)) console.log('  ', e.slice(0, 300));
}
