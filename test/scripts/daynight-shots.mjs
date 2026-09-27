// day/night and weather looks at one view. node test/harness.mjs daynight-shots --tag=daynight --quiet
//   [--view=opening] [--shots=day,dawn,cloudy,rain,storm-flash,storm,night] [--name=suffix]
const PRESETS = {
  day: [8.62, 'clear'],
  dawn: [6.3, 'clear'],
  cloudy: [13, 'cloudy'],
  rain: [15, 'rain'],
  storm: [19, 'storm'],
  'storm-flash': [19, 'storm'],
  night: [1, 'clear'],
  dusk: [18.2, 'clear'],
  'night-moon': [1, 'clear'],
  'dawn-sun': [6.3, 'clear'],
  'dusk-sun': [18.2, 'clear'],
};

export default async function (g) {
  const view = g.args.view || 'opening';
  const shots = (g.args.shots || 'day,dawn,cloudy,rain,storm-flash,storm,night').split(',');
  const suffix = g.args.name ? `-${g.args.name}` : '';
  await g.delay(1500);
  await g.evalJs(`(() => { const s = document.createElement('style'); s.textContent = '#ui, #loading { display: none !important; }'; document.head.appendChild(s); })()`);
  await g.luma(`L.view(${JSON.stringify(view)})`);
  await g.delay(2500);
  for (const name of shots) {
    const [h, w] = PRESETS[name];
    await g.luma(`L.day(${h}, ${JSON.stringify(w)})`);
    if (name === 'night-moon' || name.endsWith('-sun')) {
      // turn from the view's camera toward the moon / the low sun
      const which = name === 'night-moon' ? 'moonDir' : 'sunDir';
      await g.luma(`(() => { const p = L.views[${JSON.stringify(view)}][0]; L.ctx.services.day.update(0); const m = L.ctx.services.day.${which};
        L.look(p, [p[0] + m.x * 100, p[1] + Math.max(m.y, 0.08) * 100 - 18, p[2] + m.z * 100]); })()`);
    }
    await g.delay(1800);
    if (name === 'storm-flash') {
      // wait for the second, stronger flicker of a strike, then grab the frame
      const hit = await g.evalJs(`new Promise((r) => { const d = __luma.ctx.services.day; const t0 = performance.now();
        const f = () => d.flash > 0.45 ? r(d.flash) : performance.now() - t0 > 15000 ? r(-1) : setTimeout(f, 1); f(); })`);
      console.log('flash at capture', hit);
    } else if (name === 'storm') {
      // between strikes
      await g.evalJs(`new Promise((r) => { const d = __luma.ctx.services.day; const t0 = performance.now();
        const f = () => d.flash < 0.002 ? r() : performance.now() - t0 > 15000 ? r() : setTimeout(f, 1); f(); })`);
    }
    await g.shot(`${view}-${name}${suffix}`);
    if (name === 'night-moon' || name.endsWith('-sun')) await g.luma(`L.view(${JSON.stringify(view)})`);
  }
  await g.luma('L.day(null)');
  console.log('stats', JSON.stringify(await g.stats()));
}
