import { describe, expect, it } from "vitest";
import {
  PATH_FOOT,
  PATH_QUEUE,
  RouteCache,
  Sim,
  UNREACHABLE,
  createWorld,
  tileIndex,
  type World,
} from "../src/index.js";
import { FIELD_CACHE_SIZE } from "../src/paths/routing.js";

const CASH = 1_000_000_00;

function open(width: number, height: number): World {
  return createWorld({ width, height, seed: 1, name: "Routes", cash: CASH });
}

/** Lays a footpath on each of `tiles`, given as [x, y] pairs, without going through a command. */
function lay(world: World, tiles: ReadonlyArray<readonly [number, number]>): void {
  for (const [x, y] of tiles) world.terrain.path[tileIndex(world.terrain, x, y)] = PATH_FOOT;
}

/** The tiles x0..x1 on row y, as [x, y] pairs. */
function row(y: number, x0: number, x1: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let x = x0; x <= x1; x++) out.push([x, y]);
  return out;
}

/** The 16 tiles around the edge of the 5x5 block at the origin, with the middle left empty. */
function ring5(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) if (x === 0 || x === 4 || y === 0 || y === 4) out.push([x, y]);
  }
  return out;
}

function at(world: World, x: number, y: number): number {
  return tileIndex(world.terrain, x, y);
}

describe("RouteCache distance fields", () => {
  it("gives a straight 10-tile path the distances 0..9 and everything else unreachable", () => {
    const world = open(12, 3);
    lay(world, row(1, 0, 9));
    const field = new RouteCache(world.terrain).distanceField(at(world, 0, 1));
    expect(field).toBeInstanceOf(Uint16Array);
    expect(field.length).toBe(12 * 3);
    for (let x = 0; x < 10; x++) expect(field[at(world, x, 1)]).toBe(x);
    expect(field[at(world, 10, 1)]).toBe(UNREACHABLE);
    expect(field[at(world, 11, 1)]).toBe(UNREACHABLE);
    expect(field[at(world, 0, 0)]).toBe(UNREACHABLE);
    expect(field[at(world, 5, 2)]).toBe(UNREACHABLE);
    expect(UNREACHABLE).toBe(0xffff);
  });

  it("measures the target from either end of the path", () => {
    const world = open(12, 3);
    lay(world, row(1, 0, 9));
    const field = new RouteCache(world.terrain).distanceField(at(world, 9, 1));
    for (let x = 0; x < 10; x++) expect(field[at(world, x, 1)]).toBe(9 - x);
  });

  it("takes the shorter way round a loop", () => {
    const world = open(6, 6);
    lay(world, ring5());
    const field = new RouteCache(world.terrain).distanceField(at(world, 0, 0));
    // Three tiles down the west side, against thirteen the long way round.
    expect(field[at(world, 0, 3)]).toBe(3);
    expect(field[at(world, 0, 4)]).toBe(4);
    // Seven along the east side from the north-east corner, against nine the other way.
    expect(field[at(world, 4, 3)]).toBe(7);
    expect(field[at(world, 2, 4)]).toBe(6);
    // The far corner is eight either way.
    expect(field[at(world, 4, 4)]).toBe(8);
    // The middle of the ring is not path.
    expect(field[at(world, 2, 2)]).toBe(UNREACHABLE);
  });

  it("marks tiles on a separate piece of path unreachable", () => {
    const world = open(12, 3);
    lay(world, row(1, 0, 3));
    lay(world, row(1, 5, 9));
    const field = new RouteCache(world.terrain).distanceField(at(world, 0, 1));
    expect(field[at(world, 3, 1)]).toBe(3);
    for (let x = 5; x <= 9; x++) expect(field[at(world, x, 1)]).toBe(UNREACHABLE);
  });

  it("does not wrap from the end of one row to the start of the next", () => {
    const world = open(4, 3);
    // (3, 0) and (0, 1) are neighbours in the flat array but not on the map.
    lay(world, [
      [2, 0],
      [3, 0],
      [0, 1],
      [1, 1],
    ]);
    const field = new RouteCache(world.terrain).distanceField(at(world, 3, 0));
    expect(field[at(world, 2, 0)]).toBe(1);
    expect(field[at(world, 0, 1)]).toBe(UNREACHABLE);
    expect(field[at(world, 1, 1)]).toBe(UNREACHABLE);
  });

  it("walks queues as well as footpaths", () => {
    const world = open(6, 1);
    lay(world, row(0, 0, 2));
    world.terrain.path[at(world, 3, 0)] = PATH_QUEUE;
    world.terrain.path[at(world, 4, 0)] = PATH_QUEUE;
    const field = new RouteCache(world.terrain).distanceField(at(world, 0, 0));
    expect(field[at(world, 4, 0)]).toBe(4);
  });

  it("answers an all-unreachable field for a target that is not on a path or not on the map", () => {
    const world = open(6, 3);
    lay(world, row(1, 0, 3));
    const cache = new RouteCache(world.terrain);
    for (const target of [at(world, 5, 2), -1, 6 * 3, 1.5, Number.NaN]) {
      const field = cache.distanceField(target);
      expect(field.length).toBe(6 * 3);
      expect(field.every((d) => d === UNREACHABLE)).toBe(true);
    }
    // None of those was worth keeping.
    expect(cache.size).toBe(0);
  });

  it("returns the cached field again until the paths change", () => {
    const world = open(12, 3);
    lay(world, row(1, 0, 9));
    const cache = new RouteCache(world.terrain);
    const first = cache.distanceField(at(world, 0, 1));
    expect(cache.distanceField(at(world, 0, 1))).toBe(first);
    expect(cache.distanceField(at(world, 9, 1))).not.toBe(first);
  });

  it("recomputes after invalidate", () => {
    const world = open(12, 3);
    lay(world, row(1, 0, 4));
    const cache = new RouteCache(world.terrain);
    const before = cache.distanceField(at(world, 0, 1));
    expect(before[at(world, 8, 1)]).toBe(UNREACHABLE);

    lay(world, row(1, 5, 9));
    // The cache has no way to know about a change made behind its back.
    expect(cache.distanceField(at(world, 0, 1))).toBe(before);

    cache.invalidate();
    expect(cache.size).toBe(0);
    const after = cache.distanceField(at(world, 0, 1));
    expect(after).not.toBe(before);
    expect(after[at(world, 8, 1)]).toBe(8);
    // The old field is left as it was.
    expect(before[at(world, 8, 1)]).toBe(UNREACHABLE);
  });
});

