// loading screen capture and startup timing. the harness load is the cold run (fresh profile); the
// page is then reloaded and the loading screen and reveal are captured during the warm run.
export default async function (g) {
  const timing = () => g.evalJs(`(() => {
    const s = window.__luma?.ctx?.services?.startup ?? {};
    return { firstPaintMs: s.firstPaintMs, playableMs: s.firstPlayableMs, settleMs: s.settleMs, warmMs: s.warmMs, phases: s.phases };
  })()`);
  console.log('cold', JSON.stringify(await timing()));

  const state = () => g.evalJs(`(() => {
    const el = document.getElementById('loading');
    const paper = el?.querySelector('.loading-paper');
    return { t: Math.round(performance.now()), ready: !!window.__lumaReady, veil: el ? (el.dataset.state || 'up') : 'gone',
      paper: paper ? Number(getComputedStyle(paper).opacity).toFixed(2) : null,
      label: el?.querySelector('.loading-label')?.textContent ?? null };
  })()`).catch(() => null);

  await g.evalJs('window.__oldPage = true');
  await g.send('Page.reload', {});
  for (let i = 0; i < 100 && (await g.evalJs('!!window.__oldPage').catch(() => true)); i++) await g.delay(20);
  const t0 = Date.now();
  const marks = [250, 1200, 2600];
  let k = 0;
  let leak = false;
  for (let i = 0; i < 300; i++) {
    const s = await state();
    if (s?.ready) break;
    // before ready the veil must be fully up: no half-built scene
    if (s && s.veil !== 'up' && s.veil !== 'gone') leak = true;
    if (s && s.veil === 'up' && s.paper !== '1.00') leak = true;
    if (k < marks.length && Date.now() - t0 >= marks[k]) {
      console.log('loading', JSON.stringify(s));
      await g.shot(`loading-${k}-${marks[k]}ms`);
      k++;
    }
    await g.delay(60);
  }
  const revealAt = Date.now();
  for (const ms of [120, 600, 1200, 3000]) {
    await g.delay(Math.max(0, ms - (Date.now() - revealAt)));
    console.log('reveal', ms, JSON.stringify(await state()));
    await g.shot(`reveal-${ms}ms`);
  }
  console.log('warm', JSON.stringify(await timing()));
  const play = await g.evalJs(`({ mode: __lumaUi.mode, gameplay: __luma.ctx.input.gameplayEnabled })`);
  console.log('play', JSON.stringify(play));
  if (play.mode !== 'play' || !play.gameplay) throw new Error('game did not start on its own after loading');
  if (leak) throw new Error('loading veil lifted before the scene was ready');
  if (g.errors.length) throw new Error(g.errors.join('\n'));
}
