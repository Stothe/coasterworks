import { describe, expect, it } from "vitest";
import {
  createDefaultRegistry,
  createWorld,
  hashWorld,
  type CommandDef,
  type World,
} from "../src/index.js";
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
  });
});
