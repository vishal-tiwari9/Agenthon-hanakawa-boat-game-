// foliage material: standard pbr plus a thin-leaf translucency term inside the direct light loop,
// so light shining through a blade or leaf is shadowed exactly like the front lighting.
import { MeshStandardNodeMaterial, PhysicalLightingModel, type Texture } from 'three/webgpu';
import { dFdx, dFdy, diffuseColor, length, log2, max, normalView, positionViewDirection, texture, vec3, vec4 } from 'three/tsl';

class FoliageLightingModel extends PhysicalLightingModel {
  direct(input: any, builder: any) {
    const { lightDirection, lightColor, reflectedLight } = input;
    const m = builder.material as FoliageMaterial;
    if (m.translucencyNode) {
      // light arriving on the far side of the leaf, strongest when looking toward the light
      const back = (normalView as any).dot(lightDirection).negate().clamp(0, 1);
      const through = (positionViewDirection as any).dot(lightDirection.negate()).clamp(0, 1).pow(4);
      const k = back.mul(0.6).add(through.mul(0.6)).mul(m.translucencyNode);
      const tint = (diffuseColor as any).rgb.mul(m.translucencyTint);
      reflectedLight.directDiffuse.addAssign(tint.mul(lightColor).mul(k));
    }
    super.direct(input, builder);
  }
}

export class FoliageMaterial extends MeshStandardNodeMaterial {
  /** 0..1 translucency amount (float node) */
  translucencyNode: any = null;
  /** color multiplier for transmitted light (thin leaves transmit a warmer, more saturated tone) */
  translucencyTint: any = vec3(1.15, 1.2, 0.55);

  constructor(params?: any) {
    super(params);
  }

  setupLightingModel() {
    return new FoliageLightingModel() as any;
  }
}

/**
 * leaf card albedo with mip-compensated alpha: mipmapped alpha averages toward the background, so
 * distant alpha-tested leaves would shrink and crowns would go thin and sparkly. alpha is boosted
 * by the sampled mip level to keep coverage constant (as in alpha-to-coverage sharpening).
 */
export function leafAlbedo(map: Texture, uvNode: any, tint: any, texSize = 1024) {
  const t = texture(map, uvNode) as any;
  const d = max(length(dFdx(uvNode)), length(dFdy(uvNode))).mul(texSize);
  const lod = log2(max(d, 1));
  const a = t.a.mul(lod.mul(0.28).add(1));
  return vec4(t.rgb.mul(tint), a);
}
