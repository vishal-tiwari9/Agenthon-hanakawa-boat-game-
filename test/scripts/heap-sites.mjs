// live js heap by allocation site (sampling heap profiler across a fresh load, after gc)
//   node test/harness.mjs heap-sites --quiet   (dev server: readable file names)
export default async function (g) {
  await g.send('HeapProfiler.enable');
  await g.send('HeapProfiler.startSampling', { samplingInterval: 65536, includeObjectsCollectedByMajorGC: false, includeObjectsCollectedByMinorGC: false });
  await g.evalJs('window.__oldPage = true');
  await g.send('Page.reload', {});
  for (let i = 0; i < 200 && (await g.evalJs('!!window.__oldPage').catch(() => true)); i++) await g.delay(20);
  while (!(await g.evalJs('!!window.__lumaReady').catch(() => false))) await g.delay(250);
  await g.delay(3000);
  await g.send('HeapProfiler.collectGarbage');
  const { profile } = await g.send('HeapProfiler.stopSampling');
  const bySite = new Map(), byFile = new Map();
  const walk = (n, stack) => {
    const f = n.callFrame, name = `${f.functionName || '(anon)'} ${f.url.replace(/^.*\/src\//, 'src/').replace(/^.*node_modules\//, 'nm/').split('?')[0]}:${f.lineNumber + 1}`;
    const self = n.selfSize || 0;
    if (self) {
      // attribute to the nearest src/ frame on the stack for readability
      const own = [name, ...stack].find((s) => s.includes(' src/')) || name;
      bySite.set(own, (bySite.get(own) || 0) + self);
      const file = own.split(' ')[1]?.split(':')[0] || '?';
      byFile.set(file, (byFile.get(file) || 0) + self);
    }
    for (const c of n.children || []) walk(c, [name, ...stack]);
  };
  walk(profile.head, []);
  const mb = (v) => (v / 1048576).toFixed(1);
  const tot = [...byFile.values()].reduce((a, b) => a + b, 0);
  console.log('sampled live MB', mb(tot));
  for (const [k, v] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log('FILE', mb(v), k);
  for (const [k, v] of [...bySite].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log('SITE', mb(v), k);
}
