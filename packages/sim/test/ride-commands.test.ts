import {
  COASTER_FAMILIES,
  RIDE_TYPES,
  STALL_TYPES,
  rotateOffset,
  rotatedFootprint,
  rotateSide,
} from "@coasterworks/content";
import type { Rot } from "@coasterworks/content";
import { describe, expect, it } from "vitest";
import {
  RIDE_CAP,
  Sim,
  canPlaceRide,
  createWorld,
  deserializeWorld,
  hashWorld,
  serializeWorld,
  type RideRecord,
  type World,
} from "../src/index.js";
import { validateWorldInvariants } from "../src/save/invariants.js";

const CASH = 1_000_000_00;
const ROTS: Rot[] = [0, 1, 2, 3];

function setup(width = 32, height = 32) {
  const world = createWorld({ width, height, seed: 5, name: "Rideland", cash: CASH });
  return { world, sim: new Sim(world) };
}

/** Runs a command that must succeed and returns its result. */
function run(sim: Sim, name: string, input: unknown) {
  const result = sim.execute(name, input);
  if (!result.ok) throw new Error(`${name} failed: ${result.error}`);
  return result;
}

/** Runs a command that must fail and returns its error. */
function refuse(sim: Sim, name: string, input: unknown): string {
  const result = sim.execute(name, input);
  if (result.ok) throw new Error(`${name} succeeded but should have failed`);
  return result.error;
}

function occupantAt(world: World, x: number, y: number): number {
  return world.terrain.occupant[y * world.terrain.width + x] as number;
}

function occupiedTiles(world: World): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  const { width, height } = world.terrain;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const id = occupantAt(world, x, y);
      if (id !== 0) out.push([x, y, id]);
    }
  }
  return out;
}

function rideOf(world: World, id: number): RideRecord {
  const ride = world.rides.find((r) => r.id === id);
  if (ride === undefined) throw new Error(`no ride ${id}`);
  return ride;
}

const carousel = RIDE_TYPES.find((t) => t.id === "carousel")!;
const snack = STALL_TYPES.find((t) => t.id === "snack_stand")!;

