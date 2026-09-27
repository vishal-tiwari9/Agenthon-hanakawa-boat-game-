// development-only: node test/harness.mjs startup-export --query=bakeStartup:1 --tag=startup --timeout=300
// captures are generated once by the app, then exported losslessly for both runtime backends.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

export default async function(g) {
  await g.evalJs(`window.__packStartup = async function(record) {
    const { bytes, ...meta } = record;
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    const zipped = new Uint8Array(await new Response(stream).arrayBuffer());
    let text='';
    for(let i=0;i<zipped.length;i+=8192) text+=String.fromCharCode(...zipped.subarray(i,i+8192));
    return {...meta, base64:btoa(text)};
  }`);
  const count = await g.luma('L.ctx.services.vegetation.forest.variants.length');
  const dir = root + 'public/assets/vegetation/impostors/';
  await mkdir(dir, { recursive: true });
  const manifest = {};
  for(let i=0;i<count;i++) {
    const data=await g.evalJs(`__luma.ctx.services.vegetation.forest.exportAtlas(${i}).then(__packStartup)`);
    const file=data.key.replace(':','-')+'.bin.gz';
    await writeFile(dir+file,Buffer.from(data.base64,'base64'));
    manifest[data.key]={file,size:data.size,signature:data.signature};
    console.log('exported',data.key,file,Buffer.from(data.base64,'base64').length,'bytes');
  }
  await writeFile(dir+'manifest.json',JSON.stringify(manifest,null,2)+'\n');
  const probes=await g.evalJs(`!!__luma.ctx.services.render.probes()?.baked`);
  if(probes) {
    const data=await g.evalJs('__luma.ctx.services.render.probes().exportAtlas().then(__packStartup)');
    const dir=root+'public/assets/render/bounce/';
    await mkdir(dir,{recursive:true});
    await writeFile(dir+'bounce.bin.gz',Buffer.from(data.base64,'base64'));
    const {base64,...meta}=data;
    await writeFile(dir+'manifest.json',JSON.stringify({...meta,file:'bounce.bin.gz'},null,2)+'\n');
    console.log('exported bounce atlas',meta.width,meta.height,meta.depth);
  }
  if(g.errors.length)throw new Error(g.errors.join('\n'));
  console.log('STARTUP ASSETS EXPORTED');
}
