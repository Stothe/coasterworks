import { describe, expect, it } from "vitest";
import {
  angleDelta,
  buildGuestFigure,
  createGuestPlaces,
  FIGURE,
  GUEST_CAPACITY,
  GUEST_CLOTHES,
  GUEST_JUMP_UNITS,
  GUEST_RUN_ON,
  guestLook,
  interpolateGuests,
  pickGuest,
  type GuestMoment,
} from "../src/guests.js";

// The guests module's own pure parts: moving between snapshots, the figure, looks and picking.
// No other module's tests live in this file.

/** A moment with the guests given as [id, x, y]. */
function moment(atMs: number, guests: [number, number, number][]): GuestMoment {
  return {
    count: guests.length,
    id: Int32Array.from(guests, (g) => g[0]),
    x: Int32Array.from(guests, (g) => g[1]),
    y: Int32Array.from(guests, (g) => g[2]),
    atMs,
  };
}

/** What `interpolateGuests` says, as { id: [x, y] }. */
function places(
  previous: GuestMoment | null,
  latest: GuestMoment | null,
  nowMs: number,
  capacity = 16,
  index?: ReadonlyMap<number, number>,
): Record<number, [number, number]> {
  const out = interpolateGuests(previous, latest, nowMs, createGuestPlaces(capacity), index);
  const result: Record<number, [number, number]> = {};
  for (let i = 0; i < out.count; i++) {
    result[out.id[i] as number] = [out.x[i] as number, out.y[i] as number];
  }
  return result;
}

