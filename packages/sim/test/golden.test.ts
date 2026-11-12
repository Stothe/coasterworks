import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Sim, deserializeWorld, serializeWorld } from "../src/index.js";
import { applySteps, parseScenario, runScenario } from "./golden/run.js";

const scenarioText = readFileSync(new URL("./golden/scenario-1.json", import.meta.url), "utf8");
const expectedHash = readFileSync(
  new URL("./golden/scenario-1.hash", import.meta.url),
  "utf8",
).trim();

const scenario = () => parseScenario(JSON.parse(scenarioText));

/*
 * The cross-platform determinism guard: CI runs this on Linux and macOS, and both must land on the
 * hash in scenario-1.hash. If a change to the sim is meant to alter its results, regenerate the
 * file with `pnpm --filter @coasterworks/sim golden:update` and say why in the commit.
 *
 * History of the recorded hash:
 *  - Plan D1 Task 3 (guests): re-recorded. The scenario now sets the entry fee to $3.00 while the
 *    park is open and runs 2,400 ticks, so guests arrive, pay, walk the path, and think; and
 *    `hashWorld` now covers the guest store and the guests' rng stream. The final 400 ticks run
 *    with the park closed and the guests still inside.
 *  - Plan D1 Task 4 (park flow): re-recorded. `hashWorld` now covers the park's month-by-month
 *    history and each guest's lost time, closing the park sends every guest home, and a month
 *    that has just ended goes into the history. The scenario gains a 31-day `sim_advance` with the
 *    park open (a month turns in the middle of it), so the final 400 ticks, with the park closed,
 *    empty the park.
 *  - Plan D2 Task 2 (rides and stalls): re-recorded. `hashWorld` now covers the rides, the ride id
 *    counter and the occupant layer, and the scenario builds a snack stand and a carousel on flat
 *    ground away from the paths before the park opens, prices, renames, opens and closes them,
 *    demolishes the stall (with an undo and a redo, which hands the refund back and takes it again)
 *    and builds a drinks stand where it stood. Guests only walk on paths, so they behave as before.
 *  - Plan D2 Task 4 (guests choose rides and stalls): re-recorded. The drinks stand now stands
 *    beside the footpath at (17, 27), turned to serve onto the path tile (16, 27), and is opened
 *    before the park opens, so thirsty guests walk to it, are served, and pay; ride and shop takings
 *    go into the month's books. The carousel stays closed, so no guest draws for a ride choice.
 *  - Plan D2 Task 4 review fixes: re-recorded. Guests find stalls by one field per need, choose
 *    rides by straight-line distance, and skip what they cannot afford. The carousel now has a
 *    four-tile queue from its entrance (3, 23) down to a footpath along y = 26 that joins the main
 *    path at (16, 26), and a footpath tile on its exit, and is opened before the park opens, so
 *    the ride choice (and its one-in-two draw), the queue, boarding and paying are guarded too.
 *    It is closed again 500 ticks before the park closes, so its last riders are off and home by
 *    the end.
 *  - Plan D3 (need tuning): re-recorded (7ae8879097eb2db4 to b0bf2d8eea6f7d38). Guests look for
 *    food and drink at 80 rather than 160 and for the toilets at 56, complain of no stall only at
 *    160, and turn for a stall on their way when they need one, so the drinks stand gets its
 *    customers days sooner. The scenario is unchanged and spawning draws what it did.
 */
describe("golden scenario 1", () => {
  it("ends on the recorded hash", () => {
    expect(runScenario(scenario()).hash()).toBe(expectedHash);
  });

  it("gives the same hash when it is run again in the same process", () => {
    const first = runScenario(scenario()).hash();
    const second = runScenario(scenario()).hash();
    expect(second).toBe(first);
  });

  it("gives a different hash for a different seed", () => {
    const other = scenario();
    other.world.seed = 8;
    expect(runScenario(other).hash()).not.toBe(expectedHash);
  });

  it("covers every command it is meant to guard", () => {
    const doc = scenario();
    expect(doc.steps.length).toBeGreaterThanOrEqual(14);
    const used = new Set<string>();
    for (const step of doc.steps) {
      if ("exec" in step) used.add(step.exec[0]);
      else if ("tick" in step) used.add("tick");
      else if ("undo" in step) used.add("undo");
      else used.add("redo");
    }
    for (const name of [
      "terrain_raise",
      "terrain_lower",
      "terrain_level",
      "terrain_smooth",
      "terrain_set_surface",
      "terrain_set_water",
      "finance_take_loan",
      "finance_repay_loan",
      "path_build",
      "path_remove",
      "path_build_tiles",
      "path_remove_tiles",
      "park_set_entrance",
      "park_set_entry_fee",
      "park_open",
      "park_close",
      "park_rename",
      "ride_build",
      "stall_build",
      "ride_demolish",
      "ride_open",
      "ride_close",
      "ride_set_price",
      "ride_rename",
      "sim_advance",
      "tick",
      "undo",
      "redo",
    ]) {
      expect(used, name).toContain(name);
    }
    expect(doc.steps.at(-1)).toEqual({ tick: 400 });
  });
});

