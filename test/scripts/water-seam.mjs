// camera-relative seam across the water ahead of the bow: cruise, freeze the follow pose, then toggle
// each suspect at the same paused frame. --only=a,b limits the toggles; row profiles via tools in /tmp
export default async function (g) {
  const only = g.args.only ? new Set(g.args.only.split(',')) : null;
  await g.delay(1200);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(400);
  await g.luma("L.press('interact')");
  await g.luma("L.hold('forward', true)");
  await g.delay(Number(g.args.cruise || 9000));
  await g.luma('L.releaseAll()');
  await g.luma("(L.look(L.ctx.camera.position.toArray(), L.ctx.camera.position.clone().add(L.ctx.camera.getWorldDirection(new L.ctx.camera.position.constructor()).multiplyScalar(50)).toArray()), L.ctx.paused = true, true)");
  await g.evalJs("for (const e of document.querySelectorAll('#ui, #hud, .hud')) e.style.visibility = 'hidden'");
  await g.delay(900);
  const info = await g.luma(`(() => {
    const c = L.ctx.camera, s = L.ctx.services.render.sun, csm = s.csm;
    const d = c.getWorldDirection(c.position.clone());
    return { pos: c.position.toArray().map((v) => +v.toFixed(2)), dir: d.toArray().map((v) => +v.toFixed(3)), near: c.near, far: c.far, fov: c.fov,
      breaks: csm.breaks, cascades: csm._cascades.map((v) => [v.x, v.y]), boat: L.stats().boat,
      bias: csm.lights.map((l) => [l.shadow.bias, +l.shadow.normalBias.toFixed(4), l.shadow.radius, l.shadow.mapSize.x]) };
  })()`);
  console.log('pose', JSON.stringify(info));
  const R = '__lumaRender', W = '__luma.ctx.services.water';
  const steps = [
    ['base', '', ''],
    ['nomist', `${R}.set({ mist: 0 })`, `${R}.set({ mist: ${R}.service.tune.mist.density })`],
    ['norefl', `${W}.setReflectionEnabled(false)`, `${W}.setReflectionEnabled(true)`],
    ['noair', `${R}.dream({ airSun: [1, 1, 1], airAway: [1, 1, 1] })`, `${R}.dream({ airSun: [1.08, 1.0, 0.9], airAway: [0.94, 1.0, 1.16] })`],
    ['nopost', `${R}.bypassPost(true)`, `${R}.bypassPost(false)`],
    ['split15', `(() => { const s = ${R}.service.sun, c = s.csm; window.__cb = c.customSplitsCallback; c.customSplitsCallback = (n, a, b, t) => t.push(0.15, 0.28, 1); c.updateFrustums(); s.refreshAll(); })()`,
      `(() => { const s = ${R}.service.sun, c = s.csm; c.customSplitsCallback = window.__cb; c.updateFrustums(); s.refreshAll(); })()`],
    ['nosun', `${R}.set({ sun: 0 })`, `${R}.set({ sun: 4.2 })`],
    ['noshadow', `${R}.shadows(false)`, `${R}.shadows(true)`, 3500],
    ['nowater', `${W}.mesh.visible = false`, `${W}.mesh.visible = true`],
    ['dbg-refr', `${W}.uniforms.uDebug.value = 2`, `${W}.uniforms.uDebug.value = 0`],
    ['dbg-scat', `${W}.uniforms.uDebug.value = 5`, `${W}.uniforms.uDebug.value = 0`],
    ['dbg-refl', `${W}.uniforms.uDebug.value = 1`, `${W}.uniforms.uDebug.value = 0`],
  ];
  for (const [name, on, off, wait] of steps) {
    if (only && !only.has(name) && name !== 'base') continue;
    if (on) await g.evalJs(on);
    await g.delay(wait || 900);
    await g.shot('seam-' + name);
    if (off) await g.evalJs(off);
    if (off) await g.delay(wait ? 2500 : 300);
  }
  if (g.args.dump) {
    const src = await g.evalJs(`(async () => { const c = __luma.ctx; return (await c.renderer.debug.getShaderAsync(c.scene, c.camera, c.services.water.mesh)).fragmentShader; })()`);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(g.args.dump, src);
    console.log('wgsl', g.args.dump, src.length);
  }
  // consecutive frames back under way with the follow camera (--seq=n)
  const n = Number(g.args.seq || 0);
  if (n) {
    await g.luma('(L.clearView(), L.ctx.paused = false, true)');
    await g.luma("L.hold('forward', true)");
    await g.delay(1500);
    for (let i = 0; i < n; i++) { await g.shot('seam-seq-' + i); await g.delay(120); }
    await g.luma('L.releaseAll()');
  }
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 5).join('\n'));
}
