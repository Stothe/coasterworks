import { describe, expect, it } from "vitest";
import {
  FIX_EARLIER,
  Sim,
  TOO_STEEP,
  TOO_TIGHT,
  buildTrackIndex,
  circuitCloses,
  createDefaultRegistry,
  createWorld,
  hashWorld,
  type TrackIndex,
  type TrackRecord,
  type World,
} from "../src/index.js";
import { ALREADY_REACHED, STATION_ON_GROUND } from "../src/commands/coaster.js";
import { validateWorldInvariants } from "../src/save/invariants.js";
import {
  TRACK_LOW_OVER_PATH,
  TRACK_OVER_WATER,
  TRACK_UNDERGROUND,
} from "../src/track/occupancy.js";

/** A flat park at height 8 with plenty of cash. */
function makeSim(size = 32, cash = 100_000_000): Sim {
  return new Sim(createWorld({ width: size, height: size, seed: 1, name: "Fit", cash }));
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

interface Preview {
  pieces: string[];
  points: { ok: boolean; reason: string | null; pieces: number }[];
  close: { ok: boolean; reason: string | null; pieces: number } | null;
  ok: boolean;
  error: string | null;
  cost: number;
  begin: { x: number; y: number; dir: number } | null;
}

function preview(sim: Sim, input: unknown): Preview {
  const out = sim.query("coaster_fit_preview", input);
  if (!out.ok) throw new Error(out.error);
  return out.result as Preview;
}

function indexData(index: TrackIndex | undefined): unknown {
  if (index === undefined) return null;
  return structuredClone([...index.tiles.entries()].sort((a, b) => a[0] - b[0]));
}

/** The built state of a park, without its log: what two ways of building it must agree on. */
function built(world: World): unknown {
  return structuredClone({
    rides: world.rides,
    tracks: world.tracks,
    nextRideId: world.nextRideId,
    cash: world.finance.cash,
    occupant: [...world.terrain.occupant],
    index: indexData(world.trackIndex ?? buildTrackIndex(world)),
  });
}

/** Four corners of a rectangle: the station at (6, 6), then clockwise. */
const RECTANGLE = [
  { x: 6, y: 6 },
  { x: 20, y: 6 },
  { x: 20, y: 18 },
  { x: 6, y: 18 },
];

/** A 20-point course round a 64 by 64 park, climbing and dropping on the way. */
const COURSE = [
  [8, 8],
  [16, 8],
  [24, 8, 14],
  [32, 8, 18],
  [40, 8, 18],
  [48, 8, 12],
  [56, 8],
  [56, 16],
  [56, 24, 12],
  [56, 32, 16],
  [56, 40],
  [56, 48],
  [48, 56],
  [40, 56, 10],
  [32, 56, 14],
  [24, 56],
  [16, 56],
  [8, 48],
  [8, 32],
  [8, 20],
].map(([x, y, height]) => (height === undefined ? { x, y } : { x, y, height }));

/** Builds `pieces` (station first) piece by piece from `begin`, as a player would. */
function replay(
  sim: Sim,
  family: string,
  begin: Preview["begin"],
  pieces: string[],
  close: boolean,
) {
  ok(sim, "coaster_begin", { family, ...begin });
  const id = sim.world.rides[sim.world.rides.length - 1]!.id;
  for (const piece of pieces.slice(1)) {
    const options = sim.query("coaster_piece_options", { id });
    if (!options.ok) throw new Error(options.error);
    const option = (options.result as { piece: string; ok: boolean; reason: string | null }[]).find(
      (o) => o.piece === piece,
    );
    expect(option, piece).toMatchObject({ ok: true, reason: null });
    ok(sim, "coaster_add_piece", { id, piece });
  }
  if (close) ok(sim, "coaster_complete", { id });
}

describe("fitting track through points", () => {
  it("fits a four-point rectangle, closes it and completes the circuit", () => {
    const sim = makeSim();
    const cash = sim.world.finance.cash;
    const plan = preview(sim, { family: "steel_coaster", points: RECTANGLE, close: true });
    expect(plan.ok).toBe(true);
    expect(plan.error).toBeNull();
    expect(plan.points.every((p) => p.ok)).toBe(true);
    expect(plan.close).toMatchObject({ ok: true, reason: null });
    expect(plan.begin).toEqual({ x: 6, y: 6, dir: 1 });
    expect(plan.pieces.slice(0, 2)).toEqual(["station", "station"]);
    // Four right turns and nothing to climb: a flat circuit.
    expect(plan.pieces.filter((p) => p.endsWith("curve")).length).toBeGreaterThanOrEqual(4);

    const cost = ok(sim, "coaster_build_from_points", {
      family: "steel_coaster",
      points: RECTANGLE,
      close: true,
    });
    expect(cost).toBe(plan.cost);
    expect(sim.world.finance.cash).toBe(cash - plan.cost);
    const track = sim.world.tracks[0] as TrackRecord;
    expect(track).toMatchObject({ id: 1, family: "steel_coaster", complete: true, tested: false });
    expect(track.pieces).toEqual(plan.pieces);
    expect(circuitCloses(track.start, track.pieces)).toBe(true);
    expect(sim.world.rides[0]).toMatchObject({ kind: "coaster", x: 6, y: 6, rot: 1 });
    expect(indexData(sim.world.trackIndex)).toEqual(indexData(buildTrackIndex(sim.world)));
    expect(validateWorldInvariants(sim.world)).toBeNull();
  });

  it("passes over every point it reports reached, at that point's height", () => {
    const sim = makeSim(64);
    const plan = preview(sim, { family: "steel_coaster", points: COURSE, close: true });
    expect(plan.ok, plan.error ?? "").toBe(true);
    ok(sim, "coaster_build_from_points", { family: "steel_coaster", points: COURSE, close: true });
    const got = sim.query("coaster_get", { id: 1 });
    if (!got.ok) throw new Error(got.error);
    const { poses } = got.result as { poses: { z: number }[] };
    expect(poses).toHaveLength(plan.pieces.length + 1);
    // The climbs before the first drop are a lift hill, so the circuit can complete.
    expect(plan.pieces.some((p) => p.endsWith("_lift"))).toBe(true);
    expect(sim.world.tracks[0]!.complete).toBe(true);
    expect(validateWorldInvariants(sim.world)).toBeNull();
  });

  it("refuses a point too high to climb in the room given", () => {
    const sim = makeSim();
    const points = [
      { x: 6, y: 6 },
      { x: 12, y: 6, height: 40 },
      { x: 20, y: 6 },
    ];
    const plan = preview(sim, { family: "steel_coaster", points });
    expect(plan.points[1]).toMatchObject({ ok: false, reason: TOO_STEEP });
    expect(plan.points[2]).toMatchObject({ ok: false, reason: FIX_EARLIER });
    expect(plan.error).toBe(`Point 1: ${TOO_STEEP}`);
    expect(refused(sim, "coaster_build_from_points", { family: "steel_coaster", points })).toBe(
      `Point 1: ${TOO_STEEP}`,
    );
    // Given more room, the same climb fits.
    const far = [
      { x: 4, y: 6 },
      { x: 24, y: 6, height: 40 },
    ];
    expect(preview(sim, { family: "steel_coaster", points: far }).ok).toBe(true);
  });

  it("refuses a point behind the track as too tight a turn", () => {
    const sim = makeSim();
    ok(sim, "coaster_build_from_points", {
      family: "steel_coaster",
      points: [
        { x: 10, y: 6 },
        { x: 14, y: 6 },
      ],
    });
    const behind = { x: 9, y: 7 };
    const plan = preview(sim, { id: 1, points: [behind] });
    expect(plan.points[0]).toMatchObject({ ok: false, reason: TOO_TIGHT });
    expect(refused(sim, "coaster_extend_to", { id: 1, point: behind })).toBe(
      `Point 0: ${TOO_TIGHT}`,
    );
  });

  it("lays exactly what the piece commands accept one by one", () => {
    for (const [size, family, points, close] of [
      [32, "steel_coaster", RECTANGLE, true],
      [32, "wooden_coaster", RECTANGLE, true],
      [64, "steel_coaster", COURSE, true],
      [64, "steel_coaster", COURSE.slice(0, 9), false],
    ] as const) {
      const fitted = makeSim(size);
      const plan = preview(fitted, { family, points, close });
      expect(plan.ok, `${family}: ${plan.error}`).toBe(true);
      ok(fitted, "coaster_build_from_points", { family, points, close });

      const byHand = makeSim(size);
      replay(byHand, family, plan.begin, plan.pieces, close);
      expect(built(byHand.world)).toEqual(built(fitted.world));
    }
  });

  it("fits the same way every time", () => {
    const a = makeSim(64);
    const b = makeSim(64);
    const input = { family: "steel_coaster", points: COURSE, close: true };
    const first = preview(a, input);
    expect(preview(a, input)).toEqual(first);
    expect(preview(b, input)).toEqual(first);
    ok(a, "coaster_build_from_points", input);
    ok(b, "coaster_build_from_points", input);
    expect(hashWorld(a.world)).toBe(hashWorld(b.world));
  });

  it("fits a 20-point course in under 50 ms", () => {
    const sim = makeSim(64);
    const input = { family: "steel_coaster", points: COURSE, close: true };
    const started = performance.now();
    const plan = preview(sim, input);
    const took = performance.now() - started;
    expect(plan.ok).toBe(true);
    expect(plan.pieces.length).toBeGreaterThan(100);
    expect(took, `${took.toFixed(1)} ms`).toBeLessThan(50);
  });

  it("never changes the world when previewing", () => {
    const sim = makeSim(64);
    ok(sim, "coaster_build_from_points", { family: "steel_coaster", points: COURSE.slice(0, 5) });
    const before = hashWorld(sim.world);
    const index = indexData(sim.world.trackIndex);
    preview(sim, { family: "steel_coaster", points: COURSE.slice(10), close: true });
    preview(sim, { id: 1, points: COURSE.slice(5, 9) });
    preview(sim, { family: "steel_coaster", points: [{ x: 30, y: 30, height: 2 }] });
    expect(hashWorld(sim.world)).toBe(before);
    expect(indexData(sim.world.trackIndex)).toEqual(index);
  });

  it("asks for either a family or an id", () => {
    const sim = makeSim();
    expect(sim.query("coaster_fit_preview", { points: RECTANGLE })).toMatchObject({ ok: false });
    expect(
      sim.query("coaster_fit_preview", { family: "steel_coaster", id: 1, points: RECTANGLE }),
    ).toMatchObject({ ok: false });
  });
});

describe("building from points", () => {
  it("undoes the whole coaster with its cash, and redoes it identically", () => {
    const input = { family: "steel_coaster", points: RECTANGLE, close: true };
    const once = makeSim();
    ok(once, "coaster_build_from_points", input);

    const sim = makeSim();
    const empty = built(sim.world);
    const cash = sim.world.finance.cash;
    ok(sim, "coaster_build_from_points", input);
    expect(sim.undo().ok).toBe(true);
    expect(sim.world.finance.cash).toBe(cash);
    expect(built(sim.world)).toEqual(empty);
    expect(sim.world.tracks).toEqual([]);
    expect(sim.redo().ok).toBe(true);
    expect(built(sim.world)).toEqual(built(once.world));

    // Through the command itself, the hash comes back exactly.
    const def = createDefaultRegistry().command("coaster_build_from_points")!;
    const world = makeSim().world;
    const parsed = def.input.parse(input);
    const before = hashWorld(world);
    const undo = def.apply(world, parsed);
    const after = hashWorld(world);
    def.revert(world, parsed, JSON.parse(JSON.stringify(undo)));
    expect(hashWorld(world)).toBe(before);
    def.apply(world, parsed);
    expect(hashWorld(world)).toBe(after);
  });

  it("builds nothing when any point fails, and names the first failing point", () => {
    const sim = makeSim();
    const before = hashWorld(sim.world);
    const points = [...RECTANGLE, { x: 6, y: 12, height: 60 }, { x: 10, y: 10 }];
    expect(
      refused(sim, "coaster_build_from_points", { family: "steel_coaster", points, close: true }),
    ).toBe(`Point 4: ${TOO_STEEP}`);
    expect(hashWorld(sim.world)).toBe(before);
    expect(sim.world.rides).toEqual([]);
    expect(sim.world.tracks).toEqual([]);
  });

  it("checks the cost against the park's cash before building", () => {
    const rich = makeSim();
    const plan = preview(rich, { family: "steel_coaster", points: RECTANGLE, close: true });
    const poor = makeSim(32, plan.cost - 1);
    expect(
      refused(poor, "coaster_build_from_points", {
        family: "steel_coaster",
        points: RECTANGLE,
        close: true,
      }),
    ).toMatch(/^Not enough cash/);
    expect(poor.world.rides).toEqual([]);
  });

  it("puts the station on the ground at the first point", () => {
    const sim = makeSim();
    expect(
      refused(sim, "coaster_build_from_points", {
        family: "steel_coaster",
        points: [
          { x: 6, y: 6, height: 12 },
          { x: 20, y: 6 },
        ],
      }),
    ).toBe(`Point 0: ${STATION_ON_GROUND}`);
    expect(
      refused(sim, "coaster_build_from_points", { family: "no_such", points: RECTANGLE }),
    ).toBe("Unknown coaster family: no_such");
  });

  it("extends an open-ended coaster to a point, undoably", () => {
    const sim = makeSim();
    ok(sim, "coaster_build_from_points", {
      family: "steel_coaster",
      points: [
        { x: 6, y: 6 },
        { x: 12, y: 6 },
      ],
    });
    const track = sim.world.tracks[0] as TrackRecord;
    const pieces = [...track.pieces];
    const state = built(sim.world);
    const cash = sim.world.finance.cash;
    const plan = preview(sim, { id: 1, points: [{ x: 18, y: 12, height: 10 }] });
    expect(plan.ok).toBe(true);
    const cost = ok(sim, "coaster_extend_to", { id: 1, point: { x: 18, y: 12, height: 10 } });
    expect(cost).toBe(plan.cost);
    expect(track.pieces).toEqual([...pieces, ...plan.pieces]);
    expect(sim.world.finance.cash).toBe(cash - cost);
    expect(indexData(sim.world.trackIndex)).toEqual(indexData(buildTrackIndex(sim.world)));
    expect(refused(sim, "coaster_extend_to", { id: 1, point: { x: 18, y: 12, height: 10 } })).toBe(
      ALREADY_REACHED,
    );
    expect(sim.undo().ok).toBe(true);
    expect(built(sim.world)).toEqual(state);
    expect(sim.redo().ok).toBe(true);
    expect(track.pieces).toEqual([...pieces, ...plan.pieces]);
  });

  it("reports what is in the way of a point", () => {
    const sim = makeSim();
    ok(sim, "path_build", { x: 14, y: 6, w: 1, h: 1, kind: "foot" });
    ok(sim, "terrain_raise", { x: 14, y: 10, w: 1, h: 1, steps: 4 });
    ok(sim, "terrain_set_water", { x: 14, y: 14, w: 1, h: 1, level: 9 });
    const at = (x: number, y: number, height?: number) =>
      preview(sim, {
        family: "steel_coaster",
        points: [{ x: 6, y: 6 }, height === undefined ? { x, y } : { x, y, height }],
      }).points[1];
    expect(at(14, 6)).toMatchObject({ ok: false, reason: TRACK_LOW_OVER_PATH });
    expect(at(14, 10, 8)).toMatchObject({ ok: false, reason: TRACK_UNDERGROUND });
    expect(at(14, 14)).toMatchObject({ ok: false, reason: TRACK_OVER_WATER });

    // A river right across the park cannot be crossed at any height.
    const river = makeSim();
    ok(river, "terrain_set_water", { x: 1, y: 12, w: 30, h: 2, level: 9 });
    const plan = preview(river, {
      family: "steel_coaster",
      points: [
        { x: 6, y: 6 },
        { x: 12, y: 20 },
      ],
    });
    expect(plan.points[1]).toMatchObject({ ok: false, reason: TRACK_OVER_WATER });
  });
});
