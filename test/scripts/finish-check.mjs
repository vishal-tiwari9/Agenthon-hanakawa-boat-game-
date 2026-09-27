export default async function(g) {
  console.log('bad geometry', await g.luma(`(() => { const out=[]; L.ctx.scene.traverse(o=>{const p=o.geometry?.attributes.position; if(!p)return; let bad=0; for(let i=0;i<p.array.length;i++)if(!Number.isFinite(p.array[i]))bad++; if(bad)out.push({name:o.name,parent:o.parent?.name,bad,type:o.type,material:o.material?.name});});return out; })()`));
  await g.send('Page.addScriptToEvaluateOnNewDocument',{source:`const originalError=console.error; console.error=(...args)=>{if(String(args[0]).includes('NaN'))originalError('GEOMETRY STACK',new Error().stack);originalError(...args);};`});
  await g.send('Page.reload',{});
  await g.delay(1500);
  for(let i=0;i<100;i++){if(await g.evalJs('!!window.__lumaReady'))break;await g.delay(500);}
  await g.delay(1000);
  for(const line of g.logs.filter(x=>x.includes('GEOMETRY STACK')))console.log(line);
}
