// water: drive the boat (forward, turn at speed, coast) and capture the wake from the follow camera
// and from above. --fwd / --turn seconds; --side=left|right
export default async function (g) {
  const b = g.args.backend || 'webgpu';
  const pose = async () => (await g.stats()).boat;
  const above = async (name, h = 22, back = 26) => {
    const s = await g.luma(`(() => { const B = L.ctx.boat; const f = { x: 0, z: -1 }; const q = B.quaternion; const fx = 2 * (q.x * q.z + q.w * q.y) * -1, fz = -(1 - 2 * (q.x * q.x + q.y * q.y)); return [B.position.x, B.position.z, fx, fz]; })()`);
    const [x, z, fx, fz] = s;
    await g.luma(`L.look([${x - fx * back + fz * 8}, ${h}, ${z - fz * back - fx * 8}], [${x - fx * 10}, 0, ${z - fz * 10}])`);
    await g.delay(250);
    await g.shot(`${name}-${b}`);
    await g.luma('L.clearView()');
  };
  await g.delay(1200);
  await g.luma('L.clearView()');
  // leave the dock: the game may hold the boat until the player sets out
  await g.luma(`(() => { document.querySelector('.title-start')?.click(); L.ctx.input.gameplayEnabled = true; const B = L.ctx.boat; if (B && B.docked) B.undock(); return true; })()`);
  await g.delay(900);
  if (g.args.at) {
    const [x, z, h] = g.args.at.split(',').map(Number);
    await g.luma(`(() => { L.ctx.boat.teleport(${x}, ${z}, ${h}); L.ctx.services.water.wake.reset(); return true; })()`);
    await g.delay(600);
  }
  await g.luma("L.hold('forward', true)");
  await g.delay((Number(g.args.fwd) || 7) * 1000);
  console.log('cruise', JSON.stringify(await pose()));
  await g.shot(`drive-cruise-${b}`);
  await above('drive-cruise-above');
  const side = g.args.side || 'left';
  await g.luma(`L.hold('${side}', true)`);
  await g.delay((Number(g.args.turn) || 5) * 1000);
  console.log('turn', JSON.stringify(await pose()));
  await g.shot(`drive-turn-${b}`);
  await above('drive-turn-above', 30, 30);
  await g.luma('L.releaseAll()');
  await g.delay(4000);
  console.log('coast', JSON.stringify(await pose()));
  await above('drive-coast-above', 34, 36);
  if (g.errors.length) console.log('ERRORS', g.errors.slice(0, 5).join('\n').slice(0, 2000));
}
