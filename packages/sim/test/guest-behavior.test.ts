import { describe, expect, it } from "vitest";
import {
  GUEST_CAP,
  GuestState,
  Rng,
  Sim,
  THOUGHT,
  createWorld,
  deserializeWorld,
  hashWorld,
  serializeWorld,
  type World,
} from "../src/index.js";
import { DEST_TURNED_AWAY } from "../src/guests/types.js";
import { findGuest, removeGuest, spawnGuest } from "../src/guests/guests.js";
import { guestRoutes, tickNeeds } from "../src/guests/behavior.js";
import { guestSystem, nextRating } from "../src/systems/guests.js";
import {
  CASH,
  ENTRANCE,
  at,
  liveCount,
  makePark,
  placeGuest,
  run,
  stepUntil,
  tileIndexOf,
} from "./helpers/guests.js";

/** The flat index of the entrance of `makePark`, on a map 16 tiles wide. */
const ENTRANCE_INDEX = ENTRANCE.y * 16 + ENTRANCE.x;

function spawn(world: World): number {
  return spawnGuest(world, world.rngStreams.guests);
}

describe("entering the park", () => {
  it("walks in from the lane and pays the entry fee once", () => {
    const sim = makePark({ fee: 300 });
    const { world } = sim;
    const slot = spawn(world);
    world.guests.cash[slot] = 5000;
    const cash = world.finance.cash;

    // 16 ticks of 2 units cross the 32 units from the lane tile to the entrance tile.
    sim.step(16);
    expect(at(world.guests.y, slot)).toBe(ENTRANCE.y * 32 + 16);
    expect(at(world.guests.state, slot)).toBe(GuestState.ENTERING);
    expect(world.park.income.entry).toBe(0);
    expect(world.park.guestsInPark).toBe(0);

    sim.step(1);
    expect(world.park.income.entry).toBe(300);
    expect(world.park.monthly.entry).toBe(300);
    expect(world.finance.cash).toBe(cash + 300);
    expect(world.park.totalAdmissions).toBe(1);
    expect(world.park.guestsInPark).toBe(1);
    expect(at(world.guests.cash, slot)).toBe(4700);
    // It sets off for somewhere along the path at once.
    expect(at(world.guests.state, slot)).toBe(GuestState.HEADING);
    expect(at(world.guests.sinceAction, slot)).toBe(0);

    // Inside, it is not charged again.
    sim.step(300);
    expect(world.park.income.entry).toBe(300);
    expect(world.park.totalAdmissions).toBe(1);
    expect(at(world.guests.cash, slot)).toBe(4700);
    expect(world.park.guestsInPark).toBe(1);
  });

  it("admits a guest for nothing when the fee is zero", () => {
    const sim = makePark({ fee: 0 });
    const slot = spawn(sim.world);
    const cash = at(sim.world.guests.cash, slot);
    sim.step(17);
    expect(sim.world.park.totalAdmissions).toBe(1);
    expect(sim.world.park.income.entry).toBe(0);
    expect(at(sim.world.guests.cash, slot)).toBe(cash);
    expect(at(sim.world.guests.state, slot)).not.toBe(GuestState.ENTERING);
  });

  it("admits a guest with exactly the fee in cash", () => {
    const sim = makePark({ fee: 300 });
    const slot = spawn(sim.world);
    sim.world.guests.cash[slot] = 300;
    sim.step(17);
    expect(sim.world.park.totalAdmissions).toBe(1);
    expect(at(sim.world.guests.cash, slot)).toBe(0);
  });

  it("turns away a guest who cannot pay, with the thought that it is too expensive", () => {
    const sim = makePark({ fee: 300 });
    const { world } = sim;
    const slot = spawn(world);
    world.guests.cash[slot] = 299;
    const cash = world.finance.cash;
    sim.step(17);
    expect(at(world.guests.state, slot)).toBe(GuestState.LEAVING);
    expect(at(world.guests.dest, slot)).toBe(DEST_TURNED_AWAY);
    expect(at(world.guests.thought, slot)).toBe(THOUGHT.TOO_EXPENSIVE);
    expect(at(world.guests.thoughtTick, slot)).toBe(17);
    expect(world.park.income.entry).toBe(0);
    expect(world.park.totalAdmissions).toBe(0);
    expect(world.finance.cash).toBe(cash);
    // It never counts as being in the park, on the way out or at any other time.
    expect(world.park.guestsInPark).toBe(0);
    const ticks = stepUntil(sim, () => world.guests.count === 0, 40);
    expect(ticks).toBeLessThanOrEqual(17);
    expect(world.park.guestsInPark).toBe(0);
  });

  it("turns a guest away from a park that has closed", () => {
    const sim = makePark();
    const slot = spawn(sim.world);
    run(sim, "park_close", {});
    sim.step(17);
    expect(at(sim.world.guests.thought, slot)).toBe(THOUGHT.PARK_CLOSED);
    expect(at(sim.world.guests.state, slot)).toBe(GuestState.LEAVING);
    expect(sim.world.park.totalAdmissions).toBe(0);
    stepUntil(sim, () => sim.world.guests.count === 0, 40);
  });

  it("sends a guest home if the entrance it was heading for moves", () => {
    const sim = makePark();
    const slot = spawn(sim.world);
    sim.step(5);
    run(sim, "park_set_entrance", { x: 3, y: 23 });
    sim.step(1);
    expect(sim.world.guests.count).toBe(0);
    expect(at(sim.world.guests.live, slot)).toBe(0);
    expect(sim.world.park.income.entry).toBe(0);
  });

  it("does not touch the guest stream in a park with nobody to simulate", () => {
    const sim = makePark({ open: false });
    const before = sim.world.rngStreams.guests.state;
    sim.step(1000);
    expect(sim.world.rngStreams.guests.state).toEqual(before);
  });
});