describe("RouteCache.nextStep", () => {
  it("follows the gradient down a path to the target", () => {
    const world = open(12, 3);
    lay(world, row(1, 0, 9));
    const cache = new RouteCache(world.terrain);
    const target = at(world, 0, 1);
    const visited: number[] = [];
    let here = at(world, 9, 1);
    while (here !== -1) {
      visited.push(here);
      here = cache.nextStep(here, target);
    }
    expect(visited).toEqual(
      row(1, 0, 9)
        .reverse()
        .map(([x, y]) => at(world, x, y)),
    );
  });

  it("answers -1 at the target, off the path, and from an unreachable tile", () => {
    const world = open(12, 3);
    lay(world, row(1, 0, 3));
    lay(world, row(1, 6, 9));
    const cache = new RouteCache(world.terrain);
    const target = at(world, 0, 1);
    expect(cache.nextStep(target, target)).toBe(-1);
    expect(cache.nextStep(at(world, 2, 2), target)).toBe(-1);
    expect(cache.nextStep(at(world, 7, 1), target)).toBe(-1);
    expect(cache.nextStep(-1, target)).toBe(-1);
    expect(cache.nextStep(12 * 3, target)).toBe(-1);
    // A target that is not on a path leads nowhere.
    expect(cache.nextStep(at(world, 1, 1), at(world, 2, 2))).toBe(-1);
  });

  it("breaks ties in the order north, east, south, west", () => {
    const world = open(3, 3);
    lay(world, [...row(0, 0, 2), ...row(1, 0, 2), ...row(2, 0, 2)]);
    const cache = new RouteCache(world.terrain);
    const centre = at(world, 1, 1);
    // From the middle of an open 3x3, two neighbours are one step closer to each corner.
    expect(cache.nextStep(centre, at(world, 0, 0))).toBe(at(world, 1, 0)); // north over west
    expect(cache.nextStep(centre, at(world, 2, 0))).toBe(at(world, 1, 0)); // north over east
    expect(cache.nextStep(centre, at(world, 2, 2))).toBe(at(world, 2, 1)); // east over south
    expect(cache.nextStep(centre, at(world, 0, 2))).toBe(at(world, 1, 2)); // south over west
  });

  it("steps toward the shorter way round a loop", () => {
    const world = open(6, 6);
    lay(world, ring5());
    const cache = new RouteCache(world.terrain);
    const target = at(world, 0, 0);
    expect(cache.nextStep(at(world, 0, 3), target)).toBe(at(world, 0, 2));
    expect(cache.nextStep(at(world, 4, 3), target)).toBe(at(world, 4, 2));
  });

  it("counts as a use of the target's field", () => {
    const world = open(10, 10);
    world.terrain.path.fill(PATH_FOOT);
    const cache = new RouteCache(world.terrain);
    for (let i = 0; i < FIELD_CACHE_SIZE; i++) cache.distanceField(i);
    cache.nextStep(99, 0);
    cache.distanceField(FIELD_CACHE_SIZE);
    expect(cache.has(0)).toBe(true);
    expect(cache.has(1)).toBe(false);
  });
});

