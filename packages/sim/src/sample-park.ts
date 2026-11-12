import type { ExecResult } from "./commands/execute.js";
import { canBuildPath } from "./paths/paths.js";
import { Sim } from "./sim.js";
import { tileCorners } from "./terrain/terrain.js";
import { createWorld } from "./world/create.js";
import type { World } from "./world/types.js";

/** Tiles per side of the sample park. */
export const SAMPLE_SIZE = 64;

/** What the player starts with, in cents. */
const STARTING_CASH = 10_000_00;

/**
 * What the shaping is paid from, in cents. A hill this size costs far more than $10,000, so the
 * park is shaped with a bigger purse and handed over with `STARTING_CASH`.
 */
const SHAPING_CASH = 1_000_000_00;

/** Where the hill is centered, before the seed nudges it by a tile. */
const HILL_X = 18;
const HILL_Y = 14;
/** Raise rings from this half-width (in tiles) down to 1, two steps each: a 20 step peak. */
const HILL_RINGS = 10;

/** Where the pond's top-left tile is, before the seed nudges it by a tile. */
const POND_X = 32;
const POND_Y = 28;

/** The height the pond's water stands at: one step below the ground around it. */
const POND_LEVEL = 7;

/**
 * How far from the hill's center the footpath loop runs: one tile past the foot of the dome, on
 * level ground. Its east side comes in closer where the pond leaves less room than that.
 */
const LOOP_REACH = 12;
/** The plaza by the pond: this many tiles wide and tall, with its top edge at the waterline. */
const PLAZA_W = 5;
const PLAZA_H = 3;
/** How long each queue stub off the loop is, in tiles. */
const STUB_LENGTH = 3;
/** What each guest pays at the gate, in cents. */
const ENTRY_FEE = 5_00;

const SURFACE_SAND = 1;
const SURFACE_ROCK = 3;

/** Runs a command as the system and fails loudly, so a broken recipe shows up as an exception. */
function mustRun(sim: Sim, name: string, input: unknown): void {
  const result: ExecResult = sim.execute(name, input, "system");
  if (!result.ok) throw new Error(`Sample park: ${name} failed: ${result.error}`);
}

/** Where the hill and the pond ended up, in tiles. */
interface Landmarks {
  hillX: number;
  hillY: number;
  pondX: number;
  pondY: number;
  pondW: number;
  pondH: number;
}

/**
 * Whether the sample park may put a path on tile (x, y): the sim allows one there (`canBuildPath`:
 * on the map, no water, not too steep), and the tile is dry land. The second half is the sample
 * park's own rule. The pond's water is only on its basin, but the shelf around the basin slopes
 * down from the water's level, so the pond covers it too; a tile with no corner above that level
 * is one of those.
 */
function canPave(world: World, x: number, y: number): boolean {
  if (canBuildPath(world, x, y) !== null) return false;
  return Math.max(...tileCorners(world.terrain, x, y)) > POND_LEVEL;
}

/** Whether `canPave` holds for every tile of the rectangle between two corner tiles. */
function allPavable(world: World, x0: number, y0: number, x1: number, y1: number): boolean {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      if (!canPave(world, x, y)) return false;
    }
  }
  return true;
}

/**
 * The first whole number from `from` to `to` (counting up or down, both ends included) that `fits`.
 * Throws if none does, so a park with no room for `what` fails loudly, like a refused command.
 */
function firstThatFits(
  what: string,
  from: number,
  to: number,
  fits: (n: number) => boolean,
): number {
  const step = from <= to ? 1 : -1;
  for (let n = from; n !== to + step; n += step) if (fits(n)) return n;
  throw new Error(`Sample park: no room for ${what}`);
}

/** Lays path on the rectangle between two corner tiles: a run one tile wide, or a block. */
function buildRun(sim: Sim, x0: number, y0: number, x1: number, y1: number, kind: string): void {
  mustRun(sim, "path_build", {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0) + 1,
    h: Math.abs(y1 - y0) + 1,
    kind,
  });
}

/**
 * Lays the entrance, paths and fee, and opens the park. See `createSamplePark`. Where things go is
 * read off the land as it is, not assumed from the recipe: the seed moves the hill and the pond by
 * a tile each way, and for some seeds that leaves the pond's shore where the loop would have run.
 */
