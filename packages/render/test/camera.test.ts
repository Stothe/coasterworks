import { describe, expect, it } from "vitest";
import { CameraRig } from "../src/camera.js";

describe("CameraRig", () => {
  it("places the camera on a sphere around the target", () => {
    const rig = new CameraRig();
    rig.target = { x: 5, y: 2, z: 7 };
    rig.yaw = 0;
    rig.pitch = 0;
    rig.distance = 10;
    const p0 = rig.position();
    expect(p0.x).toBeCloseTo(5, 9);
    expect(p0.y).toBeCloseTo(2, 9);
    expect(p0.z).toBeCloseTo(17, 9);

    rig.yaw = Math.PI / 2;
    const p1 = rig.position();
    expect(p1.x).toBeCloseTo(15, 9);
    expect(p1.y).toBeCloseTo(2, 9);
    expect(p1.z).toBeCloseTo(7, 9);

    rig.yaw = 0;
    rig.pitch = Math.PI / 2;
    const p2 = rig.position();
    expect(p2.x).toBeCloseTo(5, 9);
    expect(p2.y).toBeCloseTo(12, 9);
    expect(p2.z).toBeCloseTo(7, 9);
  });

  it("starts at the documented default pose", () => {
    const rig = new CameraRig();
    expect(rig.distance).toBe(40);
    expect(rig.yaw).toBeCloseTo(Math.PI / 4, 12);
    expect(rig.pitch).toBe(0.6);
    expect(rig.limits.pitch).toEqual([0.26, 1.4]);
    expect(rig.limits.distance).toEqual([4, 200]);
  });

  it("orbits yaw freely and clamps pitch to the limits", () => {
    const rig = new CameraRig();
    const yaw = rig.yaw;
    rig.orbit(0.5, 0);
    expect(rig.yaw).toBeCloseTo(yaw + 0.5, 12);
    rig.orbit(0, 10);
    expect(rig.pitch).toBe(1.4);
    rig.orbit(0, -10);
    expect(rig.pitch).toBe(0.26);
    rig.orbit(0, 0.1);
    expect(rig.pitch).toBeCloseTo(0.36, 12);
  });

  it("zooms by a factor and clamps the distance", () => {
    const rig = new CameraRig();
    rig.zoom(0.5);
    expect(rig.distance).toBe(20);
    rig.zoom(0.5);
    rig.zoom(0.5);
    expect(rig.distance).toBe(5);
    rig.zoom(0.5);
    expect(rig.distance).toBe(4);
    rig.zoom(0.1);
    expect(rig.distance).toBe(4);
    rig.zoom(1000);
    expect(rig.distance).toBe(200);
  });

  it("snaps to the four classic angles, keeping the distance", () => {
    const rig = new CameraRig();
    rig.distance = 33;
    rig.setClassic(0);
    expect(rig.yaw).toBeCloseTo(Math.PI / 4, 12);
    expect(rig.pitch).toBe(0.615);
    rig.setClassic(1);
    expect(rig.yaw).toBeCloseTo(Math.PI / 4 + Math.PI / 2, 12);
    rig.setClassic(3);
    expect(rig.yaw).toBeCloseTo(Math.PI / 4 + (3 * Math.PI) / 2, 12);
    expect(rig.distance).toBe(33);
  });

  it("pans along the ground-projected right and forward vectors", () => {
    const rig = new CameraRig();
    rig.yaw = 0;
    rig.distance = 40;
    // 40 / 1000 * 2 = 0.08 world units per screen pixel.
    rig.pan(100, 0, 1000);
    expect(rig.target.x).toBeCloseTo(8, 9);
    expect(rig.target.z).toBeCloseTo(0, 9);
    rig.pan(0, 100, 1000);
    expect(rig.target.x).toBeCloseTo(8, 9);
    expect(rig.target.z).toBeCloseTo(-8, 9);
    expect(rig.target.y).toBe(0);

    const turned = new CameraRig();
    turned.yaw = Math.PI / 2;
    turned.distance = 40;
    turned.pan(100, 0, 1000); // right at yaw 90 degrees is -Z
    expect(turned.target.x).toBeCloseTo(0, 9);
    expect(turned.target.z).toBeCloseTo(-8, 9);
    turned.pan(0, 100, 1000); // forward at yaw 90 degrees is -X
    expect(turned.target.x).toBeCloseTo(-8, 9);
    expect(turned.target.z).toBeCloseTo(-8, 9);
  });

  it("pans further per pixel when zoomed out", () => {
    const near = new CameraRig();
    near.distance = 10;
    near.yaw = 0;
    const far = new CameraRig();
    far.distance = 100;
    far.yaw = 0;
    near.pan(50, 0, 500);
    far.pan(50, 0, 500);
    expect(far.target.x).toBeCloseTo(near.target.x * 10, 9);
  });

  it("keeps the target inside the map", () => {
    const rig = new CameraRig();
    rig.target = { x: -5, y: 3, z: 100 };
    rig.clampTarget(64, 64);
    expect(rig.target).toEqual({ x: 0, y: 3, z: 64 });
    rig.target = { x: 70, y: 3, z: -1 };
    rig.clampTarget(64, 48);
    expect(rig.target).toEqual({ x: 64, y: 3, z: 0 });
    rig.target = { x: 10, y: 3, z: 20 };
    rig.clampTarget(64, 64);
    expect(rig.target).toEqual({ x: 10, y: 3, z: 20 });
  });

  it("applies its pose to a camera-like object", () => {
    const rig = new CameraRig();
    rig.target = { x: 1, y: 2, z: 3 };
    rig.yaw = 0;
    rig.pitch = 0;
    rig.distance = 10;
    const calls: string[] = [];
    rig.applyTo({
      position: {
        set: (x, y, z) => {
          calls.push(`set ${x.toFixed(3)} ${y.toFixed(3)} ${z.toFixed(3)}`);
        },
      },
      lookAt: (x, y, z) => {
        calls.push(`lookAt ${x} ${y} ${z}`);
      },
    });
    expect(calls).toEqual(["set 1.000 2.000 13.000", "lookAt 1 2 3"]);
  });
});
