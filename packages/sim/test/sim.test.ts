import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  LOAN_MAX,
  Registry,
  Sim,
  TICKS_PER_DAY,
  createDefaultRegistry,
  createWorld,
  financeSystem,
  getCorner,
  type System,
} from "../src/index.js";

function setup(opts: { cash?: number; seed?: number } = {}) {
  const world = createWorld({ width: 8, height: 8, seed: opts.seed ?? 1, name: "t", ...opts });
  return { world, sim: new Sim(world) };
}

describe("Sim construction", () => {
  it("holds the world and a default registry with the sim and finance commands", () => {
    const { world, sim } = setup();
    expect(sim.world).toBe(world);
    const byName = new Map(sim.registry.catalog().map((e) => [e.name, e]));
    expect(byName.get("sim_advance")).toMatchObject({ category: "sim", undoable: false });
    expect(byName.get("finance_take_loan")).toMatchObject({ category: "finance", undoable: true });
    expect(byName.get("finance_repay_loan")).toMatchObject({
      category: "finance",
      undoable: true,
    });
  });

  it("uses the registry it is given", () => {
    const registry = new Registry();
    const sim = new Sim(createWorld({ width: 4, height: 4, seed: 1, name: "t" }), registry);
    expect(sim.registry).toBe(registry);
    expect(sim.execute("sim_advance", { days: 1 })).toEqual({
      ok: false,
      error: "Unknown command: sim_advance",
    });
    expect(sim.world.tick).toBe(0);
  });

  it("starts with the finance system and gives each sim its own systems list", () => {
    const a = setup().sim;
    const b = setup().sim;
    expect(a.systems).toEqual([financeSystem]);
    a.systems.push({ name: "extra", tick: () => {} });
    expect(b.systems).toEqual([financeSystem]);
  });
});

