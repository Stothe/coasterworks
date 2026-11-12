import { familyById, pieceById } from "@coasterworks/content";
import { describe, expect, it } from "vitest";
import {
  Sim,
  buildTrackIndex,
  createWorld,
  deserializeWorld,
  hashWorld,
  serializeWorld,
  type TrackIndex,
  type World,
} from "../src/index.js";
import {
  ALREADY_COMPLETE,
  COMPLETE_FIRST,
  KEEP_FIRST_STATION,
  NOT_CLOSED,
  NO_LIFT,
  RUN_A_TEST,
  STATION_LENGTH,
} from "../src/commands/coaster.js";
import { canPlaceRide } from "../src/rides/rides.js";
import { validateWorldInvariants } from "../src/save/invariants.js";
import {
  STATION_NOT_CONTIGUOUS,
  STATION_TOO_LONG,
  TRACK_ENTRANCE_IN_WAY,
  TRACK_HITS_ITSELF,
  TRACK_HITS_OTHER,
  TRACK_LOW_OVER_PATH,
  TRACK_OUTSIDE,
  TRACK_OVER_WATER,
  TRACK_RIDE_IN_WAY,
  TRACK_UNDERGROUND,
} from "../src/track/occupancy.js";
import { typeById } from "@coasterworks/content";

/** A flat 32 by 32 park at height 8 with plenty of cash. */
function makeSim(cash = 100_000_000): Sim {
  return new Sim(createWorld({ width: 32, height: 32, seed: 1, name: "Coasters", cash }));
}

function ok(sim: Sim, name: string, input: unknown): number {
  const result = sim.execute(name, input);
  if (!result.ok) throw new Error(`${name} ${JSON.stringify(input)}: ${result.error}`);
  return result.cost;
}

function refused(sim: Sim, name: string, input: unknown): string {
  const result = sim.execute(name, input);
  if (result.ok) throw new Error(`${name} ${JSON.stringify(input)} was taken`);
  return result.error;
}

function add(sim: Sim, pieces: readonly string[], id = 1): number {
  let cost = 0;
  for (const piece of pieces) cost += ok(sim, "coaster_add_piece", { id, piece });
  return cost;
}

/**
 * After `coaster_begin` at (8, 6) facing east: a second station, a two-piece lift up 2 steps,
 * a U-turn of two large curves, a drop of 2 steps, two straights and a second U-turn back to the
 * station. It covers x 5 to 14, y 6 to 11; its entrance is (8, 5) and its exit (8, 7).
 */
const OVAL_START = { x: 8, y: 6, dir: 1 };
const OVAL = [
  "station",
  "flat_to_gentle_up_lift",
  "gentle_up_to_flat_lift",
  "right_large_curve",
  "right_large_curve",
  "flat_to_gentle_down",
  "gentle_down_to_flat",
  "straight",
  "straight",
  "right_large_curve",
  "right_large_curve",
];

function begin(sim: Sim, at = OVAL_START, family = "steel_coaster"): number {
  return ok(sim, "coaster_begin", { family, ...at });
}

/** A built, complete oval as coaster 1. */
function oval(): Sim {
  const sim = makeSim();
  begin(sim);
  add(sim, OVAL);
  ok(sim, "coaster_complete", { id: 1 });
  return sim;
}

function costOf(family: string, pieces: readonly string[]): number {
  const f = familyById(family)!;
  return pieces.reduce((sum, id) => sum + f.pieceCost[pieceById(id)!.kind], 0);
}

/** An index as plain sorted data, to compare two exactly. */
function indexData(index: TrackIndex | undefined): unknown {
  if (index === undefined) return null;
  return structuredClone([...index.tiles.entries()].sort((a, b) => a[0] - b[0]));
}

function expectIndexRebuilt(world: World): void {
  expect(indexData(world.trackIndex)).toEqual(indexData(buildTrackIndex(world)));
}

function tile(world: World, x: number, y: number): number {
  return y * world.terrain.width + x;
}

function query<T>(sim: Sim, name: string, input: unknown): T {
  const out = sim.query(name, input);
  if (!out.ok) throw new Error(out.error);
  return out.result as T;
}

