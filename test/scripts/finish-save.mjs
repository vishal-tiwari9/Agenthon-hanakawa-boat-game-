export default async function(g) {
  const check=(name,ok)=>{console.log(ok?'PASS':'FAIL',name);if(!ok)throw new Error(name);};
  const press=async a=>{await g.luma(`L.press('${a}')`);await g.delay(350);};
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await press('interact');
  await g.evalJs(`(async()=>{const m=await import('/src/world/layout.ts');const a=m.riverFrame(292);__luma.ctx.boat.teleport(a.x,a.z,m.riverHeading(300));})()`);
  await g.delay(350);
  await g.evalJs(`(async()=>{const m=await import('/src/world/layout.ts');const a=m.riverFrame(308);__luma.ctx.boat.teleport(a.x,a.z,m.riverHeading(300));})()`);
  await g.delay(450);
  await g.luma(`(()=>{const d=L.docks.find(d=>d.id==='temple');L.ctx.boat.teleport(d.moorX,d.moorZ,d.headingDeg);})()`);
  await g.delay(500); await press('interact');
  check('temple delivery completed',await g.luma("L.ctx.services.game.objectives.some(o=>o.id==='incense'&&o.status==='done')"));
  await press('chart'); await g.delay(1500);
  check('chart disables steering',await g.evalJs("__lumaUi.mode==='chart'&&!__luma.ctx.input.gameplayEnabled"));
  await g.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
  await g.delay(600); await g.shot('river-chart-1920');
  check('resize updates camera',await g.luma('Math.abs(L.ctx.camera.aspect-1920/1080)<0.001'));
  await press('chart'); await press('pause');
  const t=await g.luma('L.ctx.time.sim'); await g.delay(400);
  check('pause freezes physics',await g.luma(`L.ctx.paused&&L.ctx.time.sim===${t}`));
  await g.evalJs("[...document.querySelectorAll('.seg input')].find(i=>i.value==='kmh').click()");
  await g.shot('river-settings');
  await g.send('Page.reload',{}); await g.delay(1500);
  for(let i=0;i<100;i++){if(await g.evalJs('!!window.__lumaReady'))break;await g.delay(500);}
  check('saved delivery restored',await g.luma("L.ctx.services.game.objectives.some(o=>o.id==='incense'&&o.status==='done')"));
  check('last berth restored',await g.luma("L.ctx.services.game.dockedAt==='temple'"));
  check('cargo restored',await g.luma("L.ctx.services.game.cargo?.label==='Tea chests'"));
  check('settings restored',await g.luma("L.ctx.settings.units==='kmh'"));
  check('resumed straight into play',await g.evalJs("__lumaUi.mode==='play'&&__luma.ctx.services.game.hasSave&&[...document.querySelectorAll('.toast')].some(t=>/Welcome back/.test(t.textContent))"));
  check('no runtime errors',g.errors.length===0);
}