describe("building rides and stalls", () => {
  for (const type of [...RIDE_TYPES, ...STALL_TYPES]) {
    for (const rot of ROTS) {
      it(`${type.id} at rotation ${rot} charges its cost and occupies exactly its rotated footprint`, () => {
        const { world, sim } = setup();
        const command = type.kind === "ride" ? "ride_build" : "stall_build";
        const result = run(sim, command, { type: type.id, x: 10, y: 10, rot });
        expect(result.cost).toBe(type.cost);
        expect(world.finance.cash).toBe(CASH - type.cost);

        const { w, h } = rotatedFootprint(type.footprint, rot);
        const expected: Array<[number, number, number]> = [];
        for (let y = 10; y < 10 + h; y++)
          for (let x = 10; x < 10 + w; x++) expected.push([x, y, 1]);
        expect(occupiedTiles(world)).toEqual(expected);

        const ride = rideOf(world, 1);
        expect(ride).toMatchObject({ id: 1, type: type.id, kind: type.kind, x: 10, y: 10, rot });
        if (type.kind === "ride") {
          const e = rotateOffset(type.entrance, type.footprint, rot);
          const x = rotateOffset(type.exit, type.footprint, rot);
          expect(ride.entrance).toEqual({ x: 10 + e.x, y: 10 + e.y });
          expect(ride.exit).toEqual({ x: 10 + x.x, y: 10 + x.y });
          expect(ride.service).toBeNull();
        } else {
          const side = rotateSide(type.front, rot);
          const [dx, dy] = [
            [0, -1],
            [1, 0],
            [0, 1],
            [-1, 0],
          ][side] as [number, number];
          expect(ride.service).toEqual({ x: 10 + dx, y: 10 + dy });
          expect(ride.entrance).toBeNull();
          expect(ride.exit).toBeNull();
        }
        expect(validateWorldInvariants(world)).toBeNull();
      });
    }
  }

  it("gives a new ride its defaults: closed, the type's price, idle, no riders or queue", () => {
    const { world, sim } = setup();
    run(sim, "ride_build", { type: "carousel", x: 10, y: 10, rot: 0 });
    expect(rideOf(world, 1)).toEqual({
      id: 1,
      type: "carousel",
      kind: "ride",
      x: 10,
      y: 10,
      rot: 0,
      name: "Carousel 1",
      open: false,
      price: carousel.defaultPrice,
      entrance: { x: 11, y: 13 },
      exit: { x: 13, y: 11 },
      service: null,
      phase: 0,
      phaseTicks: 0,
      riders: [],
      queue: [],
      stats: { customers: 0, income: 0, runningCost: 0, monthCustomers: 0, monthIncome: 0 },
    });
    expect(world.nextRideId).toBe(2);
  });

  it("names each ride with the smallest free number for its type", () => {
    const { world, sim } = setup(48, 48);
    run(sim, "ride_build", { type: "carousel", x: 2, y: 2, rot: 0 });
    run(sim, "ride_build", { type: "carousel", x: 8, y: 2, rot: 0 });
    run(sim, "ride_build", { type: "carousel", x: 14, y: 2, rot: 0 });
    run(sim, "stall_build", { type: "snack_stand", x: 20, y: 2, rot: 0 });
    expect(world.rides.map((r) => r.name)).toEqual([
      "Carousel 1",
      "Carousel 2",
      "Carousel 3",
      "Snack Stand 1",
    ]);
    run(sim, "ride_demolish", { id: 2 });
    run(sim, "ride_build", { type: "carousel", x: 8, y: 2, rot: 0 });
    expect(rideOf(world, 5).name).toBe("Carousel 2");
    run(sim, "ride_rename", { id: 1, name: "Old Faithful" });
    run(sim, "ride_build", { type: "carousel", x: 26, y: 2, rot: 0 });
    expect(rideOf(world, 6).name).toBe("Carousel 1");
  });

  it("never reuses an id, even after a demolish", () => {
    const { world, sim } = setup();
    run(sim, "ride_build", { type: "carousel", x: 4, y: 4, rot: 0 });
    run(sim, "stall_build", { type: "snack_stand", x: 12, y: 4, rot: 0 });
    run(sim, "ride_demolish", { id: 2 });
    run(sim, "stall_build", { type: "snack_stand", x: 12, y: 4, rot: 0 });
    expect(world.rides.map((r) => r.id)).toEqual([1, 3]);
    expect(world.nextRideId).toBe(4);
    expect(occupantAt(world, 12, 4)).toBe(3);
  });

  it("keeps the rides sorted by id and bumps rideVersion on every apply and revert", () => {
    const { world, sim } = setup();
    const versions: number[] = [world.rideVersion];
    run(sim, "ride_build", { type: "carousel", x: 4, y: 4, rot: 0 });
    versions.push(world.rideVersion);
    run(sim, "stall_build", { type: "snack_stand", x: 12, y: 4, rot: 0 });
    versions.push(world.rideVersion);
    run(sim, "ride_demolish", { id: 1 });
    versions.push(world.rideVersion);
    expect(sim.undo().ok).toBe(true);
    versions.push(world.rideVersion);
    expect(world.rides.map((r) => r.id)).toEqual([1, 2]);
    for (const [name, input] of [
      ["ride_open", { id: 1 }],
      ["ride_close", { id: 1 }],
      ["ride_set_price", { id: 1, cents: 300 }],
      ["ride_rename", { id: 1, name: "Spinner" }],
    ] as const) {
      run(sim, name, input);
      versions.push(world.rideVersion);
      expect(sim.undo().ok).toBe(true);
      versions.push(world.rideVersion);
    }
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i], `step ${i}`).toBeGreaterThan(versions[i - 1] as number);
    }
  });

  it("refuses the wrong kind of type, and types that do not exist", () => {
    const { sim } = setup();
    expect(refuse(sim, "ride_build", { type: "snack_stand", x: 4, y: 4, rot: 0 })).toBe(
      "Not a ride: snack_stand",
    );
    expect(refuse(sim, "ride_build", { type: "teacups", x: 4, y: 4, rot: 0 })).toBe(
      "Unknown ride type: teacups",
    );
    expect(refuse(sim, "stall_build", { type: "carousel", x: 4, y: 4, rot: 0 })).toBe(
      "Not a stall: carousel",
    );
    expect(refuse(sim, "stall_build", { type: "pizza", x: 4, y: 4, rot: 0 })).toBe(
      "Unknown stall type: pizza",
    );
  });

  it("refuses a build the park cannot pay for, and charges nothing", () => {
    const world = createWorld({ width: 32, height: 32, seed: 5, name: "Poor", cash: 1_000_00 });
    const sim = new Sim(world);
    expect(refuse(sim, "ride_build", { type: "carousel", x: 4, y: 4, rot: 0 })).toMatch(
      /^Not enough cash: need \$1200\.00, have \$1000\.00$/,
    );
    expect(world.rides).toEqual([]);
    expect(world.finance.cash).toBe(1_000_00);
  });
});