describe("walking", () => {
  it("walks 10 tiles of path in 160 ticks", () => {
    const sim = makePark();
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 14 }, GuestState.HEADING, {
      dest: tileIndexOf(world, 8, 4),
    });
    sim.step(16);
    expect([at(world.guests.x, slot), at(world.guests.y, slot)]).toEqual([
      8 * 32 + 16,
      13 * 32 + 16,
    ]);
    sim.step(144);
    expect([at(world.guests.x, slot), at(world.guests.y, slot)]).toEqual([
      8 * 32 + 16,
      4 * 32 + 16,
    ]);
    expect(at(world.guests.state, slot)).toBe(GuestState.HEADING);
    // The next tick notices it has arrived.
    sim.step(1);
    expect(at(world.guests.state, slot)).toBe(GuestState.WANDERING);
    expect([at(world.guests.x, slot), at(world.guests.y, slot)]).toEqual([
      8 * 32 + 16,
      4 * 32 + 16,
    ]);
  });

  it("follows the path round a corner", () => {
    const sim = makePark();
    run(sim, "path_build", { x: 9, y: 10, w: 4, h: 1, kind: "foot" });
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 14 }, GuestState.HEADING, {
      dest: tileIndexOf(world, 12, 10),
    });
    sim.step(8 * 16);
    expect([at(world.guests.x, slot), at(world.guests.y, slot)]).toEqual([
      12 * 32 + 16,
      10 * 32 + 16,
    ]);
  });

  it("waits at its destination until its turn, then picks another waypoint", () => {
    const sim = makePark();
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 14 }, GuestState.HEADING, {
      dest: tileIndexOf(world, 8, 4),
    });
    // Arrived and noticed at tick 161. Guest 1 wanders when (tick + id) is a multiple of 120.
    sim.step(238);
    expect(at(world.guests.state, slot)).toBe(GuestState.WANDERING);
    expect(at(world.guests.dest, slot)).toBe(-1);
    sim.step(1);
    expect(world.tick).toBe(239);
    expect(at(world.guests.state, slot)).toBe(GuestState.HEADING);
    expect(at(world.guests.sinceAction, slot)).toBe(0);
    const dest = at(world.guests.dest, slot);
    expect(dest).not.toBe(tileIndexOf(world, 8, 4));
    // It is on the path, and the guest has already taken its first step.
    expect(world.terrain.path[dest]).toBe(1);
    expect(at(world.guests.ty, slot)).toBe(5);
  });

  it("prefers a destination within 12 steps when it can find one", () => {
    // A path 47 tiles long, so about half of it is out of range of a guest in the middle.
    const world = createWorld({ width: 48, height: 8, seed: 4, name: "Long", cash: CASH });
    const sim = new Sim(world);
    run(sim, "park_set_entrance", { x: 0, y: 3 });
    run(sim, "path_build", { x: 1, y: 3, w: 47, h: 1, kind: "foot" });
    run(sim, "park_open", {});
    world.park.rating = 0;
    const routes = guestRoutes(world);
    const slot = placeGuest(world, { x: 24, y: 3 }, GuestState.WANDERING);
    const g = world.guests;
    const here = tileIndexOf(world, 24, 3);
    let near = 0;
    let picks = 0;
    for (let i = 0; i < 200; i++) {
      g.state[slot] = GuestState.WANDERING;
      g.x[slot] = 24 * 32 + 16;
      g.y[slot] = 3 * 32 + 16;
      g.tx[slot] = 24;
      g.ty[slot] = 3;
      g.dest[slot] = -1;
      // Guest 1 takes its turn when the tick is one short of a multiple of 120.
      world.tick = 119 + 120 * i;
      guestSystem.tick(world);
      const dest = at(g.dest, slot);
      if (dest >= 0) {
        picks++;
        if (at(routes.distanceField(dest), here) <= 12) near++;
      }
    }
    expect(picks).toBe(200);
    // Three tries at about even odds each: all but an eighth of the picks are in range, where a
    // blind pick would have managed half.
    expect(near / picks).toBeGreaterThan(0.75);
  });
});

