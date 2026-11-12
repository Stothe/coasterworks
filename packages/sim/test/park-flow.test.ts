import { describe, expect, it } from "vitest";
import {
  GuestState,
  Sim,
  THOUGHT,
  createWorld,
  type MonthRecord,
  type World,
} from "../src/index.js";
import { findGuest, spawnGuest } from "../src/guests/guests.js";
import { DEST_TURNED_AWAY } from "../src/guests/types.js";
import { ENTRANCE, at, makePark, placeGuest, run, stepUntil } from "./helpers/guests.js";

/** The flat index of the entrance of `makePark`, on a map 16 tiles wide. */
const ENTRANCE_INDEX = ENTRANCE.y * 16 + ENTRANCE.x;

const MONTH = 12_400;

/** The states of the live guests, in slot order. */
function liveStates(world: World): number[] {
  const out: number[] = [];
  for (let slot = 0; slot < world.guests.live.length; slot++) {
    if (at(world.guests.live, slot) === 1) out.push(at(world.guests.state, slot));
  }
  return out;
}

/** The ids of the live guests who are in `states`. */
function idsIn(world: World, ...states: number[]): number[] {
  const out: number[] = [];
  for (let slot = 0; slot < world.guests.live.length; slot++) {
    if (at(world.guests.live, slot) === 1 && states.includes(at(world.guests.state, slot))) {
      out.push(at(world.guests.id, slot));
    }
  }
  return out;
}

function summary(sim: Sim): FinanceSummary {
  const out = sim.query("finance_summary", {});
  if (!out.ok) throw new Error(out.error);
  return out.result as FinanceSummary;
}

type MonthFigures = Omit<MonthRecord, "year" | "month">;

interface FinanceSummary {
  cash: number;
  loan: number;
  thisMonth: MonthFigures;
  lastMonth: MonthRecord | null;
  history: MonthRecord[];
}

/** A park that has been open long enough to have guests wandering in it. */
function busyPark(): Sim {
  const sim = makePark({ rating: 500, fee: 3_00 });
  sim.step(2000);
  return sim;
}

describe("an open park", () => {
  it("brings guests over 2,000 ticks, and each pays the fee once", () => {
    const sim = makePark({ rating: 500, fee: 3_00 });
    const { world } = sim;
    const cash = world.finance.cash;
    sim.step(2000);

    const { park } = world;
    expect(park.totalAdmissions).toBeGreaterThan(5);
    expect(park.guestsInPark).toBeGreaterThan(0);
    expect(park.income.entry).toBe(park.totalAdmissions * 3_00);
    expect(park.monthly.entry).toBe(park.income.entry);
    // The gate takings are the only money that moved.
    expect(world.finance.cash).toBe(cash + park.income.entry);
  });
});