describe("building a coaster piece by piece", () => {
  it("builds a small oval with a lift, completes it, and charges the sum of its pieces", () => {
    const sim = makeSim();
    const cash = sim.world.finance.cash;
    let charged = begin(sim);
    charged += add(sim, OVAL);
    expect(ok(sim, "coaster_complete", { id: 1 })).toBe(0);
    const total = costOf("steel_coaster", ["station", ...OVAL]);
    expect(charged).toBe(total);
    expect(sim.world.finance.cash).toBe(cash - total);

    const ride = sim.world.rides[0]!;
    expect(ride).toMatchObject({
      id: 1,
      kind: "coaster",
      type: "steel_coaster",
      name: "Steel Coaster 1",
      open: false,
      x: 8,
      y: 6,
      rot: 1,
      entrance: { x: 8, y: 5 },
      exit: { x: 8, y: 7 },
      service: null,
    });
    expect(sim.world.tracks).toEqual([
      {
        id: 1,
        family: "steel_coaster",
        start: { x: 8 * 1024, y: 6 * 1024 + 512, z: 8 * 256, dir: 1, pitch: 0, bank: 0 },
        pieces: ["station", ...OVAL],
        complete: true,
        tested: false,
        stats: null,
      },
    ]);
    // Coasters leave the occupant layer alone.
    expect(sim.world.terrain.occupant.every((v) => v === 0)).toBe(true);
    expectIndexRebuilt(sim.world);
    expect(validateWorldInvariants(sim.world)).toBeNull();

    const got = query<{
      poses: unknown[];
      end: unknown;
      complete: boolean;
      tested: boolean;
      length: number;
      cost: number;
      canComplete: string | null;
    }>(sim, "coaster_get", { id: 1 });
    expect(got.poses).toHaveLength(OVAL.length + 2);
    expect(got.end).toEqual(sim.world.tracks[0]!.start);
    expect(got).toMatchObject({ complete: true, tested: false, cost: total, canComplete: null });
    expect(got.length).toBeGreaterThan(16 * 1024);
  });

  it("names coasters by family and number, and takes the wooden family's own prices", () => {
    const sim = makeSim();
    begin(sim);
    expect(begin(sim, { x: 20, y: 20, dir: 0 }, "wooden_coaster")).toBe(10_000);
    begin(sim, { x: 24, y: 4, dir: 2 });
    expect(sim.world.rides.map((r) => r.name)).toEqual([
      "Steel Coaster 1",
      "Wooden Coaster 1",
      "Steel Coaster 2",
    ]);
  });

  it("completes a flat circuit without a lift, but not one that climbs above its station", () => {
    const flat = makeSim();
    begin(flat);
    add(flat, [
      "station",
      "right_small_curve",
      "right_small_curve",
      "straight",
      "straight",
      "right_small_curve",
      "right_small_curve",
    ]);
    ok(flat, "coaster_complete", { id: 1 });

    const climbs = makeSim();
    begin(climbs);
    add(
      climbs,
      OVAL.map((p) => p.replace("_lift", "")),
    );
    expect(refused(climbs, "coaster_complete", { id: 1 })).toBe(NO_LIFT);
  });

  it("refuses to complete a track with a gap, a short station, or twice", () => {
    const sim = makeSim();
    begin(sim);
    add(sim, OVAL.slice(0, -1));
    expect(refused(sim, "coaster_complete", { id: 1 })).toBe(NOT_CLOSED);
    add(sim, OVAL.slice(-1));
    ok(sim, "coaster_complete", { id: 1 });
    expect(refused(sim, "coaster_complete", { id: 1 })).toBe(ALREADY_COMPLETE);
    expect(refused(sim, "coaster_add_piece", { id: 1, piece: "straight" })).toBe(ALREADY_COMPLETE);

    const short = makeSim();
    begin(short);
    add(short, ["straight", ...OVAL.slice(1)]);
    expect(refused(short, "coaster_complete", { id: 1 })).toBe(STATION_LENGTH);
  });

  it("refuses to open a coaster that is incomplete or untested", () => {
    const sim = makeSim();
    begin(sim);
    expect(refused(sim, "ride_open", { id: 1 })).toBe(COMPLETE_FIRST);
    add(sim, OVAL);
    ok(sim, "coaster_complete", { id: 1 });
    expect(refused(sim, "ride_open", { id: 1 })).toBe(RUN_A_TEST);
    // The other D2 ride commands work on a coaster.
    ok(sim, "ride_rename", { id: 1, name: "Big Dipper" });
    ok(sim, "ride_set_price", { id: 1, cents: 450 });
    ok(sim, "ride_close", { id: 1 });
    expect(sim.world.rides[0]).toMatchObject({ name: "Big Dipper", price: 450, open: false });
  });
});