describe("RouteCache.reachable", () => {
  it("is true along a path, including to itself, and false across a gap or off the path", () => {
    const world = open(12, 3);
    lay(world, row(1, 0, 3));
    lay(world, row(1, 6, 9));
    const cache = new RouteCache(world.terrain);
    const target = at(world, 0, 1);
    expect(cache.reachable(at(world, 3, 1), target)).toBe(true);
    expect(cache.reachable(target, target)).toBe(true);
    expect(cache.reachable(at(world, 7, 1), target)).toBe(false);
    expect(cache.reachable(at(world, 2, 2), target)).toBe(false);
    expect(cache.reachable(-1, target)).toBe(false);
    expect(cache.reachable(12 * 3, target)).toBe(false);
    // A target that is not walkable is reachable from nowhere, itself included.
    expect(cache.reachable(at(world, 2, 2), at(world, 2, 2))).toBe(false);
  });
});

describe("RouteCache.nearestPathTile", () => {
  it("finds the closest path tile within the radius and nothing beyond it", () => {
    const world = open(20, 20);
    lay(world, [[14, 10]]);
    const cache = new RouteCache(world.terrain);
    const tile = at(world, 14, 10);
    expect(cache.nearestPathTile(10, 10, 4)).toBe(tile);
    expect(cache.nearestPathTile(10, 10, 3)).toBe(-1);
    expect(cache.nearestPathTile(14, 10, 0)).toBe(tile);
    expect(cache.nearestPathTile(13, 10, 0)).toBe(-1);
    expect(cache.nearestPathTile(13, 10, 1)).toBe(tile);
  });

  it("measures distance as Chebyshev rings, so a diagonal neighbour is at radius 1", () => {
    const world = open(10, 10);
    lay(world, [
      [6, 6],
      [4, 5],
    ]);
    const cache = new RouteCache(world.terrain);
    expect(cache.nearestPathTile(5, 5, 1)).toBe(at(world, 4, 5));
    expect(cache.nearestPathTile(7, 7, 1)).toBe(at(world, 6, 6));
  });

  it("prefers a nearer ring to a lower index", () => {
    const world = open(10, 10);
    lay(world, [
      [5, 1], // radius 2 from (5, 3), and the earlier index
      [6, 4], // radius 1
    ]);
    const cache = new RouteCache(world.terrain);
    expect(cache.nearestPathTile(5, 3)).toBe(at(world, 6, 4));
  });

  it("breaks a tie within a ring in row-major order", () => {
    const world = open(10, 10);
    // All on the radius-1 ring round (5, 5).
    lay(world, [
      [4, 6],
      [6, 5],
      [6, 4],
    ]);
    const cache = new RouteCache(world.terrain);
    expect(cache.nearestPathTile(5, 5, 1)).toBe(at(world, 6, 4));
    world.terrain.path[at(world, 5, 4)] = PATH_FOOT;
    expect(cache.nearestPathTile(5, 5, 1)).toBe(at(world, 5, 4));
    world.terrain.path[at(world, 4, 4)] = PATH_FOOT;
    expect(cache.nearestPathTile(5, 5, 1)).toBe(at(world, 4, 4));
  });

  it("searches to a radius of 8 by default", () => {
    const world = open(30, 30);
    lay(world, [[18, 10]]);
    const cache = new RouteCache(world.terrain);
    expect(cache.nearestPathTile(10, 10)).toBe(at(world, 18, 10));
    expect(cache.nearestPathTile(9, 10)).toBe(-1);
  });

  it("copes with the edge of the map, a centre off it, and nonsense", () => {
    const world = open(10, 10);
    lay(world, [
      [0, 0],
      [9, 9],
    ]);
    const cache = new RouteCache(world.terrain);
    expect(cache.nearestPathTile(0, 0, 0)).toBe(0);
    expect(cache.nearestPathTile(1, 1, 1)).toBe(0);
    expect(cache.nearestPathTile(9, 8, 1)).toBe(at(world, 9, 9));
    expect(cache.nearestPathTile(-1, -1, 1)).toBe(0);
    expect(cache.nearestPathTile(-5, -5, 3)).toBe(-1);
    expect(cache.nearestPathTile(1.5, 1, 3)).toBe(-1);
    expect(cache.nearestPathTile(1, 1, -1)).toBe(-1);
    expect(cache.nearestPathTile(1, 1, Number.NaN)).toBe(-1);
    // An unbounded radius stops at the edge of the map.
    expect(cache.nearestPathTile(5, 5, Number.POSITIVE_INFINITY)).toBe(at(world, 9, 9));
    expect(new RouteCache(open(4, 4).terrain).nearestPathTile(2, 2, Number.POSITIVE_INFINITY)).toBe(
      -1,
    );
  });
});

