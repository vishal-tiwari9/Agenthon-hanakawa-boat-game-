// water: the bow-wave reference framing. the boat runs upstream toward the vermilion bridge at ~4 m/s;
// the camera sits beside and above the bow looking across the bow wave so the rails and piers reflect.
// then a follow-cam cruise frame and a turn.
import { riverFrame, riverHeading } from '../../src/world/layout.ts';

export default async function (g) {
  const pose = `(() => { const B = L.ctx.boat, q = B.quaternion; const fx = -2 * (q.x * q.z + q.w * q.y), fz = -(1 - 2 * (q.x * q.x + q.y * q.y)); const l = Math.hypot(fx, fz); return [B.position.x, B.position.z, fx / l, fz / l, B.speed]; })()`;
  const speed = async () => (await g.luma('L.ctx.boat.speed'));
  // camera at (along, side, up) metres in the boat frame from the boat centre, aimed at (along, side) on the water
  const close = async (name, a, s, h, ta, ts, lead) => {
    const [x, z, fx, fz, v] = await g.luma(pose);
    const rx = -fz, rz = fx;
    const ld = v * lead;
    const P = [x + fx * (a + ld) + rx * s, h, z + fz * (a + ld) + rz * s];
    const T = [x + fx * (ta + ld) + rx * ts, 0, z + fz * (ta + ld) + rz * ts];
    await g.luma(`L.look([${P.join(',')}], [${T.join(',')}])`);
    await g.delay(120);
    await g.shot(name);
    await g.luma('L.clearView()');
  };
  await g.delay(1200);
  await g.luma('L.clearView()');
  await g.luma(`(() => { document.querySelector('.title-start')?.click(); L.ctx.input.gameplayEnabled = true; const B = L.ctx.boat; if (B && B.docked) B.undock(); return true; })()`);
  await g.delay(900);
  const f = riverFrame(252);
  await g.luma(`(() => { L.ctx.boat.teleport(${f.x + f.nx * 3}, ${f.z + f.nz * 3}, ${riverHeading(252)}); L.ctx.services.water.wake.reset(); return true; })()`);
  await g.delay(800);
  // run up to ~4.3 m/s, then coast so the shot is taken near 4 m/s with the bow packet developed
  await g.luma("L.hold('forward', true)");
  for (let i = 0; i < 60 && (await speed()) < 4.3; i++) await g.delay(150);
  await g.luma('L.releaseAll()');
  await g.delay(700);
  console.log('repro', JSON.stringify(await g.luma(pose)), 'bridge', JSON.stringify(riverFrame(300)));
  await close('repro', -0.5, -2.4, 3.4, 6.5, 3.2, 0.2);
  await g.delay(200);
  await close('repro-wide', -3, -3.2, 4.6, 7, 4, 0.2);
  console.log('probe', JSON.stringify(await g.luma('L.ctx.services.water.debug.wakeProbe()')));
  // follow cam at cruise, then a turn
  await g.luma("L.hold('forward', true)");
  await g.delay(2500);
  await g.shot('follow');
  await g.luma("L.hold('right', true)");
  await g.delay(2200);
  console.log('turn', JSON.stringify(await g.luma(pose)));
  await g.shot('turn');
  await g.luma('L.releaseAll()');
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 5).join('\n').slice(0, 2000));
}
