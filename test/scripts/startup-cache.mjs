// run on a fresh harness profile to compare cold and repeat startup without changing scene quality.
export default async function(g) {
  const stats = () => g.luma(`({
    readyMs: performance.now(),
    sky: { cache:L.ctx.services.render.sky.cache, prepareMs:L.ctx.services.render.sky.prepareMs },
    forest:L.ctx.services.vegetation.forest.stats,
    bounceLoaded:L.ctx.services.render.probes()?.loaded ?? null,
    assetsBytes:performance.getEntriesByType('resource').reduce((s,r)=>s+(r.transferSize||0),0)
  })`);
  console.log('cold',JSON.stringify(await stats()));
  await g.evalJs('__luma.ctx.services.render.sky.cacheWrite');
  await g.send('Page.reload',{});
  await g.delay(1000);
  let ready=false;
  for(let i=0;i<120;i++){
    ready=await g.evalJs('!!window.__lumaReady');
    if(ready)break;
    await g.delay(250);
  }
  if(!ready)throw new Error('repeat startup timed out');
  const warm=await stats();
  console.log('warm',JSON.stringify(warm));
  if(warm.sky.cache!=='hit')throw new Error('prepared sky cache not used');
  if(warm.forest.loadedAtlases!==7 || warm.forest.capturedAtlases!==0)throw new Error('forest recaptured shipped atlases');
  if(g.errors.length)throw new Error(g.errors.join('\n'));
  console.log('PASS exact forest atlases loaded and prepared sky cache reused');
}
