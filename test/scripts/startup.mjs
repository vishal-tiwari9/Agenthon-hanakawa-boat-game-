// startup: capture the loading screen mid-load, then check play begins on its own (no click, no title
// gate) and that real key presses start the audio and drive the boat.
export default async function (g) {
  const key = (type, code, k, vk) => g.send('Input.dispatchKeyEvent', { type, code, key: k, windowsVirtualKeyCode: vk });
  const fail = [];
  const check = (what, ok) => { console.log(ok ? 'PASS' : 'FAIL', what); if (!ok) fail.push(what); };

  // reload so the loading screen can be seen part way through
  await g.evalJs('window.__oldPage = true');
  await g.send('Page.reload', {});
  for (let i = 0; i < 100 && (await g.evalJs('!!window.__oldPage').catch(() => true)); i++) await g.delay(20);
  await g.delay(1400);
  const mid = await g.evalJs(`({ ready: !!window.__lumaReady, label: document.querySelector('.loading-label')?.textContent, boat: document.querySelector('.river-carrier')?.style.transform })`).catch(() => null);
  console.log('mid-load', JSON.stringify(mid));
  await g.shot('startup-loading');
  check('loading screen showing mid-load', !!mid && !mid.ready && !!mid.label);

  let ready = false;
  for (let i = 0; i < 240 && !ready; i++) { await g.delay(500); ready = await g.evalJs('!!window.__lumaReady').catch(() => false); }
  check('ready', ready);
  await g.delay(1800);
  const state = await g.evalJs(`({ mode: __lumaUi.mode, gameplay: __luma.ctx.input.gameplayEnabled, veil: !!document.getElementById('loading'), titleCard: !!document.querySelector('.title, .title-start'), audio: !!__luma.ctx.services.audio?.started, boat: __luma.stats().boat })`);
  console.log('after load', JSON.stringify(state));
  check('play started without a click', state.mode === 'play' && state.gameplay && !state.titleCard);
  check('loading screen gone', !state.veil);

  // real keys only: E casts off, then W is held for three seconds
  await key('keyDown', 'KeyE', 'e', 69); await g.delay(60); await key('keyUp', 'KeyE', 'e', 69);
  await g.delay(700);
  const a = (await g.stats()).boat;
  await key('keyDown', 'KeyW', 'w', 87);
  await g.delay(3000);
  const b = (await g.stats()).boat;
  await key('keyUp', 'KeyW', 'w', 87);
  const moved = Math.hypot(b.x - a.x, b.z - a.z);
  console.log('drive', JSON.stringify({ a, b, moved: +moved.toFixed(2) }));
  check('boat drives from the keyboard', !b.docked && moved > 1.5);
  check('audio started on first key', await g.evalJs('!!__luma.ctx.services.audio?.started'));
  await g.shot('startup-playing');

  check('no runtime errors', g.errors.length === 0);
  if (g.errors.length) console.log(g.errors.slice(0, 5).join('\n'));
  console.log(fail.length ? `FAILED: ${fail.join('; ')}` : 'STARTUP PASSED');
  return fail.length === 0;
}
