// post pipeline, built per quality preset and backend. one scene pass (hdr, linear), optional
// half-res gtao fed into the materials' indirect term (builtinAOContext skips transparent water),
// optional ssgi on high, a restrained bloom for sun glints, then exactly one tone mapping +
// output conversion, then the preset's antialiasing on display-referred color.
import {
  HalfFloatType, Layers, NodeMaterial, QuadMesh, RenderPipeline, RenderTarget, UnsignedByteType, Vector2, Vector3, type Node, type PerspectiveCamera,
  type Scene, type WebGPURenderer,
} from 'three/webgpu';
import {
  builtinAOContext, diffuseColor, dot, float, mix, mrt, normalView, output, packNormalToRGB, pass, renderOutput, sample,
  screenUV, smoothstep, texture, uniform, unpackRGBToNormal, vec3, vec4, velocity,
} from 'three/tsl';
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { LAYERS } from '../core/layers';
import { TUNE } from './config';

export interface PostOptions {
  ao: boolean;
  ssgi: boolean;
  bloom: boolean;
  aa: 'none' | 'fxaa' | 'smaa' | 'traa';
}

export const uAOStrength = uniform(TUNE.ao.strength);
export const uSSGIStrength = uniform(1);
/** display-referred split tone (TUNE.dream): shared by every pipeline build so tuning survives rebuilds */
export const uGrade = {
  hiTint: uniform(new Vector3(...TUNE.dream.hiTint)),
  loTint: uniform(new Vector3(...TUNE.dream.loTint)),
  lift: uniform(new Vector3(...TUNE.dream.lift)),
  saturation: uniform(TUNE.grade.saturation),
  vibrance: uniform(TUNE.grade.vibrance),
};

/** warm highlights, cool shadows and a small coloured lift at black, on display-referred color. this
 *  runs after the single tone mapping, so it shapes the look without touching scene radiometry */
function splitTone(display: Node): Node {
  if (!TUNE.dream.enabled) return display;
  const d = display as any;
  const L = dot(d.rgb, vec3(0.2126, 0.7152, 0.0722));
  const hi = smoothstep(0.35, 0.95, L), lo = float(1).sub(smoothstep(0.04, 0.5, L));
  const tinted = d.rgb.mul(mix(vec3(1), vec3(uGrade.hiTint as any), hi)).mul(mix(vec3(1), vec3(uGrade.loTint as any), lo));
  return vec4(tinted.add(vec3(uGrade.lift as any).mul(float(1).sub(L))).clamp(0, 1), d.a);
}

export class Post {
  pipeline: RenderPipeline;
  options: PostOptions;
  bloomNode: ReturnType<typeof bloom> | null = null;
  private nodes: { dispose(): void }[] = [];
  private aoTarget: RenderTarget | null = null;
  private aoQuad: QuadMesh | null = null;
  private size = new Vector2();

