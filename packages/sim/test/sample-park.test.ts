import { describe, expect, it } from "vitest";
import { MAX_HEIGHT, Sim, createSamplePark, hashWorld, type World } from "../src/index.js";
import { forEachGuest, guestTile } from "../src/guests/guests.js";
import { GuestState } from "../src/guests/types.js";
import { PATH_FOOT, PATH_NONE, PATH_QUEUE, canBuildPath, pathAt } from "../src/paths/paths.js";
import { tileCorners } from "../src/terrain/terrain.js";

/** Corner height of a freshly created world; the hill must stand this many steps above it. */
const GROUND = 8;

function waterTiles(water: Uint8Array): number {
  let n = 0;
  for (const level of water) if (level > 0) n++;
  return n;
}

/** Counts the path tiles of one kind, or of any kind with `PATH_NONE` meaning "any". */
function countPath(world: World, kind: number): number {
  let n = 0;
  for (const v of world.terrain.path) if (kind === PATH_NONE ? v !== PATH_NONE : v === kind) n++;
  return n;
}

/** The tiles reachable from the entrance's neighbours over path, as "x,y" keys. */
function reachableFromGate(world: World): Set<string> {
  const t = world.terrain;
  const gate = world.park.entrance;
  if (gate === null) throw new Error("no entrance");
  const seen = new Set<string>();
  const queue: Array<[number, number]> = [[gate.x, gate.y]];
  seen.add(`${gate.x},${gate.y}`);
  while (queue.length > 0) {
    const [x, y] = queue.shift() as [number, number];
    for (const [nx, ny] of [
      [x, y - 1],
      [x + 1, y],
      [x, y + 1],
      [x - 1, y],
    ] as const) {
      if (pathAt(t, nx, ny) === PATH_NONE || seen.has(`${nx},${ny}`)) continue;
      seen.add(`${nx},${ny}`);
      queue.push([nx, ny]);
    }
  }
  return seen;
}

/** The height the pond's water stands at. */
function pondLevel(world: World): number {
  return Math.max(...world.terrain.water);
}

/**
 * Whether a pond with its water at `level` covers tile (x, y): the tile has water, or none of its
 * corners is above that level. The second kind is the shelf around the basin, which has no water
 * of its own but slopes down from the waterline, so the pond is drawn over it.
 */
function underPond(world: World, level: number, x: number, y: number): boolean {
  const t = world.terrain;
  return (t.water[y * t.width + x] as number) > 0 || Math.max(...tileCorners(t, x, y)) <= level;
}

/** The path tiles the pond covers, as "x,y" keys: there should be none. */
function pathUnderPond(world: World): string[] {
  const { width, height } = world.terrain;
  const level = pondLevel(world);
  const wet: string[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pathAt(world.terrain, x, y) === PATH_NONE) continue;
      if (underPond(world, level, x, y)) wet.push(`${x},${y}`);
    }
  }
  return wet;
}

/**
 * The plaza's waterfront: the footpath tiles with the pond directly north of them and more
 * footpath directly south, as [x, y] pairs.
 */
function waterfront(world: World): Array<[number, number]> {
  const { width, height } = world.terrain;
  const level = pondLevel(world);
  const tiles: Array<[number, number]> = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 0; x < width; x++) {
      if (
        pathAt(world.terrain, x, y) === PATH_FOOT &&
        pathAt(world.terrain, x, y + 1) === PATH_FOOT &&
        underPond(world, level, x, y - 1)
      ) {
        tiles.push([x, y]);
      }
    }
  }
  return tiles;
}

/** The tile under the highest corner of the map: the top of the hill. */
function peakTile(world: World): { x: number; y: number } {
  const { corners, width } = world.terrain;
  const at = corners.indexOf(Math.max(...corners));
  return { x: Math.min(width - 1, at % (width + 1)), y: Math.floor(at / (width + 1)) };
}

/** Whether a walk from (x, y) in the direction (dx, dy) comes to a footpath before the map's edge. */
function meetsFootpath(world: World, x: number, y: number, dx: number, dy: number): boolean {
  const { width, height } = world.terrain;
  for (; x >= 0 && y >= 0 && x < width && y < height; x += dx, y += dy) {
    if (pathAt(world.terrain, x, y) === PATH_FOOT) return true;
  }
  return false;
}