describe("interpolateGuests", () => {
  const a = moment(1000, [
    [1, 0, 0],
    [2, 100, 40],
  ]);
  const b = moment(1050, [
    [1, 8, 0],
    [2, 100, 48],
  ]);

  it("draws nobody without a snapshot", () => {
    const out = interpolateGuests(null, null, 0, createGuestPlaces(4));
    expect(out.count).toBe(0);
    expect(interpolateGuests(a, null, 0, out).count).toBe(0);
  });

  it("puts guests at the only snapshot there is", () => {
    expect(places(null, b, 5000)).toEqual({ 1: [8, 0], 2: [100, 48] });
  });

  it("starts from the earlier places when the later snapshot arrives", () => {
    expect(places(a, b, 1050)).toEqual({ 1: [0, 0], 2: [100, 40] });
    // Before that, too: it never goes back past the earlier one.
    expect(places(a, b, 900)).toEqual({ 1: [0, 0], 2: [100, 40] });
  });

  it("moves each guest in a straight line over the time between the two", () => {
    expect(places(a, b, 1075)).toEqual({ 1: [4, 0], 2: [100, 44] });
    expect(places(a, b, 1100)).toEqual({ 1: [8, 0], 2: [100, 48] });
    const out = interpolateGuests(a, b, 1062.5, createGuestPlaces(4));
    expect(out.k).toBeCloseTo(0.25, 12);
    expect(out.x[0]).toBeCloseTo(2, 6);
  });

  it("runs on a little when the next snapshot is late, then stands", () => {
    const edge = 1100 + 50 * GUEST_RUN_ON;
    const at = places(a, b, edge);
    expect(at[1]?.[0]).toBeCloseTo(8 + 8 * GUEST_RUN_ON, 5);
    expect(at[2]?.[1]).toBeCloseTo(48 + 8 * GUEST_RUN_ON, 5);
    expect(places(a, b, edge + 10_000)).toEqual(at);
  });

  it("has guests at the later places when there is no time between the two", () => {
    const same = moment(1050, [
      [1, 0, 0],
      [2, 100, 40],
    ]);
    expect(places(same, b, 1050)).toEqual({ 1: [8, 0], 2: [100, 48] });
    const backwards = moment(2000, [[1, 0, 0]]);
    expect(places(backwards, b, 1050)[1]).toEqual([8, 0]);
  });

  it("follows a guest that changed slot", () => {
    const shuffled = moment(1050, [
      [2, 100, 48],
      [1, 8, 0],
    ]);
    const out = interpolateGuests(a, shuffled, 1075, createGuestPlaces(4));
    expect(Array.from(out.id.subarray(0, 2))).toEqual([2, 1]);
    expect(Array.from(out.x.subarray(0, 2))).toEqual([100, 4]);
    expect(Array.from(out.y.subarray(0, 2))).toEqual([44, 0]);
    // Where each one was in the earlier moment.
    expect(Array.from(out.from.subarray(0, 2))).toEqual([1, 0]);
  });

  it("shows a new guest at its place and drops one that has gone", () => {
    const next = moment(1050, [
      [2, 100, 48],
      [7, 500, 500],
    ]);
    const out = interpolateGuests(a, next, 1075, createGuestPlaces(4));
    expect(out.count).toBe(2);
    expect(Array.from(out.id.subarray(0, 2))).toEqual([2, 7]);
    expect([out.x[1], out.y[1]]).toEqual([500, 500]);
    expect(Array.from(out.from.subarray(0, 2))).toEqual([1, -1]);
    expect(places(a, next, 1075)[1]).toBeUndefined();
  });

  it("does not slide a guest that was moved further than it could have walked", () => {
    const far = moment(1050, [
      [1, GUEST_JUMP_UNITS + 1, 0],
      [2, 100, 40 + GUEST_JUMP_UNITS],
    ]);
    const out = interpolateGuests(a, far, 1060, createGuestPlaces(4));
    // Guest 1 went too far and is put there; guest 2 went exactly as far as a walk can.
    expect(out.x[0]).toBe(GUEST_JUMP_UNITS + 1);
    expect(out.from[0]).toBe(-1);
    expect(out.y[1]).toBeCloseTo(40 + GUEST_JUMP_UNITS * 0.2, 4);
    expect(out.from[1]).toBe(1);
  });

  it("gives the same places with a ready-made index as without", () => {
    const shuffled = moment(1050, [
      [2, 100, 48],
      [9, 5, 5],
      [1, 8, 0],
    ]);
    const index = new Map([
      [1, 0],
      [2, 1],
    ]);
    expect(places(a, shuffled, 1070, 16, index)).toEqual(places(a, shuffled, 1070));
    // An index that points at the wrong guest is not believed.
    const wrong = new Map([
      [1, 1],
      [2, 0],
      [9, 5],
    ]);
    expect(places(a, shuffled, 1070, 16, wrong)).toEqual({ 2: [100, 48], 9: [5, 5], 1: [8, 0] });
  });

  it("draws no more guests than there is room for", () => {
    const out = interpolateGuests(a, b, 1075, createGuestPlaces(1));
    expect(out.count).toBe(1);
    expect(out.id[0]).toBe(1);
  });

  it("takes places that are not whole numbers, as its own output is", () => {
    const shown = interpolateGuests(a, b, 1075, createGuestPlaces(4));
    const carried: GuestMoment = { ...shown, atMs: 1100 };
    const c = moment(1150, [
      [1, 16, 0],
      [2, 100, 56],
    ]);
    // From (4, 0) to (16, 0), a quarter of the way.
    expect(places(carried, c, 1162.5)[1]?.[0]).toBeCloseTo(7, 5);
  });

  it("does not write to the moments it reads", () => {
    const before = [Array.from(a.x as Int32Array), Array.from(b.y as Int32Array)];
    places(a, b, 1075);
    expect([Array.from(a.x as Int32Array), Array.from(b.y as Int32Array)]).toEqual(before);
  });
});

