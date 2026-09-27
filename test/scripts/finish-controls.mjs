export default async function(g) {
  const check=(name,ok)=>{console.log(ok?'PASS':'FAIL',name);if(!ok)throw new Error(name);};
  const press=async a=>{await g.luma(`L.press('${a}')`);await g.delay(450);};
  await g.evalJs("document.querySelector('.title-start')?.click()");
  await press('camera'); check('helm view',await g.luma("L.ctx.cameraRig.mode==='helm'"));
  await press('camera'); check('photo view',await g.luma("L.ctx.cameraRig.mode==='photo'"));
  await press('camera'); check('follow view',await g.luma("L.ctx.cameraRig.mode==='follow'"));
  await press('pause');
  await g.evalJs("document.getElementById('tab-voyage').click()");
  await g.evalJs("document.querySelector('#panel-voyage .btn').click()");
  await g.delay(150);
  await g.evalJs("document.querySelector('#panel-voyage .btn-primary').click()");
  await g.delay(600);
  check('new game returns to village',await g.luma("L.ctx.services.game.dockedAt==='village'&&L.ctx.services.game.objectives.every(o=>o.status!=='done')"));
  check('new game retains starting cargo',await g.luma("L.ctx.services.game.cargo?.label==='Incense bundles'"));
  check('no runtime errors',g.errors.length===0);
}