describe("Sim.step", () => {
  it("advances the tick by the number of ticks, 1 by default", () => {
    const { world, sim } = setup();
    sim.step(5);
    expect(world.tick).toBe(5);
    sim.step();
    expect(world.tick).toBe(6);
    sim.step(0);
    expect(world.tick).toBe(6);
  });

  it("rejects a tick count that is negative or not an integer", () => {
    const { world, sim } = setup();
    expect(() => sim.step(-1)).toThrow(RangeError);
    expect(() => sim.step(1.5)).toThrow(RangeError);
    expect(() => sim.step(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(world.tick).toBe(0);
  });

  it("increments the tick first, then runs every system in order with the new tick", () => {
    const { sim } = setup();
    const seen: Array<[string, number]> = [];
    const spy = (name: string): System => ({ name, tick: (w) => seen.push([name, w.tick]) });
    sim.systems = [spy("a"), spy("b")];
    sim.step(2);
    expect(seen).toEqual([
      ["a", 1],
      ["b", 1],
      ["a", 2],
      ["b", 2],
    ]);
  });
});

describe("Sim.advanceDays and the finance system", () => {
  it("advances 400 ticks per day", () => {
    const { world, sim } = setup();
    sim.advanceDays(3);
    expect(world.tick).toBe(3 * TICKS_PER_DAY);
  });

  it("charges a month of loan interest once when a month starts", () => {
    const { world, sim } = setup();
    world.finance.loan = 10_000_00;
    sim.advanceDays(31);
    // 10% a year on $10000.00 is $1000.00, so one eighth of that for a month: $125.00.
    expect(world.tick).toBe(12400);
    expect(world.finance.cash).toBe(10_000_00 - 125_00);
    expect(world.finance.loan).toBe(10_000_00);
  });

  it("charges nothing before the month starts, and again at the next month", () => {
    const { world, sim } = setup();
    world.finance.loan = 10_000_00;
    sim.step(12399);
    expect(world.finance.cash).toBe(10_000_00);
    sim.step(1);
    expect(world.finance.cash).toBe(10_000_00 - 125_00);
    sim.advanceDays(30);
    expect(world.finance.cash).toBe(10_000_00 - 125_00);
    sim.advanceDays(1);
    expect(world.finance.cash).toBe(10_000_00 - 250_00);
  });

  it("charges interest first, then records the month-start cash", () => {
    const { world, sim } = setup();
    world.finance.loan = 10_000_00;
    expect(world.finance.monthStart.cash).toBe(10_000_00);
    sim.advanceDays(31);
    expect(world.finance.monthStart.cash).toBe(10_000_00 - 125_00);
    expect(world.finance.monthStart.cash).toBe(world.finance.cash);
  });

  it("rounds interest down to a whole cent and lets cash go negative", () => {
    const { world, sim } = setup({ cash: 0 });
    world.finance.loan = 1_001; // 1001 * 10 / 100 / 8 = 12.5125
    sim.advanceDays(31);
    expect(world.finance.cash).toBe(-12);
    expect(world.finance.monthStart.cash).toBe(-12);
  });

  it("charges nothing with no loan, but still records the month-start cash", () => {
    const { world, sim } = setup();
    world.finance.cash = 7_000_00;
    sim.advanceDays(31);
    expect(world.finance.cash).toBe(7_000_00);
    expect(world.finance.monthStart.cash).toBe(7_000_00);
  });
});

describe("sim_advance", () => {
  it("rejects more than 3650 days and fewer than 1", () => {
    const { world, sim } = setup();
    const tooMany = sim.execute("sim_advance", { days: 4000 });
    expect(tooMany.ok).toBe(false);
    expect(tooMany).toMatchObject({ error: expect.stringContaining("days") });
    expect(sim.execute("sim_advance", { days: 0 }).ok).toBe(false);
    expect(sim.execute("sim_advance", { days: 1.5 }).ok).toBe(false);
    expect(sim.execute("sim_advance", {}).ok).toBe(false);
    expect(world.tick).toBe(0);
    expect(world.log).toEqual([]);
  });

  it("advances the days and logs an entry at the tick it was issued", () => {
    const { world, sim } = setup();
    sim.step(7);
    const result = sim.execute("sim_advance", { days: 2 });
    expect(result).toEqual({ ok: true, id: 1, cost: 0 });
    expect(world.tick).toBe(7 + 800);
    expect(world.log).toEqual([
      { id: 1, tick: 7, client: "player", name: "sim_advance", input: { days: 2 }, cost: 0 },
    ]);
  });

  it("accepts the largest advance", () => {
    const { world, sim } = setup();
    expect(sim.execute("sim_advance", { days: 3650 }).ok).toBe(true);
    expect(world.tick).toBe(3650 * TICKS_PER_DAY);
  });

  it("records the client and is not undoable", () => {
    const { world, sim } = setup();
    sim.execute("sim_advance", { days: 1 }, "agent");
    expect(world.log[0]?.client).toBe("agent");
    expect(world.undoStack).toEqual([]);
    expect(sim.undo()).toEqual({ ok: false, error: "Nothing to undo" });
    expect(world.tick).toBe(TICKS_PER_DAY);
  });

  it("charges loan interest on the days it advances", () => {
    const { world, sim } = setup();
    world.finance.loan = 10_000_00;
    sim.execute("sim_advance", { days: 62 });
    expect(world.finance.cash).toBe(10_000_00 - 2 * 125_00);
  });
});

describe("Sim.execute, undo, redo", () => {
  it("runs terrain commands, with the client defaulting to player", () => {
    const { world, sim } = setup();
    const result = sim.execute("terrain_raise", { x: 0, y: 0, w: 1, h: 1 });
    expect(result).toEqual({ ok: true, id: 1, cost: 4 * 50_00 });
    expect(world.log[0]?.client).toBe("player");
    expect(getCorner(world.terrain, 0, 0)).toBe(9);
  });

  it("undoes a command after time has passed; the last log entry is the undo", () => {
    const { world, sim } = setup();
    sim.execute("terrain_raise", { x: 0, y: 0, w: 1, h: 1 });
    expect(world.finance.cash).toBe(10_000_00 - 200_00);
    sim.advanceDays(1);
    const undone = sim.undo();
    expect(undone).toEqual({ ok: true, id: 2, cost: -200_00 });
    expect(world.log[world.log.length - 1]).toMatchObject({ name: "undo", input: { target: 1 } });
    expect(world.finance.cash).toBe(10_000_00);
    expect(getCorner(world.terrain, 0, 0)).toBe(8);
    expect(world.tick).toBe(TICKS_PER_DAY);
  });

  it("redoes an undone command and passes the client through", () => {
    const { world, sim } = setup();
    sim.execute("terrain_raise", { x: 0, y: 0, w: 1, h: 1 });
    sim.undo("agent");
    expect(world.log[1]?.client).toBe("agent");
    const redone = sim.redo("replay");
    expect(redone).toEqual({ ok: true, id: 3, cost: 200_00 });
    expect(world.log[2]).toMatchObject({ name: "redo", client: "replay" });
    expect(getCorner(world.terrain, 0, 0)).toBe(9);
  });

  it("reports unknown commands and nothing to undo or redo", () => {
    const { sim } = setup();
    expect(sim.execute("nope_nothing", {})).toEqual({
      ok: false,
      error: "Unknown command: nope_nothing",
    });
    expect(sim.undo()).toEqual({ ok: false, error: "Nothing to undo" });
    expect(sim.redo()).toEqual({ ok: false, error: "Nothing to redo" });
  });
});

describe("Sim.query", () => {
  it("runs a registered query", () => {
    const registry = createDefaultRegistry();
    registry.registerQuery({
      name: "test_peek_cash",
      description: "Reads the cash.",
      category: "finance",
      input: z.object({}),
      run: (world) => world.finance.cash,
    });
    const sim = new Sim(createWorld({ width: 4, height: 4, seed: 1, name: "t" }), registry);
    expect(sim.query("test_peek_cash", {})).toEqual({ ok: true, result: 10_000_00 });
  });

  it("reports an unknown query", () => {
    const { sim } = setup();
    expect(sim.query("nope_nothing", {})).toEqual({
      ok: false,
      error: "Unknown query: nope_nothing",
    });
  });
});

describe("Sim.hash", () => {
  function run(seed: number): Sim {
    const sim = new Sim(createWorld({ width: 8, height: 8, seed, name: "t" }));
    sim.execute("terrain_raise", { x: 1, y: 1, w: 3, h: 2 });
    sim.execute("finance_take_loan", { amount: 5_000_00 });
    sim.execute("terrain_set_surface", { x: 0, y: 0, w: 2, h: 2, surface: 2 });
    sim.step(1000);
    sim.execute("sim_advance", { days: 40 });
    sim.undo();
    return sim;
  }

  it("is equal for two sims given the same seed, commands, and ticks", () => {
    const a = run(7);
    const b = run(7);
    expect(a.hash()).toBe(b.hash());
    expect(a.hash()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("differs when the seed, the tick, or the commands differ", () => {
    const a = run(7);
    expect(run(8).hash()).not.toBe(a.hash());
    const stepped = run(7);
    stepped.step(1);
    expect(stepped.hash()).not.toBe(a.hash());
    const extra = run(7);
    extra.execute("terrain_lower", { x: 6, y: 6, w: 1, h: 1 });
    expect(extra.hash()).not.toBe(a.hash());
  });
});

describe("finance_take_loan", () => {
  it("adds the amount to the loan and to the cash", () => {
    const { world, sim } = setup();
    expect(sim.execute("finance_take_loan", { amount: 2_000_00 })).toMatchObject({
      ok: true,
      cost: 0,
    });
    expect(world.finance.loan).toBe(2_000_00);
    expect(world.finance.cash).toBe(12_000_00);
  });

  it("allows a loan up to 50000.00 in total, and no more", () => {
    const { world, sim } = setup();
    expect(LOAN_MAX).toBe(50_000_00);
    expect(sim.execute("finance_take_loan", { amount: 30_000_00 }).ok).toBe(true);
    expect(sim.execute("finance_take_loan", { amount: 20_000_01 })).toEqual({
      ok: false,
      error: "Loan limit is $50000.00",
    });
    expect(sim.execute("finance_take_loan", { amount: 20_000_00 }).ok).toBe(true);
    expect(world.finance.loan).toBe(LOAN_MAX);
    expect(sim.execute("finance_take_loan", { amount: 100 })).toEqual({
      ok: false,
      error: "Loan limit is $50000.00",
    });
  });

  it("rejects an amount under 100, over the limit, or not a whole number of cents", () => {
    const { world, sim } = setup();
    expect(sim.execute("finance_take_loan", { amount: 99 }).ok).toBe(false);
    expect(sim.execute("finance_take_loan", { amount: LOAN_MAX + 1 }).ok).toBe(false);
    expect(sim.execute("finance_take_loan", { amount: 100.5 }).ok).toBe(false);
    expect(sim.execute("finance_take_loan", {}).ok).toBe(false);
    expect(world.finance.loan).toBe(0);
    expect(world.log).toEqual([]);
  });

  it("is undone by taking the amount back, and redone", () => {
    const { world, sim } = setup();
    sim.execute("finance_take_loan", { amount: 2_000_00 });
    expect(sim.undo().ok).toBe(true);
    expect(world.finance.loan).toBe(0);
    expect(world.finance.cash).toBe(10_000_00);
    expect(sim.redo().ok).toBe(true);
    expect(world.finance.loan).toBe(2_000_00);
    expect(world.finance.cash).toBe(12_000_00);
  });

  it("cannot be undone if the park no longer has the cash to give back", () => {
    const { world, sim } = setup({ cash: 0 });
    sim.execute("finance_take_loan", { amount: 1_000_00 });
    sim.advanceDays(31); // interest of $12.50 leaves $987.50
    const before = sim.hash();
    expect(sim.undo()).toEqual({ ok: false, error: "Not enough cash to undo this loan" });
    expect(sim.hash()).toBe(before);
    expect(world.finance.loan).toBe(1_000_00);
  });
});

describe("finance_repay_loan", () => {
  function withLoan(loan: number, cash?: number) {
    const made = setup(cash === undefined ? {} : { cash });
    made.sim.execute("finance_take_loan", { amount: loan });
    return made;
  }

  it("subtracts the amount from the loan and from the cash", () => {
    const { world, sim } = withLoan(5_000_00);
    expect(sim.execute("finance_repay_loan", { amount: 2_000_00 })).toMatchObject({
      ok: true,
      cost: 0,
    });
    expect(world.finance.loan).toBe(3_000_00);
    expect(world.finance.cash).toBe(13_000_00);
  });

  it("can repay the whole loan", () => {
    const { world, sim } = withLoan(5_000_00);
    expect(sim.execute("finance_repay_loan", { amount: 5_000_00 }).ok).toBe(true);
    expect(world.finance.loan).toBe(0);
  });

  it("rejects more than is owed", () => {
    const { world, sim } = withLoan(2_000_00);
    expect(sim.execute("finance_repay_loan", { amount: 5_000_00 })).toEqual({
      ok: false,
      error: "You only owe $2000.00",
    });
    expect(sim.execute("finance_repay_loan", { amount: 2_000_01 }).ok).toBe(false);
    expect(world.finance.loan).toBe(2_000_00);
  });

  it("rejects repaying with no loan", () => {
    const { sim } = setup();
    expect(sim.execute("finance_repay_loan", { amount: 100 })).toEqual({
      ok: false,
      error: "You only owe $0.00",
    });
  });

  it("rejects more than the cash on hand", () => {
    const { world, sim } = withLoan(5_000_00, 0);
    world.finance.cash = 100_00;
    expect(sim.execute("finance_repay_loan", { amount: 200_00 })).toEqual({
      ok: false,
      error: "Not enough cash to repay",
    });
    expect(world.finance.cash).toBe(100_00);
    expect(world.finance.loan).toBe(5_000_00);
  });

  it("rejects an amount under 100 cents", () => {
    const { sim } = withLoan(5_000_00);
    expect(sim.execute("finance_repay_loan", { amount: 99 }).ok).toBe(false);
  });

  it("is undone by adding the amount back to the loan and the cash, and redone", () => {
    const { world, sim } = withLoan(5_000_00);
    sim.execute("finance_repay_loan", { amount: 2_000_00 });
    expect(sim.undo().ok).toBe(true);
    expect(world.finance.loan).toBe(5_000_00);
    expect(world.finance.cash).toBe(15_000_00);
    expect(sim.redo().ok).toBe(true);
    expect(world.finance.loan).toBe(3_000_00);
    expect(world.finance.cash).toBe(13_000_00);
  });
});