describe("angleDelta", () => {
  it("is the short way round", () => {
    expect(angleDelta(0, 1)).toBeCloseTo(1, 12);
    expect(angleDelta(1, 0)).toBeCloseTo(-1, 12);
    expect(angleDelta(3, -3)).toBeCloseTo(Math.PI * 2 - 6, 12);
    expect(angleDelta(-3, 3)).toBeCloseTo(6 - Math.PI * 2, 12);
    expect(angleDelta(0.5, 0.5 + Math.PI * 6)).toBeCloseTo(0, 9);
  });
});

describe("buildGuestFigure", () => {
  const figure = buildGuestFigure();
  const vertexCount = figure.positions.length / 3;

  it("is a small mesh: 150 to 250 triangles", () => {
    expect(figure.triangleCount).toBeGreaterThanOrEqual(150);
    expect(figure.triangleCount).toBeLessThanOrEqual(250);
    expect(figure.indices.length).toBe(figure.triangleCount * 3);
    expect(Math.max(...figure.indices)).toBe(vertexCount - 1);
    expect(figure.normals.length).toBe(vertexCount * 3);
    expect(figure.parts.length).toBe(vertexCount * 4);
  });

  it("stands on the ground and is as tall as it says", () => {
    let low = Infinity;
    let high = -Infinity;
    let left = 0;
    let right = 0;
    for (let v = 0; v < vertexCount; v++) {
      low = Math.min(low, figure.positions[v * 3 + 1] as number);
      high = Math.max(high, figure.positions[v * 3 + 1] as number);
      left = Math.max(left, figure.positions[v * 3] as number);
      right = Math.min(right, figure.positions[v * 3] as number);
    }
    expect(low).toBeCloseTo(0, 6);
    expect(high).toBeCloseTo(FIGURE.height, 2);
    // The same on both sides.
    expect(left).toBeCloseTo(-right, 6);
  });

  it("has unit normals that point out of each part", () => {
    for (let v = 0; v < vertexCount; v++) {
      const n = [0, 1, 2].map((c) => figure.normals[v * 3 + c] as number);
      expect(Math.hypot(n[0] as number, n[1] as number, n[2] as number)).toBeCloseTo(1, 5);
    }
    // On the head, a ball, the normal is close to the direction from its middle.
    let headVertices = 0;
    for (let v = 0; v < vertexCount; v++) {
      if (figure.parts[v * 4] !== 1) continue;
      headVertices++;
      const x = figure.positions[v * 3] as number;
      const y = (figure.positions[v * 3 + 1] as number) - FIGURE.headY;
      const z = figure.positions[v * 3 + 2] as number;
      const length = Math.hypot(x, y, z);
      const dot =
        (x * (figure.normals[v * 3] as number) +
          y * (figure.normals[v * 3 + 1] as number) +
          z * (figure.normals[v * 3 + 2] as number)) /
        length;
      expect(dot).toBeGreaterThan(0.97);
    }
    expect(headVertices).toBeGreaterThan(20);
  });

  it("winds every triangle to face out, the way its normals point", () => {
    for (let t = 0; t < figure.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => figure.indices[t + k] as number) as [
        number,
        number,
        number,
      ];
      const p = (i: number, k: number) => figure.positions[i * 3 + k] as number;
      const u = [0, 1, 2].map((k) => p(b, k) - p(a, k)) as [number, number, number];
      const w = [0, 1, 2].map((k) => p(c, k) - p(a, k)) as [number, number, number];
      const face = [
        u[1] * w[2] - u[2] * w[1],
        u[2] * w[0] - u[0] * w[2],
        u[0] * w[1] - u[1] * w[0],
      ] as const;
      let agree = 0;
      for (const i of [a, b, c]) {
        agree +=
          face[0] * (figure.normals[i * 3] as number) +
          face[1] * (figure.normals[i * 3 + 1] as number) +
          face[2] * (figure.normals[i * 3 + 2] as number);
      }
      expect(agree).toBeGreaterThan(0);
    }
  });

  it("marks every vertex with its part, and limbs with their side and their bend", () => {
    const counts = [0, 0, 0, 0];
    for (let v = 0; v < vertexCount; v++) {
      const part = figure.parts[v * 4] as number;
      const along = figure.parts[v * 4 + 1] as number;
      const side = figure.parts[v * 4 + 2] as number;
      const bends = figure.parts[v * 4 + 3] as number;
      counts[part] = (counts[part] as number) + 1;
      expect(along).toBeGreaterThanOrEqual(0);
      expect(along).toBeLessThanOrEqual(1);
      const x = figure.positions[v * 3] as number;
      const y = figure.positions[v * 3 + 1] as number;
      if (part >= 2) {
        // A limb is on the side it says it is.
        expect(Math.sign(x)).toBe(side);
        // What bends is below the knee or the elbow, and nothing above is.
        const joint = part === 2 ? FIGURE.kneeY : FIGURE.elbowY;
        if (bends === 1) expect(y).toBeLessThan(joint);
        else expect(y).toBeGreaterThanOrEqual(joint - 0.002);
      } else {
        expect(side).toBe(0);
        expect(bends).toBe(0);
      }
    }
    expect(counts.every((n) => n > 0)).toBe(true);
    // Two legs and two arms, alike.
    expect((counts[2] as number) % 2).toBe(0);
    expect((counts[3] as number) % 2).toBe(0);
  });
});