describe("canPlaceRide", () => {
  it("refuses tiles off the map or on the edge ring, footprint, entrance or exit alike", () => {
    const { world } = setup();
    expect(canPlaceRide(world, carousel, 30, 30, 0)).toBe("Area is outside the park");
    expect(canPlaceRide(world, carousel, 40, 2, 0)).toBe("Area is outside the park");
    expect(canPlaceRide(world, carousel, 0, 5, 0)).toBe("Area is outside the park");
    // Footprint rows 28..30 are inside, but the entrance below lands on the edge row 31.
    expect(canPlaceRide(world, carousel, 10, 28, 0)).toBe("Area is outside the park");
    // The exit to the east lands on column 31.
    expect(canPlaceRide(world, carousel, 28, 10, 0)).toBe("Area is outside the park");
    expect(canPlaceRide(world, carousel, 27, 10, 0)).toBeNull();
    // A stall whose service tile would be on the edge.
    expect(canPlaceRide(world, snack, 10, 30, 0)).toBe("Area is outside the park");
    expect(canPlaceRide(world, snack, 10, 29, 0)).toBeNull();
  });

  it("refuses water under the footprint", () => {
    const { world, sim } = setup();
    run(sim, "terrain_set_water", { x: 11, y: 11, w: 1, h: 1, level: 12 });
    expect(canPlaceRide(world, carousel, 10, 10, 0)).toBe("Cannot build on water");
    expect(refuse(sim, "ride_build", { type: "carousel", x: 10, y: 10, rot: 0 })).toBe(
      "Cannot build on water",
    );
  });

  it("refuses ground that is not flat, but takes ground that is flat and raised", () => {
    const { world, sim } = setup();
    run(sim, "terrain_raise", { x: 12, y: 12, w: 1, h: 1, steps: 1 });
    expect(canPlaceRide(world, carousel, 10, 10, 0)).toBe("Ground is not flat");
    expect(canPlaceRide(world, snack, 12, 12, 0)).toBeNull();
    run(sim, "terrain_raise", { x: 20, y: 10, w: 3, h: 3, steps: 2 });
    expect(canPlaceRide(world, carousel, 20, 10, 0)).toBeNull();
    expect(canPlaceRide(world, carousel, 19, 10, 0)).toBe("Ground is not flat");
  });

  it("refuses a path under the footprint, but lets the entrance and exit stand on paths", () => {
    const { world, sim } = setup();
    run(sim, "path_build", { x: 12, y: 12, w: 1, h: 1, kind: "foot" });
    expect(canPlaceRide(world, carousel, 10, 10, 0)).toBe("Something is already here");
    // Entrance (11, 13) and exit (13, 11) on paths are fine.
    run(sim, "path_build", { x: 11, y: 17, w: 1, h: 1, kind: "queue" });
    run(sim, "path_build", { x: 13, y: 15, w: 1, h: 1, kind: "foot" });
    expect(canPlaceRide(world, carousel, 10, 14, 0)).toBeNull();
    run(sim, "ride_build", { type: "carousel", x: 10, y: 14, rot: 0 });
    expect(rideOf(world, 1).entrance).toEqual({ x: 11, y: 17 });
  });

  it("refuses the park entrance under the footprint or under the entrance tile", () => {
    // The entrance must be on the edge ring, where nothing of a ride can go, so it is placed in the
    // middle of the map by hand to check the rule on its own.
    const { world } = setup();
    world.park.entrance = { x: 11, y: 11, side: 0 };
    expect(canPlaceRide(world, carousel, 10, 10, 0)).toBe("Something is already here");
    world.park.entrance = { x: 11, y: 13, side: 0 };
    expect(canPlaceRide(world, carousel, 10, 10, 0)).toBe("Something is already here");
    world.park.entrance = { x: 10, y: 21, side: 0 };
    expect(canPlaceRide(world, snack, 10, 20, 0)).toBe("Something is already here");
  });

  it("refuses an overlap with another ride", () => {
    const { world, sim } = setup();
    run(sim, "ride_build", { type: "carousel", x: 10, y: 10, rot: 0 });
    expect(canPlaceRide(world, carousel, 12, 12, 0)).toBe("Something is already here");
    expect(canPlaceRide(world, snack, 11, 11, 0)).toBe("Something is already here");
    expect(refuse(sim, "ride_build", { type: "swing_tower", x: 8, y: 8, rot: 2 })).toBe(
      "Something is already here",
    );
  });

  it("refuses a footprint on another ride's entrance, exit or service tile", () => {
    const { world, sim } = setup();
    run(sim, "ride_build", { type: "carousel", x: 10, y: 10, rot: 0 });
    // The carousel's entrance is (11, 13) and its exit (13, 11).
    expect(canPlaceRide(world, snack, 11, 13, 0)).toBe("Something is already here");
    expect(canPlaceRide(world, snack, 13, 11, 0)).toBe("Something is already here");
    run(sim, "stall_build", { type: "snack_stand", x: 20, y: 20, rot: 0 });
    // The stall's service tile is (20, 21).
    expect(canPlaceRide(world, snack, 20, 21, 0)).toBe("Something is already here");
  });

  it("refuses an entrance, exit or service tile on another ride or on water", () => {
    const { world, sim } = setup();
    run(sim, "ride_build", { type: "carousel", x: 10, y: 10, rot: 0 });
    // A stall north of the carousel, facing south onto it.
    expect(canPlaceRide(world, snack, 11, 9, 0)).toBe("Something is already here");
    run(sim, "terrain_set_water", { x: 20, y: 21, w: 1, h: 1, level: 12 });
    expect(canPlaceRide(world, snack, 20, 20, 0)).toBe("Something is already here");
  });

  it("refuses once 255 rides and stalls stand, or once 65,535 ids have been used", () => {
    const { world } = setup();
    world.nextRideId = 65_536;
    expect(canPlaceRide(world, snack, 10, 10, 0)).toBe("Too many rides built");
    world.nextRideId = 65_535;
    expect(canPlaceRide(world, snack, 10, 10, 0)).toBeNull();

    const { world: full, sim } = setup(64, 64);
    let built = 0;
    for (let y = 1; y < 62 && built < RIDE_CAP; y += 2) {
      for (let x = 1; x < 63 && built < RIDE_CAP; x++) {
        run(sim, "stall_build", { type: "snack_stand", x, y, rot: 0 });
        built++;
      }
    }
    expect(full.rides).toHaveLength(RIDE_CAP);
    expect(canPlaceRide(full, snack, 1, 60, 0)).toBe("Too many rides");
    expect(validateWorldInvariants(full)).toBeNull();
  });
});

