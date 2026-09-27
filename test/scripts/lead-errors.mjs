// boot, let a few frames render, print unique console errors
export default async function (g) {
  await g.delay(4000);
  const uniq = [...new Set(g.errors.map((e) => String(e).slice(0, 400)))];
  console.log('UNIQUE ERRORS', uniq.length);
  for (const e of uniq.slice(0, 12)) console.log('---\n' + e);
  console.log('stats', JSON.stringify(await g.stats()));
}
