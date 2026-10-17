// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { classicCycle, type ClassicAngle, type ClassicRig } from "../src/viewport/classicView";

/** A rig that sets its yaw as the real one does: 45 degrees plus `index` quarter turns. */
function fakeRig() {
  const rig: ClassicRig & { setClassic: ReturnType<typeof vi.fn> } = {
    yaw: 1,
    setClassic: vi.fn((index: ClassicAngle) => {
      rig.yaw = Math.PI / 4 + (index * Math.PI) / 2;
    }),
  };
  return rig;
}

const angles = (rig: ReturnType<typeof fakeRig>) => rig.setClassic.mock.calls.map(([i]) => i);

describe("classicCycle", () => {
  it("goes to the first angle, then round the four, one a call", () => {
    const rig = fakeRig();
    const go = classicCycle(rig);
    for (let i = 0; i < 9; i++) go();
    expect(angles(rig)).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0]);
  });

  it("starts again at the first angle once the view has been turned since", () => {
    const rig = fakeRig();
    const go = classicCycle(rig);
    go();
    go();
    // A turn by hand or by q and e.
    rig.yaw += 0.3;
    go();
    expect(angles(rig)).toEqual([0, 1, 0]);
    go();
    expect(angles(rig)).toEqual([0, 1, 0, 1]);
  });

  it("starts at the first angle from a view that was never classic, even at a classic yaw", () => {
    const rig = fakeRig();
    rig.yaw = Math.PI / 4 + Math.PI / 2;
    classicCycle(rig)();
    expect(angles(rig)).toEqual([0]);
  });

  it("keeps a cycle for each rig", () => {
    const a = fakeRig();
    const b = fakeRig();
    const goA = classicCycle(a);
    const goB = classicCycle(b);
    goA();
    goA();
    goB();
    expect(angles(a)).toEqual([0, 1]);
    expect(angles(b)).toEqual([0]);
  });
});