function layOutPark(sim: Sim, land: Landmarks): void {
  const { world } = sim;
  const { hillX, hillY, pondX, pondY, pondW, pondH } = land;
  const last = SAMPLE_SIZE - 1;

  // The plaza is centered on the pond, on the first rows south of it that are dry all the way
  // across: its top row is the beach, sloping down to the waterline.
  const plazaX = pondX + (pondW >> 1) - (PLAZA_W >> 1);
  const plazaRight = plazaX + PLAZA_W - 1;
  const plazaY = firstThatFits("the plaza", pondY + pondH, pondY + pondH + 4, (y) =>
    allPavable(world, plazaX, y, plazaRight, y + PLAZA_H - 1),
  );
  const plazaBottom = plazaY + PLAZA_H - 1;

  // The main path runs straight up from the gate to the middle of the plaza's south side.
  const gateX = plazaX + (PLAZA_W >> 1);
  mustRun(sim, "park_set_entrance", { x: gateX, y: last });
  buildRun(sim, gateX, plazaBottom + 1, gateX, last - 1, "foot");
  buildRun(sim, plazaX, plazaY, plazaRight, plazaBottom, "foot");

  // The loop: a ring of footpath around the base of the hill, one tile wide. Its east side carries
  // on south down the pond's west shore and turns along the beach into the plaza's waterfront
  // row, so whoever walks between the hill and the gate walks by the water. That side therefore
  // runs in the column nearest its place that is dry all the way down and along.
  const west = hillX - LOOP_REACH;
  const north = hillY - LOOP_REACH;
  const south = hillY + LOOP_REACH;
  const east = firstThatFits(
    "the loop",
    hillX + LOOP_REACH,
    hillX + 1,
    (x) => allPavable(world, x, north, x, plazaY) && allPavable(world, x, plazaY, plazaX, plazaY),
  );
  buildRun(sim, west, north, east, north, "foot");
  buildRun(sim, west, south, east, south, "foot");
  buildRun(sim, west, north, west, south, "foot");
  buildRun(sim, east, north, east, plazaY, "foot");
  buildRun(sim, east, plazaY, plazaX, plazaY, "foot");

  // Two queue stubs off the loop, where rides will later stand: one west, one east.
  buildRun(sim, west - STUB_LENGTH, hillY, west - 1, hillY, "queue");
  buildRun(sim, east + 1, hillY, east + STUB_LENGTH, hillY, "queue");

  mustRun(sim, "park_set_entry_fee", { cents: ENTRY_FEE });
  mustRun(sim, "park_open", {});
}

/**
 * Builds the demo park, "Leafy Lake": 64 by 64 tiles with a rocky hill in the north-west and a
 * sandy pond to the south-east of it. It is shaped through the same commands a player uses, run
 * as the `"system"` client, so the log is not empty. The seed only nudges positions and sizes by
 * a tile or two (drawn from a stream forked off the world's generator), so a seed always gives
 * the same park.
 *
 * Unless `withPark` is false, the park is also laid out and opened: an entrance on the south edge,
 * a main footpath from it up to a plaza at the pond's waterline, a loop of footpath around the
 * base of the hill, joined to the plaza by a path down the pond's west shore, two short queue
 * stubs off the loop, a $5.00 entry fee, and the park open. Where each piece goes is read off the
 * land the seed produced (`canPave`), and every tile is built through `path_build`, so nothing
 * lands on water, under the pond's edge, or on a slope that is too steep, whatever the seed.
 */
export function createSamplePark(seed: number, options: { withPark?: boolean } = {}): World {
  const world = createWorld({
    width: SAMPLE_SIZE,
    height: SAMPLE_SIZE,
    seed,
    name: "Leafy Lake",
    cash: SHAPING_CASH,
  });
  const sim = new Sim(world);
  const rng = world.rng.fork("sample");
  const nudge = () => rng.int(3) - 1;

  // The hill: nested raises, each a ring narrower than the last, then smoothed into a dome.
  const hillX = HILL_X + nudge();
  const hillY = HILL_Y + nudge();
  for (let ring = 0; ring < HILL_RINGS; ring++) {
    const half = HILL_RINGS - ring;
    const west = hillX - half + (rng.chance(1, 3) ? 1 : 0);
    const north = hillY - half + (rng.chance(1, 3) ? 1 : 0);
    const east = hillX + half - (rng.chance(1, 3) ? 1 : 0);
    const south = hillY + half - (rng.chance(1, 3) ? 1 : 0);
    mustRun(sim, "terrain_raise", {
      x: west,
      y: north,
      w: Math.max(1, east - west),
      h: Math.max(1, south - north),
      steps: 2,
    });
  }
  const reach = HILL_RINGS + 1;
  const dome = { x: hillX - reach, y: hillY - reach, w: 2 * reach, h: 2 * reach };
  mustRun(sim, "terrain_smooth", dome);
  mustRun(sim, "terrain_smooth", dome);

  // The rock outcrop on top, with a stray rock or two beside it.
  mustRun(sim, "terrain_set_surface", {
    x: hillX - 1,
    y: hillY - 1,
    w: 3,
    h: 3,
    surface: SURFACE_ROCK,
  });
  mustRun(sim, "terrain_set_surface", {
    x: hillX + 2 + rng.int(2),
    y: hillY - 1 + rng.int(2),
    w: 1,
    h: 2,
    surface: SURFACE_ROCK,
  });

  // The pond: a shallow shelf, a basin dug two steps down in it, and water over the basin.
  const pondX = POND_X + nudge();
  const pondY = POND_Y + nudge();
  const pondW = 6 + rng.int(3);
  const pondH = 4;
  mustRun(sim, "terrain_lower", {
    x: pondX - 1,
    y: pondY - 1,
    w: pondW + 2,
    h: pondH + 2,
    steps: 1,
  });
  mustRun(sim, "terrain_lower", { x: pondX, y: pondY, w: pondW, h: pondH, steps: 1 });
  mustRun(sim, "terrain_set_water", {
    x: pondX,
    y: pondY,
    w: pondW,
    h: pondH,
    level: POND_LEVEL,
  });

  // The beach around it, which is also the pond's sandy bed.
  mustRun(sim, "terrain_set_surface", {
    x: pondX - 2,
    y: pondY - 2,
    w: pondW + 4,
    h: pondH + 4,
    surface: SURFACE_SAND,
  });

  if (options.withPark !== false) layOutPark(sim, { hillX, hillY, pondX, pondY, pondW, pondH });

  // The park is handed over as if nothing had been paid for: full purse, nothing to undo.
  world.finance.cash = STARTING_CASH;
  world.finance.monthStart.cash = STARTING_CASH;
  world.undoStack.length = 0;
  world.redoStack.length = 0;
  return world;
}
