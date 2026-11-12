import { typeById } from "@coasterworks/content";
import { describe, expect, it } from "vitest";
import type { Sim } from "../src/index.js";
import { GuestState } from "../src/guests/types.js";
import { validateWorldInvariants } from "../src/save/invariants.js";
import { DAYS_PER_MONTH, TICKS_PER_DAY, isMonthStart } from "../src/time.js";
import { at, run } from "./helpers/guests.js";
import { makeRidePark } from "./helpers/rides.js";

const MONTH = DAYS_PER_MONTH * TICKS_PER_DAY;

/**
 * The ride park (a carousel, id 1, with a queue off the footpath along x = 8) with a snack stand
 * (id 2) and a drinks stand (id 3) serving onto the footpath, everything open and guests coming in.
 */
function busyPark(): Sim {
  const sim = makeRidePark({ rating: 900, seed: 3 });
  run(sim, "stall_build", { type: "snack_stand", x: 9, y: 12, rot: 1 });
  run(sim, "stall_build", { type: "drinks_stand", x: 9, y: 16, rot: 1 });
  run(sim, "ride_open", { id: 2 });
  run(sim, "ride_open", { id: 3 });
  return sim;
}

interface Paid {
  entry: number;
  rides: number;
  shops: number;
}

/**
 * Steps `sim` one tick at a time `ticks` times, watching every guest's pocket: a guest's cash only
 * ever goes down when it pays, so each drop is a payment, put down to the gate if the guest was
 * entering, to a ride if it is now riding, and to a stall if it was buying. Returns the totals,
 * counted from the guests and not from the park's books.
 */
function stepWatchingPockets(sim: Sim, ticks: number, paid: Paid): void {
  const g = sim.world.guests;
  // By guest id: cash and state before the tick, -1 for a guest that was not there.
  const cashBefore: number[] = [];
  const stateBefore: number[] = [];
  for (let t = 0; t < ticks; t++) {
    cashBefore.fill(-1);
    // Between ticks the live guests fill slots 0 to count - 1.
    for (let slot = 0; slot < g.count; slot++) {
      cashBefore[at(g.id, slot)] = at(g.cash, slot);
      stateBefore[at(g.id, slot)] = at(g.state, slot);
    }
    sim.step(1);
    for (let slot = 0; slot < g.count; slot++) {
      const id = at(g.id, slot);
      const cash = cashBefore[id] ?? -1;
      if (cash < 0) continue;
      const was = { cash, state: stateBefore[id] as number };
      const spent = was.cash - at(g.cash, slot);
      if (spent < 0) throw new Error(`guest ${id} gained ${-spent}`);
      if (spent === 0) continue;
      if (was.state === GuestState.ENTERING) paid.entry += spent;
      else if (at(g.state, slot) === GuestState.RIDING) paid.rides += spent;
      else if (was.state === GuestState.BUYING) paid.shops += spent;
      else throw new Error(`guest ${at(g.id, slot)} paid ${spent} while in state ${was.state}`);
    }
  }
}

describe("the month's books", () => {
  it(
    "record what guests paid for rides and at stalls, and the rides' running costs",
    { timeout: 60_000 },
    () => {
      const sim = busyPark();
      const { world } = sim;
      // Through the first month as it comes; then watch the second from its first tick to the last.
      sim.step(MONTH - 1);
      expect(isMonthStart(world.tick + 1)).toBe(true);

      // The month's first tick closes the last month's books and then guests may pay, into this one.
      const paid: Paid = { entry: 0, rides: 0, shops: 0 };
      stepWatchingPockets(sim, MONTH, paid);
      expect(world.park.history).toHaveLength(1);
      expect(isMonthStart(world.tick + 1)).toBe(true);
      const stats = world.rides.map((ride) => ({ ...ride.stats }));
      sim.step(1);
      expect(world.park.history).toHaveLength(2);
      const row = world.park.history[1];

      expect(paid.rides).toBeGreaterThan(0);
      expect(paid.shops).toBeGreaterThan(0);
      expect(row?.entry).toBe(paid.entry);
      expect(row?.rides).toBe(paid.rides);
      expect(row?.shops).toBe(paid.shops);
      // The rides' own month figures say the same, and are cleared for the new month.
      expect(stats[0]?.monthIncome).toBe(paid.rides);
      expect((stats[1]?.monthIncome ?? 0) + (stats[2]?.monthIncome ?? 0)).toBe(paid.shops);
      for (const ride of world.rides) {
        expect(ride.stats.monthIncome).toBe(0);
        expect(ride.stats.monthCustomers).toBe(0);
      }
      // Every ride and stall stood all month, so the month carries exactly their running costs.
      const running = world.rides.reduce(
        (sum, ride) => sum + (typeById(ride.type)?.runningCost ?? 0),
        0,
      );
      expect(row?.running).toBe(running);
      expect(row?.net).toBe(paid.entry + paid.rides + paid.shops - running);
      expect(validateWorldInvariants(world)).toBeNull();
    },
  );
});

describe("finance_summary", () => {
  it("breaks out entry, ride and shop income and running costs, by month and by ride", () => {
    const sim = busyPark();
    const { world } = sim;
    sim.step(MONTH + 5 * TICKS_PER_DAY);
    const result = sim.query("finance_summary", {});
    if (!result.ok) throw new Error(result.error);
    const summary = result.result as Record<string, unknown>;
    const { park } = world;
    expect(summary["thisMonth"]).toEqual({
      entry: park.monthly.entry,
      rides: park.monthly.rides,
      shops: park.monthly.shops,
      running: park.monthly.running,
      wages: park.monthly.wages,
      net:
        park.monthly.entry +
        park.monthly.rides +
        park.monthly.shops -
        park.monthly.running -
        park.monthly.wages,
    });
    expect(summary["lastMonth"]).toEqual(park.history[0]);
    expect(summary["history"]).toEqual(park.history);
    expect(summary["allTime"]).toEqual({
      entry: park.income.entry,
      rides: park.income.rides,
      shops: park.income.shops,
      running: park.expenses.running,
      wages: park.expenses.wages,
    });
    const byRide = summary["rides"] as Array<Record<string, unknown>>;
    expect(byRide.map((ride) => ride["id"])).toEqual([1, 2, 3]);
    expect(byRide[0]).toEqual({
      id: 1,
      name: "Carousel 1",
      kind: "ride",
      income: world.rides[0]?.stats.income,
      customers: world.rides[0]?.stats.customers,
      runningCost: world.rides[0]?.stats.runningCost,
      monthIncome: world.rides[0]?.stats.monthIncome,
      monthCustomers: world.rides[0]?.stats.monthCustomers,
    });
    const rideIncome = byRide.filter((r) => r["kind"] === "ride");
    const shopIncome = byRide.filter((r) => r["kind"] === "stall");
    const total = (list: Array<Record<string, unknown>>, key: string) =>
      list.reduce((sum, r) => sum + (r[key] as number), 0);
    expect(total(rideIncome, "income")).toBe(park.income.rides);
    expect(total(shopIncome, "income")).toBe(park.income.shops);
    expect(total(byRide, "runningCost")).toBe(park.expenses.running);
    expect(park.income.shops).toBeGreaterThan(0);
  });
});