describe("needs", () => {
  /** A calm guest in the middle of the path, off the ambient-thought thresholds. */
  function calm(sim: Sim) {
    const slot = placeGuest(sim.world, { x: 8, y: 10 }, GuestState.WANDERING, {
      happiness: 100,
      hunger: 10,
      thirst: 10,
      bathroom: 10,
      energy: 200,
    });
    return { slot, rng: new Rng(5) };
  }

  it("raises hunger and thirst every 40 ticks, bathroom every 80, and lowers energy every 60", () => {
    const sim = makePark();
    const { world } = sim;
    const { slot, rng } = calm(sim);
    const g = world.guests;
    // Guest 1's phases: its events fall when (tick + 1) is a multiple of the interval.
    const seen: Record<string, number[]> = { hunger: [], thirst: [], energy: [], bathroom: [] };
    for (let t = 1; t <= 2400; t++) {
      world.tick = t;
      const before = [g.hunger, g.thirst, g.energy, g.bathroom].map((a) => at(a, slot));
      tickNeeds(world, slot, rng);
      const after = [g.hunger, g.thirst, g.energy, g.bathroom].map((a) => at(a, slot));
      (["hunger", "thirst", "energy", "bathroom"] as const).forEach((name, i) => {
        if (after[i] !== before[i]) seen[name]?.push(t);
      });
    }
    expect(at(g.hunger, slot)).toBe(10 + 60);
    expect(at(g.thirst, slot)).toBe(10 + 60);
    expect(at(g.energy, slot)).toBe(200 - 40);
    expect(at(g.bathroom, slot)).toBe(10 + 30);
    expect(seen.hunger?.every((t) => (t + 1) % 40 === 0)).toBe(true);
    expect(seen.energy?.every((t) => (t + 1) % 60 === 0)).toBe(true);
    expect(seen.bathroom?.every((t) => (t + 1) % 80 === 0)).toBe(true);
    // Nausea does not move until rides exist.
    expect(at(g.nausea, slot)).toBe(0);
  });

  it("staggers guests: a different guest's events fall on different ticks", () => {
    const sim = makePark();
    const { world } = sim;
    const a = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING, { hunger: 0 });
    const b = placeGuest(world, { x: 8, y: 11 }, GuestState.WANDERING, { hunger: 0 });
    const rng = new Rng(1);
    const first = (slot: number) => {
      for (let t = 1; t <= 80; t++) {
        world.tick = t;
        tickNeeds(world, slot, rng);
        if (at(world.guests.hunger, slot) > 0) return t;
      }
      return -1;
    };
    expect(first(a)).toBe(39);
    world.tick = 0;
    expect(first(b)).toBe(38);
  });

  it.each([
    ["hunger", 199, 200, THOUGHT.HUNGRY, 40],
    ["thirst", 199, 200, THOUGHT.THIRSTY, 40],
    ["bathroom", 199, 200, THOUGHT.NEED_TOILET, 80],
    ["energy", 56, 55, THOUGHT.TIRED, 60],
  ] as const)(
    "has a guest think once when %s reaches the threshold",
    (field, start, crossed, thought, interval) => {
      const sim = makePark();
      const { world } = sim;
      const { slot, rng } = calm(sim);
      const g = world.guests;
      g[field][slot] = start;
      let at200 = -1;
      for (let t = 1; t <= interval * 2; t++) {
        world.tick = t;
        tickNeeds(world, slot, rng);
        if (at(g[field], slot) === crossed && at200 < 0) {
          at200 = t;
          expect(at(g.thought, slot)).toBe(thought);
          expect(at(g.thoughtTick, slot)).toBe(t);
          // Forget it, and see that it does not come back.
          g.thought[slot] = THOUGHT.NONE;
        }
      }
      expect(at200).toBeGreaterThan(0);
      expect(at200).toBeLessThanOrEqual(interval);
      expect(at(g.thought, slot)).toBe(THOUGHT.NONE);
    },
  );

  it("does not think about a need that is merely rising", () => {
    const sim = makePark();
    const { world } = sim;
    const { slot, rng } = calm(sim);
    for (let t = 1; t <= 2000; t++) {
      world.tick = t;
      tickNeeds(world, slot, rng);
    }
    expect(at(world.guests.thought, slot)).toBe(THOUGHT.NONE);
  });

  it("drifts happiness one step every 40 ticks towards a baseline set by the needs", () => {
    const sim = makePark();
    const { world } = sim;
    const g = world.guests;
    // Content: needs at ease give a baseline of 200, so a low mood climbs.
    const up = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING, {
      happiness: 100,
      hunger: 128,
      thirst: 128,
      energy: 255,
    });
    // Starving: hunger 228 takes 50 off the baseline, so a high mood falls (but not to the floor).
    const down = placeGuest(world, { x: 8, y: 11 }, GuestState.WANDERING, {
      happiness: 200,
      hunger: 228,
      thirst: 128,
      energy: 255,
    });
    const rng = new Rng(2);
    for (let t = 1; t <= 400; t++) {
      world.tick = t;
      tickNeeds(world, up, rng);
      tickNeeds(world, down, rng);
    }
    // Ten drifts of one each.
    expect(at(g.happiness, up)).toBe(110);
    expect(at(g.happiness, down)).toBe(190);
  });

  it("settles happiness on the baseline and holds it there", () => {
    const sim = makePark();
    const { world } = sim;
    const g = world.guests;
    const rng = new Rng(2);
    const worst = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING, {
      happiness: 20,
      hunger: 255,
      thirst: 255,
      energy: 0,
    });
    for (let t = 1; t <= 4000; t++) {
      world.tick = t;
      tickNeeds(world, worst, rng);
    }
    // 200 - (127 + 127 + 128) / 2 = 9, and a mood cannot go below the floor on the way.
    expect(at(g.happiness, worst)).toBe(9);

    // With the needs held at ease the baseline is 200: a mood above it comes down and stays.
    const best = placeGuest(world, { x: 8, y: 11 }, GuestState.WANDERING, { happiness: 250 });
    // Held just short of what a tick that moves them would bring to 128, 128 and 128.
    const hold = () => {
      g.hunger[best] = 127;
      g.thirst[best] = 127;
      g.energy[best] = 129;
    };
    for (let t = 1; t <= 2400; t++) {
      world.tick = t;
      hold();
      tickNeeds(world, best, rng);
    }
    expect(at(g.happiness, best)).toBe(200);
    for (let t = 2401; t <= 2800; t++) {
      world.tick = t;
      hold();
      tickNeeds(world, best, rng);
    }
    expect(at(g.happiness, best)).toBe(200);
  });

  it("does not run needs for a guest still outside the gate", () => {
    const sim = makePark();
    const slot = spawn(sim.world);
    const before = sim.world.guests.hunger[slot];
    const rng = new Rng(1);
    for (let t = 1; t <= 200; t++) {
      sim.world.tick = t;
      tickNeeds(sim.world, slot, rng);
    }
    expect(sim.world.guests.hunger[slot]).toBe(before);
    expect(sim.world.guests.sinceAction[slot]).toBe(0);
  });

  it("sometimes admires a view from high ground and never from low ground", () => {
    const sim = makePark();
    const { world } = sim;
    const rng = new Rng(11);
    const lowSlot = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING, { happiness: 100 });
    const g = world.guests;
    let low = 0;
    for (let t = 1; t <= 100_000; t++) {
      world.tick = t;
      g.thought[lowSlot] = THOUGHT.NONE;
      tickNeeds(world, lowSlot, rng);
      if (at(g.thought, lowSlot) === THOUGHT.NICE_VIEW) low++;
    }
    expect(low).toBe(0);

    // Raise the tile's corners to 14.
    const t = world.terrain;
    for (const [cx, cy] of [
      [8, 10],
      [9, 10],
      [8, 11],
      [9, 11],
    ] as const) {
      t.corners[cy * (t.width + 1) + cx] = 14;
    }
    let high = 0;
    for (let tick = 1; tick <= 100_000; tick++) {
      world.tick = tick;
      g.thought[lowSlot] = THOUGHT.NONE;
      tickNeeds(world, lowSlot, rng);
      if (at(g.thought, lowSlot) === THOUGHT.NICE_VIEW) high++;
    }
    // One in 4000 a tick: 25 expected.
    expect(high).toBeGreaterThan(8);
    expect(high).toBeLessThan(60);
  });

  it("sometimes thinks the park is great, but only when happy", () => {
    const sim = makePark();
    const { world } = sim;
    const g = world.guests;
    const slot = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING, {});
    const rng = new Rng(21);
    let sad = 0;
    let glad = 0;
    for (let t = 1; t <= 120_000; t++) {
      world.tick = t;
      // Hold the mood fixed and the other needs out of the way.
      g.happiness[slot] = 219;
      g.hunger[slot] = 0;
      g.thirst[slot] = 0;
      g.thought[slot] = THOUGHT.NONE;
      tickNeeds(world, slot, rng);
      if (at(g.thought, slot) === THOUGHT.GREAT_PARK) sad++;
      g.happiness[slot] = 230;
      g.thought[slot] = THOUGHT.NONE;
      tickNeeds(world, slot, rng);
      if (at(g.thought, slot) === THOUGHT.GREAT_PARK) glad++;
    }
    expect(sad).toBe(0);
    // One in 6000 a tick over 120,000 ticks: 20 expected.
    expect(glad).toBeGreaterThan(5);
    expect(glad).toBeLessThan(50);
  });
});

