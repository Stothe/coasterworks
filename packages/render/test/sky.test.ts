import { describe, expect, it } from "vitest";
import {
  AMBIENT_FLOOR,
  AMBIENT_NOON,
  MOON_FULL_INTENSITY,
  SUN_FULL_INTENSITY,
  airMass,
  linearToSrgb,
  luminance,
  smoothstep,
  sunFor,
  sunlightThrough,
  toneMap,
} from "../src/sky.js";

const length = (v: readonly number[]) => Math.hypot(v[0]!, v[1]!, v[2]!);

describe("sunFor", () => {
  it("peaks at midday with the full sun, white light and a blue sky", () => {
    const noon = sunFor(0.5);
    expect(noon.elevation).toBeCloseTo(-0.35 + 1.45, 9);
    expect(noon.intensity).toBeCloseTo(SUN_FULL_INTENSITY, 9);
    expect(noon.ambient).toBeCloseTo(AMBIENT_NOON, 9);
    expect(noon.moonlit).toBe(false);
    expect(noon.daylight).toBe(1);
    expect(noon.night).toBe(0);
    expect(noon.dusk).toBe(0);
    expect(noon.azimuth).toBeCloseTo(Math.PI / 4 + Math.PI / 2, 9);
    // Bluer overhead than at the horizon, and the horizon itself blue-white.
    expect(noon.zenith[2]).toBeGreaterThan(noon.zenith[0]);
    expect(noon.skyColor[2]).toBeGreaterThan(noon.skyColor[0]);
    expect(Math.max(...noon.lightColor)).toBeCloseTo(1, 9);
  });

  it("is moonlit, cool and still readable in the middle of the night", () => {
    const night = sunFor(0);
    expect(night.elevation).toBeCloseTo(-0.35, 9);
    expect(night.moonlit).toBe(true);
    expect(night.intensity).toBeCloseTo(MOON_FULL_INTENSITY, 9);
    expect(night.lightColor[2]).toBeGreaterThan(night.lightColor[0]);
    expect(night.night).toBe(1);
    expect(night.daylight).toBe(0);
    expect(night.ambient).toBeGreaterThanOrEqual(AMBIENT_FLOOR);
    expect(night.lightDirection).toEqual(night.moonDirection);
    expect(night.lightDirection[1]).toBeGreaterThan(0);
  });

  it("wraps: 0 and 1 are the same moment, and so are t and t + n", () => {
    expect(sunFor(1)).toEqual(sunFor(0));
    expect(sunFor(1.25)).toEqual(sunFor(0.25));
    expect(sunFor(-0.25)).toEqual(sunFor(0.75));
  });

  it("never goes darker than the ambient floor nor brighter than noon", () => {
    for (let i = 0; i < 200; i++) {
      const s = sunFor(i / 200);
      expect(s.ambient).toBeGreaterThanOrEqual(AMBIENT_FLOOR);
      expect(s.ambient).toBeLessThanOrEqual(AMBIENT_NOON + 1e-9);
    }
  });

  it("keeps intensity, the sRGB colors and the shares in range, and the directions unit", () => {
    for (let i = 0; i < 200; i++) {
      const s = sunFor(i / 200);
      expect(s.intensity).toBeGreaterThanOrEqual(0);
      expect(s.intensity).toBeLessThanOrEqual(SUN_FULL_INTENSITY + 1e-9);
      for (const c of [...s.color, ...s.skyColor]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
      for (const v of [s.daylight, s.night, s.dusk]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      for (const d of [s.sunDirection, s.moonDirection, s.lightDirection]) {
        expect(length(d)).toBeCloseTo(1, 6);
      }
      // The light never rakes the ground flat or comes from below it.
      expect(s.lightDirection[1]).toBeGreaterThan(0.35);
    }
  });

  it("has a warm dusk with sunset colors at the horizon", () => {
    // Find the moment the sun crosses the horizon in the evening.
    let t = 0.5;
    while (sunFor(t).elevation > -0.02) t += 0.001;
    const dusk = sunFor(t);
    expect(dusk.dusk).toBeGreaterThan(0.5);
    expect(dusk.horizon[0]).toBeGreaterThan(dusk.horizon[2]);
    // And no dusk colors at noon or midnight.
    expect(sunFor(0.5).dusk).toBe(0);
    expect(sunFor(0).dusk).toBe(0);
  });

  it("rises to noon and sets again symmetrically in elevation", () => {
    expect(sunFor(0.1).elevation).toBeLessThan(sunFor(0.3).elevation);
    expect(sunFor(0.3).elevation).toBeLessThan(sunFor(0.5).elevation);
    expect(sunFor(0.2).elevation).toBeCloseTo(sunFor(0.8).elevation, 9);
  });
});

describe("sky helpers", () => {
  it("smoothstep eases between its edges, either way round", () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 9);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(1, 0, 0)).toBe(1);
  });

  it("linearToSrgb maps the ends to themselves and brightens the middle", () => {
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(1)).toBeCloseTo(1, 9);
    expect(linearToSrgb(0.2)).toBeGreaterThan(0.2);
  });

  it("airMass is 1 overhead and grows toward the horizon", () => {
    expect(airMass(Math.PI / 2)).toBeCloseTo(1, 3);
    expect(airMass(0)).toBeGreaterThan(30);
    expect(airMass(-0.2)).toBe(airMass(0));
  });

  it("sunlight turns golden as the sun sinks", () => {
    const high = sunlightThrough(1.2);
    const low = sunlightThrough(0.05);
    expect(low[2] / low[0]).toBeLessThan(high[2] / high[0]);
    expect(luminance(low)).toBeLessThan(luminance(high));
  });

  it("toneMap keeps every curve in 0..1 and passes 'none' through", () => {
    expect(toneMap([0.3, 0.4, 0.5], "none", 2)).toEqual([0.3, 0.4, 0.5]);
    for (const curve of ["linear", "reinhard", "aces", "agx", "neutral"] as const) {
      for (const v of [0, 0.05, 0.5, 4]) {
        for (const c of toneMap([v, v * 0.8, v * 0.6], curve, 1)) {
          expect(c).toBeGreaterThanOrEqual(-1e-6);
          expect(c).toBeLessThanOrEqual(1 + 1e-6);
        }
      }
    }
  });
});
