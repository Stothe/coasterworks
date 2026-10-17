import { describe, expect, it } from "vitest";
import { sunFor } from "../src/sky.js";

describe("sunFor", () => {
  it("peaks at midday", () => {
    const noon = sunFor(0.5);
    expect(noon.elevation).toBeCloseTo(-0.35 + 1.45, 9);
    expect(noon.intensity).toBe(2.2);
    expect(noon.ambient).toBeCloseTo(0.75, 9);
    expect(noon.color).toEqual([1.0, 0.95, 0.86]);
    expect(noon.skyColor).toEqual([0.62, 0.83, 0.95]);
    expect(noon.azimuth).toBeCloseTo(Math.PI / 4 + Math.PI / 2, 9);
  });

  it("is below the horizon with a warm color and a night sky at the start of the day", () => {
    const dawn = sunFor(0);
    expect(dawn.elevation).toBeCloseTo(-0.35, 9);
    expect(dawn.intensity).toBe(0.15);
    expect(dawn.color).toEqual([1.0, 0.72, 0.45]);
    expect(dawn.skyColor).toEqual([0.06, 0.08, 0.16]);
    expect(dawn.azimuth).toBeCloseTo(Math.PI / 4, 9);
  });

  it("wraps: 0 and 1 are the same moment, and so are t and t + n", () => {
    expect(sunFor(1)).toEqual(sunFor(0));
    expect(sunFor(1.25)).toEqual(sunFor(0.25));
    expect(sunFor(-0.25)).toEqual(sunFor(0.75));
  });

  it("never goes darker than the ambient floor", () => {
    for (let i = 0; i < 100; i++) {
      const s = sunFor(i / 100);
      expect(s.ambient).toBeGreaterThanOrEqual(0.25);
      expect(s.ambient).toBeLessThanOrEqual(0.75);
    }
  });

  it("keeps intensity and every color channel in range", () => {
    for (let i = 0; i < 100; i++) {
      const s = sunFor(i / 100);
      expect(s.intensity).toBeGreaterThanOrEqual(0.15);
      expect(s.intensity).toBeLessThanOrEqual(2.2);
      for (const c of [...s.color, ...s.skyColor]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  it("has a daytime plateau and a short dawn and dusk", () => {
    expect(sunFor(0.3).skyColor).toEqual([0.62, 0.83, 0.95]);
    expect(sunFor(0.7).skyColor).toEqual([0.62, 0.83, 0.95]);
    const dusk = sunFor(0.05);
    expect(dusk.skyColor[0]).toBeGreaterThan(0.2);
    expect(dusk.skyColor[0]).toBeGreaterThan(dusk.skyColor[2]);
  });

  it("rises to noon and sets again symmetrically in elevation", () => {
    expect(sunFor(0.1).elevation).toBeLessThan(sunFor(0.3).elevation);
    expect(sunFor(0.3).elevation).toBeLessThan(sunFor(0.5).elevation);
    expect(sunFor(0.2).elevation).toBeCloseTo(sunFor(0.8).elevation, 9);
  });
});