describe("leaving", () => {
  it("sends a guest with happiness under 60 to the entrance, out of the park, and out of the store", () => {
    const sim = makePark();
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING, { happiness: 59 });
    const id = at(world.guests.id, slot);
    sim.step(1);
    expect(at(world.guests.state, slot)).toBe(GuestState.LEAVING);
    expect(at(world.guests.thought, slot)).toBe(THOUGHT.GOING_HOME);
    expect(at(world.guests.dest, slot)).toBe(ENTRANCE_INDEX);
    expect(world.park.guestsInPark).toBe(1);

    // 13 tiles down the path to the entrance, then one more out along the lane.
    const ticks = stepUntil(sim, () => world.guests.count === 0, 400);
    expect(ticks).toBeGreaterThanOrEqual(13 * 16 + 16 - 2);
    expect(ticks).toBeLessThanOrEqual(13 * 16 + 16 + 4);
    expect(at(world.guests.live, slot)).toBe(0);
    expect(at(world.guests.state, slot)).toBe(GuestState.GONE);
    expect(world.park.guestsInPark).toBe(0);
    // Leaving costs and pays nothing.
    expect(world.park.income.entry).toBe(0);
    expect(world.park.totalAdmissions).toBe(0);
    // The id is not handed out again.
    expect(id).toBe(1);
    expect(world.guests.nextGuestId).toBe(2);
  });

  it.each([
    ["energy under 30", { energy: 29 }],
    ["a long time with nothing to do", { sinceAction: 6001 }],
  ])("sends a guest home after %s", (_label, patch) => {
    const sim = makePark();
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING, patch);
    sim.step(1);
    expect(at(world.guests.state, slot)).toBe(GuestState.LEAVING);
    expect(at(world.guests.thought, slot)).toBe(THOUGHT.GOING_HOME);
    stepUntil(sim, () => world.guests.count === 0, 400);
  });

  it("does not send home a guest who is only just inside the limits", () => {
    const sim = makePark();
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING, {
      happiness: 70,
      energy: 31,
      sinceAction: 6000,
    });
    // Hold each figure one step inside its limit going into every tick; a tick that moves it
    // brings it to the limit itself (energy 30, idle for 6,000 ticks) and no further.
    for (let i = 0; i < 70; i++) {
      world.guests.happiness[slot] = 60;
      world.guests.energy[slot] = 31;
      world.guests.sinceAction[slot] = 5999;
      sim.step(1);
    }
    expect(at(world.guests.state, slot)).not.toBe(GuestState.LEAVING);
  });

  it("leaves from the middle of a walk, finishing the step it is on", () => {
    const sim = makePark();
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 14 }, GuestState.HEADING, {
      dest: tileIndexOf(world, 8, 4),
    });
    sim.step(5);
    world.guests.happiness[slot] = 10;
    sim.step(1);
    expect(at(world.guests.state, slot)).toBe(GuestState.LEAVING);
    // Still on its way to (8, 13), so it does not turn round on the spot.
    sim.step(10);
    expect(at(world.guests.y, slot)).toBe(13 * 32 + 16);
    stepUntil(sim, () => world.guests.count === 0, 400);
  });

  it("keeps guests who are content inside", () => {
    const sim = makePark();
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING, { happiness: 150 });
    sim.step(380);
    expect([GuestState.WANDERING, GuestState.HEADING]).toContain(at(world.guests.state, slot));
    expect(world.guests.count).toBe(1);
  });
});

