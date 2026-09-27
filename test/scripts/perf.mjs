// measures frame time over a few seconds at the given views. rAF is pumped by a 4ms timer,
// so fps here is gpu/cpu-bound throughput, not vsync-limited.
export default async function (g) {
  const views = (g.args.views || 'harbor,open-water').split(',');
  for (const v of views) {
    await g.luma(`L.view(${JSON.stringify(v)})`);
    await g.delay(2000);
    const a = await g.stats();
    await g.delay(4000);
    const b = await g.stats();
    const frames = b.frames - a.frames;
    console.log(`perf ${v}: ${(frames / 4).toFixed(1)} fps (${(4000 / frames).toFixed(2)} ms/frame), calls ${b.calls}, tris ${b.triangles}`);
  }
}
