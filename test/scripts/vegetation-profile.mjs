// cpu profile of a cold startup (reloads the page under the sampling profiler) with the vegetation
// build timings and main-thread long tasks. prints the hottest functions by self and total time.
// options: --focus=vegetation (substring of the url to list separately)
export default async function (g) {
  const focus = g.args.focus || '/src/vegetation/';
  await g.send('Profiler.enable');
  await g.send('Profiler.setSamplingInterval', { interval: 200 });
  await g.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__longTasks = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  ` });
  await g.send('Profiler.start');
  await g.send('Page.reload', {});
  await g.delay(800);
  let ready = false;
  for (let i = 0; i < 240; i++) {
    try { ready = await g.evalJs('!!window.__lumaReady'); } catch {}
    if (ready) break;
    await g.delay(250);
  }
  const { profile } = await g.send('Profiler.stop');
  if (!ready) throw new Error('reload did not become ready');
  const dt = (profile.endTime - profile.startTime) / 1000 / Math.max(1, profile.samples.length);
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  for (const n of profile.nodes) self.set(n.id, (n.hitCount || 0) * dt);
  const key = (n) => {
    const c = n.callFrame;
    const file = c.url ? c.url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '') : '';
    return `${c.functionName || '(anon)'} ${file}:${c.lineNumber + 1}`;
  };
  const selfBy = new Map(), totalBy = new Map();
  const total = (n, stack) => {
    let t = self.get(n.id);
    const k = key(n);
    const rec = stack.has(k);
    stack.add(k);
    for (const c of n.children || []) t += total(byId.get(c), stack);
    if (!rec) stack.delete(k);
    selfBy.set(k, (selfBy.get(k) || 0) + self.get(n.id));
    if (!rec) totalBy.set(k, (totalBy.get(k) || 0) + t);
    return t;
  };
  total(profile.nodes[0], new Set());
  const top = (m, filt, n) => [...m].filter(([k]) => filt(k)).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `${v.toFixed(0).padStart(6)} ms  ${k}`).join('\n');
  console.log('--- self, all');
  console.log(top(selfBy, (k) => !/\((idle|program|garbage collector)\)/.test(k), 25));
  console.log(`--- total, ${focus}`);
  console.log(top(totalBy, (k) => k.includes(focus), 30));
  console.log(`--- self, ${focus}`);
  console.log(top(selfBy, (k) => k.includes(focus), 20));
  console.log('gc', (selfBy.get('(garbage collector) :0') || 0).toFixed(0), 'ms');
  const lt = await g.evalJs('window.__longTasks');
  const big = lt.filter(([, d]) => d > 50);
  console.log('long tasks > 50 ms:', big.length, 'max', Math.max(0, ...lt.map(([, d]) => d)), 'ms', JSON.stringify(big.slice(0, 40)));
  console.log('startup', JSON.stringify(await g.luma('L.ctx.services.startup')));
  const s = await g.luma('L.ctx.services.vegetation.stats()');
  console.log('veg', JSON.stringify(s));
}
