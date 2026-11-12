import {
  BackSide,
  CustomToneMapping,
  DoubleSide,
  GLSL3,
  HalfFloatType,
  NoBlending,
  PerspectiveCamera,
  RawShaderMaterial,
  ShaderChunk,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type IUniform,
  type Material,
  type Mesh,
  type Object3D,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { FXAAPass } from "three/examples/jsm/postprocessing/FXAAPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { FullScreenQuad, Pass } from "three/examples/jsm/postprocessing/Pass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { Quality, RenderContext, SceneModule } from "./context.js";
import {
  aoFadeEndFor,
  aoFadeStartFor,
  aoRadiusFor,
  createFrameMeter,
  documentVisibility,
  createGovernor,
  detectQuality,
  postPlan,
  samePostPlan,
  stepGovernor,
  tiltShiftFor,
  withCustomToneMapping,
  type GovernorState,
  type PostPlan,
} from "./quality.js";

/** What the scene reports about how it is drawing. */
export interface RenderInfo {
  /** The quality the frame is drawn at. */
  quality: Quality;
  /** The graphics hardware, as WebGL names it; empty when the browser will not say. */
  gl: string;
  /** The smoothed time between frames, in milliseconds; 0 until two frames have been drawn. */
  frameMs: number;
}

/**
 * The last stage: it draws the frame, measures how long frames take, and decides the quality
 * when the player leaves it on "auto".
 */
export type PostModule = SceneModule & {
  /** Draws the scene to the canvas. The scene calls this once per frame, after every `update`. */
  render(): void;
  /**
   * What the player asked for. "auto" starts from the graphics hardware (a software renderer gets
   * `low`) and lets the governor step down when frames stay slow; a named quality is held as is.
   */
  request(quality: Quality | "auto"): void;
  /**
   * How the scene is being drawn. `quality` is the quality this module wants in force: when it
   * differs from `ctx.quality` after a `render()`, the scene applies it to every module through
   * `setQuality`.
   */
  readonly info: RenderInfo;
};

/**
 * The name of the graphics hardware behind `renderer`: the unmasked renderer string where the
 * browser gives it (`WEBGL_debug_renderer_info`), the masked one otherwise, or "" when neither can
 * be read.
 */
export function glRendererString(renderer: WebGLRenderer): string {
  try {
    const gl = renderer.getContext();
    const extension = gl.getExtension("WEBGL_debug_renderer_info");
    const name: unknown = extension
      ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    return typeof name === "string" ? name : "";
  } catch {
    return "";
  }
}

// The look ---------------------------------------------------------------------------------------

/** Exposure of the whole picture. The lighting is authored for 1. */
const EXPOSURE = 1;

/**
 * The tone curve and the grade, as three's custom tone mapping operator. It is the one place the
 * picture's colors are decided, at every quality: at `low` three applies it in each material as
 * it draws to the canvas, and at `medium` and `high` the finish pass applies it to the finished
 * frame, so the tiers differ in what is drawn and never in color.
 *
 * In goes scene-linear light, out comes display-linear color in 0..1. The grade is small: a little
 * vibrance, which lifts the muted colors more than the ones that are already strong (so the grass
 * gains and nothing turns neon), and a gentle S-curve for contrast, worked on the square root of
 * the color because that is close to how light the eye takes it to be.
 */
export const LOOK_TONE_MAPPING_GLSL = /* glsl */ `
vec3 CustomToneMapping( vec3 color ) {

	color = NeutralToneMapping( color );

	float cwLuma = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
	float cwPeak = max( color.r, max( color.g, color.b ) );
	float cwSpread = ( cwPeak - min( color.r, min( color.g, color.b ) ) ) / max( cwPeak, 1e-4 );
	color = mix( vec3( cwLuma ), color, 1.0 + 0.08 * ( 1.0 - cwSpread ) );

	vec3 cwTone = sqrt( clamp( color, 0.0, 1.0 ) );
	cwTone += 0.8 * cwTone * cwTone * ( 1.0 - cwTone ) * ( cwTone - 0.4 );
	return cwTone * cwTone;

}`;

/** three's own tone mapping chunk, kept while the look is installed in its place. */
let stockToneMappingChunk: string | null = null;
/** How many post modules have the look installed. */
let lookUsers = 0;

/**
 * Puts the look into three's tone mapping chunk, where every material and the finish pass pick it
 * up when their shaders are built. The chunk is one per page, so the installs are counted and the
 * last `uninstallLook` puts three's own back.
 */
function installLook(): void {
  if (lookUsers++ > 0) return;
  stockToneMappingChunk = ShaderChunk.tonemapping_pars_fragment;
  // DEBUG-TEMP
  const params = new URLSearchParams(
    (globalThis as { location?: { search?: string } }).location?.search ?? "",
  );
  let look = LOOK_TONE_MAPPING_GLSL;
  const tm = params.get("tm");
  if (tm === "aces") look = look.replace("NeutralToneMapping", "ACESFilmicToneMapping");
  if (tm === "agx") look = look.replace("NeutralToneMapping", "AgXToneMapping");
  if (params.get("grade") === "off")
    look = look.replace("1.0 + 0.08 *", "1.0 + 0.0 *").replace("+= 0.8 *", "+= 0.0 *");
  ShaderChunk.tonemapping_pars_fragment = withCustomToneMapping(stockToneMappingChunk, look);
}

function uninstallLook(): void {
  if (--lookUsers > 0 || stockToneMappingChunk === null) return;
  ShaderChunk.tonemapping_pars_fragment = stockToneMappingChunk;
  stockToneMappingChunk = null;
}

// DEBUG-TEMP: look development switches read from the page's address.
const debugParams = new URLSearchParams(
  (globalThis as { location?: { search?: string } }).location?.search ?? "",
);

// Ambient occlusion ------------------------------------------------------------------------------

/** How much of the occlusion found is taken out of the picture, where nothing holds it back. */
const AO_INTENSITY = 1;

/** The vertex stage of every full-screen pass of this module's own that three prefixes. */
const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

/**
 * Lays the occlusion over the scene. Occlusion is light that the sky cannot reach, so it belongs
 * to the shade and not to what the sun lights directly, and it has a color: light bounces between
 * the faces of a crease in a bright surface and fills it in again. Both keep it from looking like
 * dirt. It fades with distance into the haze, and it is left off the sky altogether.
 */
const AO_COMPOSITE_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tAo;
uniform highp sampler2D tDepth;
uniform vec2 uAoTexel;
uniform float uNear;
uniform float uFar;
uniform vec2 uFade;
uniform float uIntensity;
varying vec2 vUv;

#include <common>
#include <packing>

// Occlusion with the light that bounces around inside a crease of this albedo put back
// (Jimenez et al., Practical Real-Time Strategies for Accurate Indirect Occlusion).
vec3 cwAoBounce( float ao, vec3 albedo ) {
  vec3 a = 2.0404 * albedo - 0.3324;
  vec3 b = -4.7951 * albedo + 0.6417;
  vec3 c = 2.7552 * albedo + 0.6903;
  return max( vec3( ao ), ( ( ao * a + b ) * ao + c ) * ao );
}

void main() {
  vec4 color = texture2D( tDiffuse, vUv );
  float depth = texture2D( tDepth, vUv ).x;
  #ifdef CW_AO_COARSE
    // The occlusion is coarser than the picture, so the samples below reach a texel of it to
    // every side. If there is sky there, this pixel may be sky too: leave it alone.
    vec2 o = uAoTexel;
    depth = max( depth, texture2D( tDepth, vUv + vec2( o.x, o.y ) ).x );
    depth = max( depth, texture2D( tDepth, vUv + vec2( -o.x, o.y ) ).x );
    depth = max( depth, texture2D( tDepth, vUv + vec2( o.x, -o.y ) ).x );
    depth = max( depth, texture2D( tDepth, vUv + vec2( -o.x, -o.y ) ).x );
  #endif
  // Four taps half a texel out: a small tent over the occlusion, which takes the edge off the
  // odd pixel the denoiser could not reach at a silhouette.
  vec2 h = 0.5 * uAoTexel;
  float ao = 0.25 * (
    texture2D( tAo, vUv + vec2( h.x, h.y ) ).r + texture2D( tAo, vUv + vec2( -h.x, h.y ) ).r +
    texture2D( tAo, vUv + vec2( h.x, -h.y ) ).r + texture2D( tAo, vUv + vec2( -h.x, -h.y ) ).r );

  float strength = 0.0;
  if ( depth < 1.0 ) {
    float distance = -perspectiveDepthToViewZ( depth, uNear, uFar );
    strength = uIntensity * ( 1.0 - smoothstep( uFade.x, uFade.y, distance ) );
  }
  // What the sun lights directly keeps most of its light: only the shade is the sky's to give.
  float luma = dot( color.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  strength *= 1.0 - 0.45 * smoothstep( 0.25, 0.9, luma );

  #ifdef CW_AO_SPLIT
    strength *= step( 0.5, vUv.x );
  #endif
  vec3 occlusion = cwAoBounce( ao, clamp( color.rgb, 0.0, 1.0 ) );
  #ifdef CW_AO_VIEW
    gl_FragColor = vec4( pow( mix( vec3( 1.0 ), vec3( ao ), strength ), vec3( 2.0 ) ) * 0.8, 1.0 );
  #else
    gl_FragColor = vec4( color.rgb * mix( vec3( 1.0 ), occlusion, strength ), color.a );
  #endif
}`;

/** Whether `object` is something three draws by itself. */
function isDrawn(object: Object3D): boolean {
  const o = object as Object3D & {
    isMesh?: boolean;
    isLine?: boolean;
    isPoints?: boolean;
    isSprite?: boolean;
  };
  return o.isMesh === true || o.isLine === true || o.isPoints === true || o.isSprite === true;
}

/** Whether a surface with `material` is solid enough to shade its surroundings. */
function isSolid(material: Material): boolean {
  return (
    !material.transparent &&
    material.depthWrite &&
    material.depthTest &&
    material.colorWrite &&
    material.allowOverride &&
    material.side !== BackSide
  );
}

/**
 * Whether `object` takes part in ambient occlusion. Occlusion is worked out from a second, plain
 * drawing of the scene (see `AoPass`), and what should not shade the ground, or cannot be drawn
 * plainly, is left out of it:
 *
 * - anything but a mesh (lines, points, sprites);
 * - a mesh that is see-through, writes no depth, or shows its inside (water, a sky dome, glows);
 * - a mesh whose instances are placed by attributes of its own rather than by an instance matrix,
 *   since the plain drawing would put them all in one spot;
 * - a mesh that says so itself with `userData.ambientOcclusion = false`.
 */
function occludes(object: Object3D): boolean {
  const mesh = object as Mesh & { isInstancedMesh?: boolean };
  if (mesh.isMesh !== true) return false;
  if (mesh.userData.ambientOcclusion === false) return false;
  const geometry = mesh.geometry as Mesh["geometry"] & { isInstancedBufferGeometry?: boolean };
  if (geometry.isInstancedBufferGeometry === true && mesh.isInstancedMesh !== true) return false;
  const material = mesh.material;
  if (Array.isArray(material)) {
    for (let i = 0; i < material.length; i++) {
      const part = material[i];
      if (part && !isSolid(part)) return false;
    }
    return true;
  }
  return isSolid(material);
}

/** Hides everything under `object` that takes no part in occlusion, and notes it in `hidden`. */
function hideFromAo(object: Object3D, hidden: Object3D[]): void {
  if (!object.visible) return;
  if (isDrawn(object) && !occludes(object)) {
    object.visible = false;
    hidden.push(object);
    return;
  }
  const children = object.children;
  for (let i = 0; i < children.length; i++) hideFromAo(children[i] as Object3D, hidden);
}

/**
 * Works out ambient occlusion with three's `GTAOPass`, and keeps what that pass does to the scene
 * in hand. `GTAOPass` (r186) draws the whole scene a second time with one plain material to get
 * depth and normals, then finds the occlusion and denoises it. Left to itself that second drawing
 * takes water for a solid floor, draws the sky dome, renders the shadow maps over again and
 * clears to the scene's background. So this pass wraps it:
 *
 * - what takes no part in occlusion is hidden for that drawing (`occludes`);
 * - the background is taken away and the shadow maps are left as the frame's first drawing made
 *   them;
 * - the drawing is done with a camera of its own that sees only as far as the occlusion reaches,
 *   so the far land and its trees are culled from it;
 * - three's pass is told to keep its result to itself (`OUTPUT.Off`): `AoCompositePass` lays it
 *   over the picture, with more care than three's own blend takes.
 */
class AoPass extends Pass {
  readonly gtao: GTAOPass;
  /** The camera the occlusion is drawn and worked out with: the view camera, seeing less far. */
  readonly camera = new PerspectiveCamera();
  private readonly hidden: Object3D[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly view: PerspectiveCamera,
    private readonly scale: number,
    samples: number,
  ) {
    super();
    this.needsSwap = false;
    this.gtao = new GTAOPass(scene, this.camera, 1, 1);
    this.gtao.output = GTAOPass.OUTPUT.Off;
    // Thin things that are drawn from both sides (a flag) are in the picture from both sides.
    this.gtao.normalMaterial.side = DoubleSide;
    this.gtao.updateGtaoMaterial({
      samples,
      distanceExponent: 1.6,
      distanceFallOff: 1,
      scale: 2.6,
      screenSpaceRadius: false,
    });
    this.gtao.updatePdMaterial({
      lumaPhi: 10,
      depthPhi: 2,
      normalPhi: 3,
      radius: 6,
      radiusExponent: 1.5,
      rings: 2,
      samples: 8,
    });
  }

  /** The occlusion, 1 where there is none: the red channel of this texture. */
  get map(): Texture {
    return this.gtao.gtaoMap;
  }

  /** The depth the occlusion was worked out from, as seen by `camera`. */
  get depth(): Texture {
    return this.gtao.depthTexture;
  }

  /** How far occlusion reaches, in world units, and how far from the eye it is worked out. */
  setReach(radius: number, far: number): void {
    const uniforms = this.gtao.gtaoMaterial.uniforms as Record<string, IUniform<number>>;
    (uniforms.radius as IUniform<number>).value = radius;
    // A surface more than this far behind another is not what shades it.
    (uniforms.thickness as IUniform<number>).value = radius * 0.8;
    const pd = this.gtao.pdMaterial.uniforms as Record<string, IUniform<number>>;
    // The denoiser tells surfaces apart by how far they are from each other's plane.
    (pd.depthPhi as IUniform<number>).value = Math.max(0.5, radius * 2);
    this.camera.far = far;
  }

  override setSize(width: number, height: number): void {
    this.gtao.setSize(
      Math.max(1, Math.round(width * this.scale)),
      Math.max(1, Math.round(height * this.scale)),
    );
  }

  override render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    const { camera, view, scene, hidden } = this;
    camera.position.copy(view.position);
    camera.quaternion.copy(view.quaternion);
    camera.layers.mask = view.layers.mask;
    camera.fov = view.fov;
    camera.aspect = view.aspect;
    camera.near = view.near;
    camera.far = Math.min(camera.far, view.far);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    hideFromAo(scene, hidden);
    const background = scene.background;
    scene.background = null;
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    try {
      this.gtao.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    } finally {
      renderer.shadowMap.autoUpdate = shadowAutoUpdate;
      scene.background = background;
      for (let i = 0; i < hidden.length; i++) (hidden[i] as Object3D).visible = true;
      hidden.length = 0;
    }
  }

  override dispose(): void {
    this.gtao.dispose();
    // three's pass leaves these two behind.
    this.gtao.gtaoMaterial.dispose();
    this.gtao.blendMaterial.dispose();
  }
}

/** Draws the scene into a multisampled target of its own; the passes after it read that. */
class ScenePass extends Pass {
  constructor(
    private readonly scene: Scene,
    private readonly camera: PerspectiveCamera,
    readonly target: WebGLRenderTarget,
  ) {
    super();
    this.needsSwap = false;
  }

  override render(renderer: WebGLRenderer): void {
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
  }
}

/** Reads the drawn scene and the occlusion and writes the shaded scene into the composer. */
class AoCompositePass extends Pass {
  readonly material: ShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor(
    scene: Texture,
    private readonly ao: AoPass,
    coarse: boolean,
    view: boolean,
  ) {
    super();
    const defines: Record<string, string> = {};
    if (coarse) defines.CW_AO_COARSE = "";
    if (view) defines.CW_AO_VIEW = "";
    if (debugParams.get("ao") === "split") defines.CW_AO_SPLIT = ""; // DEBUG-TEMP
    this.material = new ShaderMaterial({
      name: "CwAoComposite",
      defines,
      uniforms: {
        tDiffuse: { value: scene },
        tAo: { value: ao.map },
        tDepth: { value: ao.depth },
        uAoTexel: { value: new Vector2(1, 1) },
        uNear: { value: 0.5 },
        uFar: { value: 1000 },
        uFade: { value: new Vector2(100, 200) },
        uIntensity: { value: AO_INTENSITY },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: AO_COMPOSITE_FRAGMENT,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /** Where the occlusion fades out, in world units from the eye. */
  setFade(start: number, end: number): void {
    (this.material.uniforms.uFade as IUniform<Vector2>).value.set(start, end);
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget): void {
    const uniforms = this.material.uniforms;
    const { gtao, camera } = this.ao;
    (uniforms.uAoTexel as IUniform<Vector2>).value.set(1 / gtao.width, 1 / gtao.height);
    (uniforms.uNear as IUniform<number>).value = camera.near;
    (uniforms.uFar as IUniform<number>).value = camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}

// Bloom ------------------------------------------------------------------------------------------

/** Scene-linear brightness above which light blooms: above anything the sun lights matt. */
const BLOOM_THRESHOLD = 1.0;
/** The width of the soft start above and below the threshold. */
const BLOOM_KNEE = 0.5;
const BLOOM_STRENGTH = 0.1;
const BLOOM_RADIUS = 0.55;

/**
 * What blooms. three's own bright pass lets a pixel through whole the moment it passes the
 * threshold, so a wide area just over it (a bright sky) floods the picture. This one lets through
 * only what is above the threshold, starting softly, and holds the brightest glints down so that
 * a single pixel of sun on the water cannot throw a halo across the frame.
 */
const BLOOM_BRIGHT_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float luminosityThreshold;
uniform float smoothWidth;
varying vec2 vUv;
void main() {
  vec3 color = min( texture2D( tDiffuse, vUv ).rgb, vec3( 6.0 ) );
  float level = max( color.r, max( color.g, color.b ) );
  float soft = clamp( level - luminosityThreshold + smoothWidth, 0.0, 2.0 * smoothWidth );
  soft = soft * soft / ( 4.0 * smoothWidth + 1e-4 );
  float over = max( soft, level - luminosityThreshold ) / max( level, 1e-4 );
  gl_FragColor = vec4( color * over, 1.0 );
}`;

function createBloom(width: number, height: number): UnrealBloomPass {
  const bloom = new UnrealBloomPass(
    new Vector2(width, height),
    BLOOM_STRENGTH,
    BLOOM_RADIUS,
    BLOOM_THRESHOLD,
  );
  const uniforms = bloom.highPassUniforms as Record<string, IUniform>;
  (uniforms.smoothWidth as IUniform<number>).value = BLOOM_KNEE;
  bloom.materialHighPassFilter.dispose();
  bloom.materialHighPassFilter = new ShaderMaterial({
    name: "CwBloomBright",
    uniforms,
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: BLOOM_BRIGHT_FRAGMENT,
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
  });
  return bloom;
}

/** three's bloom pass leaves its bright-pass material behind when it is disposed. */
function disposeBloom(bloom: UnrealBloomPass): void {
  bloom.dispose();
  bloom.materialHighPassFilter.dispose();
}

// The finish pass --------------------------------------------------------------------------------

/** The widest the tilt-shift blur gets, in pixels of a frame 900 pixels high. */
const TILT_MAX_RADIUS = 3;
/** How much darker the corners of the frame are than its middle. */
const VIGNETTE = 0.08;

/** The blur's taps on a unit disc: a ring of 6 half way out and a ring of 12 on the rim. */
function tiltKernelGlsl(): string {
  const taps: string[] = [];
  const ring = (count: number, radius: number, turn: number) => {
    for (let i = 0; i < count; i++) {
      const angle = ((i + turn) / count) * Math.PI * 2;
      taps.push(
        `vec2( ${(Math.cos(angle) * radius).toFixed(5)}, ${(Math.sin(angle) * radius).toFixed(5)} )`,
      );
    }
  };
  ring(6, 0.5, 0);
  ring(12, 1, 0.5);
  return `const vec2 CW_TILT_TAPS[ 18 ] = vec2[ 18 ]( ${taps.join(", ")} );`;
}

const FINISH_VERTEX = /* glsl */ `
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

/**
 * The finish: the lens, then the look. In scene-linear light it blurs toward the top and bottom
 * of the frame (the shallow focus of a photograph of a model; `high` only) and darkens the
 * corners a little. Then it applies the look (`LOOK_TONE_MAPPING_GLSL`, through three's tone
 * mapping chunk), encodes to sRGB, and adds a grain too fine to see so that the sky's slow
 * gradients do not band in 8 bits.
 */
const FINISH_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform float uTilt;
uniform float uVignette;
in vec2 vUv;
out vec4 cwOut;

#include <tonemapping_pars_fragment>
#include <colorspace_pars_fragment>

${tiltKernelGlsl()}

void main() {
  vec3 color = texture( tDiffuse, vUv ).rgb;

  #ifdef CW_TILT_SHIFT
    // In focus across the middle of the frame, where the camera looks; out of it toward the top
    // (far off) and the bottom (under the lens).
    float away = smoothstep( 0.35, 1.0, abs( vUv.y - 0.5 ) * 2.0 );
    float radius = uTilt * away * away;
    if ( radius > 0.3 ) {
      for ( int i = 0; i < 18; i++ ) {
        color += texture( tDiffuse, vUv + CW_TILT_TAPS[ i ] * radius * uTexel ).rgb;
      }
      color /= 19.0;
    }
  #endif

  vec2 fromCenter = vUv - 0.5;
  color *= 1.0 - uVignette * smoothstep( 0.25, 1.0, dot( fromCenter, fromCenter ) * 2.0 );

  color = CustomToneMapping( color );
  color = sRGBTransferOETF( vec4( color, 1.0 ) ).rgb;

  float grain = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  cwOut = vec4( color + ( grain - 0.5 ) / 255.0, 1.0 );
}`;

class FinishPass extends Pass {
  readonly material: RawShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor(tiltShift: boolean) {
    super();
    const defines: Record<string, string> = {};
    if (tiltShift) defines.CW_TILT_SHIFT = "";
    this.material = new RawShaderMaterial({
      name: "CwFinish",
      glslVersion: GLSL3,
      defines,
      uniforms: {
        tDiffuse: { value: null },
        uTexel: { value: new Vector2(1, 1) },
        uTilt: { value: 0 },
        uVignette: { value: VIGNETTE },
        toneMappingExposure: { value: EXPOSURE },
      },
      vertexShader: FINISH_VERTEX,
      fragmentShader: FINISH_FRAGMENT,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /** The tilt-shift blur's radius at the top and bottom edge of the frame, in pixels. */
  setTilt(radius: number): void {
    (this.material.uniforms.uTilt as IUniform<number>).value = radius;
  }

  override setSize(width: number, height: number): void {
    (this.material.uniforms.uTexel as IUniform<Vector2>).value.set(1 / width, 1 / height);
  }

  override render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    const uniforms = this.material.uniforms;
    (uniforms.tDiffuse as IUniform<Texture | null>).value = readBuffer.texture;
    (uniforms.toneMappingExposure as IUniform<number>).value = renderer.toneMappingExposure;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}

// The pipeline -----------------------------------------------------------------------------------

/** Everything the composer draws with, for one plan and one size of drawing buffer. */
interface Pipeline {
  plan: PostPlan;
  composer: EffectComposer;
  scene: ScenePass;
  ao: AoPass;
  aoComposite: AoCompositePass;
  bloom: UnrealBloomPass;
  finish: FinishPass;
  antialias: Pass;
  height: number;
}

function createPipeline(
  ctx: RenderContext,
  plan: PostPlan,
  width: number,
  height: number,
): Pipeline {
  const { renderer, scene, camera } = ctx;

  // The scene's own target: half-float so that light brighter than white survives to the bloom
  // and the tone curve, multisampled so that edges are smooth before anything else touches them.
  const sceneTarget = new WebGLRenderTarget(width, height, {
    type: HalfFloatType,
    samples: plan.samples,
    depthBuffer: true,
    // Nothing reads the depth afterwards (occlusion has its own), so it need not be resolved.
    resolveDepthBuffer: false,
    resolveStencilBuffer: false,
  });
  sceneTarget.texture.name = "CwPost.scene";

  // The composer's two buffers hold finished frames only: no samples, no depth.
  const buffer = new WebGLRenderTarget(width, height, { type: HalfFloatType, depthBuffer: false });
  buffer.texture.name = "CwPost.buffer";
  const composer = new EffectComposer(renderer, buffer);
  // Sizes are given to the composer in device pixels throughout.
  composer.setPixelRatio(1);

  // DEBUG-TEMP
  if (debugParams.get("aos") !== null)
    plan = { ...plan, aoSamples: Number(debugParams.get("aos")) };
  if (debugParams.get("aoscale") !== null)
    plan = { ...plan, aoScale: Number(debugParams.get("aoscale")) };
  const scenePass = new ScenePass(scene, camera, sceneTarget);
  const ao = new AoPass(scene, camera, plan.aoScale, plan.aoSamples);
  if (debugParams.get("pds") !== null)
    ao.gtao.updatePdMaterial({ samples: Number(debugParams.get("pds")) });
  if (debugParams.get("pd") === "off") ao.gtao.pdMaterial.defines.SAMPLES = 0;
  if (debugParams.get("aop") !== null)
    ao.gtao.updateGtaoMaterial({ scale: Number(debugParams.get("aop")) });
  const aoComposite = new AoCompositePass(
    sceneTarget.texture,
    ao,
    plan.aoScale < 1,
    debugParams.get("ao") === "view", // DEBUG-TEMP
  );
  const bloom = createBloom(width, height);
  const finish = new FinishPass(plan.tiltShift);
  const antialias: Pass = plan.antialias === "smaa" ? new SMAAPass() : new FXAAPass();

  // DEBUG-TEMP
  if (debugParams.get("bloom") !== null) bloom.strength = Number(debugParams.get("bloom"));
  if (debugParams.get("ao") === "off") aoComposite.material.uniforms.uIntensity!.value = 0;
  if (debugParams.get("aoi") !== null)
    aoComposite.material.uniforms.uIntensity!.value = Number(debugParams.get("aoi"));
  if (debugParams.get("aa") === "none") antialias.enabled = false;
  const off = (debugParams.get("off") ?? "").split(",");
  if (off.includes("aa")) antialias.enabled = false;
  if (off.includes("bloom")) bloom.enabled = false;
  if (off.includes("ao")) {
    ao.enabled = false;
    aoComposite.material.uniforms.uIntensity!.value = 0;
  }
  if (off.includes("tilt")) {
    delete finish.material.defines!.CW_TILT_SHIFT;
  }
  if (debugParams.get("vig") !== null)
    finish.material.uniforms.uVignette!.value = Number(debugParams.get("vig"));

  composer.addPass(scenePass);
  composer.addPass(ao);
  composer.addPass(aoComposite);
  composer.addPass(bloom);
  composer.addPass(finish);
  composer.addPass(antialias);
  composer.setSize(width, height);

  return {
    plan,
    composer,
    scene: scenePass,
    ao,
    aoComposite,
    bloom,
    finish,
    antialias,
    height,
  };
}

function resizePipeline(pipeline: Pipeline, width: number, height: number): void {
  pipeline.scene.target.setSize(width, height);
  pipeline.composer.setSize(width, height);
  pipeline.height = height;
}

function disposePipeline(pipeline: Pipeline): void {
  pipeline.scene.target.dispose();
  pipeline.ao.dispose();
  pipeline.aoComposite.dispose();
  disposeBloom(pipeline.bloom);
  pipeline.finish.dispose();
  pipeline.antialias.dispose();
  pipeline.composer.dispose();
}

/**
 * Creates the post module: what turns the drawn scene into the finished frame.
 *
 * At `low` the scene is drawn straight to the canvas and that is all. At `medium` and `high` it
 * goes through three's `EffectComposer`:
 *
 * 1. the scene, into a multisampled half-float target;
 * 2. ground-truth ambient occlusion (three's `GTAOPass`), laid over it as contact shade;
 * 3. bloom (three's `UnrealBloomPass`) on what is brighter than white: glints and the sun;
 * 4. the finish pass: tilt-shift blur, vignette, the tone curve and grade, sRGB;
 * 5. edge smoothing on the finished picture (three's `SMAAPass`, or `FXAAPass` at `medium`).
 *
 * The tone curve and grade are one function shared by every tier (`LOOK_TONE_MAPPING_GLSL`), so
 * `low` has the colors of the others. `postPlan` says what each tier is made of.
 *
 * The module also measures the frame time and, on "auto", lets the governor choose the quality.
 */
export function createPost(ctx: RenderContext): PostModule {
  const { renderer, scene, camera, rig } = ctx;
  const previousToneMapping = renderer.toneMapping;
  const previousExposure = renderer.toneMappingExposure;
  installLook();
  renderer.toneMapping = CustomToneMapping;
  renderer.toneMappingExposure = EXPOSURE;

  const gl = glRendererString(renderer);
  // A long frame on a visible page is a slow frame; only a hidden page has paused.
  const visibility = documentVisibility();
  const meter = createFrameMeter({ wasHidden: visibility.wasHidden });
  let governor: GovernorState | null = null;
  let wanted: Quality = ctx.quality;

  const bufferSize = renderer.getDrawingBufferSize(new Vector2());
  let pixelRatio = renderer.getPixelRatio();
  /** What the frame is drawn with: follows the quality in force and the pixel ratio. */
  let plan = postPlan(ctx.quality, pixelRatio);
  /** Built when a frame first needs it, and again whenever the plan changes. */
  let pipeline: Pipeline | null = null;

  function setPlan(next: PostPlan | null): void {
    if (samePostPlan(plan, next)) return;
    plan = next;
    // The old pipeline goes at once (at `low` its memory is wanted back); the next frame builds
    // the new one.
    if (pipeline) {
      disposePipeline(pipeline);
      pipeline = null;
    }
  }

  const info: RenderInfo = {
    get quality() {
      return wanted;
    },
    gl,
    get frameMs() {
      return meter.frameMs;
    },
  };

  return {
    info,
    request(quality: Quality | "auto"): void {
      if (quality === "auto") {
        governor = createGovernor(detectQuality(gl), performance.now());
        wanted = governor.quality;
      } else {
        governor = null;
        wanted = quality;
      }
    },
    render(): void {
      const now = performance.now();
      const frameMs = meter.sample(now);
      if (governor && frameMs > 0) {
        // The pause goes along, so that time in a hidden tab is not taken for slow frames.
        governor = stepGovernor(governor, frameMs, now, meter.pausedMs);
        wanted = governor.quality;
      }

      if (
        plan === null ||
        bufferSize.x < 1 ||
        bufferSize.y < 1 ||
        debugParams.get("post") === "direct"
      ) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      pipeline ??= createPipeline(ctx, plan, bufferSize.x, bufferSize.y);

      const distance = rig.distance;
      const fadeEnd = aoFadeEndFor(distance);
      pipeline.ao.setReach(
        aoRadiusFor(distance) * Number(debugParams.get("aor") ?? 1), // DEBUG-TEMP
        fadeEnd * 1.05,
      );
      pipeline.aoComposite.setFade(aoFadeStartFor(distance), fadeEnd);
      pipeline.finish.setTilt(
        tiltShiftFor(distance, rig.pitch) * TILT_MAX_RADIUS * (pipeline.height / 900),
      );
      pipeline.composer.render();
    },
    setQuality(quality: Quality): void {
      setPlan(postPlan(quality, pixelRatio));
    },
    resize(_width: number, _height: number, ratio: number): void {
      // The renderer has its new size already; its drawing buffer is what the targets match.
      renderer.getDrawingBufferSize(bufferSize);
      pixelRatio = ratio;
      setPlan(postPlan(ctx.quality, pixelRatio));
      if (pipeline && bufferSize.x >= 1 && bufferSize.y >= 1) {
        resizePipeline(pipeline, bufferSize.x, bufferSize.y);
      }
    },
    dispose(): void {
      visibility.dispose();
      if (pipeline) {
        disposePipeline(pipeline);
        pipeline = null;
      }
      renderer.setRenderTarget(null);
      renderer.toneMapping = previousToneMapping;
      renderer.toneMappingExposure = previousExposure;
      uninstallLook();
    },
  };
}
