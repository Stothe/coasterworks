import { MeshStandardMaterial, type IUniform } from "three";
import { ATMOSPHERE_GLSL } from "../atmosphere.glsl.js";
import { SHARED_UNIFORMS_GLSL, type RenderContext } from "../context.js";
import { NOISE_GLSL } from "../shaders/noise.glsl.js";

/**
 * The materials every ride and stall is drawn with, shared by all of them: one soft, matte,
 * vertex-colored standard material (the models carry their paint in their vertex colors), and
 * the see-through ones of the placement ghost, tinted green where the ride may go, red where it
 * may not and grey while that is not yet known.
 */
export interface RideMaterials {
  lit: MeshStandardMaterial;
  ghostOk: MeshStandardMaterial;
  ghostBad: MeshStandardMaterial;
  /** Not yet checked: neither green nor red. */
  ghostWait: MeshStandardMaterial;
  /**
   * Turns the cloud shadow on the lit material on or off (on to begin with, when made with a
   * context). Off is for a software renderer at low, where the cloud field is dearer than it is
   * worth; the program is rebuilt without it.
   */
  setCloudShadow(on: boolean): void;
  dispose(): void;
}

const VERTEX_DECLARATIONS = /* glsl */ `
varying vec3 vCwRideWorld;
`;

// Where the vertex is in the world, instance and all, for the cloud shadow to be read at.
const VERTEX_WORLD = /* glsl */ `
{
  vec4 cwP = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  cwP = instanceMatrix * cwP;
#endif
  vCwRideWorld = ( modelMatrix * cwP ).xyz;
}
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
varying vec3 vCwRideWorld;
${SHARED_UNIFORMS_GLSL}
${NOISE_GLSL}
${ATMOSPHERE_GLSL}
`;

// The sun (or moon) is the scene's only direct light, so dimming all direct light dims exactly
// that, as on the ground and the scenery. Sky light is indirect and is left alone.
const FRAGMENT_CLOUD_SHADOW = /* glsl */ `
{
  float cwCloud = cwCloudShadow( vCwRideWorld.xz );
  reflectedLight.directDiffuse *= cwCloud;
  reflectedLight.directSpecular *= cwCloud;
}
`;

/** Puts `addition` right after `#include <name>` in `source`, or throws: the names are three.js's. */
function after(source: string, name: string, addition: string): string {
  const include = `#include <${name}>`;
  if (!source.includes(include)) {
    throw new Error(
      `Ride material: three.js's shader has no "${include}". ` +
        `The shader was written against three r186; see packages/render/src/rides/materials.ts.`,
    );
  }
  return source.replace(include, `${include}\n${addition}`);
}

function ghost(tint: number, glow: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    vertexColors: true,
    color: tint,
    emissive: glow,
    emissiveIntensity: 0.55,
    roughness: 0.8,
    metalness: 0,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
}

/**
 * The ride materials. With the scene's context the lit one takes the atmosphere's cloud shadow on
 * its direct light, by the same shader patch as the scenery's (the shared and atmosphere uniforms
 * bound by reference); without it, it is plain.
 */
export function createRideMaterials(
  ctx?: Pick<RenderContext, "uniforms" | "atmosphereUniforms">,
): RideMaterials {
  const lit = new MeshStandardMaterial({ vertexColors: true, roughness: 0.66, metalness: 0 });
  let clouds = ctx !== undefined;
  if (ctx) {
    const bound: Record<string, IUniform> = { ...ctx.uniforms, ...ctx.atmosphereUniforms };
    lit.onBeforeCompile = (shader) => {
      if (!clouds) return;
      Object.assign(shader.uniforms, bound);
      shader.vertexShader = after(
        after(shader.vertexShader, "common", VERTEX_DECLARATIONS),
        "begin_vertex",
        VERTEX_WORLD,
      );
      shader.fragmentShader = after(
        after(shader.fragmentShader, "clipping_planes_pars_fragment", FRAGMENT_DECLARATIONS),
        "lights_fragment_begin",
        FRAGMENT_CLOUD_SHADOW,
      );
    };
    lit.customProgramCacheKey = () => (clouds ? "cw-ride-clouds" : "cw-ride");
  }
  const ghostOk = ghost(0xb4f5b8, 0x1f8a3a);
  const ghostBad = ghost(0xf5b0a8, 0xa02a20);
  const ghostWait = ghost(0xd5dae3, 0x4a5568);
  return {
    lit,
    ghostOk,
    ghostBad,
    ghostWait,
    setCloudShadow(on) {
      if (!ctx || on === clouds) return;
      clouds = on;
      lit.needsUpdate = true;
    },
    dispose() {
      lit.dispose();
      ghostOk.dispose();
      ghostBad.dispose();
      ghostWait.dispose();
    },
  };
}