describe("closing the park", () => {
  it("sends every guest inside home at once, thinking the park is closed", () => {
    const sim = busyPark();
    const { world } = sim;
    const inside = idsIn(world, GuestState.WANDERING, GuestState.HEADING);
    expect(inside.length).toBeGreaterThan(3);

    run(sim, "park_close", {});

    expect(world.park.open).toBe(false);
    // Nobody inside is left wandering about; the only guests not leaving are those still
    // outside the gate, who are turned away when they reach it.
    for (const state of liveStates(world)) {
      expect([GuestState.ENTERING, GuestState.LEAVING]).toContain(state);
    }
    for (const id of inside) {
      const slot = findGuest(world, id);
      expect(at(world.guests.state, slot), `guest ${id}`).toBe(GuestState.LEAVING);
      expect(at(world.guests.dest, slot), `guest ${id}`).toBe(ENTRANCE_INDEX);
      expect(at(world.guests.thought, slot), `guest ${id}`).toBe(THOUGHT.PARK_CLOSED);
      expect(at(world.guests.thoughtTick, slot), `guest ${id}`).toBe(world.tick);
    }
  });

  it("empties the park within 3,000 ticks, takes nothing more, and refunds nothing", () => {
    const sim = busyPark();
    const { world } = sim;
    expect(world.park.guestsInPark).toBeGreaterThan(3);
    const takings = { ...world.park.income };
    const admissions = world.park.totalAdmissions;

    const cash = world.finance.cash;

    run(sim, "park_close", {});
    stepUntil(sim, () => world.park.guestsInPark === 0, 3000);
    // Guests turned away at the gate are not in the park but are still walking off.
    stepUntil(sim, () => world.guests.count === 0, 3000);

    expect(world.park.totalAdmissions).toBe(admissions);
    expect(world.park.income).toEqual(takings);
    expect(world.finance.cash).toBe(cash);
    expect(world.park.guestsInPark).toBe(0);
  });

  it("empties a big crowd just as fast: everyone walks out the way they came in", () => {
    const sim = makePark({ rating: 0 });
    const { world } = sim;
    for (let y = 5; y <= 22; y++) {
      placeGuest(world, { x: 8, y }, y % 2 === 0 ? GuestState.WANDERING : GuestState.HEADING, {
        dest: y % 2 === 0 ? -1 : 4 * 16 + 8,
      });
    }
    sim.step(50);
    expect(world.park.guestsInPark).toBe(18);

    run(sim, "park_close", {});
    // The farthest guest is under 20 tiles from the gate, and a tile takes 16 ticks.
    const ticks = stepUntil(sim, () => world.park.guestsInPark === 0, 3000);
    expect(ticks).toBeLessThan(500);
    stepUntil(sim, () => world.guests.count === 0, 100);
  });

  it("turns away a guest who reaches the gate after the park has closed", () => {
    const sim = makePark({ rating: 500 });
    const { world } = sim;
    // Run until someone is outside the gate, then close with them still on the way in.
    stepUntil(sim, () => idsIn(world, GuestState.ENTERING).length > 0, 3000);
    const [id] = idsIn(world, GuestState.ENTERING) as [number];

    run(sim, "park_close", {});
    const admissions = world.park.totalAdmissions;
    expect(at(world.guests.state, findGuest(world, id))).toBe(GuestState.ENTERING);

    stepUntil(sim, () => findGuest(world, id) < 0, 100);
    expect(world.park.totalAdmissions).toBe(admissions);
  });

  it("sends a lost guest home as well", () => {
    const sim = makePark({ rating: 0 });
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 10 }, GuestState.LOST);
    const id = at(world.guests.id, slot);

    run(sim, "park_close", {});

    const now = findGuest(world, id);
    expect(at(world.guests.state, now)).toBe(GuestState.LEAVING);
    expect(at(world.guests.thought, now)).toBe(THOUGHT.PARK_CLOSED);
    stepUntil(sim, () => findGuest(world, id) < 0, 500);
    expect(world.park.guestsInPark).toBe(0);
  });

  it("lets the rating settle back to 500 once the park is empty", () => {
    const sim = busyPark();
    const { world } = sim;
    sim.step(2000);
    expect(world.park.rating).not.toBe(500);

    run(sim, "park_close", {});
    stepUntil(sim, () => world.guests.count === 0, 3000);
    // With no one in the park the rating moves a sixteenth of the way home each day.
    sim.step(400 * 150);
    expect(world.park.rating).toBe(500);
  });

  it("undoes to an open park, but the guests who were sent home keep leaving", () => {
    const sim = makePark({ rating: 0 });
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING);
    const id = at(world.guests.id, slot);
    run(sim, "park_close", {});
    expect(world.park.open).toBe(false);

    expect(sim.undo().ok).toBe(true);
    expect(world.park.open).toBe(true);
    expect(at(world.guests.state, findGuest(world, id))).toBe(GuestState.LEAVING);
    expect(sim.redo().ok).toBe(true);
    expect(world.park.open).toBe(false);
  });

  it("sends home guests it finds inside a park that is already closed", () => {
    // As in a save from before closing the park emptied it.
    const sim = makePark({ rating: 0, open: false });
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING);
    const id = at(world.guests.id, slot);

    run(sim, "park_close", {});

    expect(world.park.open).toBe(false);
    expect(at(world.guests.state, findGuest(world, id))).toBe(GuestState.LEAVING);
    stepUntil(sim, () => world.guests.count === 0, 500);
  });
});

