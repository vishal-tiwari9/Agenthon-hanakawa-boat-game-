// near-first streaming check: a screenshot at the reveal, frame times while the far reaches stream in
// behind it, then a camera flight up the river from the town into the bamboo gorge (faster than the boat
// can go) to catch any first-sight pipeline build, and a screenshot in the gorge once everything is in.
//   LUMA_PORT=5191 node test/harness.mjs stream-drive --quiet
export default async function (g) {
  await g.shot('stream-reveal');
  const stats = () => g.evalJs(`JSON.stringify((({ startS, idle, stats }) => ({ startS: Math.round(startS), idle, ...stats }))(__luma.ctx.services.stream))`);
  console.log('stream at ready', await stats());
  // per-frame record: wall dt, render ms, pipelines created this frame, stream progress
  await g.evalJs(`(() => {
    const c = __luma.ctx, r = c.render, st = c.services.stream;
    const pipes = () => { try { return c.renderer._pipelines.caches.size; } catch { return -1; } };
    window.__fr = []; let last = performance.now();
    c.render = () => {
      const p0 = pipes(), t0 = performance.now();
      r();
      const t = performance.now();
      window.__fr.push({ dt: +(t - last).toFixed(1), render: +(t - t0).toFixed(1), newPipes: pipes() - p0, warmed: st.stats.warmed, done: st.stats.done, s: window.__flyS ?? null });
      last = t;
    };
  })()`);
  for (let i = 0; i < 60 && !(await g.evalJs('__luma.ctx.services.stream.idle')); i++) await g.delay(250);
  await g.delay(1000);
  const summarize = (label, fr) => {
    const slow = fr.filter((f) => f.dt > 50);
    const pipes = fr.reduce((n, f) => n + Math.max(0, f.newPipes), 0);
    const sorted = fr.map((f) => f.dt).sort((a, b) => a - b);
    const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    console.log(`${label}: ${fr.length} frames, median ${p(0.5)} ms, p99 ${p(0.99)} ms, max ${sorted[sorted.length - 1]} ms, >50 ms: ${slow.length}, new pipelines: ${pipes}`);
    for (const f of slow.slice(0, 10)) console.log('  slow', JSON.stringify(f));
    for (const f of fr.filter((x) => x.newPipes > 0).slice(0, 10)) console.log('  pipes', JSON.stringify(f));
  };
  const streaming = await g.evalJs('window.__fr.splice(0)');
  summarize('while streaming', streaming.slice(2));
  console.log('stream drained', await stats());

  // attribute slow frames: time every per-frame update callback, keep the slowest per frame
  await g.evalJs(`(() => {
    const loop = __luma.ctx.services.loop;
    window.__slowest = { name: '', ms: 0 };
    loop.updates.forEach((e, i) => {
      const fn = e.fn, name = (fn.name || 'anon') + '@' + e.order;
      e.fn = (c) => { const t = performance.now(); fn(c); const ms = performance.now() - t; if (ms > window.__slowest.ms) window.__slowest = { name, ms: +ms.toFixed(1) }; };
    });
    const r = __luma.ctx.render;
    __luma.ctx.render = () => { r(); const f = window.__fr[window.__fr.length - 1]; if (f) f.top = window.__slowest; window.__slowest = { name: '', ms: 0 }; };
  })()`);
  // fly: 25 m/s up the river from the village to the gorge, 4 m up, looking 60 m ahead
  await g.evalJs(`(() => {
    const c = __luma.ctx, V = c.camera.position.constructor;
    let s = 250;
    window.__flyS = s;
    window.__flyOff = c.onUpdate((cc) => {
      s = Math.min(1150, s + 25 * Math.min(0.05, cc.time.frameDt));
      window.__flyS = Math.round(s);
      const f = __luma.river(s), a = __luma.river(s + 60);
      cc.cameraRig.setOverride(new V(f.x, 4, f.z), new V(a.x, 3, a.z));
    }, 49);
  })()`);
  await g.delay(200);
  for (let i = 0; i < 240 && (await g.evalJs('window.__flyS')) < 1150; i++) await g.delay(250);
  const fly = await g.evalJs('window.__fr.splice(0)');
  await g.evalJs('window.__flyOff?.()');
  summarize('flight s 250-1150', fly.slice(2));
  // by reach: the far pieces start at s 1080 (covered bridge); the town is s < 720
  const buckets = {};
  for (const f of fly.slice(2)) {
    const b = Math.floor((f.s ?? 0) / 150) * 150;
    const e = (buckets[b] ??= { frames: 0, over50: 0, maxMs: 0, pipes: 0, tops: {} });
    e.frames++; e.pipes += Math.max(0, f.newPipes); e.maxMs = Math.max(e.maxMs, f.dt);
    if (f.dt > 50) { e.over50++; const k = f.top?.name ?? '?'; e.tops[k] = (e.tops[k] ?? 0) + 1; }
  }
  for (const [b, e] of Object.entries(buckets)) console.log(`  s ${b}-${+b + 150}: ${JSON.stringify(e)}`);
  console.log('stream after flight', await stats());
  await g.viewShot('gorge', 'stream-gorge', 2500);
  const late = await g.evalJs(`(() => { const out = {}; __luma.ctx.scene.traverse((o) => { if (/^(bridges:(covered-bridge|plank-bridge|landing-teahouse|landing-mill)|structures:(lake|mill))$/.test(o.name)) out[o.name] = { visible: o.visible, parent: o.parent?.name || 'scene', meshes: o.children.length }; }); return out; })()`);
  console.log('late pieces', JSON.stringify(late));
  if (g.errors.length) console.log(g.errors.slice(0, 5).join('\n'));
}
