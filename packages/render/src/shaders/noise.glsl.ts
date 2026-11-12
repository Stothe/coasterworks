/**
 * The noise every shader in the renderer shares, as GLSL ES 3.00 source to paste ahead of the code
 * that uses it. No textures: everything is computed from the coordinates.
 *
 * The hashes are integer hashes (multiply, shift, xor on `uint`), not the `fract(sin(x) * big)`
 * kind. Integer math is exact on every GPU, so the pattern is the same on Apple, mobile and
 * software renderers and has none of the banding or drift a sine hash shows once the coordinates
 * grow. Lattice coordinates are taken with `floor` and cast through `int`, so negative
 * coordinates are fine.
 *
 * All names start with `cw`. Everything returns values in 0..1 unless it says otherwise, ends
 * included, and never outside: the gradient noise is held to that range where it would stray.
 *
 * - `float cwHash12(vec2 p)`: one number for a lattice point.
 * - `vec2 cwHash22(vec2 p)`: two independent numbers for a lattice point.
 * - `float cwValueNoise(vec2 p)`: smooth value noise, one feature per unit.
 * - `float cwGradNoise(vec2 p)`: gradient noise, one feature per unit, smoother and less grid
 *   aligned than value noise.
 * - `vec3 cwGradNoiseD(vec2 p)`: the same value in `x`, and its exact derivative with respect to
 *   `p` in `yz` (zero on the rare sample where the value is held at 0 or 1).
 * - `float cwFbm(vec2 p, int octaves)`: fractal sum of gradient noise (up to 8 octaves), each
 *   octave twice the frequency and half the weight, rotated to hide the lattice.
 * - `vec3 cwFbmD(vec2 p, int octaves)`: the same value in `x`, and its derivative in `yz`.
 * - `vec2 cwVoronoi(vec2 p)`: cells of about one unit; `x` is the distance to the nearest cell
 *   point (0 at the point, about 0.5 at an edge, never above about 1.1), `y` is a number in 0..1
 *   that names the cell.
 */
export const NOISE_GLSL = /* glsl */ `
#ifndef CW_NOISE_GLSL
#define CW_NOISE_GLSL

uint cwHashU(uvec2 v) {
  // Two rounds of a multiply-xorshift mix over both coordinates.
  uint h = v.x * 0x9E3779B1u + v.y * 0x85EBCA77u;
  h ^= h >> 15;
  h *= 0x2C1B3C6Du;
  h ^= h >> 12;
  h *= 0x297A2D39u;
  h ^= h >> 15;
  return h;
}

uvec2 cwLattice(vec2 p) {
  return uvec2(ivec2(floor(p)));
}

float cwHash12(vec2 p) {
  // The top 24 bits: every one of them fits a float exactly.
  return float(cwHashU(cwLattice(p)) >> 8) * (1.0 / 16777216.0);
}

vec2 cwHash22(vec2 p) {
  uint h = cwHashU(cwLattice(p));
  uint k = h * 0x9E3779B1u + 0x7F4A7C15u;
  k ^= k >> 16;
  return vec2(float(h >> 8), float(k >> 8)) * (1.0 / 16777216.0);
}

float cwValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  // Quintic fade: level first and second derivatives at the lattice points.
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = cwHash12(i);
  float b = cwHash12(i + vec2(1.0, 0.0));
  float c = cwHash12(i + vec2(0.0, 1.0));
  float d = cwHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec2 cwGradient(vec2 i) {
  // A unit-ish gradient in -1..1 on each axis.
  return cwHash22(i) * 2.0 - 1.0;
}

vec3 cwGradNoiseD(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

  vec2 ga = cwGradient(i);
  vec2 gb = cwGradient(i + vec2(1.0, 0.0));
  vec2 gc = cwGradient(i + vec2(0.0, 1.0));
  vec2 gd = cwGradient(i + vec2(1.0, 1.0));

  float va = dot(ga, f);
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));

  float value = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd);
  vec2 slope =
    ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) +
    du * (u.yx * (va - vb - vc + vd) + vec2(vb, vc) - va);
  // The raw value keeps within about -0.7..0.7 but can reach -1..1 where four gradients line up
  // (a few samples in a million). Bring it to 0..1 and hold it there, with no slope where it is
  // held, so that what comes out is safe to hand to pow or sqrt.
  float scaled = value * 0.7 + 0.5;
  float inside = step(0.0, scaled) * step(scaled, 1.0);
  return vec3(clamp(scaled, 0.0, 1.0), slope * (0.7 * inside));
}

float cwGradNoise(vec2 p) {
  return cwGradNoiseD(p).x;
}

// Turns each octave by about 37 degrees and doubles its frequency.
const mat2 cwOctave = mat2(1.6, 1.2, -1.2, 1.6);

float cwFbm(vec2 p, int octaves) {
  float sum = 0.0;
  float weight = 0.5;
  float total = 0.0;
  for (int k = 0; k < 8; k++) {
    if (k >= octaves) break;
    sum += weight * cwGradNoise(p);
    total += weight;
    weight *= 0.5;
    p = cwOctave * p + vec2(17.3, 9.1);
  }
  return sum / max(total, 1e-4);
}

vec3 cwFbmD(vec2 p, int octaves) {
  float sum = 0.0;
  vec2 slope = vec2(0.0);
  float weight = 0.5;
  float total = 0.0;
  // The matrix that takes the original p to this octave's coordinates.
  mat2 chain = mat2(1.0, 0.0, 0.0, 1.0);
  for (int k = 0; k < 8; k++) {
    if (k >= octaves) break;
    vec3 n = cwGradNoiseD(p);
    sum += weight * n.x;
    // Chain rule: the derivative with respect to the original p.
    slope += weight * (n.yz * chain);
    total += weight;
    weight *= 0.5;
    p = cwOctave * p + vec2(17.3, 9.1);
    chain = cwOctave * chain;
  }
  float inv = 1.0 / max(total, 1e-4);
  return vec3(sum * inv, slope * inv);
}

vec2 cwVoronoi(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  float nearest = 8.0;
  float id = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 cell = vec2(float(x), float(y));
      vec2 jitter = cwHash22(i + cell);
      vec2 d = cell + jitter - f;
      float dist = dot(d, d);
      if (dist < nearest) {
        nearest = dist;
        id = cwHash12(i + cell + vec2(57.0, 113.0));
      }
    }
  }
  return vec2(sqrt(nearest), id);
}

#endif
`;
