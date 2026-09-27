// water + audio under the day cycle: opening-view water shots at the default look, day(15,'rain'),
// day(19,'storm') and day(1,'clear'), plus a muted probe of the weather audio graph (rain gain at rain 0
// and 1, thunder scheduled after a lightning event, the night chorus, birds fading).
// chrome runs muted (--mute-audio); levels come from AnalyserNodes before the destination.
// usage: node test/harness.mjs weather-wa --tag=weather-wa --quiet [--shots [--looks=15:rain,19:storm]: water shots only]
export default async function (g) {
  if (g.args.shots) {
    await g.delay(1500);
    await g.luma(`(() => { document.querySelector('.title-start')?.click(); return true; })()`);
    await g.luma(`L.view('opening')`);
    const looks = (g.args.looks || '15:rain,19:storm').split(',').map((l) => l.split(':'));
    for (const [h, w] of looks) {
      await g.luma(`L.day(${h}, '${w}')`);
      await g.delay(3500);
      console.log(`[wa] wake ${w}:`, JSON.stringify(await g.luma(`L.ctx.services.water.debug.wakeProbe()`)));
      await g.shot(`opening-${h}-${w}-v2`);
    }
    console.log('[wa] stats', JSON.stringify(await g.stats()));
    if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 8).join('\n').slice(0, 3000));
    return;
  }
  const A = 'L.ctx.services.audio';
  const log = (label, v) => console.log(`[wa] ${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const W = () => g.luma(`${A}.stats()?.weather ?? null`);
  const dayState = () => g.luma(`(() => { const d = L.ctx.services.day; return { h: +d.hours.toFixed(2), night: +d.night.toFixed(2), twi: +d.twilight.toFixed(2), cloud: d.cloud, rain: d.rain, storm: d.storm, weather: d.weather }; })()`);
  const pick = (m, keys) => Object.fromEntries(keys.map((k) => [k, m?.[k]]));
  const buses = ['rain', 'thunder', 'night', 'wind', 'birds', 'river', 'ambience', 'master'];

  await g.delay(1500);
  await g.luma(`(() => { document.querySelector('.title-start')?.click(); return true; })()`);
  await g.evalJs(`document.getElementById('game').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }))`);
  await g.delay(2500);
  log('audio', await g.luma(`({ started: ${A}.started, state: ${A}.context?.state })`));

  // defaults: nothing weather-related is built
  await g.luma(`L.view('opening')`);
  await g.delay(2500);
  log('default day', await dayState());
  log('default weather audio (expect voices:false, no rain/thunder/night bus)', await W());
  log('default levels', pick(await g.luma(`${A}.levels()`), buses));
  await g.shot('opening-default');

  // rain gain at rain = 0 (cloudy builds the graph without rain) and at rain = 1
  await g.luma(`L.day(15, 'cloudy')`);
  await g.delay(2500);
  log('day(15,cloudy)', await dayState());
  log('weather audio rain=0', await W());
  log('meter rain=0', pick(await g.luma(`${A}.meter(1200)`), buses));

  await g.luma(`L.day(15, 'rain')`);
  await g.delay(3000);
  log('day(15,rain)', await dayState());
  log('weather audio rain=1', await W());
  log('meter rain=1', pick(await g.luma(`${A}.meter(1200)`), buses));
  log('wake', await g.luma(`L.ctx.services.water.debug.wakeProbe()`));
  await g.shot('opening-15-rain');

  // thunder: no storm here, so the only strike is ours. 686 m -> 2.0 s true, eased to ~1.56 s
  const before = await W();
  const t0 = await g.luma(`(() => { L.ctx.events.emit('weather:lightning', { distance: 686, strength: 1 }); return ${A}.context.currentTime; })()`);
  const after = await W();
  log('thunder scheduled', { emittedAt: +t0.toFixed(3), thundersBefore: before?.thunders, thundersAfter: after?.thunders, delay: after?.lastDelay, startsAt: after?.lastThunderAt });
  log('thunder bus right after emit (expect silent)', pick(await g.luma(`${A}.levels()`), ['thunder']));
  await g.delay(Math.max(0, (after?.lastDelay ?? 1.5) * 1000 - 150));
  log('thunder bus after the delay (expect loud)', pick(await g.luma(`${A}.meter(900)`), ['thunder', 'ambience', 'master']));

  // storm at dusk: natural lightning + thunder, howl, heavy patter
  await g.luma(`L.day(19, 'storm')`);
  await g.delay(3500);
  log('day(19,storm)', await dayState());
  log('weather audio storm', await W());
  log('meter storm', pick(await g.luma(`${A}.meter(1500)`), buses));
  log('wake', await g.luma(`L.ctx.services.water.debug.wakeProbe()`));
  await g.shot('opening-19-storm');

  // clear night: crickets, frogs, moon glint; birds silent
  await g.luma(`L.day(1, 'clear')`);
  await g.delay(4000);
  log('day(1,clear)', await dayState());
  log('weather audio night', await W());
  log('meter night', pick(await g.luma(`${A}.meter(1500)`), buses));
  await g.shot('opening-1-clear');

  await g.luma(`L.day(null)`);
  await g.delay(1500);
  log('released', await dayState());
  log('stats', await g.stats());
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 8).join('\n').slice(0, 3000));
}