describe("paths and the entrance around rides", () => {
  it("refuses a path on a ride tile, naming the tile in a list", () => {
    const { world, sim } = setup();
    run(sim, "ride_build", { type: "carousel", x: 10, y: 10, rot: 0 });
    expect(refuse(sim, "path_build", { x: 9, y: 11, w: 3, h: 1, kind: "foot" })).toBe(
      "Something is already here",
    );
    expect(
      refuse(sim, "path_build_tiles", {
        tiles: [
          { x: 9, y: 11 },
          { x: 10, y: 11 },
        ],
        kind: "foot",
      }),
    ).toBe("Something is already here at (10, 11)");
    expect(world.terrain.path.every((v) => v === 0)).toBe(true);
  });

  it("lets a path go on the entrance and exit tiles", () => {
    const { world, sim } = setup();
    run(sim, "ride_build", { type: "carousel", x: 10, y: 10, rot: 0 });
    run(sim, "path_build", { x: 11, y: 13, w: 1, h: 3, kind: "queue" });
    run(sim, "path_build", { x: 13, y: 11, w: 3, h: 1, kind: "foot" });
    expect(world.terrain.path[13 * 32 + 11]).toBe(2);
    expect(world.terrain.path[11 * 32 + 13]).toBe(1);
  });

  it("refuses the park entrance on an occupied tile", () => {
    const { world, sim } = setup();
    // Only rides occupy tiles and they never reach the edge, so the tile is marked by hand.
    world.terrain.occupant[0 * 32 + 5] = 1;
    expect(refuse(sim, "park_set_entrance", { x: 5, y: 0 })).toBe("Something is already here");
    world.terrain.occupant[0 * 32 + 5] = 0;
    run(sim, "park_set_entrance", { x: 5, y: 0 });
  });
});

