// cpu profile of a cold boot (reload under the sampling profiler), saved for tools/analysis, plus the
// structures and bridges build log lines and startup phases
import { writeFile } from 'node:fs/promises';

export default async function (g) {
  await g.send('Profiler.enable');
  await g.send('Profiler.setSamplingInterval', { interval: 250 });
  await g.send('Profiler.start');
  g.logs.length = 0;
  await g.send('Page.reload', { ignoreCache: false });
  await g.delay(1500);
  for (let i = 0; i < 200; i++) {
    await g.delay(250);
    try { if (await g.evalJs('!!window.__lumaReady')) break; } catch {}
  }
  const { profile } = await g.send('Profiler.stop');
  const out = g.args.out || '/tmp/townperf/profile.cpuprofile';
  await writeFile(out, JSON.stringify(profile));
  console.log('profile saved', out);
  for (const l of g.logs) if (/\[(structures|bridges|startup)\]/.test(l)) console.log(l.slice(0, 600));
}
