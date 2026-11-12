import { describe, expect, it } from "vitest";
import { familyById } from "@coasterworks/content";
import {
  FIX_EARLIER,
  Sim,
  TOO_LONG,
  TOO_STEEP,
  TOO_TIGHT,
  buildTrackIndex,
  circuitCloses,
  createDefaultRegistry,
  createWorld,
  fitPoints,
  hashWorld,
  poseAtTile,
  type FitPoint,
  type FitStart,
  type TrackIndex,
  type TrackRecord,
  type World,
} from "../src/index.js";
import { ALREADY_REACHED, STATION_ON_GROUND, assertPlanned } from "../src/commands/coaster.js";
import { validateWorldInvariants } from "../src/save/invariants.js";
import {
  TRACK_LOW_OVER_PATH,
  TRACK_OVER_WATER,
  TRACK_TOO_HIGH,
  TRACK_UNDERGROUND,
  reservedTiles,
  stationAccess,
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

  it("refuses a point behind the track as too tight a turn when there is no room to turn", () => {
    // This test used to rely on a precheck that refused every point behind the track without
    // searching, and on the open park (9, 7) is reachable by a loop round. Here the track runs
    // along a three-tile corridor between two rivers, rows 5 to 7, so it can never turn at all
    // (a curve needs two tiles to the side and a third to leave by): truly too tight.
    const sim = makeSim();
    ok(sim, "terrain_set_water", { x: 1, y: 4, w: 30, h: 1, level: 9 });
    ok(sim, "terrain_set_water", { x: 1, y: 8, w: 30, h: 1, level: 9 });
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

/** What `coaster_build_from_points` fits from for a steel coaster on (x, y) facing east. */
function stationStart(world: World, x: number, y: number): FitStart {
  const reserved = reservedTiles(world);
  const { entrance, exit } = stationAccess(x, y, 1);
  const width = world.terrain.width;
  reserved.add(entrance.y * width + entrance.x);
  reserved.add(exit.y * width + exit.x);
  return {
    rideId: world.nextRideId,
    family: familyById("steel_coaster")!,
    start: poseAtTile(x, y, 1, 8),
    pieces: ["station", "station"],
    laid: 0,
    reserved,
  };
}

/** A 64-point staircase (the most points a fit takes) across a 256 by 256 park. */
const STAIRCASE = Array.from({ length: 64 }, (_, i) => {
  const k = Math.floor(i / 2);
  const x = 8 + 7 * k + 7 * (i % 2);
  const y = 8 + 7 * k;
  return i === 0 ? { x, y } : { x, y, height: i % 2 === 1 ? 16 : 12 };
});

/** The staircase after its station point, as `fitPoints` takes points. */
const STAIRS: FitPoint[] = STAIRCASE.slice(1).map((p) => ({
  x: p.x,
  y: p.y,
  height: p.height ?? 8,
}));

/** A fit's result without its work counts, which depend on what was kept. */
function answer(fit: ReturnType<typeof fitPoints>): unknown {
  return { ...fit, work: null };
}

describe("fitting long and awkward courses", () => {
  it("reaches a far point with a climb that the leg cap used to refuse", () => {
    const sim = makeSim(256);
    const points = [
      { x: 8, y: 8 },
      { x: 68, y: 68, height: 15 },
    ];
    const plan = preview(sim, { family: "steel_coaster", points });
    expect(plan.ok, plan.error ?? "").toBe(true);
    ok(sim, "coaster_build_from_points", { family: "steel_coaster", points });
    expect(sim.world.tracks[0]!.pieces).toEqual(plan.pieces);
    expect(validateWorldInvariants(sim.world)).toBeNull();
  });

  it("takes the best leg found so far when a leg reaches its cap", () => {
    const world = makeSim(256).world;
    const from = stationStart(world, 8, 8);
    const target = [{ x: 68, y: 68, height: 15 }];
    const full = fitPoints(world, from, target, false);
    expect(full.ok).toBe(true);
    expect(full.work.capped).toBe(0);
    // 800 poses is fewer than proving the best leg takes, but a leg to the point is found by then.
    expect(full.work.searched).toBeGreaterThan(800);
    const capped = fitPoints(world, from, target, false, { legCap: 800 });
    expect(capped.ok).toBe(true);
    expect(capped.work).toMatchObject({ capped: 1, searched: 800 });
    // What it took is track the piece commands accept, and it passes over the point.
    const sim = makeSim(256);
    replay(sim, "steel_coaster", { x: 8, y: 8, dir: 1 }, [...from.pieces, ...capped.pieces], false);
    expect(preview(sim, { id: 1, points: target }).points[0]).toMatchObject({
      ok: true,
      reason: ALREADY_REACHED,
    });
  });

  /** Previews the staircase on one park and builds it on a fresh one; returns both times. */
  function timeStaircase(): { previewMs: number; buildMs: number } {
    const input = { family: "steel_coaster", points: STAIRCASE };
    const sim = makeSim(256);
    let started = performance.now();
    const plan = preview(sim, input);
    const previewMs = performance.now() - started;
    expect(plan.ok, plan.error ?? "").toBe(true);
    // A fresh park, so building cannot lean on the legs the preview kept: one fit, not three.
    const fresh = makeSim(256);
    started = performance.now();
    ok(fresh, "coaster_build_from_points", input);
    const buildMs = performance.now() - started;
    console.log(
      `64-point staircase: preview ${previewMs.toFixed(0)} ms, build ${buildMs.toFixed(0)} ms`,
    );
    expect(fresh.world.tracks[0]!.pieces).toEqual(plan.pieces);
    return { previewMs, buildMs };
  }

  // Every CI machine runs this one. Its bound only catches a fit gone badly wrong (the three
  // fits per build it replaced took about 0.8 s on a fast Mac); the work itself is bounded
  // exactly by MAX_FIT_EXPANSIONS, which the tests below check.
  it("previews and builds a 64-point staircase", () => {
    const { previewMs, buildMs } = timeStaircase();
    expect(previewMs + buildMs, `${(previewMs + buildMs).toFixed(1)} ms`).toBeLessThan(2_000);
  });

  // Run with PERF=1, as the guest benchmark is (CI runs both on one known kind of runner): a
  // timed bound is a benchmark, not something every machine can promise.
  it.skipIf(process.env["PERF"] !== "1")(
    "previews a 64-point staircase in under 150 ms and builds it in under 250 ms",
    () => {
      const { previewMs, buildMs } = timeStaircase();
      expect(previewMs, `${previewMs.toFixed(1)} ms`).toBeLessThan(150);
      expect(buildMs, `${buildMs.toFixed(1)} ms`).toBeLessThan(250);
    },
  );

  it("fits only the last leg again when only the last point moves, until the park changes", () => {
    const sim = makeSim(256);
    const world = sim.world;
    const from = stationStart(world, 8, 8);
    const first = fitPoints(world, from, STAIRS, false);
    expect(first.ok).toBe(true);
    const last = STAIRS[62]!;
    const moved = [...STAIRS.slice(0, 62), { ...last, x: last.x + 1 }];
    const again = fitPoints(world, from, moved, false);
    expect(again.work.searched).toBeLessThan(first.work.searched / 10);
    // The same answer, and the same work charged, as a fit with nothing kept.
    const fresh = fitPoints(makeSim(256).world, from, moved, false);
    expect(answer(again)).toEqual(answer(fresh));
    expect(again.work.charged).toBe(fresh.work.charged);
    // Any command drops what was kept; water across the track's way changes the answer.
    ok(sim, "path_build", { x: 200, y: 20, w: 1, h: 1, kind: "foot" });
    expect(fitPoints(world, from, moved, false).work.searched).toBe(fresh.work.searched);
    ok(sim, "terrain_set_water", { x: 1, y: 13, w: 254, h: 1, level: 9 });
    expect(fitPoints(world, from, moved, false).ok).toBe(false);
  });

  it("refuses a course too long to fit at once, the same whether legs were kept or not", () => {
    const world = makeSim(256).world;
    const from = stationStart(world, 8, 8);
    const full = fitPoints(world, from, STAIRS, false);
    expect(full.ok).toBe(true);
    const budget = Math.floor(full.work.charged / 2);
    const short = fitPoints(world, from, STAIRS, false, { budget });
    expect(short.ok).toBe(false);
    const at = short.points.findIndex((p) => !p.ok);
    expect(short.points[at]).toMatchObject({ ok: false, reason: TOO_LONG });
    expect(short.points.slice(at + 1).every((p) => p.reason === FIX_EARLIER)).toBe(true);
    expect(short.work.charged).toBeLessThanOrEqual(budget);
    const fresh = fitPoints(makeSim(256).world, from, STAIRS, false, { budget });
    expect(answer(short)).toEqual(answer(fresh));
  });

  it("reaches a point behind the track by a loop round when there is room", () => {
    const sim = makeSim();
    ok(sim, "coaster_begin", { family: "steel_coaster", x: 6, y: 10, dir: 1 });
    for (let i = 0; i < 6; i++) ok(sim, "coaster_add_piece", { id: 1, piece: "straight" });
    const before = [...sim.world.tracks[0]!.pieces];
    const point = { x: 10, y: 11 };
    const plan = preview(sim, { id: 1, points: [point] });
    expect(plan.points[0]).toMatchObject({ ok: true, reason: null });
    expect(plan.pieces.some((p) => p.endsWith("curve"))).toBe(true);
    ok(sim, "coaster_extend_to", { id: 1, point });
    expect(sim.world.tracks[0]!.pieces).toEqual([...before, ...plan.pieces]);
    expect(validateWorldInvariants(sim.world)).toBeNull();
    const byHand = makeSim();
    replay(byHand, "steel_coaster", { x: 6, y: 10, dir: 1 }, [...before, ...plan.pieces], false);
    expect(built(byHand.world)).toEqual(built(sim.world));
  });

  it("gives the closing leg the room from ahead of the station round to behind it", () => {
    // Station at (10, 10) facing east, a lift of 16 steps, a U-turn and straights back west: the
    // track ends over (13, 13), 16 steps up, facing west, ahead of the station along its axis.
    // To the tile behind the station that is 7 tiles of room, enough to drop 16 steps; it used
    // to be counted as 5 (to the station's own tile, less the one it ends on), refused as too
    // steep.
    const sim = makeSim();
    ok(sim, "coaster_begin", { family: "steel_coaster", x: 10, y: 10, dir: 1 });
    const climb = [
      "station",
      "flat_to_gentle_up_lift",
      "gentle_to_steep_up_lift",
      "steep_up_lift",
      "steep_up_lift",
      "steep_to_gentle_up_lift",
      "gentle_up_to_flat_lift",
      "right_small_curve",
      "right_small_curve",
      ...Array<string>(5).fill("straight"),
    ];
    for (const piece of climb) ok(sim, "coaster_add_piece", { id: 1, piece });
    const reached = { x: 13, y: 13, height: 24 };
    const plan = preview(sim, { id: 1, points: [reached], close: true });
    expect(plan.points[0]).toMatchObject({ ok: true, reason: ALREADY_REACHED, pieces: 0 });
    expect(plan.close, plan.error ?? "").toMatchObject({ ok: true, reason: null });
    for (const piece of plan.pieces) ok(sim, "coaster_add_piece", { id: 1, piece });
    ok(sim, "coaster_complete", { id: 1 });
    expect(validateWorldInvariants(sim.world)).toBeNull();
  });

  it("reports a point already reached the same way in the preview and when extending", () => {
    const sim = makeSim();
    ok(sim, "coaster_build_from_points", {
      family: "steel_coaster",
      points: [
        { x: 6, y: 6 },
        { x: 12, y: 6 },
      ],
    });
    const plan = preview(sim, { id: 1, points: [{ x: 12, y: 6 }] });
    expect(plan.ok).toBe(true);
    expect(plan.pieces).toEqual([]);
    expect(plan.points[0]).toEqual({ ok: true, reason: ALREADY_REACHED, pieces: 0 });
    expect(refused(sim, "coaster_extend_to", { id: 1, point: { x: 12, y: 6 } })).toBe(
      ALREADY_REACHED,
    );
    // A repeated point in a course is reached already, and the course still builds.
    const twice = [
      { x: 6, y: 20 },
      { x: 12, y: 20 },
      { x: 12, y: 20 },
    ];
    const course = preview(sim, { family: "steel_coaster", points: twice });
    expect(course.points[2]).toEqual({ ok: true, reason: ALREADY_REACHED, pieces: 0 });
    ok(sim, "coaster_build_from_points", { family: "steel_coaster", points: twice });
  });

  it("previews by id with one point exactly what extending to it lays", () => {
    for (const point of [
      { x: 18, y: 12, height: 10 },
      { x: 9, y: 9 },
      { x: 20, y: 6, height: 14 },
    ]) {
      const sim = makeSim();
      ok(sim, "coaster_build_from_points", {
        family: "steel_coaster",
        points: [
          { x: 6, y: 6 },
          { x: 12, y: 6 },
        ],
      });
      const pieces = [...sim.world.tracks[0]!.pieces];
      const plan = preview(sim, { id: 1, points: [point] });
      const result = sim.execute("coaster_extend_to", { id: 1, point });
      if (plan.ok) {
        expect(result.ok).toBe(true);
        expect(sim.world.tracks[0]!.pieces).toEqual([...pieces, ...plan.pieces]);
      } else {
        expect(result).toEqual({ ok: false, error: plan.error });
      }
    }
  });

  it("refuses a point above the track ceiling", () => {
    const sim = makeSim();
    const plan = preview(sim, {
      family: "steel_coaster",
      points: [
        { x: 6, y: 6 },
        { x: 20, y: 6, height: 200 },
      ],
    });
    expect(plan.points[1]).toMatchObject({ ok: false, reason: TRACK_TOO_HIGH });
  });

  it("checks a fitted plan again before building it, and throws on one the rules refuse", () => {
    const sim = makeSim();
    const plan = preview(sim, { family: "steel_coaster", points: RECTANGLE, close: true });
    const world = sim.world;
    const from = stationStart(world, 6, 6);
    const family = familyById("steel_coaster")!;
    expect(() =>
      assertPlanned(world, from.rideId, family, from.start, [], from.reserved, plan.pieces),
    ).not.toThrow();
    // A station piece after the station run: the piece rules refuse it.
    const bad = ["station", "station", "straight", "station"];
    expect(() =>
      assertPlanned(world, from.rideId, family, from.start, [], from.reserved, bad),
    ).toThrow(/Internal error/);
  });
});