describe("ride_demolish", () => {
  it("frees the tiles and refunds half the cost, rounded down", () => {
    const { world, sim } = setup();
    run(sim, "ride_build", { type: "big_wheel", x: 10, y: 10, rot: 1 });
    const cash = world.finance.cash;
    const result = run(sim, "ride_demolish", { id: 1 });
    expect(result.cost).toBe(0);
    const bigWheel = RIDE_TYPES.find((t) => t.id === "big_wheel")!;
    expect(world.finance.cash).toBe(cash + Math.floor(bigWheel.cost / 2));
    expect(world.rides).toEqual([]);
    expect(occupiedTiles(world)).toEqual([]);
    expect(validateWorldInvariants(world)).toBeNull();
  });

  it("refuses an id with no ride", () => {
    const { sim } = setup();
    for (const name of ["ride_demolish", "ride_open", "ride_close"]) {
      expect(refuse(sim, name, { id: 7 })).toBe("No ride with id 7");
    }
    expect(refuse(sim, "ride_set_price", { id: 7, cents: 100 })).toBe("No ride with id 7");
    expect(refuse(sim, "ride_rename", { id: 7, name: "X" })).toBe("No ride with id 7");
  });

  it("is undone exactly but for the cycle: the same record, id and tiles, and the refund taken back", () => {
    const { world, sim } = setup();
    run(sim, "ride_build", { type: "carousel", x: 10, y: 10, rot: 3 });
    run(sim, "ride_set_price", { id: 1, cents: 350 });
    run(sim, "ride_rename", { id: 1, name: "Golden Horses" });
    run(sim, "ride_open", { id: 1 });
    // Give the record state a later task would have set, so the undo has to keep all of it.
    const ride = rideOf(world, 1);
    ride.phase = 2;
    ride.phaseTicks = 17;
    ride.stats = {
      customers: 40,
      income: 4_000,
      runningCost: 300,
      monthCustomers: 4,
      monthIncome: 400,
    };
    const record = JSON.parse(JSON.stringify(ride)) as RideRecord;
    const tiles = occupiedTiles(world);
    const before = hashWorld(world);
    const cash = world.finance.cash;

    run(sim, "ride_demolish", { id: 1 });
    expect(world.finance.cash).toBe(cash + carousel.cost / 2);
    expect(sim.undo().ok).toBe(true);
    // Everything but the cycle: a demolish empties the ride and an undo brings it back idle.
    expect(world.rides).toEqual([{ ...record, phase: 0, phaseTicks: 0 }]);
    expect(occupiedTiles(world)).toEqual(tiles);
    expect(world.finance.cash).toBe(cash);
    expect(world.nextRideId).toBe(2);
    // The undo itself is logged, so compare the parts that are not the log.
    expect(validateWorldInvariants(world)).toBeNull();

    expect(sim.redo().ok).toBe(true);
    expect(world.rides).toEqual([]);
    expect(world.finance.cash).toBe(cash + carousel.cost / 2);
    expect(hashWorld(world)).not.toBe(before);
  });

  it("cannot be undone when the park can no longer give the refund back", () => {
    const { world, sim } = setup();
    run(sim, "ride_build", { type: "carousel", x: 10, y: 10, rot: 0 });
    run(sim, "ride_demolish", { id: 1 });
    world.finance.cash = 100_00;
    const result = sim.undo();
    expect(result).toEqual({ ok: false, error: "Not enough cash: need $600.00, have $100.00" });
    expect(world.rides).toEqual([]);
    world.finance.cash = 600_00;
    expect(sim.undo().ok).toBe(true);
    expect(world.finance.cash).toBe(0);
    expect(rideOf(world, 1).name).toBe("Carousel 1");
  });

  it("undoing a build frees the id again, so a redo builds the same ride", () => {
    const { world, sim } = setup();
    const before = hashWorld(world);
    run(sim, "ride_build", { type: "carousel", x: 10, y: 10, rot: 0 });
    const ride = JSON.parse(JSON.stringify(rideOf(world, 1)));
    expect(sim.undo().ok).toBe(true);
    expect(world.rides).toEqual([]);
    expect(world.nextRideId).toBe(1);
    expect(occupiedTiles(world)).toEqual([]);
    expect(world.finance.cash).toBe(CASH);
    expect(sim.redo().ok).toBe(true);
    expect(world.rides).toEqual([ride]);
    expect(hashWorld(world)).not.toBe(before);
  });
});