describe("reopening the park", () => {
  it("does not charge a guest again who was inside when it closed", () => {
    const sim = makePark({ rating: 0 });
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING, { cash: 50_00 });
    const id = at(world.guests.id, slot);
    expect(world.park.totalAdmissions).toBe(0);

    run(sim, "park_close", {});
    sim.step(20);
    run(sim, "park_open", {});
    expect(world.park.open).toBe(true);
    const cash = world.finance.cash;

    // The guest is still on its way out, in a park that is open again. It does not pay a second
    // time, and it does not turn round.
    for (let t = 0; t < 600 && findGuest(world, id) >= 0; t++) {
      const now = findGuest(world, id);
      expect(at(world.guests.state, now)).toBe(GuestState.LEAVING);
      expect(at(world.guests.cash, now)).toBe(50_00);
      sim.step(1);
    }
    expect(findGuest(world, id)).toBe(-1);
    expect(world.park.totalAdmissions).toBe(0);
    expect(world.park.income.entry).toBe(0);
    expect(world.park.monthly.entry).toBe(0);
    expect(world.finance.cash).toBe(cash);
    expect(world.park.guestsInPark).toBe(0);
  });

  it("takes new guests as it did before, each paying once", () => {
    const sim = busyPark();
    const { world } = sim;
    run(sim, "park_close", {});
    stepUntil(sim, () => world.guests.count === 0, 3000);
    const admissions = world.park.totalAdmissions;

    run(sim, "park_open", {});
    sim.step(2000);

    expect(world.park.totalAdmissions).toBeGreaterThan(admissions);
    expect(world.park.income.entry).toBe(world.park.totalAdmissions * 3_00);
    expect(world.park.guestsInPark).toBeGreaterThan(0);
  });

  it("does not charge a guest who was turned away at the gate while it was shut", () => {
    const sim = makePark({ rating: 0 });
    const { world } = sim;
    const slot = spawnGuest(world, world.rngStreams.guests);
    const id = at(world.guests.id, slot);
    const wallet = at(world.guests.cash, slot);

    run(sim, "park_close", {});
    sim.step(17);
    const turned = findGuest(world, id);
    expect(at(world.guests.state, turned)).toBe(GuestState.LEAVING);
    expect(at(world.guests.dest, turned)).toBe(DEST_TURNED_AWAY);
    run(sim, "park_open", {});
    const cash = world.finance.cash;

    // It is on its way out of a park that is open again; the gate has no second chance for it.
    for (let t = 0; t < 100 && findGuest(world, id) >= 0; t++) {
      expect(at(world.guests.cash, findGuest(world, id))).toBe(wallet);
      sim.step(1);
    }
    expect(findGuest(world, id)).toBe(-1);
    expect(world.park.totalAdmissions).toBe(0);
    expect(world.park.income.entry).toBe(0);
    expect(world.finance.cash).toBe(cash);
  });
});