describe("lost guests", () => {
  it("loses a guest when its path goes, and sends it home once the path is back", () => {
    const sim = makePark();
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 8 }, GuestState.HEADING, {
      dest: tileIndexOf(world, 8, 4),
    });
    sim.step(5);
    run(sim, "path_remove", { x: 8, y: 4, w: 1, h: 19 });
    stepUntil(sim, () => at(world.guests.state, slot) === GuestState.LOST, 20);
    expect(at(world.guests.thought, slot)).toBe(THOUGHT.LOST);
    expect(at(world.guests.dest, slot)).toBe(-1);
    // Nothing within 8 tiles to walk to, so it stands where it is.
    expect(at(world.guests.tx, slot)).toBe(-1);
    expect(at(world.guests.ty, slot)).toBe(-1);
    const spot = [at(world.guests.x, slot), at(world.guests.y, slot)];
    expect(spot).toEqual([8 * 32 + 16, 7 * 32 + 16]);

    sim.step(100);
    expect(at(world.guests.state, slot)).toBe(GuestState.LOST);
    run(sim, "path_build", { x: 8, y: 4, w: 1, h: 19, kind: "foot" });
    // It only looks again every 200 ticks, at its own turn.
    expect(at(world.guests.state, slot)).toBe(GuestState.LOST);
    stepUntil(sim, () => at(world.guests.state, slot) === GuestState.LEAVING, 200);
    expect(world.tick % 200).toBe(199);
    expect(at(world.guests.dest, slot)).toBe(ENTRANCE_INDEX);

    // It makes it to the entrance and out.
    stepUntil(sim, () => world.guests.count === 0, 600);
    expect(world.park.guestsInPark).toBe(0);
  });

  it("walks to the nearest path tile when it is lost on ground with no path", () => {
    const sim = makePark();
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 8 }, GuestState.WANDERING, {});
    run(sim, "path_remove", { x: 8, y: 4, w: 1, h: 7 });
    // At its turn it finds nowhere reachable and that it is not standing on a path.
    stepUntil(sim, () => at(world.guests.state, slot) === GuestState.LOST, 130);
    expect(at(world.guests.thought, slot)).toBe(THOUGHT.LOST);
    sim.step(60);
    // (8, 11) is the nearest path left: three tiles, 48 ticks.
    expect([at(world.guests.x, slot), at(world.guests.y, slot)]).toEqual([
      8 * 32 + 16,
      11 * 32 + 16,
    ]);
    // Back on a path with a way out, at the next retry it goes home.
    stepUntil(sim, () => at(world.guests.state, slot) !== GuestState.LOST, 200);
    expect(at(world.guests.state, slot)).toBe(GuestState.LEAVING);
    expect(world.tick % 200).toBe(199);
    stepUntil(sim, () => world.guests.count === 0, 400);
  });

  it("is lost for a while when only its destination goes, then goes home", () => {
    const sim = makePark();
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 12 }, GuestState.HEADING, {
      dest: tileIndexOf(world, 8, 4),
    });
    run(sim, "path_remove", { x: 8, y: 4, w: 1, h: 7 });
    stepUntil(sim, () => at(world.guests.state, slot) === GuestState.LOST, 20);
    // It is standing on a path that is still there, so that is the nearest one.
    expect(at(world.guests.tx, slot)).toBe(8);
    expect(at(world.guests.ty, slot)).toBe(12);
    // At its next look there is a way out, so that is what it takes.
    stepUntil(sim, () => at(world.guests.state, slot) === GuestState.LEAVING, 200);
    expect(world.tick % 200).toBe(199);
    stepUntil(sim, () => world.guests.count === 0, 400);
  });

  it("wanders again if it cannot get out but can get about", () => {
    const sim = makePark();
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 6 }, GuestState.HEADING, {
      dest: tileIndexOf(world, 8, 20),
    });
    // Cut the path in two: the guest is on the northern piece, which does not reach the gate.
    run(sim, "path_remove", { x: 8, y: 11, w: 1, h: 12 });
    stepUntil(sim, () => at(world.guests.state, slot) === GuestState.LOST, 20);
    stepUntil(sim, () => at(world.guests.state, slot) === GuestState.WANDERING, 200);
    expect(world.tick % 200).toBe(199);
    // It stays inside, on the piece it can reach, and is never charged or counted twice.
    sim.step(600);
    expect(world.guests.count).toBe(1);
    expect([GuestState.WANDERING, GuestState.HEADING]).toContain(at(world.guests.state, slot));
    expect(at(world.guests.y, slot)).toBeLessThanOrEqual(10 * 32 + 16);
  });

  it("goes home from where it is if the entrance moves while it walks", () => {
    const sim = makePark();
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING, { happiness: 10 });
    sim.step(40);
    expect(at(world.guests.state, slot)).toBe(GuestState.LEAVING);
    // The old entrance stops being an entrance; the guest cannot reach it any more.
    run(sim, "park_set_entrance", { x: 7, y: 23 });
    run(sim, "path_build", { x: 7, y: 22, w: 1, h: 1, kind: "foot" });
    sim.step(400);
    // It found its way to the new entrance, via a lost spell or not, and left.
    expect(world.guests.count).toBe(0);
  });

  it("keeps its guests when a path removal is undone", () => {
    const sim = makePark();
    const { world } = sim;
    for (let y = 6; y <= 18; y += 3) placeGuest(world, { x: 8, y }, GuestState.WANDERING, {});
    const ids = () => Array.from(world.guests.id.subarray(0, 5));
    const before = ids();
    expect(world.guests.count).toBe(5);

    // Removed and put back before anyone has looked: nothing happened to them.
    run(sim, "path_remove", { x: 8, y: 4, w: 1, h: 19 });
    expect(world.guests.count).toBe(5);
    expect(sim.undo().ok).toBe(true);
    expect(world.guests.count).toBe(5);
    expect(ids()).toEqual(before);
    sim.step(300);
    expect(world.guests.count).toBe(5);
    expect(world.park.guestsInPark).toBe(5);
    expect(Array.from(world.guests.state.subarray(0, 5)).includes(GuestState.LOST)).toBe(false);
  });

  it("does not lose or duplicate guests when a removal is undone after they have been lost", () => {
    const sim = makePark();
    const { world } = sim;
    for (let y = 6; y <= 18; y += 3) placeGuest(world, { x: 8, y }, GuestState.WANDERING, {});
    const ids = () => Array.from(world.guests.id.subarray(0, 5));
    const before = ids();

    run(sim, "path_remove", { x: 8, y: 4, w: 1, h: 19 });
    sim.step(150);
    expect(world.guests.count).toBe(5);
    expect(Array.from(world.guests.state.subarray(0, 5))).toEqual(Array(5).fill(GuestState.LOST));
    // The undo itself leaves every guest as it was.
    const states = Array.from(world.guests.state.subarray(0, 5));
    expect(sim.undo().ok).toBe(true);
    expect(world.guests.count).toBe(5);
    expect(ids()).toEqual(before);
    expect(Array.from(world.guests.state.subarray(0, 5))).toEqual(states);

    // With the path back, each lost guest finds the way out at its next look, and leaves. (The
    // rating has risen by then, so others may have arrived: look at these five.)
    sim.step(900);
    for (const id of [1, 2, 3, 4, 5]) expect(findGuest(world, id), `guest ${id}`).toBe(-1);
    expect(
      Array.from(world.guests.state.subarray(0, world.guests.count)).includes(GuestState.LOST),
    ).toBe(false);
    expect(world.guests.nextGuestId - 1 - world.guests.count).toBeGreaterThanOrEqual(5);
  });
});

