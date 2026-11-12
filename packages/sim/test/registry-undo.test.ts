import { describe, expect, it } from "vitest";
import {
  buildTrackIndex,
  createDefaultRegistry,
  createWorld,
  executeCommand,
  hashWorld,
  type CommandDef,
  type TrackIndex,
  type World,
} from "../src/index.js";
import { typeById } from "@coasterworks/content";
import { addRide, newRide } from "../src/rides/rides.js";
import { takeLoan } from "../src/systems/finance.js";

/**
 * An input for a command that validates on a fresh 16x16 world, plus any state the command needs
 * that a fresh world lacks (a loan to repay, hills to lower, bumps to smooth). `setup` changes the
 * world directly, before the test takes its hash.
 */
interface Fixture {
  input: unknown;
  setup?: (world: World) => void;
}

const AREA = { x: 2, y: 2, w: 3, h: 3 };

/** Lifts one corner inside `AREA`, so smoothing and lowering have something to change. */
function addBump(world: World): void {
  world.terrain.corners[3 * (world.terrain.width + 1) + 3] = 14;
}

/** Puts the park entrance on the north edge, which `park_open` needs. */
function placeEntrance(world: World): void {
  world.park.entrance = { x: 5, y: 0, side: 0 };
}

/** Puts a ride of `typeId` at (x, y) straight into the world, as `ride_build` would. */
function placeRide(
  world: World,
  typeId: string,
  x: number,
  y: number,
  rot: 0 | 1 | 2 | 3 = 0,
): void {
  const type = typeById(typeId);
  if (type === undefined) throw new Error(`no type ${typeId}`);
  addRide(world, newRide(world, world.nextRideId++, type, x, y, rot));
}

/** A carousel (id 1) and an open snack stand (id 2), for the commands that act on a ride. */
function twoRides(world: World): void {
  placeRide(world, "carousel", 2, 2, 1);
  placeRide(world, "snack_stand", 8, 8, 3);
  (world.rides[1] as { open: boolean }).open = true;
}

/**
 * A steel coaster (id 3, after `twoRides`) begun at (11, 11) facing east, with `pieces` added: run
 * through the commands, as a player would build it.
 */
function placeCoaster(world: World, pieces: readonly string[]): void {
  twoRides(world);
  const registry = createDefaultRegistry();
  const run = (name: string, input: unknown) => {
    const result = executeCommand(world, registry, name, input, "player");
    if (!result.ok) throw new Error(`${name}: ${result.error}`);
  };
  run("coaster_begin", { family: "steel_coaster", x: 11, y: 11, dir: 1 });
  for (const piece of pieces) run("coaster_add_piece", { id: 3, piece });
}

/** A flat circuit from (11, 11): two stations, a small U-turn, two straights, a small U-turn. */
const SMALL_CIRCUIT = [
  "station",
  "right_small_curve",
  "right_small_curve",
  "straight",
  "straight",
  "right_small_curve",
  "right_small_curve",
];

