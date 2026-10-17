import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseScenario, runScenario } from "./golden/run.js";

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
      "park_set_entrance",
      "park_set_entry_fee",
      "park_open",
      "park_close",
      "park_rename",
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
    // 120 ticks, then 70 days, then 2,400 ticks and 31 days with the park open, then 400 shut.
    expect(sim.world.tick).toBe(120 + 70 * 400 + 2400 + 31 * 400 + 400);
    expect(sim.world.log.some((entry) => entry.name === "undo")).toBe(true);
  });

  it("lays the paths and sets up the park, so the hash is not guarding a no-op", () => {
    const { world } = runScenario(scenario());
    // The foot path ran (16, 25..30); its first tile was removed and its last two became a queue.
    const path = (x: number, y: number) => world.terrain.path[y * 32 + x];
    expect([25, 26, 27, 28, 29, 30].map((y) => path(16, y))).toEqual([0, 1, 1, 1, 2, 2]);
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

    // Closing the park and waiting 400 ticks is the end of the scenario, and empties the park.
    sim.execute("park_close", {});
    sim.step(400);
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
      thisMonth: { entry: number; net: number };
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
    expect(summary.thisMonth.net).toBe(summary.thisMonth.entry);
    expect(sim.world.park.income.entry).toBe(sim.world.park.totalAdmissions * 300);
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
