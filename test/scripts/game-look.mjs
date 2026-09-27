// close looks at gameplay props: lateral marks, yellow special marks, cargo crates; hud marker in play.
export default async function (g) {
  const G = 'L.ctx.services.game';
  const tp = (x, z, h) => g.luma(`(L.ctx.boat.teleport(${x}, ${z}, ${h}), true)`);
  await g.delay(1500);
  await g.evalJs(`document.querySelector('.title-start')?.click()`);
  await g.delay(500);
  const routes = await g.luma(`${G}.debug.routes()`);
  const c = routes.find((r) => r.id === 'cliffs').gates[2];
  const rx = -c.dz * c.half, rz = c.dx * c.half;
  await g.luma(`L.look([${c.x - c.dx * 16 + rx * 0.4}, 2.2, ${c.z - c.dz * 16 + rz * 0.4}], [${c.x}, 0.8, ${c.z}])`);
  await g.delay(1500);
  await g.shot('look-special-marks');
  const h = routes.find((r) => r.id === 'harbor').gates[3];
  const hx = -h.dz * h.half, hz = h.dx * h.half;
  await g.luma(`L.look([${h.x - h.dx * 14 + hx * 1.6}, 2.4, ${h.z - h.dz * 14 + hz * 1.6}], [${h.x + hx}, 1.2, ${h.z + hz}])`);
  await g.delay(1200);
  await g.shot('look-lateral-marks');
  // cargo aboard: finish the lessons at the berth, then look into the boat
  await g.luma(`${G}.debug.complete('cast-off')`);
  await g.luma(`L.press('interact')`);
  await g.delay(300);
  const d = (await g.luma('L.docks')).find((x) => x.id === 'harbor');
  await tp(d.moorX, d.moorZ, d.headingDeg);
  await g.delay(400);
  await g.luma(`L.press('interact')`);
  await g.delay(1500);
  const b = await g.luma('L.stats().boat');
  const f = { x: Math.sin((d.headingDeg * Math.PI) / 180), z: -Math.cos((d.headingDeg * Math.PI) / 180) };
  await g.luma(`L.look([${b.x - f.x * 5 + f.z * 2.5}, 3.6, ${b.z - f.z * 5 - f.x * 2.5}], [${b.x + f.x * 1}, 0.3, ${b.z + f.z * 1}])`);
  await g.delay(1200);
  await g.shot('look-cargo');
  await g.luma('L.clearView()');
  // underway toward faro with the marker and compass tick live
  await g.luma(`L.press('interact')`);
  await tp(-60, -40, 60);
  await g.delay(300);
  await g.luma(`L.hold('forward', true)`);
  await g.delay(3000);
  await g.shot(`look-hud-underway-${g.W}`);
  await g.luma('L.releaseAll()');
  console.log('errors', g.errors.length, g.errors.slice(0, 4).join('\n'));
}