describe("open, close, price and rename", () => {
  it("open and close flip the flag and undo puts it back", () => {
    const { world, sim } = setup();
    run(sim, "stall_build", { type: "drinks_stand", x: 10, y: 10, rot: 0 });
    run(sim, "ride_open", { id: 1 });
    expect(rideOf(world, 1).open).toBe(true);
    run(sim, "ride_close", { id: 1 });
    expect(rideOf(world, 1).open).toBe(false);
    expect(sim.undo().ok).toBe(true);
    expect(rideOf(world, 1).open).toBe(true);
    expect(sim.undo().ok).toBe(true);
    expect(rideOf(world, 1).open).toBe(false);
  });

  it("sets a price from 0 to $20.00 and undo puts the old one back", () => {
    const { world, sim } = setup();
    run(sim, "ride_build", { type: "swing_tower", x: 10, y: 10, rot: 0 });
    run(sim, "ride_set_price", { id: 1, cents: 0 });
    expect(rideOf(world, 1).price).toBe(0);
    run(sim, "ride_set_price", { id: 1, cents: 2000 });
    expect(rideOf(world, 1).price).toBe(2000);
    expect(refuse(sim, "ride_set_price", { id: 1, cents: 2001 })).toMatch(/cents/);
    expect(refuse(sim, "ride_set_price", { id: 1, cents: -1 })).toMatch(/cents/);
    expect(sim.undo().ok).toBe(true);
    expect(sim.undo().ok).toBe(true);
    expect(rideOf(world, 1).price).toBe(250);
  });

  it("renames to 1 to 40 characters and undo puts the old name back", () => {
    const { world, sim } = setup();
    run(sim, "ride_build", { type: "carousel", x: 10, y: 10, rot: 0 });
    run(sim, "ride_rename", { id: 1, name: "The Merry Go Round" });
    expect(rideOf(world, 1).name).toBe("The Merry Go Round");
    expect(refuse(sim, "ride_rename", { id: 1, name: "" })).toMatch(/name/);
    expect(refuse(sim, "ride_rename", { id: 1, name: "x".repeat(41) })).toMatch(/name/);
    expect(sim.undo().ok).toBe(true);
    expect(rideOf(world, 1).name).toBe("Carousel 1");
  });

  it("are free", () => {
    const { world, sim } = setup();
    run(sim, "ride_build", { type: "carousel", x: 10, y: 10, rot: 0 });
    const cash = world.finance.cash;
    for (const [name, input] of [
      ["ride_open", { id: 1 }],
      ["ride_close", { id: 1 }],
      ["ride_set_price", { id: 1, cents: 50 }],
      ["ride_rename", { id: 1, name: "Spin" }],
    ] as const) {
      expect(run(sim, name, input).cost).toBe(0);
    }
    expect(world.finance.cash).toBe(cash);
  });
});

