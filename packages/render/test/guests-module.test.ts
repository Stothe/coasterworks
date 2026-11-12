import type { GuestSection } from "@coasterworks/protocol";
import { Scene, type InstancedMesh } from "three";
import { describe, expect, it } from "vitest";
import { createAtmosphereUniforms } from "../src/atmosphere.glsl.js";
import { createSharedUniforms, type FrameInfo, type RenderContext } from "../src/context.js";
import { createGuests, FIGURE, GUEST_CAPACITY } from "../src/guests.js";
import { sunFor } from "../src/sky.js";

// The guests module as the scene drives it: snapshots in, frames out. Nothing here draws; the
// tests read the instance matrices the module would hand to the GPU. No other module's tests
// live in this file.

/** A section with the guests given as [id, x, y] in tiles. */
function section(guests: [number, number, number][], color = 0): GuestSection {
  const count = guests.length;
  return {
    count,
    id: Int32Array.from(guests, (g) => g[0]),
    x: Int32Array.from(guests, (g) => Math.round(g[1] * 32)),
    y: Int32Array.from(guests, (g) => Math.round(g[2] * 32)),
    state: new Uint8Array(count),
    color: new Uint8Array(count).fill(color),
    happiness: new Uint8Array(count),
  };
}

function harness(heightAt: (x: number, z: number) => number = () => 0) {
  const scene = new Scene();
  const ctx = {
    scene,
    uniforms: createSharedUniforms(),
    atmosphereUniforms: createAtmosphereUniforms(),
    quality: "high",
    heightAt,
  } as unknown as RenderContext;
  const guests = createGuests(ctx);
  const mesh = scene.children[0] as InstancedMesh;
  const frame: FrameInfo = { time: 0, dt: 0, nowMs: 0, sun: sunFor(0.4) };
  return {
    scene,
    guests,
    mesh,
    update(nowMs: number): void {
      frame.nowMs = nowMs;
      guests.update?.(frame);
    },
    /** World place of the guest in slot `i`. */
    place(i: number): [number, number, number] {
      const m = mesh.instanceMatrix.array;
      return [m[i * 16 + 12] as number, m[i * 16 + 13] as number, m[i * 16 + 14] as number];
    },
    /** The way the guest in slot `i` faces, as a unit vector on the ground (x, z). */
    facing(i: number): [number, number] {
      const m = mesh.instanceMatrix.array;
      const x = m[i * 16 + 8] as number;
      const z = m[i * 16 + 10] as number;
      const length = Math.hypot(x, z);
      return [x / length, z / length];
    },
  };
}