describe("arrivals", () => {
  it("brings nobody to a closed park, a park with no entrance, or a park rated 0", () => {
    const closed = makePark({ open: false, rating: 500 });
    closed.step(1500);
    expect(closed.world.guests.nextGuestId).toBe(1);

    const noEntrance = new Sim(createWorld({ width: 8, height: 8, seed: 1, name: "t" }));
    noEntrance.world.park.open = true;
    noEntrance.world.park.rating = 900;
    noEntrance.step(1500);
    expect(noEntrance.world.guests.nextGuestId).toBe(1);

    const unrated = makePark({ rating: 0 });
    unrated.step(399);
    expect(unrated.world.guests.nextGuestId).toBe(1);
  });

  it("brings nobody when the fee is the most it can be", () => {
    const sim = makePark({ fee: 100_00, rating: 999 });
    sim.step(3000);
    expect(sim.world.guests.nextGuestId).toBe(1);
  });

  it("brings guests in groups of 1 to 3", () => {
    const sim = makePark({ rating: 500 });
    const { world } = sim;
    const sizes = new Set<number>();
    let total = 0;
    for (let t = 0; t < 3000; t++) {
      const before = world.guests.nextGuestId;
      sim.step(1);
      const made = world.guests.nextGuestId - before;
      sizes.add(made);
      total += made;
    }
    expect([...sizes].sort()).toEqual([0, 1, 2, 3]);
    expect(total).toBe(world.guests.nextGuestId - 1);
    // About 1% of ticks, two guests a time: some dozens in 3,000 ticks.
    expect(total).toBeGreaterThan(30);
    expect(total).toBeLessThan(120);
    expect(world.park.totalAdmissions).toBeGreaterThan(0);
    expect(world.park.income.entry).toBe(world.park.totalAdmissions * 3_00);
  });

  it("brings fewer guests the more the park costs", () => {
    const count = (fee: number) => {
      const sim = makePark({ rating: 500, fee });
      sim.step(4000);
      return sim.world.guests.nextGuestId - 1;
    };
    const free = count(0);
    const dear = count(50_00);
    expect(dear).toBeGreaterThan(0);
    expect(dear).toBeLessThan(free);
  });

  it("brings more guests the higher the rating", () => {
    const count = (rating: number) => {
      const sim = makePark({ rating, fee: 0 });
      // Hold the rating fixed by running under the first monthly update.
      sim.step(399);
      return sim.world.guests.nextGuestId - 1;
    };
    expect(count(999)).toBeGreaterThan(count(100));
  });

  it("never lets the park hold more than the cap", () => {
    const sim = makePark({ rating: 999, fee: 0 });
    const { world } = sim;
    for (let i = 0; i < GUEST_CAP - 2; i++) spawn(world);
    sim.step(500);
    expect(world.guests.count).toBeLessThanOrEqual(GUEST_CAP);
    expect(liveCount(world)).toBe(world.guests.count);
    expect(world.guests.count).toBe(GUEST_CAP);
    expect(world.guests.nextGuestId).toBe(GUEST_CAP + 1);
  });
});

