import { CameraRig } from "@coasterworks/render";
import { describe, expect, it } from "vitest";
import { FRAMING, framingDistance } from "../src/viewport/framing";

const { limits } = new CameraRig();

describe("framingDistance", () => {
  it("pulls back to about a map-width and a bit for the longer side", () => {
    expect(framingDistance({ width: 64, height: 32 }, 40, limits.distance)).toBeCloseTo(
      64 * FRAMING,
      9,
    );
    expect(framingDistance({ width: 16, height: 80 }, 40, limits.distance)).toBeCloseTo(
      80 * FRAMING,
      9,
    );
  });

  it("keeps a camera that is already farther back", () => {
    expect(framingDistance({ width: 16, height: 16 }, 90, limits.distance)).toBe(90);
  });

  it("never goes closer than the nearest zoom", () => {
    expect(framingDistance({ width: 1, height: 1 }, 1, limits.distance)).toBe(limits.distance[0]);
  });

  it("opens a map larger than the farthest zoom at the farthest zoom", () => {
    // 256 * 1.05 is 268.8, past the rig's limit of 200.
    expect(framingDistance({ width: 256, height: 256 }, 40, limits.distance)).toBe(
      limits.distance[1],
    );
    expect(framingDistance({ width: 129, height: 40 }, 40, limits.distance)).toBeLessThanOrEqual(
      limits.distance[1],
    );
  });
});