describe("createGuests", () => {
  it("draws the guests of the snapshot, and none without one", () => {
    const h = harness();
    h.update(0);
    expect(h.mesh.count).toBe(0);
    h.guests.setGuests(
      section([
        [1, 3.5, 4.5],
        [2, 10, 20],
      ]),
      1000,
    );
    h.update(1000);
    expect(h.mesh.count).toBe(2);
    expect(h.place(0)).toEqual([3.5, 0, 4.5]);
    expect(h.place(1)).toEqual([10, 0, 20]);
    h.guests.setGuests(null, 1010);
    h.update(1020);
    expect(h.mesh.count).toBe(0);
  });

  it("adds one mesh for the figures and one for their shade, and takes both away", () => {
    const h = harness();
    expect(h.scene.children.length).toBe(2);
    h.guests.dispose();
    expect(h.scene.children.length).toBe(0);
  });

  it("walks guests from where they are shown to the new snapshot, over a snapshot's time", () => {
    const h = harness();
    h.guests.setGuests(section([[1, 2, 2]]), 1000);
    h.update(1000);
    h.guests.setGuests(section([[1, 3, 2]]), 1050);
    h.update(1050);
    expect(h.place(0)[0]).toBeCloseTo(2, 5);
    h.update(1075);
    expect(h.place(0)[0]).toBeCloseTo(2.5, 5);
    h.update(1100);
    expect(h.place(0)[0]).toBeCloseTo(3, 5);
    expect(h.place(0)[2]).toBeCloseTo(2, 5);
  });

  it("does not jump when a snapshot comes early or late", () => {
    const h = harness();
    h.guests.setGuests(section([[1, 2, 2]]), 1000);
    h.guests.setGuests(section([[1, 3, 2]]), 1050);
    // Early: the guest is only part of the way there.
    h.update(1080);
    const before = h.place(0)[0];
    expect(before).toBeGreaterThan(2.4);
    expect(before).toBeLessThan(3);
    h.guests.setGuests(section([[1, 4, 2]]), 1080);
    h.update(1080);
    expect(h.place(0)[0]).toBeCloseTo(before, 5);
    // Late: it has run on a little past the last place, and carries on from there.
    h.update(1200);
    const ahead = h.place(0)[0];
    expect(ahead).toBeGreaterThan(4);
    expect(ahead).toBeLessThan(4.5);
    h.guests.setGuests(section([[1, 5, 2]]), 1200);
    h.update(1200);
    expect(h.place(0)[0]).toBeCloseTo(ahead, 5);
    h.update(1201);
    expect(h.place(0)[0]).toBeGreaterThan(ahead);
  });

  it("ignores a section it already has", () => {
    const h = harness();
    const first = section([[1, 2, 2]]);
    const second = section([[1, 3, 2]]);
    h.guests.setGuests(first, 1000);
    h.guests.setGuests(second, 1050);
    h.update(1075);
    const midway = h.place(0)[0];
    // Handing the same section in again must not start the step over.
    h.guests.setGuests(second, 1075);
    h.update(1075);
    expect(h.place(0)[0]).toBeCloseTo(midway, 6);
    h.update(1100);
    expect(h.place(0)[0]).toBeCloseTo(3, 5);
  });

  it("turns a guest to face the way it walks, smoothly", () => {
    const h = harness();
    h.guests.setGuests(section([[1, 2, 2]]), 1000);
    h.update(1000);
    const [startX, startZ] = h.facing(0);
    // Walking toward +X from now on.
    let now = 1000;
    let lastDot = startX;
    for (let step = 1; step <= 12; step++) {
      now += 50;
      h.guests.setGuests(section([[1, 2 + step * 0.125, 2]]), now);
      h.update(now + 16);
      h.update(now + 33);
      const [x] = h.facing(0);
      // Never turning away from the way it walks.
      expect(x).toBeGreaterThanOrEqual(lastDot - 1e-6);
      lastDot = x;
    }
    expect(lastDot).toBeGreaterThan(0.99);
    expect(Math.hypot(startX, startZ)).toBeCloseTo(1, 5);
    // Standing still keeps the heading.
    h.guests.setGuests(section([[1, 2 + 12 * 0.125, 2]]), now + 50);
    h.update(now + 100);
    h.update(now + 400);
    expect(h.facing(0)[0]).toBeGreaterThan(0.99);
  });

  it("follows a guest by id when slots change", () => {
    const h = harness();
    h.guests.setGuests(
      section([
        [1, 2, 2],
        [2, 8, 8],
      ]),
      1000,
    );
    h.update(1000);
    // Guest 2 walks toward -Z for a while so that it has a heading worth keeping.
    let now = 1000;
    for (let step = 1; step <= 10; step++) {
      now += 50;
      h.guests.setGuests(
        section([
          [1, 2, 2],
          [2, 8, 8 - step * 0.125],
        ]),
        now,
      );
      h.update(now + 25);
    }
    expect(h.facing(1)[1]).toBeLessThan(-0.95);
    // Guest 1 leaves; guest 2 moves up into slot 0 and a new guest takes slot 1.
    now += 50;
    h.guests.setGuests(
      section([
        [2, 8, 8 - 11 * 0.125],
        [3, 20, 20],
      ]),
      now,
    );
    h.update(now + 25);
    expect(h.mesh.count).toBe(2);
    expect(h.facing(0)[1]).toBeLessThan(-0.95);
    // It carried on from where it was, not from the new place or from guest 1's.
    expect(h.place(0)[0]).toBeCloseTo(8, 5);
    expect(h.place(0)[2]).toBeCloseTo(8 - 10.5 * 0.125, 2);
    expect(h.place(1)).toEqual([20, 0, 20]);
  });

  it("stands guests on the ground, also between snapshots", () => {
    const h = harness((x, z) => x * 0.5 + z * 0.25);
    h.guests.setGuests(section([[1, 2, 4]]), 1000);
    h.update(1000);
    expect(h.place(0)[1]).toBeCloseTo(2, 5);
    h.guests.setGuests(section([[1, 3, 4]]), 1050);
    h.update(1075);
    expect(h.place(0)[1]).toBeCloseTo(2.25, 5);
    h.update(1100);
    expect(h.place(0)[1]).toBeCloseTo(2.5, 5);
  });

  it("picks the guest under a ray, by id", () => {
    const h = harness();
    h.guests.setGuests(
      section([
        [41, 2, 2],
        [42, 5, 5],
      ]),
      1000,
    );
    h.update(1000);
    const down = (x: number, z: number) => ({
      origin: { x, y: 30, z },
      direction: { x: 0, y: -1, z: 0 },
    });
    expect(h.guests.pickAt(down(5, 5))).toEqual({ id: 42 });
    expect(h.guests.pickAt(down(2.02, 2.02))).toEqual({ id: 41 });
    expect(h.guests.pickAt(down(3.5, 3.5))).toBeNull();
    // From the side, at head height.
    const across = {
      origin: { x: -10, y: FIGURE.height * 0.6, z: 2 },
      direction: { x: 1, y: 0, z: 0 },
    };
    expect(h.guests.pickAt(across)).toEqual({ id: 41 });
    h.guests.setGuests(null, 1100);
    expect(h.guests.pickAt(down(5, 5))).toBeNull();
  });

  it("draws no more than its capacity, and a full park without trouble", () => {
    const h = harness();
    const crowd = (shift: number): GuestSection =>
      section(
        Array.from({ length: GUEST_CAPACITY + 300 }, (_, i): [number, number, number] => [
          i + 1,
          (i % 60) + shift,
          Math.floor(i / 60),
        ]),
      );
    h.guests.setGuests(crowd(0), 1000);
    h.update(1000);
    expect(h.mesh.count).toBe(GUEST_CAPACITY);
    h.guests.setGuests(crowd(0.125), 1050);
    h.update(1075);
    expect(h.mesh.count).toBe(GUEST_CAPACITY);
    expect(h.place(GUEST_CAPACITY - 1)[0]).toBeCloseTo(((GUEST_CAPACITY - 1) % 60) + 0.0625, 4);
  });
});