describe("RouteCache and the park entrance", () => {
  /** An 8x8 park with the entrance at (0, 3), nothing on that tile, and a path from (1, 3) to (5, 3). */
  function parkWithEntrance() {
    const world = open(8, 8);
    const sim = new Sim(world);
    const placed = sim.execute("park_set_entrance", { x: 0, y: 3 });
    if (!placed.ok) throw new Error(`park_set_entrance failed: ${placed.error}`);
    lay(world, row(3, 1, 5));
    const entrance = at(world, 0, 3);
    return { world, sim, entrance, isEntrance: (index: number) => index === entrance };
  }

  it("treats the entrance tile as walkable as a target and as a start", () => {
    const { world, entrance, isEntrance } = parkWithEntrance();
    expect(world.terrain.path[entrance]).toBe(0);
    const cache = new RouteCache(world.terrain, isEntrance);

    const toEntrance = cache.distanceField(entrance);
    expect(toEntrance[entrance]).toBe(0);
    for (let x = 1; x <= 5; x++) expect(toEntrance[at(world, x, 3)]).toBe(x);
    expect(cache.nextStep(at(world, 5, 3), entrance)).toBe(at(world, 4, 3));
    expect(cache.nextStep(at(world, 1, 3), entrance)).toBe(entrance);

    const far = at(world, 5, 3);
    expect(cache.reachable(entrance, far)).toBe(true);
    expect(cache.distanceField(far)[entrance]).toBe(5);
    expect(cache.nextStep(entrance, far)).toBe(at(world, 1, 3));
  });

  it("leaves the entrance out unless told", () => {
    const { world, entrance } = parkWithEntrance();
    const cache = new RouteCache(world.terrain);
    expect(cache.reachable(entrance, at(world, 5, 3))).toBe(false);
    expect(cache.distanceField(entrance).every((d) => d === UNREACHABLE)).toBe(true);
  });

  it("reaches an entrance that has no path beside it, from itself only", () => {
    const world = open(8, 8);
    const sim = new Sim(world);
    sim.execute("park_set_entrance", { x: 0, y: 3 });
    lay(world, row(5, 2, 4));
    const entrance = at(world, 0, 3);
    const cache = new RouteCache(world.terrain, (index) => index === entrance);
    expect(cache.reachable(entrance, entrance)).toBe(true);
    expect(cache.reachable(at(world, 3, 5), entrance)).toBe(false);
    expect(cache.nextStep(at(world, 3, 5), entrance)).toBe(-1);
  });

  it("counts the entrance tile for nearestPathTile", () => {
    const { world, entrance, isEntrance } = parkWithEntrance();
    expect(new RouteCache(world.terrain).nearestPathTile(0, 2, 0)).toBe(-1);
    expect(new RouteCache(world.terrain, isEntrance).nearestPathTile(0, 3, 0)).toBe(entrance);
  });

  it("takes the predicate from sync, and keeps it between syncs", () => {
    const { world, entrance, isEntrance } = parkWithEntrance();
    const cache = new RouteCache(world.terrain);
    cache.sync(world, isEntrance);
    expect(cache.reachable(entrance, at(world, 5, 3))).toBe(true);
    cache.sync(world);
    expect(cache.reachable(entrance, at(world, 5, 3))).toBe(true);
  });
});