describe("ride queries", () => {
  function builtPark() {
    const { world, sim } = setup();
    run(sim, "ride_build", { type: "carousel", x: 4, y: 4, rot: 0 });
    run(sim, "stall_build", { type: "snack_stand", x: 12, y: 4, rot: 1 });
    run(sim, "ride_open", { id: 1 });
    return { world, sim };
  }

  function query(sim: Sim, name: string, input: unknown): unknown {
    const out = sim.query(name, input);
    if (!out.ok) throw new Error(out.error);
    return out.result;
  }

  it("ride_list lists every ride and stall in id order", () => {
    const { sim } = builtPark();
    expect(query(sim, "ride_list", {})).toEqual([
      {
        id: 1,
        type: "carousel",
        kind: "ride",
        name: "Carousel 1",
        x: 4,
        y: 4,
        rot: 0,
        open: true,
        price: 100,
        queueLength: 0,
        riders: 0,
      },
      {
        id: 2,
        type: "snack_stand",
        kind: "stall",
        name: "Snack Stand 1",
        x: 12,
        y: 4,
        rot: 1,
        open: false,
        price: 150,
        queueLength: 0,
        riders: 0,
      },
    ]);
  });

  it("ride_get gives the whole record, the content type, and the tiles", () => {
    const { world, sim } = builtPark();
    const out = query(sim, "ride_get", { id: 1 }) as Record<string, unknown>;
    expect(out).toMatchObject({
      ...JSON.parse(JSON.stringify(rideOf(world, 1))),
      footprint: { x: 4, y: 4, w: 3, h: 3 },
      content: { id: "carousel", name: "Carousel", excitement: 420, cost: carousel.cost },
    });
    const stall = query(sim, "ride_get", { id: 2 }) as Record<string, unknown>;
    expect(stall).toMatchObject({ service: { x: 11, y: 4 }, entrance: null, exit: null });
    expect(sim.query("ride_get", { id: 9 })).toEqual({ ok: false, error: "No ride with id 9" });
    // The result is a copy.
    (out.riders as number[]).push(5);
    expect(rideOf(world, 1).riders).toEqual([]);
  });

  it("content_list lists the types, all or one kind", () => {
    const { sim } = setup();
    const all = query(sim, "content_list", {}) as Array<{ id: string; kind: string }>;
    expect(all.map((t) => t.id)).toEqual(
      [...RIDE_TYPES, ...STALL_TYPES, ...COASTER_FAMILIES].map((t) => t.id),
    );
    const families = query(sim, "content_list", { kind: "coaster" }) as Array<{ id: string }>;
    expect(families.map((t) => t.id)).toEqual(["steel_coaster", "wooden_coaster"]);
    const rides = query(sim, "content_list", { kind: "ride" }) as Array<{ id: string }>;
    expect(rides.map((t) => t.id)).toEqual(RIDE_TYPES.map((t) => t.id));
    const stalls = query(sim, "content_list", { kind: "stall" }) as Array<Record<string, unknown>>;
    expect(stalls.map((t) => t.id)).toEqual(STALL_TYPES.map((t) => t.id));
    expect(stalls[0]).toMatchObject({ name: "Snack Stand", category: "food", cost: snack.cost });
    expect(all[0]).toMatchObject({ footprint: { w: 3, h: 3 }, excitement: 420, intensity: 180 });
  });

  it("ride_check says whether a build would be taken, and why not, without changing anything", () => {
    const { world, sim } = builtPark();
    const before = hashWorld(world);
    // Free flat ground: taken, at the type's cost.
    expect(query(sim, "ride_check", { type: "carousel", x: 20, y: 20, rot: 0 })).toEqual({
      ok: true,
      reason: null,
      cost: carousel.cost,
    });
    // On the carousel already there: the same reason the build gives.
    const onTop = { type: "carousel", x: 5, y: 5, rot: 0 };
    const refused = query(sim, "ride_check", onTop) as { ok: boolean; reason: string };
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe(canPlaceRide(world, carousel, 5, 5, 0));
    expect(sim.execute("ride_build", onTop)).toEqual({ ok: false, error: refused.reason });
    // A stall type is checked as a stall; an unknown type is a reason, not an error.
    expect(query(sim, "ride_check", { type: "snack_stand", x: 20, y: 12, rot: 2 })).toMatchObject({
      ok: true,
      cost: snack.cost,
    });
    expect(query(sim, "ride_check", { type: "nope", x: 20, y: 12, rot: 0 })).toEqual({
      ok: false,
      reason: "Unknown ride type: nope",
      cost: 0,
    });
    // Without the cash: refused as the build would be.
    const cash = world.finance.cash;
    world.finance.cash = 5;
    const poor = query(sim, "ride_check", { type: "carousel", x: 20, y: 20, rot: 0 }) as {
      reason: string;
    };
    expect(poor.reason).toMatch(/^Not enough cash/);
    world.finance.cash = cash;
    expect(hashWorld(world)).toBe(before);
  });

  it("park_status counts rides and stalls", () => {
    const { sim } = builtPark();
    run(sim, "stall_build", { type: "restrooms", x: 20, y: 4, rot: 0 });
    expect(query(sim, "park_status", {})).toMatchObject({ rides: 1, stalls: 2 });
  });
});