describe("createGuests: atRest", () => {
  it("is true with no guests", () => {
    const h = harness();
    expect(h.guests.atRest()).toBe(true);
  });

  it("is false while guests move, and through the last moves after a pause, then true", () => {
    const h = harness();
    h.guests.setGuests(section([[1, 2, 2]]), 0);
    h.update(0);
    // The first snapshot: nothing to say yet that nobody moves.
    expect(h.guests.atRest()).toBe(false);
    h.guests.setGuests(section([[1, 3, 2]]), 100);
    h.update(150);
    expect(h.guests.atRest()).toBe(false);
    // The sim pauses: the next snapshot puts the guest where the last one did, but the frame drawn
    // just after it still shows the walk from where the guest was drawn.
    h.guests.setGuests(section([[1, 3, 2]]), 200);
    h.update(210);
    expect(h.place(0)[0]).not.toBeCloseTo(3, 3);
    expect(h.guests.atRest()).toBe(false);
    // Once the frames have caught up with the snapshot, it is true.
    for (let t = 250; t <= 2000; t += 50) {
      h.guests.setGuests(section([[1, 3, 2]]), t);
      h.update(t + 25);
    }
    expect(h.place(0)[0]).toBeCloseTo(3, 2);
    expect(h.guests.atRest()).toBe(true);
    // Moving again: false at once.
    h.guests.setGuests(section([[1, 3.5, 2]]), 2100);
    h.update(2110);
    expect(h.guests.atRest()).toBe(false);
  });

  it("is false when a new snapshot has come but no frame has drawn it", () => {
    const h = harness();
    for (let t = 0; t <= 1000; t += 50) {
      h.guests.setGuests(section([[1, 3, 2]]), t);
      h.update(t + 25);
    }
    expect(h.guests.atRest()).toBe(true);
    h.guests.setGuests(
      section([
        [1, 3, 2],
        [2, 5, 5],
      ]),
      1050,
    );
    expect(h.guests.atRest()).toBe(false);
  });
});