  constructor(private renderer: WebGPURenderer, scene: Scene, camera: PerspectiveCamera, opts: PostOptions) {
    this.options = opts;
    const pipe = new RenderPipeline(renderer);
    this.pipeline = pipe;
    const useTRAA = opts.aa === 'traa';

    const scenePass = pass(scene, camera);
    this.nodes.push(scenePass);
    const outputs: Record<string, Node> = { output };
    if (useTRAA) outputs.velocity = velocity;
    if (opts.ssgi) {
      outputs.diffuseColor = diffuseColor;
      outputs.normal = packNormalToRGB(normalView);
    }
    if (Object.keys(outputs).length > 1) scenePass.setMRT(mrt(outputs));
    if (opts.ssgi) {
      scenePass.getTexture('diffuseColor').type = UnsignedByteType;
      scenePass.getTexture('normal').type = UnsignedByteType;
    }
    let color: Node = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');

    if (opts.ssgi) {
      // high: screen-space gi and its own ao, composited onto opaque pixels only. the water is
      // transparent, so where the scene depth is nearer than the opaque prepass depth we skip it.
      const normal = sample((uv: Node) => unpackRGBToNormal(scenePass.getTextureNode('normal').sample(uv as any)));
      const gi = ssgi(color, depth, normal as any, camera);
      gi.sliceCount.value = 2;
      gi.stepCount.value = 8;
      gi.radius.value = 6;
      gi.giIntensity.value = 6;
      gi.thickness.value = 0.6;
      gi.useTemporalFiltering = useTRAA;
      this.nodes.push(gi);
      const opaque = pass(scene, camera);
      opaque.transparent = false;
      opaque.setMRT(mrt({ output: float(0) }));
      opaque.setResolutionScale(0.5);
      this.nodes.push(opaque);
      const opaqueDepth = opaque.getLinearDepthNode();
      const sceneDepth = scenePass.getLinearDepthNode();
      const onOpaque = sceneDepth.lessThan(opaqueDepth.sub(0.002)).select(float(0), float(1));
      const aoV = mix(float(1), gi.getAONode().r, uAOStrength.mul(onOpaque));
      const giV = gi.getGINode().rgb.mul(uSSGIStrength).mul(onOpaque);
      const diff = scenePass.getTextureNode('diffuseColor').rgb;
      const c = color as any;
      color = vec4(c.rgb.mul(aoV).add(diff.mul(giV)), c.a);
    } else if (opts.ao) {
      // opaque layer-0 prepass at half res: depth + normals for gtao. grass (no-reflect layer) is
      // skipped here; it samples the ao of the ground behind it, which reads fine at that scale.
      const pre = pass(scene, camera);
      pre.transparent = false;
      const layers = new Layers();
      layers.set(LAYERS.DEFAULT);
      pre.setLayers(layers);
      pre.setMRT(mrt({ output: packNormalToRGB(normalView) }));
      pre.getTexture('output').type = UnsignedByteType;
      pre.setResolutionScale(0.5);
      this.nodes.push(pre);
      const preDepth = pre.getTextureNode('depth');
      const preNormal = sample((uv: Node) => unpackRGBToNormal(pre.getTextureNode().sample(uv as any)));
      const aoPass = gtao(preDepth, preNormal as any, camera);
      aoPass.resolutionScale = 0.5;
      aoPass.radius.value = TUNE.ao.radius;
      aoPass.samples.value = 12;
      aoPass.distanceFallOff.value = 1;
      aoPass.scale.value = 1;
      aoPass.thickness.value = 1.5;
      aoPass.useTemporalFiltering = useTRAA;
      this.nodes.push(aoPass);
      let aoTex: Node = aoPass.getTextureNode();
      if (!useTRAA) {
        const dn = denoise(aoTex, preDepth, preNormal as any, camera);
        dn.radius.value = 4;
        this.nodes.push(dn as any);
        aoTex = dn as any;
      }
      // the ao chain is resolved into its own target before the pipeline runs. if the scene pass
      // pulled it lazily through its material context, the prepass would render nested inside the
      // scene pass (same scene + camera render list) and corrupt it.
      this.aoTarget = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
      const mat = new NodeMaterial();
      mat.name = 'render.ao';
      mat.fragmentNode = vec4((aoTex as any).r, 0, 0, 1);
      this.aoQuad = new QuadMesh(mat);
      this.aoQuad.name = 'render.ao';
      const aoValue = mix(float(1), texture(this.aoTarget.texture).sample(screenUV).r, uAOStrength);
      scenePass.contextNode = builtinAOContext(aoValue);
    }

    if (opts.bloom) {
      const B = TUNE.bloom;
      const b = bloom(color as any, B.strength, B.radius, B.threshold);
      b.smoothWidth.value = B.knee;
      // per-mip tint: read when the composite is built, so set before the first render
      b.bloomTintColors.forEach((t, i) => t.set(...B.tint[i]));
      this.bloomNode = b;
      this.nodes.push(b);
      color = (color as any).add(b);
    }

    // vibrance, in scene-linear before the single tone mapping: lifts muted colours (plaster, water,
    // foliage) more than already-saturated ones, so the scene reads colourful without neon
    {
      const c = color as any;
      const luma = c.rgb.dot(vec3(0.2126, 0.7152, 0.0722));
      const chroma = c.rgb.sub(luma).length().div(luma.add(0.02));
      const boost = uGrade.vibrance.mul(float(1).sub(chroma.clamp(0, 1)));
      color = vec4(mix(vec3(luma), c.rgb, boost.add(uGrade.saturation)), c.a);
    }

    if (TUNE.debugOverride === 'ao' && this.aoTarget) {
      // debug: show the ao term the materials receive
      const a = mix(float(1), texture(this.aoTarget.texture).sample(screenUV).r, uAOStrength);
      color = vec4(a, a, a, 1);
    }

    if (useTRAA) {
      const velocityTex = scenePass.getTextureNode('velocity');
      const t = traa(color, depth, velocityTex, camera);
      this.nodes.push(t);
      pipe.outputNode = splitTone(renderOutput(t));
      pipe.outputColorTransform = false;
    } else {
      const display = splitTone(renderOutput(color));
      let out: Node = display;
      if (opts.aa === 'smaa') out = smaa(display);
      else if (opts.aa === 'fxaa') out = fxaa(display);
      pipe.outputNode = out;
      pipe.outputColorTransform = false;
    }
  }

  render() {
    const r = this.renderer;
    if (this.aoQuad && this.aoTarget) {
      r.getDrawingBufferSize(this.size);
      const w = Math.max(1, Math.round(this.size.x * 0.5)), h = Math.max(1, Math.round(this.size.y * 0.5));
      if (this.aoTarget.width !== w || this.aoTarget.height !== h) this.aoTarget.setSize(w, h);
      const prev = r.getRenderTarget();
      r.setRenderTarget(this.aoTarget);
      this.aoQuad.render(r);
      r.setRenderTarget(prev);
    }
    this.pipeline.render();
  }

  dispose() {
    for (const n of this.nodes) {
      try { n.dispose(); } catch {}
    }
    this.pipeline.dispose();
    this.aoTarget?.dispose();
    (this.aoQuad?.material as NodeMaterial | undefined)?.dispose();
  }
}