describe("guestLook", () => {
  it("is the same every time for the same guest", () => {
    expect(guestLook(1234, 3)).toEqual(guestLook(1234, 3));
  });

  it("wears the snapshot's color as its shirt", () => {
    const a = guestLook(5, 0).shirt;
    const b = guestLook(5, 4).shirt;
    expect(a).not.toEqual(b);
    // The same color for every guest that has that index, and an index off the end wraps.
    expect(guestLook(99, 4).shirt).toEqual(b);
    expect(guestLook(5, 4 + GUEST_CLOTHES.length).shirt).toEqual(b);
    expect(GUEST_CLOTHES.length).toBe(9);
  });

  it("keeps colors and measures in range for a great many guests", () => {
    const styles = new Set<number>();
    const skins = new Set<string>();
    let children = 0;
    // Lowest and highest seen of: a color channel, sleeve, hem, belt, scale, seed.
    const low = [Infinity, Infinity, Infinity, Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity];
    const note = (slot: number, value: number) => {
      low[slot] = Math.min(low[slot] as number, value);
      high[slot] = Math.max(high[slot] as number, value);
    };
    for (let id = 1; id <= 3000; id++) {
      const look = guestLook(id, id % 9);
      for (const color of [look.shirt, look.trousers, look.skin, look.hair]) {
        for (const channel of color) note(0, channel);
      }
      note(1, look.sleeve);
      note(2, look.hem);
      note(3, look.belt);
      note(4, look.scale);
      note(5, look.seed);
      styles.add(look.hairStyle);
      skins.add(look.skin.join());
      if (look.scale < 0.8) children++;
    }
    // Albedo stays plausible: nothing brighter than white paint.
    expect(low[0]).toBeGreaterThanOrEqual(0);
    expect(high[0]).toBeLessThanOrEqual(0.8);
    expect(low[1]).toBeGreaterThan(0.2);
    expect(high[1]).toBeLessThan(1);
    expect(low[2]).toBeGreaterThan(0.1);
    expect(high[2]).toBeLessThan(0.8);
    expect(low[3]).toBeGreaterThanOrEqual(0.2);
    expect(high[3]).toBeLessThanOrEqual(0.3);
    expect(low[4]).toBeGreaterThan(0.6);
    expect(high[4]).toBeLessThan(1.1);
    expect(low[5]).toBeGreaterThanOrEqual(0);
    expect(high[5]).toBeLessThan(1);
    // Every hair style and skin tone turns up, and some guests are children.
    expect(styles.size).toBe(5);
    expect(skins.size).toBe(6);
    expect(children).toBeGreaterThan(200);
    expect(children).toBeLessThan(700);
  });

  it("makes neighbors in id look different", () => {
    const looks = new Set<string>();
    for (let id = 1; id <= 40; id++) looks.add(JSON.stringify({ ...guestLook(id, 0), seed: 0 }));
    expect(looks.size).toBeGreaterThan(35);
  });
});

