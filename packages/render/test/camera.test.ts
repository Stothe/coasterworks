import { describe, expect, it } from "vitest";
import { CAMERA_CLEARANCE, CameraRig } from "../src/camera.js";

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

  it("has a 35 degree vertical field of view, settable", () => {
    const rig = new CameraRig();
    expect(rig.fovY).toBeCloseTo((35 * Math.PI) / 180, 12);
    rig.fovY = Math.PI / 2;
    expect(rig.fovY).toBe(Math.PI / 2);
  });

  it("pans along the ground-projected right and forward vectors", () => {
    const rig = new CameraRig();
    rig.yaw = 0;
    rig.distance = 40;
    // The screen is 2 * 40 * tan(fovY / 2) world units tall at the target, over 1000 pixels.
    const perPixel = (40 * 2 * Math.tan(rig.fovY / 2)) / 1000;
    expect(perPixel).toBeCloseTo(0.025224, 6);
    rig.pan(100, 0, 1000);
    expect(rig.target.x).toBeCloseTo(100 * perPixel, 9);
    expect(rig.target.z).toBeCloseTo(0, 9);
    rig.pan(0, 100, 1000);
    expect(rig.target.x).toBeCloseTo(100 * perPixel, 9);
    expect(rig.target.z).toBeCloseTo(-100 * perPixel, 9);
    expect(rig.target.y).toBe(0);

    const turned = new CameraRig();
    turned.yaw = Math.PI / 2;
    turned.distance = 40;
    turned.pan(100, 0, 1000); // right at yaw 90 degrees is -Z
    expect(turned.target.x).toBeCloseTo(0, 9);
    expect(turned.target.z).toBeCloseTo(-100 * perPixel, 9);
    turned.pan(0, 100, 1000); // forward at yaw 90 degrees is -X
    expect(turned.target.x).toBeCloseTo(-100 * perPixel, 9);
    expect(turned.target.z).toBeCloseTo(-100 * perPixel, 9);
  });

  it("pans a screen-height drag across exactly the world height the screen shows at the target", () => {
    const rig = new CameraRig();
    rig.yaw = 0;
    rig.distance = 25;
    rig.fovY = Math.PI / 3;
    // Dragging the full viewport height moves the ground by the view's height at the target.
    rig.pan(500, 0, 500);
    expect(rig.target.x).toBeCloseTo(2 * 25 * Math.tan(Math.PI / 6), 9);
  });

  it("pans further per pixel when zoomed out, or with a wider field of view", () => {
    const near = new CameraRig();
    near.distance = 10;
    near.yaw = 0;
    const far = new CameraRig();
    far.distance = 100;
    far.yaw = 0;
    near.pan(50, 0, 500);
    far.pan(50, 0, 500);
    expect(far.target.x).toBeCloseTo(near.target.x * 10, 9);

    const narrow = new CameraRig();
    narrow.yaw = 0;
    narrow.fovY = Math.PI / 6;
    const wide = new CameraRig();
    wide.yaw = 0;
    wide.fovY = Math.PI / 2;
    narrow.pan(50, 0, 500);
    wide.pan(50, 0, 500);
    expect(wide.target.x).toBeGreaterThan(narrow.target.x);
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

/** A cone of rock `height` high and `radius` wide on flat ground at 0, centered on (cx, cz). */
function hill(cx: number, cz: number, height: number, radius: number) {
  return (x: number, z: number) => height * Math.max(0, 1 - Math.hypot(x - cx, z - cz) / radius);
}

/** How far the rig's eye is above the least height it is allowed. */
function clearanceOf(rig: CameraRig, ground: (x: number, z: number) => number): number {
  const eye = rig.position();
  return eye.y - ground(eye.x, eye.z) - CAMERA_CLEARANCE;
}

describe("CameraRig height awareness", () => {
  it("keeps one unit of clearance", () => {
    expect(CAMERA_CLEARANCE).toBe(1);
  });

  it("settle() does nothing without a height sampler", () => {
    const rig = new CameraRig();
    rig.target = { x: 3, y: 2, z: 4 };
    rig.distance = 4;
    rig.settle();
    expect(rig.target).toEqual({ x: 3, y: 2, z: 4 });
    expect(rig.distance).toBe(4);
    expect(rig.pitch).toBe(0.6);
  });

  it("eases the target toward the ground by a fifth of the gap each frame, then lands on it", () => {
    const rig = new CameraRig();
    rig.heightAt = () => 10;
    rig.target = { x: 0, y: 0, z: 0 };
    rig.settle();
    expect(rig.target.y).toBeCloseTo(2, 12);
    rig.settle();
    expect(rig.target.y).toBeCloseTo(3.6, 12);
    for (let i = 0; i < 100; i++) rig.settle();
    expect(rig.target.y).toBe(10);
    // Above the ground it comes down the same way.
    rig.heightAt = () => 0;
    rig.settle();
    expect(rig.target.y).toBeCloseTo(8, 12);
  });

  it("leaves a camera that already clears the ground exactly where it is", () => {
    const rig = new CameraRig();
    rig.heightAt = hill(40, 40, 6, 8); // far from the eye and the target
    rig.target = { x: 10, y: 0, z: 10 };
    const { distance, pitch, yaw } = rig;
    rig.settle();
    expect(rig.distance).toBe(distance);
    expect(rig.pitch).toBe(pitch);
    expect(rig.yaw).toBe(yaw);
  });

  it("makes the target follow the ground over a hill, and back down the far side", () => {
    const rig = new CameraRig();
    const ground = hill(10, 10, 6, 8);
    rig.heightAt = ground;
    rig.target = { x: 4, y: 0, z: 10 };
    for (const x of [6, 8, 10, 12, 14, 16, 18]) {
      rig.target.x = x;
      for (let i = 0; i < 80; i++) rig.settle();
      expect(rig.target.y).toBeCloseTo(ground(x, 10), 3);
    }
    expect(rig.target.y).toBe(0);
  });

  it("keeps the eye above a hill when zoomed all the way in at the default pitch", () => {
    const rig = new CameraRig();
    const ground = hill(10, 10, 6, 8);
    rig.heightAt = ground;
    rig.zoom(0.001);
    expect(rig.distance).toBe(4);
    expect(rig.pitch).toBe(0.6);
    // Looking at the top of the hill, a little off its peak, from the flank.
    rig.target = { x: 10, y: 6, z: 10 };
    rig.yaw = Math.PI / 4;

    for (let frame = 0; frame < 40; frame++) {
      rig.settle();
      expect(clearanceOf(rig, ground)).toBeGreaterThanOrEqual(-1e-9);
    }
    expect(rig.target.y).toBeCloseTo(6, 6);
    expect(rig.position().y).toBeGreaterThanOrEqual(ground(rig.position().x, rig.position().z) + 1);
  });

  it("lifts the eye over a ridge by raising the pitch, not by backing off", () => {
    const rig = new CameraRig();
    // The camera is on the +Z side of the target; the ridge is between it and the target's feet.
    const ground = hill(0, 3.3, 3, 4);
    rig.heightAt = ground;
    rig.target = { x: 0, y: 0, z: 0 };
    rig.yaw = 0;
    rig.distance = 4;
    rig.pitch = 0.6;
    expect(clearanceOf(rig, ground)).toBeLessThan(0); // it would be inside the ridge

    rig.settle();

    expect(rig.pitch).toBeGreaterThan(0.6);
    expect(rig.pitch).toBeLessThanOrEqual(1.4);
    expect(rig.distance).toBe(4);
    expect(clearanceOf(rig, ground)).toBeGreaterThanOrEqual(-1e-9);
    // Not much more than it had to: a hair above the least pitch that clears.
    expect(clearanceOf(rig, ground)).toBeLessThan(0.01);
  });

  it("backs off when the pitch is already as high as it goes", () => {
    const rig = new CameraRig();
    const ground = hill(0, 0.7, 40, 30); // a mountain the eye cannot get over by pitch alone
    rig.heightAt = ground;
    rig.target = { x: 0, y: 0, z: 0 };
    rig.yaw = 0;
    rig.distance = 4;
    rig.pitch = 0.6;

    rig.settle();

    expect(rig.pitch).toBe(1.4);
    expect(rig.distance).toBeGreaterThan(4);
    expect(clearanceOf(rig, ground)).toBeGreaterThanOrEqual(-1e-9);
  });

  it("never leaves the eye in the ground, from any pose over bumpy land", () => {
    const rig = new CameraRig();
    const ground = (x: number, z: number) => 3 + 2.5 * Math.sin(x * 0.7) * Math.cos(z * 0.5);
    rig.heightAt = ground;
    for (const distance of [4, 7, 15, 40]) {
      for (const pitch of [0.26, 0.6, 1.0, 1.4]) {
        for (let k = 0; k < 8; k++) {
          rig.distance = distance;
          rig.pitch = pitch;
          rig.yaw = (k * Math.PI) / 4;
          rig.target = { x: 3 + k * 1.7, y: ground(3 + k * 1.7, 9), z: 9 };
          rig.settle();
          expect(clearanceOf(rig, ground)).toBeGreaterThanOrEqual(-1e-9);
          expect(rig.pitch).toBeGreaterThanOrEqual(pitch);
          expect(rig.pitch).toBeLessThanOrEqual(1.4);
        }
      }
    }
  });
});
