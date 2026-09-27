import { readFileSync, writeFileSync } from 'node:fs';
import { Vector3, DataUtils } from 'three/webgpu';
import { loadSky } from './src/render/sky';
import { sunDirection } from './src/render/sun';
const buf = readFileSync('/Users/siddharth/Desktop/code/testing/boat-sim/public/assets/render/kloofendal_48d_partly_cloudy_puresky/kloofendal_48d_partly_cloudy_puresky_4k.hdr');
const t0 = performance.now();
const sky = await loadSky(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), sunDirection(new Vector3()));
console.log('loadSky ms', (performance.now() - t0).toFixed(0));
const dump = (tex: any, name: string) => {
  const { width, height, data } = tex.image;
  const f = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) for (let k = 0; k < 3; k++) f[i * 3 + k] = DataUtils.fromHalfFloat(data[i * 4 + k]);
  writeFileSync(`/tmp/rsky/${name}.f32`, Buffer.from(f.buffer));
  console.log(name, width, height);
};
dump(sky.environment, 'env');
dump(sky.horizon, 'horizon');
console.log('horizonAvg', sky.horizonAvg.map((v) => v.toFixed(3)), 'zenithAvg', sky.zenithAvg.map((v) => v.toFixed(3)));