/** Whether there is footpath north, east, south and west of the hill's top: a loop goes round it. */
function loopGoesRoundTheHill(world: World): boolean {
  const { x, y } = peakTile(world);
  return (
    meetsFootpath(world, x, y, 0, -1) &&
    meetsFootpath(world, x, y, 1, 0) &&
    meetsFootpath(world, x, y, 0, 1) &&
    meetsFootpath(world, x, y, -1, 0)
  );
}

describe("createSamplePark", () => {
  const world = createSamplePark(7);

  it("is a 64 by 64 park called Leafy Lake with $10,000.00 in the bank", () => {
    expect(world.terrain.width).toBe(64);
    expect(world.terrain.height).toBe(64);
    expect(world.meta.name).toBe("Leafy Lake");
    expect(world.meta.seed).toBe(7);
    expect(world.finance.cash).toBe(10_000_00);
    expect(world.finance.monthStart.cash).toBe(10_000_00);
    expect(world.finance.loan).toBe(0);
    expect(world.tick).toBe(0);
  });

  it("has a hill at least 14 steps above the ground, near tile (18, 14)", () => {
    const { corners, width } = world.terrain;
    const peak = Math.max(...corners);
    expect(peak).toBeGreaterThanOrEqual(GROUND + 14);
    expect(peak).toBeLessThanOrEqual(MAX_HEIGHT);

    const at = corners.indexOf(peak);
    const px = at % (width + 1);
    const py = Math.floor(at / (width + 1));
    expect(Math.abs(px - 18)).toBeLessThanOrEqual(4);
    expect(Math.abs(py - 14)).toBeLessThanOrEqual(4);
  });

  it("has a pond of at least 24 water tiles, with sand around it and rock on the hill", () => {
    const { water, surface } = world.terrain;
    expect(waterTiles(water)).toBeGreaterThanOrEqual(24);
    expect(surface.includes(1)).toBe(true);
    expect(surface.includes(3)).toBe(true);
  });

  it("puts every water tile above the ground under it", () => {
    const { water, corners, width, height } = world.terrain;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const level = water[y * width + x] as number;
        if (level === 0) continue;
        const lowest = Math.min(
          corners[y * (width + 1) + x] as number,
          corners[y * (width + 1) + x + 1] as number,
          corners[(y + 1) * (width + 1) + x] as number,
          corners[(y + 1) * (width + 1) + x + 1] as number,
        );
        expect(level).toBeGreaterThan(lowest);
      }
    }
  });

  it("was shaped through commands as the system, so the log is not empty", () => {
    expect(world.log.length).toBeGreaterThan(0);
    for (const entry of world.log) {
      expect(entry.client).toBe("system");
      expect(/^(terrain|path|park)_/.test(entry.name)).toBe(true);
    }
  });

  it("opens with an entrance on the south edge, a $5.00 fee, and the park open", () => {
    expect(world.park.open).toBe(true);
    expect(world.park.entryFee).toBe(5_00);
    expect(world.park.entrance).toMatchObject({ y: 63, side: 2 });
    expect(world.park.name).toBe("Leafy Lake");
  });

  it("has one connected network of path from the gate to the pond and around the hill", () => {
    const gate = world.park.entrance;
    if (gate === null) throw new Error("no entrance");
    const reached = reachableFromGate(world);
    // Every path tile is joined to the gate (the entrance tile itself carries no path).
    expect(reached.size - 1).toBe(countPath(world, PATH_NONE));
    expect(countPath(world, PATH_FOOT)).toBeGreaterThan(100);
    expect(countPath(world, PATH_QUEUE)).toBeGreaterThanOrEqual(4);
    expect(loopGoesRoundTheHill(world)).toBe(true);

    // The main path: footpath all the way up the gate's column to the plaza.
    const front = waterfront(world);
    const plazaY = Math.min(...front.map(([, y]) => y));
    for (let y = plazaY; y < gate.y; y++) expect(pathAt(world.terrain, gate.x, y)).toBe(PATH_FOOT);
  });

  it("has a plaza a few tiles wide and three deep at the pond's waterline", () => {
    const front = waterfront(world);
    expect(front.length).toBeGreaterThanOrEqual(3);
    for (const [x, y] of front) {
      for (let row = y; row < y + 3; row++) expect(pathAt(world.terrain, x, row)).toBe(PATH_FOOT);
    }
  });

  it("lays path only where the sim allows it, and never under the pond", () => {
    const { path, width } = world.terrain;
    // The entrance was placed first and the paths built around it, so with it out of the way
    // every path tile must be one `canBuildPath` passes: on the map, no water, not too steep.
    const bare: World = { ...world, park: { ...world.park, entrance: null } };
    for (let i = 0; i < path.length; i++) {
      if ((path[i] as number) === PATH_NONE) continue;
      expect(canBuildPath(bare, i % width, Math.floor(i / width))).toBeNull();
    }
    // The shelf around the pond's basin has no water of its own, but it is under the surface.
    expect(pathUnderPond(world)).toEqual([]);
    expect(world.finance.cash).toBe(10_000_00);
  });

  it("brings guests in, to the waterfront and round the hill, and none of them gets lost", () => {
    const sim = new Sim(createSamplePark(7));
    const front = new Set(waterfront(sim.world).map(([x, y]) => `${x},${y}`));
    // The first row with any path on it is the far side of the loop, north of the hill.
    const { path, width } = sim.world.terrain;
    const farSide = Math.floor(path.findIndex((v) => v !== PATH_NONE) / width);
    let atWaterfront = false;
    let pastTheHill = false;
    let lost = 0;
    // Eight game days, looked at four times a tile's walk.
    for (let tick = 0; tick < 3200; tick += 4) {
      sim.step(4);
      forEachGuest(sim.world, (slot) => {
        if (sim.world.guests.state[slot] === GuestState.LOST) lost++;
        const { x, y } = guestTile(sim.world, slot);
        if (front.has(`${x},${y}`)) atWaterfront = true;
        if (y === farSide) pastTheHill = true;
      });
    }
    expect(sim.world.park.guestsInPark).toBeGreaterThan(20);
    expect(sim.world.park.totalAdmissions).toBeGreaterThan(20);
    // Nothing else earns or costs money yet, so the purse is the start plus the gate's takings.
    expect(sim.world.finance.cash).toBe(10_000_00 + sim.world.park.totalAdmissions * 5_00);
    expect(atWaterfront).toBe(true);
    expect(pastTheHill).toBe(true);
    expect(lost).toBe(0);
  });

  it("can be built without the park, as an empty field with only terrain work in its log", () => {
    const bare = createSamplePark(7, { withPark: false });
    expect(bare.park.entrance).toBeNull();
    expect(bare.park.open).toBe(false);
    expect(countPath(bare, PATH_NONE)).toBe(0);
    for (const entry of bare.log) expect(entry.name.startsWith("terrain_")).toBe(true);
    expect(hashWorld(bare)).not.toBe(hashWorld(world));
  });

  it("cannot be undone away: the player starts with a clean slate", () => {
    expect(world.undoStack).toEqual([]);
    expect(world.redoStack).toEqual([]);
  });

  it("is the same park for the same seed, and a different one for another", () => {
    expect(hashWorld(createSamplePark(7))).toBe(hashWorld(world));
    expect(hashWorld(createSamplePark(8))).not.toBe(hashWorld(world));
  });

  it("works for any seed", () => {
    // The seed moves the hill and the pond a tile each way, and they come close enough for the
    // pond's shore to lie where a loop of a fixed size would run: about one seed in nine (13, 21,
    // 23 and 27 are the first) once failed with "Cannot build on water". The first 200 seeds meet
    // every pairing of the two many times over.
    const seeds = [...Array.from({ length: 200 }, (_, seed) => seed), 123456, 2 ** 31 - 1];
    for (const seed of seeds) {
      const park = createSamplePark(seed);
      const hint = `seed ${seed}`;
      expect(Math.max(...park.terrain.corners), hint).toBeGreaterThanOrEqual(GROUND + 14);
      expect(waterTiles(park.terrain.water), hint).toBeGreaterThanOrEqual(24);
      expect(park.finance.cash, hint).toBe(10_000_00);
      expect(park.park.open, hint).toBe(true);
      expect(park.park.entryFee, hint).toBe(5_00);
      expect(park.park.entrance, hint).toMatchObject({ y: 63, side: 2 });
      expect(reachableFromGate(park).size - 1, hint).toBe(countPath(park, PATH_NONE));
      expect(countPath(park, PATH_QUEUE), hint).toBeGreaterThanOrEqual(4);
      expect(pathUnderPond(park), hint).toEqual([]);
      expect(waterfront(park).length, hint).toBeGreaterThanOrEqual(3);
      expect(loopGoesRoundTheHill(park), hint).toBe(true);
    }
  });
});