describe("pickGuest", () => {
  // Three guests in a row along X, standing on y = 1.
  const spots = new Float32Array([0, 1, 0, 2, 1, 0, 4, 1, 0]);
  const sizes = new Float32Array([1, 1, 1]);
  const down = (x: number, z: number) => ({
    origin: { x, y: 10, z },
    direction: { x: 0, y: -3, z: 0 },
  });

  it("finds the guest under a ray", () => {
    expect(pickGuest(down(2, 0), spots, sizes, 3)).toBe(1);
    expect(pickGuest(down(4.05, 0.05), spots, sizes, 3)).toBe(2);
  });

  it("misses between guests and off to the side", () => {
    expect(pickGuest(down(1, 0), spots, sizes, 3)).toBe(-1);
    expect(pickGuest(down(2, 0.5), spots, sizes, 3)).toBe(-1);
  });

  it("leaves out a guest further along the ray than its reach (behind the ground)", () => {
    const along = { origin: { x: -5, y: 1.2, z: 0 }, direction: { x: 1, y: 0, z: 0 } };
    // Guest 0 is 5 along the ray (less its radius); a wall of ground 3 along hides all of them.
    expect(pickGuest(along, spots, sizes, 3, 3)).toBe(-1);
    expect(pickGuest(along, spots, sizes, 3, 6)).toBe(0);
  });

  it("takes the nearest of the guests in the way", () => {
    const along = { origin: { x: -5, y: 1.2, z: 0 }, direction: { x: 1, y: 0, z: 0 } };
    expect(pickGuest(along, spots, sizes, 3)).toBe(0);
    const back = { origin: { x: 9, y: 1.2, z: 0 }, direction: { x: -2, y: 0, z: 0 } };
    expect(pickGuest(back, spots, sizes, 3)).toBe(2);
  });

  it("hits the whole height of the figure and nothing above it", () => {
    const at = (y: number) => ({ origin: { x: 2, y, z: -5 }, direction: { x: 0, y: 0, z: 1 } });
    expect(pickGuest(at(1.02), spots, sizes, 3)).toBe(1);
    expect(pickGuest(at(1 + FIGURE.height - 0.02), spots, sizes, 3)).toBe(1);
    expect(pickGuest(at(1 + FIGURE.height + 0.05), spots, sizes, 3)).toBe(-1);
    expect(pickGuest(at(0.9), spots, sizes, 3)).toBe(-1);
  });

  it("goes by each guest's size", () => {
    const at = {
      origin: { x: 2, y: 1 + FIGURE.height * 1.3, z: -5 },
      direction: { x: 0, y: 0, z: 1 },
    };
    expect(pickGuest(at, spots, sizes, 3)).toBe(-1);
    expect(pickGuest(at, spots, new Float32Array([1, 1.5, 1]), 3)).toBe(1);
  });

  it("ignores guests behind the ray, guests past the count, and a ray with no direction", () => {
    const away = { origin: { x: 2, y: 10, z: 0 }, direction: { x: 0, y: 1, z: 0 } };
    expect(pickGuest(away, spots, sizes, 3)).toBe(-1);
    expect(pickGuest(down(4, 0), spots, sizes, 2)).toBe(-1);
    const none = { origin: { x: 2, y: 10, z: 0 }, direction: { x: 0, y: 0, z: 0 } };
    expect(pickGuest(none, spots, sizes, 3)).toBe(-1);
  });
});

describe("GUEST_CAPACITY", () => {
  it("is the sim's cap", () => {
    expect(GUEST_CAPACITY).toBe(2000);
  });
});