describe("park rating", () => {
  it("moves 1/16 of the way to the guests' mood, scaled to 999", () => {
    // No guests: back towards 500.
    expect(nextRating(900, 0, 0)).toBe(875);
    expect(nextRating(100, 0, 0)).toBe(100 + Math.trunc(400 / 16));
    expect(nextRating(500, 0, 0)).toBe(500);
    // Ten guests all at 255: aim for 999.
    expect(nextRating(500, 10, 2550)).toBe(500 + Math.trunc(499 / 16));
    // Average 200: aim for floor(200 * 999 / 255) = 783.
    expect(nextRating(500, 4, 800)).toBe(500 + Math.trunc(283 / 16));
    // A small gap still closes, a step at a time.
    expect(nextRating(998, 1, 255)).toBe(999);
    expect(nextRating(1, 0, 0)).toBe(1 + Math.trunc(499 / 16));
    expect(nextRating(499, 0, 0)).toBe(500);
    expect(nextRating(501, 0, 0)).toBe(500);
    // Never outside 0..999.
    expect(nextRating(999, 1, 255)).toBe(999);
    expect(nextRating(0, 1, 0)).toBe(0);
  });

  it("takes 1/5 of a point per guest over 1,500 off the target, up to 100", () => {
    // 2,000 guests all at 255 would aim for 999 less 100.
    expect(nextRating(500, 2000, 2000 * 255)).toBe(500 + Math.trunc(399 / 16));
    // 1,600 guests: a 20 point penalty.
    expect(nextRating(500, 1600, 1600 * 255)).toBe(500 + Math.trunc(479 / 16));
    // At 1,500 there is none.
    expect(nextRating(500, 1500, 1500 * 255)).toBe(500 + Math.trunc(499 / 16));
  });

  it("is recomputed on day boundaries only", () => {
    // Closed, so no one arrives to change the count.
    const sim = makePark({ rating: 500, open: false });
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING, { happiness: 255 });
    sim.step(399);
    expect(world.park.rating).toBe(500);
    sim.step(1);
    const happiness = at(world.guests.happiness, slot);
    expect(world.park.rating).toBe(nextRating(500, 1, happiness));
    expect(world.park.rating).toBeGreaterThan(500);
    const after = world.park.rating;
    sim.step(399);
    expect(world.park.rating).toBe(after);
  });

  it("drifts to 500 in an empty park", () => {
    const sim = makePark({ rating: 900, open: false });
    sim.step(400);
    expect(sim.world.park.rating).toBe(875);
    sim.step(400 * 200);
    expect(sim.world.park.rating).toBe(500);
  });
});

