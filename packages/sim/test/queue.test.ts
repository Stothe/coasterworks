import { describe, expect, it } from "vitest";
import { QUEUE_PER_TILE, queueCapacity, queueInfo } from "../src/rides/queue.js";
import { run, tileIndexOf } from "./helpers/guests.js";
import { QUEUE_LINE, RIDE_ENTRANCE, makeRidePark, rideOf } from "./helpers/rides.js";

describe("queue tiles", () => {
  it("are the queue path joined to the entrance, front (the entrance) first", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const info = queueInfo(world, rideOf(world));
    expect(info.tiles).toEqual(QUEUE_LINE.map((t) => tileIndexOf(world, t.x, t.y)));
    expect(info.tiles.map((i) => info.dist.get(i))).toEqual([0, 1, 2, 3, 4]);
    // The main footpath the line meets is not part of it.
    expect(info.dist.has(tileIndexOf(world, 8, 10))).toBe(false);
  });

  it("hold four guests a tile", () => {
    const sim = makeRidePark();
    expect(QUEUE_PER_TILE).toBe(4);
    expect(queueCapacity(sim.world, rideOf(sim.world))).toBe(5 * QUEUE_PER_TILE);
  });

  it("are only the entrance tile, for one tile's worth of guests, when there is no queue path", () => {
    const sim = makeRidePark({ queue: false });
    const { world } = sim;
    const info = queueInfo(world, rideOf(world));
    expect(info.tiles).toEqual([tileIndexOf(world, RIDE_ENTRANCE.x, RIDE_ENTRANCE.y)]);
    expect(queueCapacity(world, rideOf(world))).toBe(QUEUE_PER_TILE);
  });

  it("are ordered by distance from the entrance, then by tile index", () => {
    const sim = makeRidePark();
    const { world } = sim;
    // A spur off (5, 10): (4, 10) is as far from the entrance as (6, 10) and comes first.
    run(sim, "path_build_tiles", { tiles: [{ x: 4, y: 10 }], kind: "queue" });
    const info = queueInfo(world, rideOf(world));
    expect(info.tiles).toEqual(
      [
        [5, 8],
        [5, 9],
        [5, 10],
        [4, 10],
        [6, 10],
        [7, 10],
      ].map(([x, y]) => tileIndexOf(world, x as number, y as number)),
    );
  });

  it("are cached until the paths or the rides change", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const first = queueInfo(world, rideOf(world));
    expect(queueInfo(world, rideOf(world))).toBe(first);
    run(sim, "path_remove_tiles", { tiles: [{ x: 7, y: 10 }] });
    const shorter = queueInfo(world, rideOf(world));
    expect(shorter).not.toBe(first);
    expect(shorter.tiles).toHaveLength(4);
    run(sim, "ride_set_price", { id: 1, cents: 50 });
    expect(queueInfo(world, rideOf(world))).not.toBe(shorter);
  });
});
