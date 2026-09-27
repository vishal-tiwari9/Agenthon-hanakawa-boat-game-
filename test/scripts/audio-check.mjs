// audio: start on a simulated first interaction, then log graph state and per-bus rms levels at the
// village landing, full throttle, the gorge, maiden falls, the lake, the approach to hanakawa falls,
// the weir, plus the temple bell, pause, volume changes, ui cues, hull impacts and tab hiding.
// chrome runs muted (--mute-audio); levels come from AnalyserNodes before the destination.
// usage: node test/harness.mjs audio-check --tag=audio [--backend=webgl] [--quick]
import { RIVER_LENGTH, bankPoint, riverFrame, riverHeading } from '../../src/world/layout.ts';
// other agents edit the project while this runs, and vite's hmr full-reloads the page mid-measurement.
// this script's own headless page ignores hmr messages (pass --hmr to keep them).
const HMR_GUARD = `(() => {
  const WS = window.WebSocket;
  function Guarded(url, protocols) {
    const ws = new WS(url, protocols);
    if (String(protocols).includes('vite')) {
      const add = ws.addEventListener.bind(ws);
      ws.addEventListener = (type, fn, o) => (type === 'message' || type === 'close' ? undefined : add(type, fn, o));
    }
    return ws;
  }
  Guarded.prototype = WS.prototype;
  Object.assign(Guarded, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Guarded;
})();`;

const fmt = (m) => (m ? Object.entries(m).map(([k, v]) => `${k}=${v}`).join(' ') : 'null');