function indexData(index: TrackIndex | undefined): unknown {
  return index === undefined ? null : [...index.tiles.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * One entry for every command in the default registry. Adding a command without adding it here
 * fails "has a fixture for every registered command", so a new undoable command cannot skip the
 * apply-then-revert check below.
 */
const FIXTURES: Record<string, Fixture> = {
  terrain_raise: { input: { ...AREA, steps: 2 } },
  terrain_lower: { input: { ...AREA, steps: 2 } },
  terrain_level: { input: { ...AREA, height: 5 } },
  terrain_smooth: { input: AREA, setup: addBump },
  terrain_set_surface: { input: { ...AREA, surface: 3 } },
  // Water has to be higher than the lowest corner of every tile; a fresh world is flat at 8.
  terrain_set_water: { input: { ...AREA, level: 12 } },
  path_build: { input: { ...AREA, kind: "foot" } },
  // A path to remove, so there is something to restore.
  path_remove: { input: AREA, setup: (world) => void (world.terrain.path[3 * 16 + 3] = 2) },
  // A stroke that turns a queue into a footpath, lists a tile twice, and lays two new tiles.
  path_build_tiles: {
    input: {
      tiles: [
        { x: 3, y: 3 },
        { x: 4, y: 3 },
        { x: 3, y: 3 },
        { x: 4, y: 4 },
      ],
      kind: "foot",
    },
    setup: (world) => void (world.terrain.path[3 * 16 + 3] = 2),
  },
  path_remove_tiles: {
    input: {
      tiles: [
        { x: 3, y: 3 },
        { x: 3, y: 3 },
        { x: 5, y: 5 },
      ],
    },
    setup: (world) => void (world.terrain.path[3 * 16 + 3] = 2),
  },
  // A queue under the entrance tile, which the entrance replaces and an undo has to bring back.
  park_set_entrance: { input: { x: 5, y: 0 }, setup: (world) => void (world.terrain.path[5] = 2) },
  park_set_entry_fee: { input: { cents: 5_00 } },
  park_open: { input: {}, setup: placeEntrance },
  park_close: {
    input: {},
    setup: (world) => {
      placeEntrance(world);
      world.park.open = true;
    },
  },
  park_rename: { input: { name: "Renamed Park" } },
  // Next to an existing ride, so the id counter and the sorted list both have to come back.
  ride_build: { input: { type: "big_wheel", x: 8, y: 3, rot: 1 }, setup: twoRides },
  stall_build: { input: { type: "restrooms", x: 12, y: 12, rot: 2 }, setup: twoRides },
  // The first of two, with a price, a name and stats of its own that the revert must restore.
  ride_demolish: {
    input: { id: 1 },
    setup: (world) => {
      twoRides(world);
      const ride = world.rides[0] as { price: number; name: string; stats: { income: number } };
      ride.price = 375;
      ride.name = "Spinny";
      ride.stats.income = 12_345;
    },
  },
  ride_open: { input: { id: 1 }, setup: twoRides },
  ride_close: { input: { id: 2 }, setup: twoRides },
  ride_set_price: { input: { id: 2, cents: 1_999 }, setup: twoRides },
  ride_rename: { input: { id: 1, name: "Whirligig" }, setup: twoRides },
  // Beside two rides, so the ride id counter and the sorted lists have to come back.
  coaster_begin: { input: { family: "steel_coaster", x: 11, y: 11, dir: 1 }, setup: twoRides },
  coaster_add_piece: {
    input: { id: 3, piece: "right_small_curve" },
    setup: (world) => placeCoaster(world, ["station"]),
  },
  // Removes the last piece of a complete circuit, which must come back complete.
  coaster_remove_piece: {
    input: { id: 3 },
    setup: (world) => {
      placeCoaster(world, SMALL_CIRCUIT);
      (world.tracks[0] as { complete: boolean }).complete = true;
    },
  },
  coaster_complete: { input: { id: 3 }, setup: (world) => placeCoaster(world, SMALL_CIRCUIT) },
  // A complete circuit, whose test run starts: the train leaves and the coaster shows TESTING.
  ride_test: {
    input: { id: 3 },
    setup: (world) => {
      placeCoaster(world, SMALL_CIRCUIT);
      (world.tracks[0] as { complete: boolean }).complete = true;
    },
  },
  // A station by two rides, so the ride id counter and the sorted lists have to come back.
  coaster_build_from_points: {
    input: {
      family: "steel_coaster",
      points: [
        { x: 11, y: 4 },
        { x: 13, y: 5 },
      ],
    },
    setup: twoRides,
  },
  coaster_extend_to: {
    input: { id: 3, point: { x: 13, y: 12 } },
    setup: (world) => placeCoaster(world, ["station"]),
  },
  sim_advance: { input: { days: 5 } },
  finance_take_loan: { input: { amount: 20_000_00 } },
  finance_repay_loan: { input: { amount: 10_00 }, setup: (world) => takeLoan(world, 20_000_00) },
};

const defs = createDefaultRegistry().commands();
const names = defs.map((def) => def.name);
const undoableNames = defs.filter((def) => def.undoable).map((def) => def.name);

function defOf(name: string): CommandDef {
  const def = defs.find((candidate) => candidate.name === name);
  if (def === undefined) throw new Error(`${name} is not registered`);
  return def;
}

function freshWorld(): World {
  return createWorld({ width: 16, height: 16, seed: 1, name: "Undo", cash: 1_000_000 });
}

function fixtureFor(name: string): Fixture {
  const fixture = FIXTURES[name];
  if (fixture === undefined) {
    throw new Error(`No fixture for command ${name}: add one to FIXTURES in registry-undo.test.ts`);
  }
  return fixture;
}

describe("registry-wide undo", () => {
  it("has a fixture for every registered command, and none for a command that is gone", () => {
    expect(
      names.filter((name) => !(name in FIXTURES)),
      "commands without a fixture in registry-undo.test.ts",
    ).toEqual([]);
    expect(
      Object.keys(FIXTURES).filter((name) => !names.includes(name)),
      "fixtures for commands that are not registered",
    ).toEqual([]);
  });

  it.each(names)("%s is undoable unless it is sim_* or save_*", (name) => {
    expect(defOf(name).undoable === true || /^(sim|save)_/.test(name), name).toBe(true);
  });

  it.each(names)("%s has a fixture that validates on a fresh world", (name) => {
    const def = defOf(name);
    const fixture = fixtureFor(name);
    const world = freshWorld();
    fixture.setup?.(world);
    expect(def.validate(world, def.input.parse(fixture.input))).toBeNull();
  });

  it.each(undoableNames)("%s reverts to the same world hash, through JSON undo data", (name) => {
    const def = defOf(name);
    const fixture = fixtureFor(name);
    const world = freshWorld();
    fixture.setup?.(world);
    const input = def.input.parse(fixture.input);
    expect(def.validate(world, input)).toBeNull();

    const before = hashWorld(world);
    const undo = def.apply(world, input);
    // The fixture has to make the command do something, or reverting it proves nothing.
    expect(hashWorld(world), "apply changed nothing; make the fixture do something").not.toBe(
      before,
    );

    // The log keeps undo data as JSON, so a save and load must not change what revert sees.
    const stored = undo === undefined ? undefined : JSON.parse(JSON.stringify(undo));
    def.revert(world, input, stored);
    expect(hashWorld(world)).toBe(before);
    // The track index is not hashed: it must match one rebuilt from the tracks.
    if (world.trackIndex !== undefined) {
      expect(indexData(world.trackIndex)).toEqual(indexData(buildTrackIndex(world)));
    }
  });
});