describe("rides in a save", () => {
  it("round-trips rides, occupancy and the id counter", () => {
    const { world, sim } = setup();
    run(sim, "ride_build", { type: "big_wheel", x: 4, y: 4, rot: 1 });
    run(sim, "stall_build", { type: "restrooms", x: 12, y: 4, rot: 2 });
    run(sim, "ride_demolish", { id: 1 });
    run(sim, "ride_build", { type: "swing_tower", x: 20, y: 20, rot: 3 });
    run(sim, "ride_rename", { id: 3, name: "Héhé \u{1F3A2}" });
    const loaded = deserializeWorld(serializeWorld(world));
    expect(loaded.rides).toEqual(world.rides);
    expect(Array.from(loaded.terrain.occupant)).toEqual(Array.from(world.terrain.occupant));
    expect(loaded.nextRideId).toBe(4);
    expect(loaded.rideVersion).toBe(0);
    expect(hashWorld(loaded)).toBe(hashWorld(world));
    // And the loaded park can still undo back past the demolish.
    const again = new Sim(loaded);
    expect(again.undo().ok).toBe(true);
    expect(again.undo().ok).toBe(true);
    expect(again.undo().ok).toBe(true);
    expect(loaded.rides.map((r) => r.id)).toEqual([1, 2]);
    expect(validateWorldInvariants(loaded)).toBeNull();
  });

  it("hashes rides, occupancy and the id counter, but not rideVersion", () => {
    const { world, sim } = setup();
    run(sim, "ride_build", { type: "carousel", x: 4, y: 4, rot: 0 });
    const base = hashWorld(world);
    world.rideVersion += 5;
    expect(hashWorld(world)).toBe(base);
    for (const change of [
      (w: World) => void (w.nextRideId += 1),
      (w: World) => void (w.terrain.occupant[0] = 1),
      (w: World) => void ((w.rides[0] as RideRecord).price += 1),
      (w: World) => void (w.rides[0] as RideRecord).queue.push(3),
      (w: World) => void ((w.rides[0] as RideRecord).stats.income += 1),
    ]) {
      const copy = deserializeWorld(serializeWorld(world));
      change(copy);
      expect(hashWorld(copy)).not.toBe(base);
    }
  });
});

describe("ride invariants", () => {
  const VIOLATIONS: Array<[string, (world: World) => void, RegExp]> = [
    ["a tile marked for no ride", (w) => void (w.terrain.occupant[0] = 9), /occupant/],
    [
      "a footprint tile left unmarked",
      (w) => void (w.terrain.occupant[4 * 32 + 4] = 0),
      /occupant/,
    ],
    [
      "a footprint tile marked for another ride",
      (w) => void (w.terrain.occupant[4 * 32 + 4] = 2),
      /occupant/,
    ],
    ["a duplicate id", (w) => void ((w.rides[1] as RideRecord).id = 1), /ride id/],
    ["ids out of order", (w) => void w.rides.reverse(), /ride id/],
    ["an id not below nextRideId", (w) => void (w.nextRideId = 2), /nextRideId/],
    ["an unknown type", (w) => void ((w.rides[0] as RideRecord).type = "teacups"), /type/],
    [
      "a kind that does not match the type",
      (w) => void ((w.rides[0] as RideRecord).kind = "stall"),
      /kind/,
    ],
    ["a price over $20.00", (w) => void ((w.rides[0] as RideRecord).price = 2001), /price/],
    [
      "a moved entrance",
      (w) => void ((w.rides[0] as RideRecord).entrance = { x: 1, y: 1 }),
      /entrance/,
    ],
    ["a phase out of range", (w) => void ((w.rides[0] as RideRecord).phase = 4), /phase/],
  ];

  function twoRides(): World {
    const { world, sim } = setup();
    run(sim, "ride_build", { type: "carousel", x: 4, y: 4, rot: 0 });
    run(sim, "stall_build", { type: "snack_stand", x: 12, y: 4, rot: 0 });
    return world;
  }

  it("accepts a park with rides", () => {
    expect(validateWorldInvariants(twoRides())).toBeNull();
  });

  it.each(VIOLATIONS)("catches %s", (_label, damage, message) => {
    const world = twoRides();
    damage(world);
    expect(validateWorldInvariants(world)).toMatch(message);
  });
});