describe("RouteCache LRU", () => {
  function allPath() {
    const world = open(10, 10);
    world.terrain.path.fill(PATH_FOOT);
    return { world, cache: new RouteCache(world.terrain) };
  }

  it("keeps 64 fields", () => {
    expect(FIELD_CACHE_SIZE).toBe(64);
    const { cache } = allPath();
    for (let i = 0; i < 64; i++) cache.distanceField(i);
    expect(cache.size).toBe(64);
    for (let i = 0; i < 64; i++) expect(cache.has(i)).toBe(true);
    expect(cache.has(64)).toBe(false);
  });

  it("evicts the oldest field when a 65th is added", () => {
    const { cache } = allPath();
    for (let i = 0; i <= 64; i++) cache.distanceField(i);
    expect(cache.size).toBe(64);
    expect(cache.has(0)).toBe(false);
    expect(cache.has(1)).toBe(true);
    expect(cache.has(64)).toBe(true);
  });

  it("evicts the least recently used field, not the oldest, when one has been used since", () => {
    const { cache } = allPath();
    const first = cache.distanceField(0);
    for (let i = 1; i < 64; i++) cache.distanceField(i);
    // Touch the first, so the second is now the one nobody has used for longest.
    expect(cache.distanceField(0)).toBe(first);
    cache.distanceField(64);
    expect(cache.size).toBe(64);
    expect(cache.has(0)).toBe(true);
    expect(cache.has(1)).toBe(false);
    expect(cache.has(2)).toBe(true);
    expect(cache.distanceField(0)).toBe(first);
  });

  it("does not count has as a use", () => {
    const { cache } = allPath();
    for (let i = 0; i < 64; i++) cache.distanceField(i);
    expect(cache.has(0)).toBe(true);
    cache.distanceField(64);
    expect(cache.has(0)).toBe(false);
  });

  it("empties on invalidate", () => {
    const { cache } = allPath();
    for (let i = 0; i < 10; i++) cache.distanceField(i);
    cache.invalidate();
    expect(cache.size).toBe(0);
    expect(cache.has(0)).toBe(false);
  });
});