describe("track placement rules", () => {
  it("refuses track into the terrain", () => {
    const sim = makeSim();
    begin(sim);
    // Raises the corners (11, 6) and (11, 7), which tile (10, 6) shares.
    ok(sim, "terrain_raise", { x: 11, y: 6, w: 1, h: 1, steps: 1 });
    ok(sim, "coaster_add_piece", { id: 1, piece: "station" });
    expect(refused(sim, "coaster_add_piece", { id: 1, piece: "straight" })).toBe(TRACK_UNDERGROUND);
  });

  it("refuses track over water", () => {
    const sim = makeSim();
    begin(sim);
    ok(sim, "terrain_set_water", { x: 9, y: 6, w: 1, h: 1, level: 9 });
    expect(refused(sim, "coaster_add_piece", { id: 1, piece: "station" })).toBe(TRACK_OVER_WATER);
  });

  it("refuses track low over a path, and lets a path pass under high track", () => {
    const sim = makeSim();
    ok(sim, "path_build", { x: 9, y: 6, w: 1, h: 1, kind: "foot" });
    begin(sim);
    expect(refused(sim, "coaster_add_piece", { id: 1, piece: "station" })).toBe(
      TRACK_LOW_OVER_PATH,
    );

    // Up 12 steps over five tiles, then high over a path laid before and one laid after.
    const high = makeSim();
    ok(high, "path_build", { x: 15, y: 6, w: 1, h: 1, kind: "foot" });
    begin(high);
    add(high, [
      "station",
      "flat_to_gentle_up_lift",
      "gentle_to_steep_up_lift",
      "steep_up_lift",
      "steep_to_gentle_up_lift",
      "gentle_up_to_flat_lift",
      "straight",
      "straight",
    ]);
    ok(high, "path_build", { x: 16, y: 6, w: 1, h: 1, kind: "foot" });
    // Not under the station, which sits on the ground.
    expect(refused(high, "path_build", { x: 9, y: 6, w: 1, h: 1, kind: "foot" })).toBe(
      "Something is already here",
    );
    expect(validateWorldInvariants(high.world)).toBeNull();
  });

  it("refuses track through a ride or stall, or its entrance, exit or service tile", () => {
    const sim = makeSim();
    ok(sim, "stall_build", { type: "snack_stand", x: 10, y: 6, rot: 0 });
    begin(sim);
    ok(sim, "coaster_add_piece", { id: 2, piece: "station" });
    expect(refused(sim, "coaster_add_piece", { id: 2, piece: "straight" })).toBe(TRACK_RIDE_IN_WAY);

    // The snack stand at (10, 7) serves from (10, 8), which track may not cross either.
    const access = makeSim();
    ok(access, "stall_build", { type: "snack_stand", x: 10, y: 7, rot: 0 });
    begin(access, { x: 8, y: 8, dir: 1 });
    ok(access, "coaster_add_piece", { id: 2, piece: "station" });
    expect(refused(access, "coaster_add_piece", { id: 2, piece: "straight" })).toBe(
      TRACK_ENTRANCE_IN_WAY,
    );
  });

  it("refuses track that runs into itself at a similar height", () => {
    const sim = makeSim();
    begin(sim, { x: 8, y: 8, dir: 1 });
    add(sim, [
      "station",
      "straight",
      "right_small_curve",
      "right_small_curve",
      "right_small_curve",
    ]);
    ok(sim, "coaster_add_piece", { id: 1, piece: "straight" });
    expect(refused(sim, "coaster_add_piece", { id: 1, piece: "straight" })).toBe(TRACK_HITS_ITSELF);
  });

  it("lets track cross over itself with enough clearance", () => {
    const sim = makeSim();
    begin(sim, { x: 8, y: 12, dir: 1 });
    add(sim, [
      "station",
      "flat_to_gentle_up_lift",
      "gentle_to_steep_up_lift",
      "steep_up_lift",
      "steep_to_gentle_up_lift",
      "gentle_up_to_flat_lift",
      "left_small_curve",
      "left_small_curve",
      "straight",
      "straight",
      "straight",
      "straight",
      "left_small_curve",
      "straight",
      "straight",
      "straight",
    ]);
    // The second station's tile, (9, 12), has the station at 8 and the track 12 steps above.
    const bands = sim.world.trackIndex!.tiles.get(tile(sim.world, 9, 12))!;
    expect(bands.map((b) => [b.piece, b.zLo / 256])).toEqual([
      [1, 8],
      [15, 20],
    ]);
    expect(validateWorldInvariants(sim.world)).toBeNull();
  });

  it("refuses track too close to another coaster's", () => {
    const sim = oval();
    begin(sim, { x: 10, y: 14, dir: 0 });
    ok(sim, "coaster_add_piece", { id: 2, piece: "station" });
    ok(sim, "coaster_add_piece", { id: 2, piece: "straight" });
    expect(refused(sim, "coaster_add_piece", { id: 2, piece: "straight" })).toBe(TRACK_HITS_OTHER);
  });

  it("refuses track on the map's outer ring", () => {
    const sim = makeSim();
    begin(sim, { x: 29, y: 6, dir: 1 });
    ok(sim, "coaster_add_piece", { id: 1, piece: "station" });
    expect(refused(sim, "coaster_add_piece", { id: 1, piece: "straight" })).toBe(TRACK_OUTSIDE);
    expect(refused(sim, "coaster_begin", { family: "steel_coaster", x: 0, y: 6, dir: 1 })).toBe(
      "Area is outside the park",
    );
  });

  it("refuses a piece the family does not have", () => {
    const sim = makeSim();
    begin(sim, OVAL_START, "wooden_coaster");
    expect(refused(sim, "coaster_add_piece", { id: 1, piece: "right_small_curve" })).toBe(
      "The Wooden Coaster cannot turn that tightly.",
    );
    expect(refused(sim, "coaster_add_piece", { id: 1, piece: "loop" })).toBe(
      "Unknown track piece: loop",
    );
  });

  it("refuses a piece whose entry does not match the end of the track", () => {
    const sim = makeSim();
    begin(sim);
    expect(refused(sim, "coaster_add_piece", { id: 1, piece: "gentle_up" })).toBe(
      "This piece starts gently up, but the track runs flat.",
    );
    ok(sim, "coaster_add_piece", { id: 1, piece: "bank_right_in" });
    expect(refused(sim, "coaster_add_piece", { id: 1, piece: "straight" })).toBe(
      "This piece starts banked level, but the track is banked gently right.",
    );
  });

  it("allows station pieces only as one run of at most 8 at the start", () => {
    const sim = makeSim();
    begin(sim);
    add(sim, ["station", "straight"]);
    expect(refused(sim, "coaster_add_piece", { id: 1, piece: "station" })).toBe(
      STATION_NOT_CONTIGUOUS,
    );
    const long = makeSim();
    begin(long, { x: 4, y: 6, dir: 1 });
    add(long, Array(7).fill("station"));
    expect(refused(long, "coaster_add_piece", { id: 1, piece: "station" })).toBe(STATION_TOO_LONG);
  });

  it("refuses a begin on sloped ground, an unknown family, or a blocked entrance", () => {
    const sim = makeSim();
    sim.world.terrain.corners[6 * 33 + 9] = 9;
    expect(refused(sim, "coaster_begin", { family: "steel_coaster", ...OVAL_START })).toBe(
      "Ground is not flat",
    );
    expect(refused(sim, "coaster_begin", { family: "mine_train", x: 20, y: 20, dir: 0 })).toBe(
      "Unknown coaster family: mine_train",
    );
    ok(sim, "stall_build", { type: "snack_stand", x: 20, y: 19, rot: 2 });
    // Facing east at (20, 20) the entrance would be (20, 19), the stall's tile.
    expect(refused(sim, "coaster_begin", { family: "steel_coaster", x: 20, y: 20, dir: 1 })).toBe(
      "Something is already here",
    );
  });

  it("lists every piece with whether it fits next, and why not", () => {
    const sim = makeSim();
    begin(sim, OVAL_START, "wooden_coaster");
    const options = query<
      Array<{ piece: string; ok: boolean; reason: string | null; cost: number }>
    >(sim, "coaster_piece_options", { id: 1 });
    const byPiece = new Map(options.map((o) => [o.piece, o]));
    expect(options).toHaveLength(query<unknown[]>(sim, "track_pieces_list", {}).length);
    expect(byPiece.get("straight")).toEqual({
      piece: "straight",
      ok: true,
      reason: null,
      cost: 5_000,
    });
    expect(byPiece.get("right_small_curve")?.reason).toBe(
      "The Wooden Coaster cannot turn that tightly.",
    );
    expect(byPiece.get("gentle_up")?.ok).toBe(false);
    for (const option of options) {
      const result = sim.execute("coaster_add_piece", { id: 1, piece: option.piece });
      expect(result.ok, option.piece).toBe(option.ok);
      if (result.ok) sim.undo();
      else expect(result.error).toBe(option.reason);
      expect(sim.world.tracks[0]!.pieces).toEqual(["station"]);
    }
  });
});

