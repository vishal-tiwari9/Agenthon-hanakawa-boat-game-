// cost of the newest content at the village view, hiding one group at a time (no recompiles)
export default async function (g) {
  await g.luma("L.view('village')");
  await g.delay(2500);
  const fps = async (label) => { await g.delay(1500); const a = await g.stats(); await g.delay(3000); const b = await g.stats(); const f = (b.frames - a.frames) / 3; console.log(label.padEnd(24), f.toFixed(1), 'fps', (1000 / f).toFixed(2), 'ms'); };
  const vis = (pred, on) => g.luma(`(() => { let n = 0; L.ctx.scene.traverse((o) => { if (${pred}) { o.visible = ${on}; n++; } }); return n; })()`);
  await fps('baseline');
  for (const [label, pred] of [
    ['life', "o.name.startsWith('structures:life') || o.name === 'river-life'"],
    ['frontage', "o.name === 'structures:frontage'"],
    ['bank-details', "o.name === 'bank-details'"],
    ['forest', "o.name === 'forest'"],
    ['grass+flowers', "/^(grass|flowers):/.test(o.name)"],
    ['shrubs', "/^shrubs:/.test(o.name)"],
  ]) {
    const n = await vis(pred, false);
    if (!n) { console.log(label, 'not found'); continue; }
    await fps('no ' + label);
    await vis(pred, true);
  }
}
