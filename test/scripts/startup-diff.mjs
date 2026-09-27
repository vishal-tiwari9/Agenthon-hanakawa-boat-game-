export default async function(g){
 console.log('cache diff',await g.evalJs(`(async()=>{const f=__luma.ctx.services.vegetation.forest;const m=await fetch('/assets/vegetation/impostors/manifest.json').then(r=>r.json());return f.variants.map(v=>({key:f.variantKey(v.species.id,v.index),actual:f.atlasSignature(v),expected:m[f.variantKey(v.species.id,v.index)]?.signature}));})()`));
 console.log('probe diff',await g.evalJs(`(async()=>{const p=__luma.ctx.services.render.probes();const m=await fetch('/assets/render/bounce/manifest.json').then(r=>r.json());return {actual:p?.cacheSignature,expected:m.signature};})()`));
 console.log('startup phases', await g.luma('L.ctx.services.startup'));
 await g.viewShot('opening','opening-rich');
 await g.evalJs("document.querySelector('.title-start')?.click()");
 await g.luma('L.clearView()');await g.delay(400);await g.shot('follow-rich');
}