describe("guests in the park", () => {
  it("is exactly the live guests who have been admitted and not yet gone", () => {
    const sim = makePark({ rating: 500, fee: 1_00 });
    const { world } = sim;
    const expected = () => {
      let n = 0;
      for (let slot = 0; slot < world.guests.live.length; slot++) {
        if (at(world.guests.live, slot) === 0) continue;
        const state = at(world.guests.state, slot);
        if (state === GuestState.WANDERING || state === GuestState.HEADING) n++;
        else if (state === GuestState.LOST) n++;
        else if (state === GuestState.LEAVING && at(world.guests.dest, slot) !== DEST_TURNED_AWAY)
          n++;
      }
      return n;
    };
    let busiest = 0;
    let sawTurnedAway = false;
    for (let t = 1; t <= 1500; t++) {
      for (let slot = 0; slot < world.guests.live.length; slot++) {
        if (at(world.guests.live, slot) === 0) continue;
        const id = at(world.guests.id, slot);
        // Some guests are broke when they reach the gate; some are miserable and leave.
        if (at(world.guests.state, slot) === GuestState.ENTERING && id % 3 === 0) {
          world.guests.cash[slot] = 0;
        }
        if (t % 100 === 0 && id % 4 === 0) world.guests.happiness[slot] = 0;
      }
      sim.step(1);
      expect(world.park.guestsInPark).toBe(expected());
      busiest = Math.max(busiest, world.park.guestsInPark);
      for (let slot = 0; slot < world.guests.live.length; slot++) {
        if (at(world.guests.live, slot) === 1 && at(world.guests.dest, slot) === DEST_TURNED_AWAY) {
          sawTurnedAway = true;
        }
      }
    }
    expect(busiest).toBeGreaterThan(3);
    expect(sawTurnedAway).toBe(true);
    // Some left, so the count came back down along the way.
    expect(world.guests.nextGuestId - 1).toBeGreaterThan(world.guests.count);
  });
});

/** A 32 by 32 park with a grid of paths, an open gate, and `guests` guests wandering on it. */
function crowdedPark(seed: number, guests: number, options: { rating?: number } = {}): Sim {
  const world = createWorld({ width: 32, height: 32, seed, name: "Crowd", cash: CASH });
  const sim = new Sim(world);
  run(sim, "park_set_entrance", { x: 16, y: 31 });
  for (let y = 4; y <= 28; y += 6) run(sim, "path_build", { x: 2, y, w: 29, h: 1, kind: "foot" });
  for (let x = 4; x <= 28; x += 6) run(sim, "path_build", { x, y: 2, w: 1, h: 29, kind: "foot" });
  run(sim, "park_set_entry_fee", { cents: 1_00 });
  run(sim, "park_open", {});
  world.park.rating = options.rating ?? 500;

  const tiles: number[] = [];
  world.terrain.path.forEach((value, index) => {
    if (value === 1) tiles.push(index);
  });
  const rng = world.rngStreams.guests;
  for (let i = 0; i < guests; i++) {
    const slot = spawn(world);
    const tile = tiles[rng.int(tiles.length)] as number;
    const x = tile % 32;
    const y = (tile - x) / 32;
    world.guests.x[slot] = x * 32 + 16;
    world.guests.y[slot] = y * 32 + 16;
    world.guests.tx[slot] = x;
    world.guests.ty[slot] = y;
    world.guests.state[slot] = GuestState.WANDERING;
    world.guests.dest[slot] = -1;
  }
  world.park.guestsInPark = guests;
  return sim;
}

describe("determinism", () => {
  it("gives the same hash for the same seed after 5,000 ticks with 200 guests, and not for another", () => {
    const a = crowdedPark(7, 200);
    const b = crowdedPark(7, 200);
    const c = crowdedPark(8, 200);
    expect(a.hash()).toBe(b.hash());
    a.step(5000);
    b.step(5000);
    c.step(5000);
    expect(a.hash()).toBe(b.hash());
    expect(c.hash()).not.toBe(a.hash());
    // Guests really did things: they walked, thought, paid, and (some) left.
    const g = a.world.guests;
    expect(a.world.park.totalAdmissions).toBeGreaterThan(0);
    expect(Array.from(g.thought.subarray(0, g.count)).some((t) => t !== 0)).toBe(true);
    expect(g.nextGuestId).toBeGreaterThan(201);
    expect(a.world.park.guestsInPark).toBeGreaterThan(100);
  });

  it("is not affected by running the same ticks in different step sizes", () => {
    const a = crowdedPark(3, 120);
    const b = crowdedPark(3, 120);
    a.step(1200);
    for (let i = 0; i < 12; i++) b.step(100);
    expect(b.hash()).toBe(a.hash());
  });

  it("carries on the same after a save and a load, even with holes in the store", () => {
    const sim = crowdedPark(5, 150);
    // Make some guests unhappy so a few leave and the store has had removals.
    for (let slot = 0; slot < 150; slot += 7) sim.world.guests.happiness[slot] = 0;
    sim.step(900);
    expect(sim.world.guests.nextGuestId).toBeGreaterThan(sim.world.guests.count);
    // Remove a few straight from the store, as a command someday might.
    removeGuest(sim.world, 2);
    removeGuest(sim.world, 5);
    expect(sim.world.guests.fragmented).toBe(true);

    const loaded = deserializeWorld(serializeWorld(sim.world));
    expect(hashWorld(loaded)).toBe(sim.hash());
    const twin = new Sim(loaded);
    sim.step(1500);
    twin.step(1500);
    expect(twin.hash()).toBe(sim.hash());
    expect(twin.world.guests.count).toBe(sim.world.guests.count);
    expect(twin.world.park.rating).toBe(sim.world.park.rating);
  });
});

describe("speed", () => {
  it("ticks 2,000 guests in well under 20 ms", () => {
    const sim = crowdedPark(1, GUEST_CAP, { rating: 0 });
    sim.step(30);
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      sim.step(1);
      best = Math.min(best, performance.now() - start);
    }
    expect(sim.world.guests.count).toBe(GUEST_CAP);
    expect(best).toBeLessThan(20);
  });
});