describe("the month rolling over", () => {
  /** A closed, empty park, so only the takings the test sets are in the books. */
  function emptyPark(): Sim {
    return makePark({ rating: 0, open: false });
  }

  it("moves the month's takings into history at the first tick of the next month", () => {
    const sim = emptyPark();
    const { world } = sim;
    world.park.monthly = { entry: 10_00, rides: 2_00, shops: 3_00, running: 4_00, wages: 1_00 };

    sim.step(MONTH - 1);
    expect(world.park.history).toEqual([]);
    expect(world.park.monthly.entry).toBe(10_00);

    sim.step(1);
    expect(world.park.history).toEqual([
      {
        year: 1,
        month: 0,
        entry: 10_00,
        rides: 2_00,
        shops: 3_00,
        running: 4_00,
        wages: 1_00,
        net: 10_00 + 2_00 + 3_00 - 4_00 - 1_00,
      },
    ]);
    expect(world.park.monthly).toEqual({ entry: 0, rides: 0, shops: 0, running: 0, wages: 0 });
  });

  it("leaves the all-time totals alone, and starts the new month's cash where it stands", () => {
    const sim = emptyPark();
    const { world } = sim;
    world.park.income.entry = 99_00;
    world.park.monthly.entry = 10_00;
    sim.step(MONTH);
    expect(world.park.income.entry).toBe(99_00);
    expect(world.finance.monthStart.cash).toBe(world.finance.cash);
  });

  it("counts a fee paid on the first tick of the month in the new month", () => {
    // Shut until the last moment, so no arrivals are in the books and the one guest below is alone.
    const sim = makePark({ rating: 0, fee: 3_00, open: false });
    const { world } = sim;
    sim.step(MONTH - 1);
    run(sim, "park_open", {});
    // A guest at the gate pays as soon as it is its turn: on the tick the month turns.
    placeGuest(world, { x: ENTRANCE.x, y: ENTRANCE.y }, GuestState.ENTERING);

    sim.step(1);

    expect(world.tick).toBe(MONTH);
    expect(world.park.totalAdmissions).toBe(1);
    expect(world.park.history).toHaveLength(1);
    expect(world.park.history[0]?.entry).toBe(0);
    expect(world.park.monthly.entry).toBe(3_00);
    expect(world.park.income.entry).toBe(3_00);
  });

  it("names the month that ended, through the end of the year and into the next", () => {
    const sim = emptyPark();
    const { world } = sim;
    for (let i = 0; i < 9; i++) {
      world.park.monthly.entry = 100 * (i + 1);
      sim.step(MONTH);
    }
    expect(world.park.history.map((r) => [r.year, r.month, r.entry])).toEqual([
      [1, 0, 100],
      [1, 1, 200],
      [1, 2, 300],
      [1, 3, 400],
      [1, 4, 500],
      [1, 5, 600],
      [1, 6, 700],
      [1, 7, 800],
      [2, 0, 900],
    ]);
  });

  it("keeps the last twelve months, dropping the oldest", () => {
    const sim = emptyPark();
    const { world } = sim;
    for (let i = 0; i < 14; i++) {
      world.park.monthly.entry = 100 * (i + 1);
      sim.step(MONTH);
    }
    expect(world.park.history).toHaveLength(12);
    expect(world.park.history.map((r) => r.entry)).toEqual(
      Array.from({ length: 12 }, (_, i) => 100 * (i + 3)),
    );
    expect(world.park.history[0]).toMatchObject({ year: 1, month: 2 });
    expect(world.park.history[11]).toMatchObject({ year: 2, month: 5 });
  });

  it("books a loss as a negative net", () => {
    const sim = emptyPark();
    const { world } = sim;
    world.park.monthly = { entry: 1_00, rides: 0, shops: 0, running: 6_00, wages: 2_00 };
    sim.step(MONTH);
    expect(world.park.history[0]?.net).toBe(-7_00);
  });

  it("records the guests' gate money, and starts the next month with only what comes in after", () => {
    const sim = makePark({ rating: 500, fee: 3_00 });
    const { world } = sim;
    sim.step(MONTH - 1);
    const taken = world.park.monthly.entry;
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBe(world.park.income.entry);

    sim.step(2000);
    expect(world.park.history).toHaveLength(1);
    expect(world.park.history[0]).toMatchObject({ entry: taken, net: taken, year: 1, month: 0 });
    // The all-time total kept counting; the month holds only what came in since the turn.
    expect(world.park.monthly.entry).toBe(world.park.income.entry - taken);
    expect(world.park.monthly.entry).toBeGreaterThan(0);
    expect(world.park.income.entry).toBe(world.park.totalAdmissions * 3_00);
  });
});

