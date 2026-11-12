import { ShaderLib, type IUniform } from "three";
import { describe, expect, it } from "vitest";
import { ATMOSPHERE_GLSL, createAtmosphereUniforms } from "../src/atmosphere.glsl.js";
import { createSharedUniforms, type RenderContext } from "../src/context.js";
import { NOISE_GLSL } from "../src/shaders/noise.glsl.js";
import { createTerrainMaterial, type TerrainChunk } from "../src/terrain/material.js";

// Only the uniforms are read from the context; no WebGL is needed to compose the shader.
const ctx = {
  uniforms: createSharedUniforms(),
  atmosphereUniforms: createAtmosphereUniforms(),
} as unknown as RenderContext;

interface Shader {
  uniforms: Record<string, IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

/** The standard material's shader as three.js hands it to `onBeforeCompile`. */
function standardShader(): Shader {
  return {
    uniforms: {},
    vertexShader: ShaderLib.standard.vertexShader,
    fragmentShader: ShaderLib.standard.fragmentShader,
  };
}

function compile(material: ReturnType<typeof createTerrainMaterial>, shader: Shader): Shader {
  (material.onBeforeCompile as unknown as (shader: Shader) => void)(shader);
  return shader;
}

const chunk = (name: string, uniform: string): TerrainChunk => ({
  glsl: `uniform float ${uniform};\nvoid ${name}(inout CwSurf s, vec3 worldPos) { s.roughness = ${uniform}; }`,
  uniforms: { [uniform]: { value: 0.5 } },
});

describe("createTerrainMaterial", () => {
  it("patches the installed three.js standard shader: every include it relies on is there", () => {
    const material = createTerrainMaterial(ctx, { surface: null, paths: null, overlay: null });
    // Throws if this version of three.js renamed or dropped one of the includes.
    expect(() => compile(material, standardShader())).not.toThrow();
  });

  it("puts the library, the struct and the three chunks ahead of main, and calls them in order", () => {
    const surface = chunk("cwSurface", "cwSurf_test");
    const paths = chunk("cwPaths", "cwPath_test");
    const overlay = chunk("cwOverlay", "cwOvl_test");
    const material = createTerrainMaterial(ctx, { surface, paths, overlay });
    const { fragmentShader, vertexShader } = compile(material, standardShader());

    const main = fragmentShader.indexOf("void main()");
    const at = (text: string) => fragmentShader.indexOf(text);
    expect(main).toBeGreaterThan(0);
    for (const declared of [
      "uniform float uTime;",
      "float cwHash12(vec2 p)",
      "float cwCloudShadow(vec2 worldXZ)",
      "struct CwSurf",
      surface.glsl,
      paths.glsl,
      overlay.glsl,
    ]) {
      expect(at(declared)).toBeGreaterThan(-1);
      expect(at(declared)).toBeLessThan(main);
    }
    expect(at("struct CwSurf")).toBeLessThan(at(surface.glsl));
    expect(at(surface.glsl)).toBeLessThan(at(paths.glsl));
    expect(at(paths.glsl)).toBeLessThan(at(overlay.glsl));

    // In main: after three.js has set the surface up, before the lights read it.
    const call = (name: string) => fragmentShader.indexOf(`${name}( cwS, cwWorldPos );`);
    expect(call("cwSurface")).toBeGreaterThan(at("#include <emissivemap_fragment>"));
    expect(call("cwSurface")).toBeLessThan(call("cwPaths"));
    expect(call("cwPaths")).toBeLessThan(call("cwOverlay"));
    expect(call("cwOverlay")).toBeLessThan(at("#include <lights_physical_fragment>"));
    expect(at("cwCloudShadow( cwWorldPos.xz )")).toBeGreaterThan(
      at("#include <lights_fragment_begin>"),
    );
    expect(at("cwCloudShadow( cwWorldPos.xz )")).toBeLessThan(
      at("#include <lights_fragment_maps>"),
    );

    expect(vertexShader).toContain("varying vec3 cwWorldPos;");
    expect(vertexShader.indexOf("cwWorldPos = (")).toBeGreaterThan(
      vertexShader.indexOf("#include <project_vertex>"),
    );
  });

  it("binds the shared uniforms and each chunk's own by reference", () => {
    const surface = chunk("cwSurface", "cwSurf_test");
    const material = createTerrainMaterial(ctx, { surface, paths: null, overlay: null });
    const { uniforms } = compile(material, standardShader());
    expect(uniforms.uTime).toBe(ctx.uniforms.uTime);
    expect(uniforms.uSunDir).toBe(ctx.uniforms.uSunDir);
    expect(uniforms.uMapSize).toBe(ctx.uniforms.uMapSize);
    expect(uniforms.cwSurf_test).toBe(surface.uniforms.cwSurf_test);
  });

  it("binds the atmosphere chunk's uniforms by reference, whatever they are", () => {
    const cwAtm_cover: IUniform<number> = { value: 0.4 };
    const withClouds = {
      uniforms: createSharedUniforms(),
      atmosphereUniforms: { cwAtm_cover },
    } as unknown as RenderContext;
    const material = createTerrainMaterial(withClouds, {
      surface: null,
      paths: null,
      overlay: null,
    });
    const { uniforms } = compile(material, standardShader());
    expect(uniforms.cwAtm_cover).toBe(cwAtm_cover);
    // The set a scene starts with is bound whole.
    const plain = compile(
      createTerrainMaterial(ctx, { surface: null, paths: null, overlay: null }),
      standardShader(),
    );
    for (const [name, uniform] of Object.entries(ctx.atmosphereUniforms)) {
      expect(plain.uniforms[name]).toBe(uniform);
    }
  });

  it("stands in an empty function for a chunk that is switched off", () => {
    const material = createTerrainMaterial(ctx, { surface: null, paths: null, overlay: null });
    const { fragmentShader } = compile(material, standardShader());
    expect(fragmentShader).toContain("void cwSurface(inout CwSurf s, vec3 worldPos) {}");
    expect(fragmentShader).toContain("void cwPaths(inout CwSurf s, vec3 worldPos) {}");
    expect(fragmentShader).toContain("void cwOverlay(inout CwSurf s, vec3 worldPos) {}");
  });

  it("fails loudly when three.js no longer has an include it patches", () => {
    const material = createTerrainMaterial(ctx, { surface: null, paths: null, overlay: null });
    for (const include of [
      "#include <emissivemap_fragment>",
      "#include <lights_fragment_begin>",
      "#include <normal_fragment_begin>",
      "#include <clipping_planes_pars_fragment>",
    ]) {
      const shader = standardShader();
      shader.fragmentShader = shader.fragmentShader.replace(include, "");
      expect(() => compile(material, shader)).toThrow(/Terrain material: .*fragment shader has no/);
    }
    const shader = standardShader();
    shader.vertexShader = shader.vertexShader.replace("#include <project_vertex>", "");
    expect(() => compile(material, shader)).toThrow(
      /vertex shader has no "#include <project_vertex>"/,
    );
  });

  it("gives materials with different chunks different program keys, and equal ones the same", () => {
    const none = { surface: null, paths: null, overlay: null };
    const a = createTerrainMaterial(ctx, none);
    const b = createTerrainMaterial(ctx, none);
    const c = createTerrainMaterial(ctx, { ...none, surface: chunk("cwSurface", "cwSurf_test") });
    expect(a.customProgramCacheKey()).toBe(b.customProgramCacheKey());
    expect(a.customProgramCacheKey()).not.toBe(c.customProgramCacheKey());
  });
});

describe("shared GLSL", () => {
  it("guards the noise library and the atmosphere chunk against being pasted twice", () => {
    expect(NOISE_GLSL).toContain("#ifndef CW_NOISE_GLSL");
    expect(ATMOSPHERE_GLSL).toContain("#ifndef CW_ATMOSPHERE_GLSL");
  });

  it("names every noise function the modules are promised", () => {
    for (const signature of [
      "float cwHash12(vec2 p)",
      "vec2 cwHash22(vec2 p)",
      "float cwValueNoise(vec2 p)",
      "float cwGradNoise(vec2 p)",
      "vec3 cwGradNoiseD(vec2 p)",
      "float cwFbm(vec2 p, int octaves)",
      "vec3 cwFbmD(vec2 p, int octaves)",
      "vec2 cwVoronoi(vec2 p)",
    ]) {
      expect(NOISE_GLSL).toContain(signature);
    }
    // No sine hash, which bands on some GPUs.
    expect(NOISE_GLSL).not.toMatch(/sin\s*\(/);
  });
});
