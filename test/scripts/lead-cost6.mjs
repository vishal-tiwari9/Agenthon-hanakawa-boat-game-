// cost breakdown in the real follow view: cruise into the village, freeze the sim, toggle big systems
export default async function (g) {
  await g.delay(1200);
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await g.delay(400);
  await g.luma("L.press('interact')");
  await g.luma("L.hold('forward', true)");
  await g.delay(7000);
  await g.luma('L.releaseAll()');
  await g.luma("(L.look(L.ctx.camera.position.toArray(), L.ctx.camera.position.clone().add(L.ctx.camera.getWorldDirection(new L.ctx.camera.position.constructor()).multiplyScalar(40)).toArray()), L.ctx.paused = true, true)");
  const fps = async (label) => { await g.delay(1500); const a = await g.stats(); await g.delay(3000); const b = await g.stats(); const f = (b.frames - a.frames) / 3; console.log(label.padEnd(26), f.toFixed(1), 'fps', (1000 / f).toFixed(2), 'ms'); };
  const vis = (pred, on) => g.luma(`(() => { let n = 0; L.ctx.scene.children.forEach((o) => { if (${pred}) { o.visible = ${on}; n++; } }); return n; })()`);
  await fps('baseline');
  await fps('baseline again');
  await g.luma('L.ctx.services.water.setReflectionEnabled(false)'); await fps('no reflection'); await g.luma('L.ctx.services.water.setReflectionEnabled(true)');
  for (const [label, pred] of [['vegetation', "o.name === 'vegetation'"], ['structures', "o.name.startsWith('structures')"], ['bridges', "o.name === 'bridges'"], ['terrain', "o.name === 'terrain'"], ['rocks', "o.name.startsWith('rocks.')"]]) {
    const n = await vis(pred, false);
    if (!n) { console.log(label, 'not found'); continue; }
    await fps('no ' + label + ` (${n})`);
    await vis(pred, true);
  }
  console.log('top-level', await g.luma("[...new Set(L.ctx.scene.children.map((o) => o.name.split(':')[0] || o.type))].join(', ')"));
}