describe("finance_summary", () => {
  it("is a query of the finance category that changes nothing", () => {
    const sim = makePark({ open: false });
    const entry = sim.registry.catalog().find((e) => e.name === "finance_summary");
    expect(entry).toMatchObject({ kind: "query", category: "finance", undoable: false });
    const before = sim.hash();
    const logged = sim.world.log.length;
    summary(sim);
    expect(sim.hash()).toBe(before);
    expect(sim.world.log).toHaveLength(logged);
  });

  it("reports the money, this month so far, and no past months in a new park", () => {
    const world = createWorld({ width: 8, height: 8, seed: 3, name: "Fin", cash: 1_000_00 });
    const sim = new Sim(world);
    sim.execute("finance_take_loan", { amount: 500_00 });
    world.park.monthly = { entry: 9_00, rides: 1_00, shops: 2_00, running: 5_00, wages: 3_00 };

    expect(sim.query("finance_summary", {})).toEqual({
      ok: true,
      result: {
        cash: 1_500_00,
        loan: 500_00,
        thisMonth: { entry: 9_00, rides: 1_00, shops: 2_00, running: 5_00, wages: 3_00, net: 4_00 },
        lastMonth: null,
        history: [],
      },
    });
  });

  it("gives the month that just ended as lastMonth, and the months so far as history", () => {
    const sim = makePark({ rating: 0, open: false });
    const { world } = sim;
    world.park.monthly = { entry: 20_00, rides: 0, shops: 0, running: 5_00, wages: 0 };
    sim.step(MONTH);
    world.park.monthly = { entry: 7_00, rides: 1_00, shops: 0, running: 0, wages: 0 };

    const out = summary(sim);
    expect(out.history).toEqual([
      { year: 1, month: 0, entry: 20_00, rides: 0, shops: 0, running: 5_00, wages: 0, net: 15_00 },
    ]);
    expect(out.lastMonth).toEqual(out.history[0]);
    expect(out.thisMonth).toEqual({
      entry: 7_00,
      rides: 1_00,
      shops: 0,
      running: 0,
      wages: 0,
      net: 8_00,
    });

    world.park.monthly = { entry: 1_00, rides: 0, shops: 0, running: 0, wages: 0 };
    sim.step(MONTH);
    const later = summary(sim);
    expect(later.history.map((r) => r.month)).toEqual([0, 1]);
    expect(later.lastMonth).toEqual(later.history[1]);
    expect(later.lastMonth?.entry).toBe(1_00);
    expect(later.thisMonth).toEqual({
      entry: 0,
      rides: 0,
      shops: 0,
      running: 0,
      wages: 0,
      net: 0,
    });
  });

  it("returns copies, so a client cannot change the books by changing the answer", () => {
    const sim = makePark({ rating: 0, open: false });
    const { world } = sim;
    world.park.monthly.entry = 5_00;
    sim.step(MONTH);
    const out = summary(sim);
    out.history.push({
      year: 9,
      month: 9,
      entry: 1,
      rides: 1,
      shops: 1,
      running: 1,
      wages: 1,
      net: 1,
    });
    (out.history[0] as MonthRecord).entry = 123;
    (out.lastMonth as MonthRecord).entry = 456;
    expect(world.park.history).toHaveLength(1);
    expect(world.park.history[0]?.entry).toBe(5_00);
  });

  it("agrees with park_status about the month so far, which has no history of its own", () => {
    const sim = busyPark();
    const status = sim.query("park_status", {});
    if (!status.ok) throw new Error(status.error);
    const park = status.result as { monthly: Record<string, number> };
    const { thisMonth, cash, loan } = summary(sim);
    expect(thisMonth).toEqual({ ...park.monthly, net: park.monthly["entry"] });
    expect(status.result).not.toHaveProperty("history");
    expect(cash).toBe(sim.world.finance.cash);
    expect(loan).toBe(0);
  });
});