describe("runScenario", () => {
  it("builds the world the scenario describes and lets time pass", () => {
    const sim = runScenario(scenario());
    expect(sim.world.terrain.width).toBe(32);
    expect(sim.world.meta.name).toBe("golden");
    // 120 ticks, then 70 days, then 2,400 ticks and 31 days with the park open, 500 more with the
    // carousel shut (its last riders get off), then 400 with the park shut.
    expect(sim.world.tick).toBe(120 + 70 * 400 + 2400 + 31 * 400 + 500 + 400);
    expect(sim.world.log.some((entry) => entry.name === "undo")).toBe(true);
  });

  it("lays the paths and sets up the park, so the hash is not guarding a no-op", () => {
    const { world } = runScenario(scenario());
    // The foot path ran (16, 25..30); its first tile was removed and its last two became a queue.
    const path = (x: number, y: number) => world.terrain.path[y * 32 + x];
    expect([25, 26, 27, 28, 29, 30].map((y) => path(16, y))).toEqual([0, 1, 1, 1, 2, 2]);
    // The tile-list stroke was built, undone and built again; one of its tiles then removed.
    expect([path(19, 25), path(20, 25), path(20, 26)]).toEqual([1, 1, 0]);
    // The extra pair was built, undone, and built again.
    expect([path(17, 25), path(18, 25)]).toEqual([1, 1]);
    expect(world.park).toMatchObject({
      name: "Golden Gardens",
      open: false,
      entryFee: 300,
      entrance: { x: 16, y: 31, side: 2 },
    });
    expect(world.pathVersion).toBeGreaterThan(0);
  });

  it("builds, prices, names, opens, closes and demolishes rides, so the hash guards them too", () => {
    const { world } = runScenario(scenario());
    // The snack stand (1) was demolished, the demolish undone and redone; its id is not reused.
    expect(world.rides.map((r) => [r.id, r.type, r.rot, r.name, r.open, r.price])).toEqual([
      [2, "carousel", 1, "Carousel 1", false, 150],
      [3, "drinks_stand", 1, "Drinks Stand 1", true, 120],
    ]);
    expect(world.nextRideId).toBe(4);
    // The carousel turned once stands on (4..6, 22..24); the drinks stand on (17, 27), where the
    // snack stand stood is free again.
    const occupant = (x: number, y: number) => world.terrain.occupant[y * 32 + x];
    expect([
      occupant(4, 22),
      occupant(6, 24),
      occupant(17, 27),
      occupant(9, 24),
      occupant(7, 22),
    ]).toEqual([2, 2, 3, 0, 0]);
    expect(world.rides[1]?.service).toEqual({ x: 16, y: 27 });
    expect(world.terrain.path[27 * 32 + 16]).not.toBe(0);
    expect(world.rideVersion).toBeGreaterThan(0);
  });

  it("lets guests in, so the hash is guarding the guest system too", () => {
    // Everything up to the closing of the park.
    const steps = scenario().steps;
    const closing = steps.findIndex((step) => "exec" in step && step.exec[0] === "park_close");
    expect(closing).toBeGreaterThan(0);
    const sim = runScenario({ ...scenario(), steps: steps.slice(0, closing) });

    const status = sim.query("park_status", {});
    if (!status.ok) throw new Error(status.error);
    const park = status.result as {
      guestsInPark: number;
      guests: number;
      totalAdmissions: number;
      income: { entry: number };
      open: boolean;
    };
    expect(park.open).toBe(true);
    expect(park.guestsInPark).toBeGreaterThan(0);
    expect(park.guests).toBe(park.guestsInPark);
    expect(park.totalAdmissions).toBeGreaterThanOrEqual(park.guestsInPark);
    expect(park.income.entry).toBe(park.totalAdmissions * 300);
    expect(sim.world.guests.count).toBeGreaterThanOrEqual(park.guestsInPark);
    // They have been about: thinking, walking the five-tile path from the gate.
    const g = sim.world.guests;
    expect(Array.from(g.sinceAction.subarray(0, g.count)).some((v) => v > 0)).toBe(true);
    expect(g.nextGuestId - 1).toBeGreaterThanOrEqual(park.totalAdmissions);

    // Closing the park, a last stroke of path, and waiting 400 ticks is the end of the scenario,
    // and empties the park.
    applySteps(sim, steps.slice(closing), closing);
    expect(sim.world.park.open).toBe(false);
    expect(sim.world.park.guestsInPark).toBe(0);
    expect(sim.world.guests.count).toBe(0);
    expect(sim.hash()).toBe(expectedHash);
  });

  it("closes the books on three months, so the hash is guarding the history too", () => {
    const sim = runScenario(scenario());
    const out = sim.query("finance_summary", {});
    if (!out.ok) throw new Error(out.error);
    const summary = out.result as {
      history: Array<{ year: number; month: number; entry: number; net: number }>;
      lastMonth: { year: number; month: number; entry: number } | null;
      thisMonth: { entry: number; running: number; net: number };
    };
    // March and April ended before the park opened; May ended in the middle of the 31 days.
    expect(summary.history.map((r) => [r.year, r.month])).toEqual([
      [1, 0],
      [1, 1],
      [1, 2],
    ]);
    expect(summary.history.map((r) => r.entry === 0)).toEqual([true, true, false]);
    expect(summary.lastMonth).toEqual(summary.history[2]);
    // Every fee taken is in a month's book or in the month under way, and nowhere twice.
    const booked = summary.history.reduce((total, r) => total + r.entry, 0);
    expect(booked + summary.thisMonth.entry).toBe(sim.world.park.income.entry);
    // The scenario's carousel and drinks stand cost a little to run each day; nothing else is spent.
    expect(summary.thisMonth.running).toBeGreaterThan(0);
    const month = sim.world.park.monthly;
    expect(summary.thisMonth.net).toBe(month.entry + month.rides + month.shops - month.running);
    expect(sim.world.park.income.entry).toBe(sim.world.park.totalAdmissions * 300);
  });

  it("lets thirsty guests buy drinks, so the hash is guarding stall visits too", () => {
    const { world } = runScenario(scenario());
    const stand = world.rides.find((ride) => ride.type === "drinks_stand");
    expect(stand?.stats.customers).toBeGreaterThan(0);
    expect(stand?.stats.income).toBe((stand?.stats.customers ?? 0) * 120);
    expect(world.park.income.shops).toBe(stand?.stats.income);
    const booked = world.park.history.reduce((total, r) => total + r.shops, 0);
    expect(booked + world.park.monthly.shops).toBe(world.park.income.shops);
  });

  it("lets guests choose the carousel, queue and pay, so the hash is guarding rides too", () => {
    const { world } = runScenario(scenario());
    const carousel = world.rides.find((ride) => ride.type === "carousel");
    expect(carousel?.stats.customers).toBeGreaterThan(0);
    expect(carousel?.stats.income).toBe((carousel?.stats.customers ?? 0) * 150);
    expect(world.park.income.rides).toBe(carousel?.stats.income);
    const booked = world.park.history.reduce((total, r) => total + r.rides, 0);
    expect(booked + world.park.monthly.rides).toBe(world.park.income.rides);
  });

  it("saved and reloaded while guests ride and buy, carries on exactly as a park that was not", () => {
    // Up to the 2,400 ticks with the park open, and 1,500 of them.
    const steps = scenario().steps;
    const open = steps.findIndex((step) => "tick" in step && step.tick === 2400);
    const sim = runScenario({ ...scenario(), steps: steps.slice(0, open) });
    sim.step(1500);
    const before = sim.world.rides.map((ride) => ride.stats.customers);
    const twin = new Sim(deserializeWorld(serializeWorld(sim.world)));
    expect(twin.hash()).toBe(sim.hash());
    sim.step(3000);
    twin.step(3000);
    expect(twin.hash()).toBe(sim.hash());
    // In those 3,000 ticks guests rode the carousel and bought drinks.
    const after = sim.world.rides.map((ride) => ride.stats.customers);
    expect(after.map((n, i) => n > (before[i] ?? 0))).toEqual([true, true]);
  });

  it("throws with the step number and the reason when a step fails", () => {
    const doc = parseScenario({
      world: { width: 4, height: 4, seed: 1, name: "bad" },
      steps: [{ tick: 1 }, { exec: ["terrain_raise", { x: 3, y: 3, w: 9, h: 9 }] }],
    });
    expect(() => runScenario(doc)).toThrow(/^Scenario step 1 \(terrain_raise\) failed: .+/);
  });

  it("throws when an undo has nothing to undo", () => {
    const doc = parseScenario({
      world: { width: 4, height: 4, seed: 1, name: "bad" },
      steps: [{ undo: true }],
    });
    expect(() => runScenario(doc)).toThrow(/^Scenario step 0 \(undo\) failed: .+/);
  });

  it("rejects a step it does not recognise", () => {
    expect(() =>
      parseScenario({ world: { width: 4, height: 4, seed: 1, name: "x" }, steps: [{ jump: 3 }] }),
    ).toThrow();
  });
});
