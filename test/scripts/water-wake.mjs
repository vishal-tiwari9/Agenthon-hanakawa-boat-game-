// water: the wave-sim wake under way. follow-cam cruise, a close bow and stern look, then a hard turn
export default async function (g) {
  const pose = `(() => { const B = L.ctx.boat, q = B.quaternion; const fx = -2 * (q.x * q.z + q.w * q.y), fz = -(1 - 2 * (q.x * q.x + q.y * q.y)); const l = Math.hypot(fx, fz); return [B.position.x, B.position.z, fx / l, fz / l, B.speed]; })()`;
  // camera at (along, side, up) metres in the boat frame from the boat centre, aimed at (along, side)
  const close = async (name, a, s, h, ta, ts) => {
    const [x, z, fx, fz] = await g.luma(pose);
    const rx = -fz, rz = fx;
    const lead = 1.2; // the boat keeps moving while the frame settles
    const P = [x + fx * (a + lead) + rx * s, h, z + fz * (a + lead) + rz * s];
    const T = [x + fx * (ta + lead) + rx * ts, 0, z + fz * (ta + lead) + rz * ts];
    await g.luma(`L.look([${P.join(',')}], [${T.join(',')}])`);
    await g.delay(160);
    await g.shot(name);
    await g.luma('L.clearView()');
  };
  await g.delay(1200);
  await g.luma('L.clearView()');
  await g.luma(`(() => { document.querySelector('.title-start')?.click(); L.ctx.input.gameplayEnabled = true; const B = L.ctx.boat; if (B && B.docked) B.undock(); return true; })()`);
  await g.delay(600);
  await g.luma("L.hold('forward', true)");
  await g.delay(8000);
  console.log('cruise', JSON.stringify((await g.stats()).boat));
  await g.shot('cruise');
  await close('bow', 5.5, 4.2, 1.7, 3.2, 0);
  await g.delay(500);
  await close('stern', -9, 3.8, 2.2, -4, 0);
  await g.delay(300);
  // a short carve, shot mid-turn before the canal wall comes up
  await g.luma("L.hold('left', true)");
  await g.delay(1300);
  await g.shot('turn');
  console.log('turn', JSON.stringify((await g.stats()).boat), JSON.stringify(await g.luma('L.ctx.services.water.debug.wakeProbe()')));
  await g.luma('L.releaseAll()');
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 5).join('\n').slice(0, 2000));
}
