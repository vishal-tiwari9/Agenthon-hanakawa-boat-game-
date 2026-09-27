// vegetation palette (linear albedo) and the gpu vegetation field, importable by any material at
// build time (like causticsNode). terrain uses vegetationGroundAlbedo() under and beyond the grass so
// the grass fades into ground of the same hue instead of a mismatched texture: close up a mottled
// carpet of clover and moss (never bare soil), far away the canopy mean tinted by the flower drifts.
import { DataTexture, LinearFilter, ClampToEdgeWrapping, RGBAFormat, UnsignedByteType } from 'three/webgpu';
import { cameraPosition, float, length, mix, smoothstep, texture, vec2, vec3, uniform } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { gustTexture } from './wind';

export const GRASS = {
  /** sunlit meadow, fresh spring green */
  fresh: [0.16, 0.3, 0.078] as [number, number, number],
  /** sheltered hollows and blade roots: deeper, bluer green */
  lush: [0.055, 0.17, 0.062] as [number, number, number],
  /** lighter, warmer blade tips */
  tip: [0.29, 0.4, 0.13] as [number, number, number],
  /** dried straw */
  straw: [0.46, 0.4, 0.2] as [number, number, number],
  /** clover leaves: cool, slightly blue */
  clover: [0.05, 0.14, 0.05] as [number, number, number],
  /** cushion moss: warm yellow-green */
  moss: [0.1, 0.16, 0.045] as [number, number, number],
};

export const FLOWER = {
  /** harujion fleabane: white with a faint pink blush */
  white: [0.8, 0.74, 0.74] as [number, number, number],
  /** renge (chinese milk vetch): magenta pink */
  renge: [0.62, 0.17, 0.4] as [number, number, number],
  /** nanohana (rapeseed): warm yellow */
  nanohana: [0.82, 0.58, 0.035] as [number, number, number],
  /** white clover heads */
  clover: [0.78, 0.77, 0.7] as [number, number, number],
  /** dandelion: deeper golden yellow */
  dandelion: [0.8, 0.46, 0.02] as [number, number, number],
  center: [0.7, 0.45, 0.03] as [number, number, number],
};

/** flower species in the order used by the flower shader and the bloom texture */
export const FLOWER_SPECIES = [FLOWER.white, FLOWER.renge, FLOWER.nanohana, FLOWER.clover, FLOWER.dandelion];

const RES = 1024;

function fieldTexture() {
  const t = new DataTexture(new Uint8Array(RES * RES * 4), RES, RES, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/** rgba8 over the world square: r density, g dryness, b lushness, a flowers. filled by vegetation init */
export const vegetationFieldTexture = fieldTexture();
/** rgba8 over the world square: rgb mean bloom colour (srgb-ish, sqrt encoded), a bloom coverage */
export const vegetationBloomTexture = fieldTexture();

export const uFieldSize = uniform(2048);
/** distances (m) over which vegetationGroundAlbedo goes from understory to canopy color */
export const uGroundNear = uniform(8);
export const uGroundFar = uniform(90);

/** vec4(density, dry, lush, flowers) at a world xz node */
export function vegetationFieldNode(xz: Node): Node {
  const uv = vec2(xz as any).div(uFieldSize).add(0.5);
  return texture(vegetationFieldTexture, uv) as any;
}

/** canopy mean for dry / lush values: the grass shader converges to exactly this with distance */
export function grassCanopyMean(dry: any, lush: any): Node {
  const fresh = vec3(...GRASS.fresh), lushC = vec3(...GRASS.lush), tip = vec3(...GRASS.tip), straw = vec3(...GRASS.straw);
  const base = mix(fresh, lushC, lush) as any;
  const top = mix(mix(base, tip, 0.55), straw, dry.mul(0.85));
  return mix(base, top, dry.mul(0.3).add(0.3)).mul(0.82) as any;
}

/** mean grass albedo at a world xz node, as the grass looks from a distance (includes self-shadowing) */
export function vegetationGroundColor(xz: Node): Node {
  const f = vegetationFieldNode(xz) as any;
  return grassCanopyMean(f.g, f.b);
}

export function fillFieldTexture(data: Uint8Array, res: number, size: number, target = vegetationFieldTexture) {
  if (res === RES) (target.image.data as Uint8Array).set(data);
  else {
    // nearest resample into the fixed-size texture
    const dst = target.image.data as Uint8Array;
    for (let j = 0; j < RES; j++) {
      const sj = Math.min(res - 1, Math.floor((j / RES) * res));
      for (let i = 0; i < RES; i++) {
        const si = Math.min(res - 1, Math.floor((i / RES) * res));
        for (let c = 0; c < 4; c++) dst[(j * RES + i) * 4 + c] = data[(sj * res + si) * 4 + c];
      }
    }
  }
  uFieldSize.value = size;
  target.needsUpdate = true;
}

/**
 * ground albedo for terrain under grass. near the camera it is the understory between the blades:
 * clover and moss in soft mottled patches, deeper in the lush hollows and yellower where it is dry,
 * so gaps between blades read as green carpet. with distance it converges to the canopy mean, and
 * far flower drifts tint it, so where grass and flowers thin out the ground already has their color.
 * terrain: albedo = mix(ownAlbedo, vegetationGroundAlbedo(worldPos), fieldDensity * k)
 */
export function vegetationGroundAlbedo(worldPos: Node): Node {
  const p = worldPos as any;
  const f = vegetationFieldNode(p.xz) as any;
  const canopy = vegetationGroundColor(p.xz) as any;
  const m1 = (texture(gustTexture, p.xz.div(5.3)) as any).r;
  const m2 = (texture(gustTexture, p.xz.div(1.7).add(vec2(0.31, 0.77))) as any).g;
  let under = mix(vec3(...GRASS.clover), vec3(...GRASS.moss), smoothstep(0.38, 0.66, m1.add(f.g.mul(0.25)).sub(f.b.mul(0.15)))) as any;
  under = mix(under, mix(vec3(...GRASS.moss), vec3(...GRASS.straw), 0.35), f.g.mul(0.45));
  under = under.mul(m2.mul(0.34).add(0.8));
  // a shade darker than the canopy: the blades above are the lit layer
  under = mix(under, canopy.mul(0.8), 0.3);
  const d = length(cameraPosition.sub(p));
  const t = smoothstep(uGroundNear, uGroundFar, d);
  // far flower drifts: their mean colour over the grass
  const uv = vec2(p.xz).div(uFieldSize).add(0.5);
  const bloom = texture(vegetationBloomTexture, uv) as any;
  const far = mix(canopy, bloom.rgb.mul(bloom.rgb), bloom.a.mul(smoothstep(12, 40, d)).mul(0.62));
  return mix(under, far, t.mul(float(1))) as any;
}
