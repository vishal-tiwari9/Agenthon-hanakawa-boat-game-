// structures build time and counts from the startup log
export default async function (g) {
  await g.delay(500);
  for (const l of g.logs.filter((l) => l.includes('[structures]'))) console.log(l.slice(0, 400));
  const d = await g.evalJs('JSON.stringify(__luma.ctx.services.structures?.debug?.town ?? null)');
  console.log('town', d);
  console.log('phase', await g.evalJs('JSON.stringify(__luma.ctx.services.structures?.debug?.phase ?? null)'));
  console.log('critters', await g.evalJs('JSON.stringify(__luma.ctx.services.structures?.debug?.critters ?? null)'));
  console.log('life', await g.evalJs('JSON.stringify(__luma.ctx.services.life?.stats?.() ?? null)'));
}