describe("other systems respect track", () => {
  it("keeps rides, stalls, terrain and water off track tiles and supports", () => {
    const sim = oval();
    const world = sim.world;
    // A snack stand on the straight at (10, 11) and one whose service tile is there.
    expect(canPlaceRide(world, typeById("snack_stand")!, 10, 11, 0)).toBe(
      "Something is already here",
    );
    expect(canPlaceRide(world, typeById("snack_stand")!, 10, 10, 0)).toBe(
      "Something is already here",
    );
    expect(refused(sim, "terrain_raise", { x: 10, y: 11, w: 1, h: 1, steps: 1 })).toBe(
      "A coaster's track stands here",
    );
    expect(refused(sim, "terrain_set_water", { x: 10, y: 11, w: 1, h: 1, level: 9 })).toBe(
      "Cannot flood a path, a ride or the park entrance",
    );
    // Inside the oval the ground is free.
    ok(sim, "terrain_raise", { x: 10, y: 8, w: 1, h: 1, steps: 1 });
  });
});

describe("removing, undoing and demolishing", () => {
  it("removes the last piece for half its cost, and undo restores the track and index exactly", () => {
    const sim = oval();
    const world = sim.world;
    const before = { track: structuredClone(world.tracks), index: indexData(world.trackIndex) };
    const cash = world.finance.cash;
    ok(sim, "coaster_remove_piece", { id: 1 });
    expect(world.finance.cash).toBe(cash + 7_000);
    expect(world.tracks[0]).toMatchObject({
      complete: false,
      pieces: ["station", ...OVAL.slice(0, -1)],
    });
    expectIndexRebuilt(world);
    expect(sim.undo().ok).toBe(true);
    expect(world.finance.cash).toBe(cash);
    expect(world.tracks).toEqual(before.track);
    expect(indexData(world.trackIndex)).toEqual(before.index);
    expect(sim.redo().ok).toBe(true);
    expectIndexRebuilt(world);

    // Undoing a removal needs the refund back.
    world.finance.cash = 6_999;
    expect(sim.undo()).toMatchObject({ ok: false });
    world.finance.cash = 7_000;
    expect(sim.undo().ok).toBe(true);
    expect(world.finance.cash).toBe(0);
  });

  it("keeps the first station piece, and undoes adds and begins exactly", () => {
    const sim = makeSim();
    begin(sim);
    expect(refused(sim, "coaster_remove_piece", { id: 1 })).toBe(KEEP_FIRST_STATION);
    add(sim, OVAL.slice(0, 4));
    for (let i = 0; i < 4; i++) {
      expect(sim.undo().ok).toBe(true);
      expectIndexRebuilt(sim.world);
    }
    expect(sim.undo().ok).toBe(true);
    expect(sim.world.tracks).toEqual([]);
    expect(sim.world.rides).toEqual([]);
    expect(sim.world.nextRideId).toBe(1);
    expect(indexData(sim.world.trackIndex)).toEqual([]);
  });

  it("demolishes a coaster with its track for half its cost, and undo puts it all back", () => {
    const sim = oval();
    const world = sim.world;
    const before = {
      rides: structuredClone(world.rides),
      tracks: structuredClone(world.tracks),
      index: indexData(world.trackIndex),
      cash: world.finance.cash,
    };
    ok(sim, "ride_demolish", { id: 1 });
    const total = costOf("steel_coaster", ["station", ...OVAL]);
    expect(world.finance.cash).toBe(before.cash + Math.floor(total / 2));
    expect(world.tracks).toEqual([]);
    expect(world.rides).toEqual([]);
    expect(indexData(world.trackIndex)).toEqual([]);
    // The ground is free again.
    ok(sim, "path_build", { x: 9, y: 6, w: 1, h: 1, kind: "foot" });
    expect(sim.undo().ok).toBe(true);
    expect(sim.undo().ok).toBe(true);
    expect(world.rides).toEqual(before.rides);
    expect(world.tracks).toEqual(before.tracks);
    expect(indexData(world.trackIndex)).toEqual(before.index);
    expect(world.finance.cash).toBe(before.cash);
    expect(validateWorldInvariants(world)).toBeNull();
  });
});

