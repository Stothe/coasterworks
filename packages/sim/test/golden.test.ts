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
    // 120 ticks, then 70 days, then 400 ticks.
    expect(sim.world.tick).toBe(120 + 70 * 400 + 400);
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
      entryFee: 500,
      entrance: { x: 16, y: 31, side: 2 },
    });
    expect(world.pathVersion).toBeGreaterThan(0);
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
