// cold startup over a throttled network (default 40 mbit/s, 30 ms rtt), cache disabled. prints the
// startup phases, bytes by kind and the largest downloads. run against the production preview:
//   MBPS=40 LUMA_PORT=5191 node test/harness.mjs startup-net --quiet
export default async function (g, args = {}) {
  const mbps = Number(process.env.MBPS ?? args.mbps ?? 40);
  await g.send('Network.enable');
  await g.send('Network.setCacheDisabled', { cacheDisabled: true });
  await g.send('Network.emulateNetworkConditions', { offline: false, latency: 30, downloadThroughput: (mbps * 1e6) / 8, uploadThroughput: 2e6 });
  await g.evalJs('window.__oldPage = true');
  await g.send('Page.reload', { ignoreCache: true });
  for (let i = 0; i < 200 && (await g.evalJs('!!window.__oldPage').catch(() => true)); i++) await g.delay(20);
  const t0 = Date.now();
  while (!(await g.evalJs('!!window.__lumaReady').catch(() => false))) {
    if (Date.now() - t0 > 240000) { console.log('TIMEOUT waiting for ready'); break; }
    await g.delay(200);
  }
  const r = await g.evalJs(`(() => {
    const s = window.__luma?.ctx?.services?.startup ?? {};
    const res = performance.getEntriesByType('resource');
    const kinds = {};
    for (const e of res) { const k = (e.name.split('?')[0].match(/\\.([a-z0-9]+)$/i)?.[1] ?? 'other'); kinds[k] = (kinds[k] ?? 0) + e.encodedBodySize; }
    const top = res.map((e) => [Math.round(e.encodedBodySize / 1024), Math.round(e.responseEnd), e.name.replace(location.origin, '')]).sort((a, b) => b[0] - a[0]).slice(0, 30);
    const total = res.reduce((a, e) => a + e.encodedBodySize, 0);
    return { playableMs: s.firstPlayableMs, phases: s.phases, warmMs: s.warmMs, settleMs: s.settleMs, files: res.length, totalMB: +(total / 1048576).toFixed(1),
      kindsMB: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, +(v / 1048576).toFixed(2)]).sort((a, b) => b[1] - a[1])), top };
  })()`);
  console.log(JSON.stringify({ ...r, top: undefined }, null, 1));
  // WRITE_PRELOAD=1 regenerates public/preload.json: every data file the cold start requested before the
  // reveal, first request first (what streams in after the reveal is fetched when it is needed)
  if (process.env.WRITE_PRELOAD) {
    const list = await g.evalJs(`performance.getEntriesByType('resource')
      .filter((e) => e.startTime < window.__luma.ctx.services.startup.firstPlayableMs)
      .filter((e) => e.initiatorType !== 'script' && e.initiatorType !== 'link' && e.initiatorType !== 'css')
      .sort((a, b) => a.startTime - b.startTime)
      .map((e) => e.name.replace(location.origin, ''))
      .filter((u) => /^\\/(assets|world)\\//.test(u) && !/\\.(js|css|woff2?)(\\?|$)/.test(u) && !/world\\.json/.test(u))`);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(new URL('../../public/preload.json', import.meta.url), JSON.stringify([...new Set(list)], null, 0) + '\n');
    console.log('preload.json', list.length, 'files');
  }
  for (const t of r.top) console.log(t.join('\t'));
}