describe("saving coasters", () => {
  it("saves and loads tracks, and rebuilds the same index", () => {
    const sim = oval();
    begin(sim, { x: 20, y: 20, dir: 0 }, "wooden_coaster");
    add(sim, ["station", "straight"], 2);
    const loaded = deserializeWorld(serializeWorld(sim.world));
    expect(loaded.tracks).toEqual(sim.world.tracks);
    // Loading checked every track against an index it rebuilt, not one it was handed.
    expect(indexData(loaded.trackIndex)).toEqual(indexData(sim.world.trackIndex));
    expect(hashWorld(loaded)).toBe(hashWorld(sim.world));
    expect(indexData(buildTrackIndex(loaded))).toEqual(indexData(sim.world.trackIndex));
    // The loaded park builds on exactly as the saved one would.
    const twin = new Sim(loaded);
    for (const s of [sim, twin]) ok(s, "coaster_add_piece", { id: 2, piece: "straight" });
    expect(hashWorld(twin.world)).toBe(hashWorld(sim.world));
    expect(indexData(twin.world.trackIndex)).toEqual(indexData(sim.world.trackIndex));
  });

  it("hashes tracks", () => {
    const a = oval();
    const b = oval();
    expect(hashWorld(a.world)).toBe(hashWorld(b.world));
    b.world.tracks[0]!.complete = false;
    expect(hashWorld(b.world)).not.toBe(hashWorld(a.world));
  });

  it("refuses a save whose tracks break the rules", () => {
    const cases: Array<[string, (w: World) => void, RegExp]> = [
      ["a track with no coaster", (w) => w.rides.splice(0, 1), /tracks for/],
      ["a coaster with no track", (w) => w.tracks.splice(0, 1), /tracks for/],
      ["an unknown piece", (w) => (w.tracks[0]!.pieces[3] = "loop"), /unknown: loop/],
      [
        "a piece into the ground",
        (w) => (w.terrain.corners[6 * 33 + 11] = 12),
        /piece 2 .*into the ground/,
      ],
      [
        "a piece out of place",
        (w) => w.tracks[0]!.pieces.splice(4, 1),
        /does not fit|does not close/,
      ],
      ["a station moved", (w) => (w.tracks[0]!.start.x += 1024), /does not start on/],
      ["a complete track that does not close", (w) => w.tracks[0]!.pieces.pop(), /does not close/],
      [
        "a tested track not complete",
        (w) => {
          w.tracks[0]!.tested = true;
          w.tracks[0]!.complete = false;
        },
        /tested but not complete/,
      ],
      ["an open untested coaster", (w) => (w.rides[0]!.open = true), /not been tested/],
      ["a moved exit", (w) => (w.rides[0]!.exit = { x: 1, y: 1 }), /has exit/],
    ];
    for (const [label, damage, message] of cases) {
      const world = oval().world;
      damage(world);
      expect(validateWorldInvariants(world), label).toMatch(message);
    }
  });
});
