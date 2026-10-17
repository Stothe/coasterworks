import type { ExecResult } from "./commands/execute.js";
import { Sim } from "./sim.js";
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

const SURFACE_SAND = 1;
const SURFACE_ROCK = 3;

/** Runs a command as the system and fails loudly, so a broken recipe shows up as an exception. */
function mustRun(sim: Sim, name: string, input: unknown): void {
  const result: ExecResult = sim.execute(name, input, "system");
  if (!result.ok) throw new Error(`Sample park: ${name} failed: ${result.error}`);
}

/**
 * Builds the demo park, "Leafy Lake": 64 by 64 tiles with a rocky hill in the north-west and a
 * sandy pond to the south-east of it. It is shaped through the same commands a player uses, run
 * as the `"system"` client, so the log is not empty. The seed only nudges positions and sizes by
 * a tile or two (drawn from a stream forked off the world's generator), so a seed always gives
 * the same park.
 */
export function createSamplePark(seed: number): World {
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
  mustRun(sim, "terrain_set_water", { x: pondX, y: pondY, w: pondW, h: pondH, level: 7 });

  // The beach around it, which is also the pond's sandy bed.
  mustRun(sim, "terrain_set_surface", {
    x: pondX - 2,
    y: pondY - 2,
    w: pondW + 4,
    h: pondH + 4,
    surface: SURFACE_SAND,
  });

  // The park is handed over as if nothing had been paid for: full purse, nothing to undo.
  world.finance.cash = STARTING_CASH;
  world.finance.monthStart.cash = STARTING_CASH;
  world.undoStack.length = 0;
  world.redoStack.length = 0;
  return world;
}