describe("RouteCache.sync", () => {
  it("clears after a path_build through the Sim and sees the new path", () => {
    const world = open(16, 16);
    const sim = new Sim(world);
    const cache = new RouteCache(world.terrain);
    expect(sim.execute("path_build", { x: 2, y: 2, w: 5, h: 1, kind: "foot" }).ok).toBe(true);
    cache.sync(sim.world);
    expect(cache.pathVersion).toBe(sim.world.pathVersion);

    const target = at(world, 2, 2);
    const before = cache.distanceField(target);
    expect(before[at(world, 6, 2)]).toBe(4);
    expect(before[at(world, 9, 2)]).toBe(UNREACHABLE);

    expect(sim.execute("path_build", { x: 7, y: 2, w: 3, h: 1, kind: "foot" }).ok).toBe(true);
    // Not until it is told.
    expect(cache.distanceField(target)).toBe(before);
    cache.sync(sim.world);
    expect(cache.size).toBe(0);
    expect(cache.pathVersion).toBe(sim.world.pathVersion);
    const after = cache.distanceField(target);
    expect(after).not.toBe(before);
    expect(after[at(world, 9, 2)]).toBe(7);
  });

  it("keeps the cache when nothing changed", () => {
    const world = open(16, 16);
    const sim = new Sim(world);
    sim.execute("path_build", { x: 2, y: 2, w: 5, h: 1, kind: "foot" });
    const cache = new RouteCache(world.terrain);
    cache.sync(sim.world);
    const first = cache.distanceField(at(world, 2, 2));
    cache.sync(sim.world);
    cache.sync(sim.world);
    expect(cache.distanceField(at(world, 2, 2))).toBe(first);
    expect(cache.size).toBe(1);
    // Commands that do not touch the paths leave it alone too.
    sim.execute("park_set_entry_fee", { cents: 500 });
    sim.step(3);
    cache.sync(sim.world);
    expect(cache.distanceField(at(world, 2, 2))).toBe(first);
  });

  it("clears after path_remove, an entrance move, and an undo", () => {
    const world = open(16, 16);
    const sim = new Sim(world);
    const cache = new RouteCache(world.terrain);
    sim.execute("path_build", { x: 2, y: 2, w: 5, h: 1, kind: "foot" });
    cache.sync(sim.world);

    const fieldAfter = (): Uint16Array => {
      cache.sync(sim.world);
      return cache.distanceField(at(world, 2, 2));
    };

    const built = fieldAfter();
    sim.execute("path_remove", { x: 4, y: 2, w: 1, h: 1 });
    const removed = fieldAfter();
    expect(removed).not.toBe(built);
    expect(removed[at(world, 6, 2)]).toBe(UNREACHABLE);

    sim.undo();
    const undone = fieldAfter();
    expect(undone).not.toBe(removed);
    expect(undone[at(world, 6, 2)]).toBe(4);

    sim.execute("park_set_entrance", { x: 0, y: 5 });
    expect(fieldAfter()).not.toBe(undone);
  });

  it("follows a replaced world, even when its path version happens to match", () => {
    const world = open(16, 16);
    const sim = new Sim(world);
    const cache = new RouteCache(world.terrain);
    cache.sync(sim.world);
    lay(world, row(2, 2, 6));
    cache.invalidate();
    const stale = cache.distanceField(at(world, 2, 2));
    expect(stale[at(world, 6, 2)]).toBe(4);

    // Both worlds are at path version 0.
    const other = open(16, 16);
    lay(other, row(2, 2, 3));
    sim.replaceWorld(other);
    expect(other.pathVersion).toBe(world.pathVersion);
    cache.sync(sim.world);
    expect(cache.size).toBe(0);
    const fresh = cache.distanceField(at(other, 2, 2));
    expect(fresh[at(other, 3, 2)]).toBe(1);
    expect(fresh[at(other, 6, 2)]).toBe(UNREACHABLE);
  });

  it("resizes for a replaced world of another size", () => {
    const world = open(8, 8);
    const cache = new RouteCache(world.terrain);
    lay(world, row(0, 0, 7));
    expect(cache.distanceField(0).length).toBe(64);

    const bigger = open(20, 12);
    lay(bigger, row(11, 0, 19));
    cache.sync(bigger);
    const field = cache.distanceField(at(bigger, 0, 11));
    expect(field.length).toBe(20 * 12);
    expect(field[at(bigger, 19, 11)]).toBe(19);
    expect(cache.nextStep(at(bigger, 19, 11), at(bigger, 0, 11))).toBe(at(bigger, 18, 11));

    const smaller = open(3, 3);
    lay(smaller, row(1, 0, 2));
    cache.sync(smaller);
    expect(cache.distanceField(at(smaller, 0, 1)).length).toBe(9);
    expect(cache.nearestPathTile(1, 1, 0)).toBe(at(smaller, 1, 1));
    // On the radius-1 ring round (1, 0) the west tile comes first in row-major order.
    expect(cache.nearestPathTile(1, 0, 1)).toBe(at(smaller, 0, 1));
  });
});

describe("RouteCache performance", () => {
  it("flood fills a 256x256 map of path well inside 50 ms", () => {
    const world = open(256, 256);
    world.terrain.path.fill(PATH_FOOT);
    const cache = new RouteCache(world.terrain);
    const last = 256 * 256 - 1;
    // Warm up on one target, then take the best of a few others so a slow tick does not fail it.
    cache.distanceField(last);
    let best = Number.POSITIVE_INFINITY;
    for (const target of [0, 128 * 256 + 128, 255]) {
      const start = performance.now();
      const field = cache.distanceField(target);
      best = Math.min(best, performance.now() - start);
      expect(field[target]).toBe(0);
    }
    expect(best).toBeLessThan(50);
    expect(cache.distanceField(0)[last]).toBe(510);
  });
});
