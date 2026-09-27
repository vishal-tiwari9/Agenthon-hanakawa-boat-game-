// integration drive: throttle up, turn, coast, reverse; logs pose/speed and grabs a few frames.
export default async function (g) {
  const log = async (label) => console.log(label, JSON.stringify((await g.stats()).boat));
  await g.delay(1500);
  await g.luma('L.clearView()');
  await log('start');
  await g.luma("L.hold('forward', true)");
  await g.delay(6000);
  await log('after 6s forward');
  await g.shot('drive-forward');
  await g.luma("L.hold('left', true)");
  await g.delay(4000);
  await log('turning');
  await g.shot('drive-turn');
  await g.luma("L.releaseAll()");
  await g.delay(3000);
  await log('coast 3s');
  await g.luma("L.hold('reverse', true)");
  await g.delay(3000);
  await log('reverse 3s');
  await g.luma("L.releaseAll()");
  await g.shot('drive-end');
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 10).join('\n'));
}