export default async function (g) {
  const A = 'L.ctx.services.audio';
  const log = (label, v) => console.log(`[audio] ${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  // other agents' edits can trigger a vite full reload mid-run; re-arm audio when that happens
  let reloads = 0;
  const ensure = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        if (await g.evalJs('!!window.__lumaReady && !!window.__luma')) break;
      } catch {}
      await g.delay(500);
    }
    const started = await g.luma(`!!${A}?.started`).catch(() => false);
    if (!started) {
      reloads++;
      console.log('[audio] (page reloaded or not started: re-arming audio)');
      await g.evalJs(`document.getElementById('game').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }))`);
      await g.delay(2800);
    }
  };
  const meter = async (label, ms = 1500) => {
    await ensure();
    const m = await g.luma(`${A}.meter(${ms})`);
    log(label, fmt(m));
    return m;
  };

  if (!g.args.hmr) {
    await g.send('Page.addScriptToEvaluateOnNewDocument', { source: HMR_GUARD });
    await g.send('Page.reload', {});
    await g.delay(1000);
    for (let i = 0; i < 120; i++) {
      try {
        if (await g.evalJs('!!window.__lumaReady')) break;
      } catch {}
      await g.delay(500);
    }
    await g.delay(1000);
  }

  log('service before interaction', await g.luma(`({ has: !!${A}, started: ${A}?.started, sounds: ${A}?.sounds })`));

  // count node creation from here on (test-only instrumentation)
  await g.evalJs(`(() => {
    window.__nodes = {};
    const P = BaseAudioContext.prototype;
    for (const m of Object.getOwnPropertyNames(P).filter((n) => n.startsWith('create'))) {
      const orig = P[m];
      P[m] = function (...a) { __nodes[m] = (__nodes[m] || 0) + 1; return orig.apply(this, a); };
    }
  })()`);

  await g.evalJs(`document.getElementById('game').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }))`);
  await g.delay(300);
  log('after pointerdown', await g.luma(`({ started: ${A}.started, state: ${A}.context?.state })`));
  log('nodes created at start', await g.evalJs('window.__nodes'));
  await g.delay(2500);
  await ensure();
  const st0 = await g.luma(`${A}.stats()`);
  log('stats', st0);
  if (!st0 || st0.state !== 'running') {
    console.log('[audio] FAIL: context not running');
    return false;
  }

  const idle = await meter('idle (spawn, follow cam)');
  if (g.args.quick) {
    log('fps', (await g.stats()).fps);
    return;
  }

  // full throttle for a few seconds (the boat spawns moored: cast off first); trace the spool-up
  await g.luma(`(L.ctx.boat?.docked && L.ctx.boat.undock(), true)`);
  await g.delay(300);
  await g.luma(`L.hold('forward', true)`);
  const spool = [];
  for (let i = 0; i < 8; i++) {
    const m = await g.luma(`${A}.meter(250)`);
    spool.push(`${m.engine}dB@${(await g.luma(`${A}.stats()`)).engine.rpm}`);
  }
  log('engine spool (rms@rpm every 300 ms)', spool.join(' '));
  const full = await meter('full throttle');
  log('engine', (await g.luma(`${A}.stats()`)).engine);
  log('boat', (await g.stats()).boat);
  await g.luma(`L.hold('forward', false)`);

  // helm camera, same throttle state decaying
  const hasHelm = await g.luma(`!!L.ctx.cameraRig`);
  if (hasHelm) {
    await g.luma(`L.hold('forward', true)`);
    await g.delay(800);
    const follow = await meter('throttle follow', 1000);
    await g.luma(`L.ctx.cameraRig.setMode('helm')`);
    await g.delay(300);
    const helm = await meter('throttle helm', 1000);
    log('helm - follow engine dB', +(helm.engine - follow.engine).toFixed(1));
    await g.luma(`L.ctx.cameraRig.setMode('follow')`);
    await g.luma(`L.hold('forward', false)`);
  }

  // places along the river: teleport the boat (the follow camera comes along)
  const at = (sAlong, lateral = 0) => {
    const f = riverFrame(sAlong);
    return [+(f.x + f.nx * lateral).toFixed(2), +(f.z + f.nz * lateral).toFixed(2), +riverHeading(sAlong).toFixed(1)];
  };
  const cascadeFoot = riverFrame(962);
  const spots = [
    ['gorge (s 1000)', ...at(1000)],
    ['maiden falls (s 962, near left bank)', ...at(962, -(cascadeFoot.width / 2 - 7))],
    ['lake (s 1720)', ...at(1720)],
    ['falls approach (s 1990)', ...at(1990)],
    ['falls near (s 2095)', ...at(2095)],
    ['weir (s 30)', ...at(30)],
    ['village landing (s 190)', ...at(190, -(riverFrame(190).width / 2 - 6))],
  ];
  const place = {};
  for (const [name, x, z, h] of spots) {
    await ensure();
    await g.luma(`L.ctx.boat ? (L.ctx.boat.teleport(${x}, ${z}, ${h}), true) : (L.look([${x}, 4, ${z}], [${x}, 2, ${z - 50}]), false)`);
    await g.delay(2500);
    place[name] = await meter(name, 2500);
    const s = await g.luma(`${A}.stats()`);
    log(`${name} state`, { site: s.site, bed: s.riverBed, banks: s.banks.length, falls: s.falls, wind: s.wind, chime: s.nearestChime, bell: s.bellDist });
  }

  // temple bell on demand (it also rings by itself every minute or two near the pagoda)
  await g.luma(`${A}.bell()`);
  const bell = await meter('temple bell struck', 2500);

  // pause duck (ui sets ctx.paused and emits 'pause')
  await g.luma(`(L.ctx.paused = true, L.ctx.events.emit('pause'), true)`);
  await g.delay(1500);
  const paused = await meter('paused', 1000);
  await g.luma(`(L.ctx.paused = false, L.ctx.events.emit('resume'), true)`);
  await g.delay(2500);
  const resumed = await meter('resumed', 1000);

  // volume settings, live
  await g.luma(`(L.ctx.events.emit('settings:change', { ambienceVolume: 0.2 }), true)`);
  await g.delay(600);
  const ambLow = await meter('ambienceVolume 0.2', 1000);
  await g.luma(`(L.ctx.events.emit('settings:change', { engineVolume: 0 }), true)`);
  await g.delay(600);
  const engOff = await meter('engineVolume 0', 1000);
  await g.luma(`(L.ctx.events.emit('settings:change', { masterVolume: 0 }), true)`);
  await g.delay(600);
  const masterOff = await meter('masterVolume 0', 800);
  await g.luma(`(L.ctx.events.emit('settings:change', { masterVolume: 0.8, engineVolume: 0.8, ambienceVolume: 0.8 }), true)`);
  await g.delay(800);

  // ui cues and event-driven one-shots
  for (const name of ['complete', 'discovery', 'unlock', 'dock', 'undock', 'toast', 'click']) {
    await g.luma(`${A}.play('${name}')`);
    const m = await g.luma(`${A}.meter(500)`);
    log(`ui ${name}`, `ui=${m.ui} master=${m.master}`);
  }
  await g.luma(`(L.ctx.events.emit('objective:completed', { id: 'test', title: 'Test' }), true)`);
  log('objective:completed ui', (await g.luma(`${A}.meter(500)`)).ui);
  await g.luma(`(() => { const b = L.ctx.boat; L.ctx.events.emit('boat:impact', { strength: 2.5, x: b?.position.x ?? 0, y: 0.3, z: b?.position.z ?? 0 }); return true; })()`);
  log('boat:impact hull', (await g.luma(`${A}.meter(400)`)).hull);
  await g.luma(`(() => { const b = L.ctx.boat; L.ctx.events.emit('boat:splash', { strength: 3, x: b?.position.x ?? 0, y: 0.2, z: b?.position.z ?? 0 }); return true; })()`);
  log('boat:splash hull', (await g.luma(`${A}.meter(400)`)).hull);

  // docked: rope/wood creaks within a few seconds
  await g.luma(`(L.ctx.events.emit('boat:docked', { dockId: 'harbor' }), true)`);
  await g.delay(300);
  const creaks = [];
  for (let i = 0; i < 45; i++) {
    creaks.push(await g.luma(`${A}.levels().hull`));
    await g.delay(150);
  }
  log('docked hull trace max/median (creaks)', `${Math.max(...creaks)} / ${[...creaks].sort((a, b) => a - b)[22]}`);
  await g.luma(`(L.ctx.events.emit('boat:undocked', { dockId: 'harbor' }), true)`);

  // tab hidden -> suspended; visible again -> running
  await g.luma(`(L.ctx.events.emit('app:hidden'), true)`);
  await g.delay(600);
  log('after app:hidden', await g.luma(`${A}.context.state`));
  await g.evalJs(`document.dispatchEvent(new Event('visibilitychange'))`);
  await g.delay(800);
  log('after visible', await g.luma(`${A}.context.state`));

  log('nodes created total', await g.evalJs('window.__nodes'));
  log('fps', (await g.stats()).fps);

  // other modules are being edited concurrently; only errors from audio fail this script
  const audioErrors = g.errors.filter((e) => /audio|AudioContext|AudioParam|AudioNode/i.test(e));
  log('console errors', `${g.errors.length} total, ${audioErrors.length} from audio; page reloads during run: ${reloads}`);

  // pass/fail summary on the level relationships we care about
  const st = await g.luma(`${A}.stats()`);
  log('totals', { birdCalls: st.birdCalls, cuckoos: st.cuckoos, chimeStrikes: st.chimeStrikes, bellStrikes: st.bellStrikes, samples: st.samples });
  const P = (k) => place[k];
  const checks = {
    'engine rises with throttle (>= 3 dB)': full.engine - idle.engine >= 3,
    'river bed louder in the gorge than on the lake (>= 6 dB)': P('gorge (s 1000)').river - P('lake (s 1720)').river >= 6,
    'maiden falls roar near the cascade (falls >= -40 dB)': P('maiden falls (s 962, near left bank)').falls >= -40,
    'hanakawa falls rises on approach (>= 6 dB)': P('falls near (s 2095)').falls - P('falls approach (s 1990)').falls >= 6,
    'weir audible at its end of the river (falls > -60 dB)': P('weir (s 30)').falls > -60,
    'bamboo/leaves wind louder in the gorge than on the lake': P('gorge (s 1000)').wind > P('lake (s 1720)').wind,
    'temple bell rings (temple >= -50 dB)': bell.temple >= -50,
    'birdsong heard during the run': st.birdCalls > 0,
    'village chimes near the landing': st.chimeStrikes > 0,
    'pause ducks world (>= 10 dB at master)': resumed.master - paused.master >= 10,
    'ambience volume setting lowers ambience (>= 10 dB)': resumed.ambience - ambLow.ambience >= 10,
    'engine volume 0 silences engine bus': engOff.engine < -80,
    'master 0 silences output': masterOff.master < -80,
    'no audio console errors': audioErrors.length === 0,
  };
  for (const [k, v] of Object.entries(checks)) console.log(`[audio] ${v ? 'PASS' : 'FAIL'} ${k}`);
  return Object.values(checks).every(Boolean);
}
