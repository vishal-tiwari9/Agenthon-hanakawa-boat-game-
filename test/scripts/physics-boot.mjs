// quick backend check: boot, leave the berth, drive a few seconds, cycle the cameras.
import { setup, fmt } from './physics-lib.mjs';

export default async function (g) {
  const { P, sim, hold, state } = await setup(g);
  await g.delay(500);
  console.log('spawn', fmt(await state()));
  await P(`(L.clearView(), P.place(1700), true)`);
  await sim(1);
  await hold('forward');
  await hold('left');
  await sim(5);
  const s = await state();
  await g.shot(`boot-${g.args.backend || 'webgpu'}`);
  await hold('left', false);
  for (let i = 0; i < 3; i++) {
    await g.luma('L.press("camera")');
    await sim(0.6);
  }
  await hold('forward', false);
  console.log('driving', fmt({ ...s, camera: (await state()).cam }));
  console.log('stats', JSON.stringify(await g.stats()));
  console.log('errors', g.errors.length);
  return g.errors.length === 0 && s.speed > 2;
}
