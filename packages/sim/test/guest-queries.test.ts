import { describe, expect, it } from "vitest";
import { GuestState, THOUGHT, type CatalogEntry, type Sim } from "../src/index.js";
import { removeGuest } from "../src/guests/guests.js";
import { at, makePark, placeGuest } from "./helpers/guests.js";

function ok(sim: Sim, name: string, input: unknown): unknown {
  const out = sim.query(name, input);
  if (!out.ok) throw new Error(out.error);
  return out.result;
}

function error(sim: Sim, name: string, input: unknown): string {
  const out = sim.query(name, input);
  if (out.ok) throw new Error(`${name} succeeded`);
  return out.error;
}

/** A park with guests in several states: id 1 walking, 2 wandering, 3 lost, 4 leaving, 5 entering. */
function populated(): Sim {
  const sim = makePark();
  const { world } = sim;
  placeGuest(world, { x: 8, y: 12 }, GuestState.HEADING, { dest: 4 * 16 + 8 });
  placeGuest(world, { x: 8, y: 14 }, GuestState.WANDERING);
  placeGuest(world, { x: 8, y: 16 }, GuestState.LOST);
  placeGuest(world, { x: 8, y: 18 }, GuestState.LEAVING, { dest: 23 * 16 + 8 });
  const slot = placeGuest(world, { x: 8, y: 23 }, GuestState.ENTERING);
  // The fifth is still out in the lane.
  world.guests.x[slot] = 8 * 32 + 16;
  world.guests.y[slot] = 24 * 32 + 16;
  return sim;
}

describe("guest_list", () => {
  it("is empty in a park with no guests", () => {
    expect(ok(makePark(), "guest_list", {})).toEqual([]);
  });

  it("describes each guest, in the order they arrived", () => {
    const sim = makePark();
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 12 }, GuestState.WANDERING, {
      happiness: 201,
      energy: 180,
      hunger: 33,
      thirst: 44,
      bathroom: 55,
      cash: 4321,
    });
    world.guests.nausea[slot] = 7;
    world.guests.x[slot] = 8 * 32 + 20;
    world.guests.y[slot] = 12 * 32 + 3;
    const list = ok(sim, "guest_list", {}) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: 1,
      name: expect.stringMatching(/^[A-Z][a-z]+ [A-Z][a-z]+$/),
      x: 8 * 32 + 20,
      y: 12 * 32 + 3,
      tile: { x: 8, y: 12 },
      state: "wandering",
      happiness: 201,
      energy: 180,
      hunger: 33,
      thirst: 44,
      bathroom: 55,
      nausea: 7,
      cash: 4321,
      thought: null,
      ride: null,
    });
  });

  it("names every state in words", () => {
    const sim = populated();
    const list = ok(sim, "guest_list", {}) as Array<{ id: number; state: string }>;
    expect(list.map((g) => [g.id, g.state])).toEqual([
      [1, "heading"],
      [2, "wandering"],
      [3, "lost"],
      [4, "leaving"],
      [5, "entering"],
    ]);
  });

  it("gives the tile of a guest still in the off-map lane", () => {
    const list = ok(populated(), "guest_list", { state: "entering" }) as Array<{
      tile: unknown;
      y: number;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.tile).toEqual({ x: 8, y: 24 });
  });

  it("includes the thought as { id, text }, or null for none", () => {
    const sim = makePark();
    const slot = placeGuest(sim.world, { x: 8, y: 12 }, GuestState.WANDERING);
    sim.world.guests.thought[slot] = THOUGHT.HUNGRY;
    placeGuest(sim.world, { x: 8, y: 13 }, GuestState.WANDERING);
    const list = ok(sim, "guest_list", {}) as Array<{ thought: unknown }>;
    expect(list[0]?.thought).toEqual({ id: THOUGHT.HUNGRY, text: "I'm hungry" });
    expect(list[1]?.thought).toBeNull();
  });

  it("filters by state", () => {
    const sim = populated();
    const ids = (state: string) =>
      (ok(sim, "guest_list", { state }) as Array<{ id: number }>).map((g) => g.id);
    expect(ids("wandering")).toEqual([2]);
    expect(ids("heading")).toEqual([1]);
    expect(ids("lost")).toEqual([3]);
    expect(ids("leaving")).toEqual([4]);
    expect(ids("entering")).toEqual([5]);
  });

  it("names and filters guests queuing for or riding a ride", () => {
    const sim = makePark();
    const { world } = sim;
    placeGuest(world, { x: 8, y: 12 }, GuestState.WANDERING);
    const queuing = placeGuest(world, { x: 8, y: 13 }, GuestState.QUEUING);
    const riding = placeGuest(world, { x: 8, y: 14 }, GuestState.RIDING);
    world.guests.ride[queuing] = 1;
    world.guests.ride[riding] = 1;
    const ids = (state: string) =>
      (ok(sim, "guest_list", { state }) as Array<{ id: number }>).map((g) => g.id);
    expect(ids("queuing")).toEqual([2]);
    expect(ids("riding")).toEqual([3]);
    expect(ok(sim, "guest_get", { id: 2 })).toMatchObject({ state: "queuing" });
    expect(ok(sim, "guest_get", { id: 3 })).toMatchObject({ state: "riding" });
  });

  it("returns 100 by default and at most the limit", () => {
    const sim = makePark();
    for (let i = 0; i < 150; i++) placeGuest(sim.world, { x: 8, y: 10 }, GuestState.WANDERING);
    expect(ok(sim, "guest_list", {})).toHaveLength(100);
    expect(ok(sim, "guest_list", { limit: 7 })).toHaveLength(7);
    expect(ok(sim, "guest_list", { limit: 500 })).toHaveLength(150);
    const first = ok(sim, "guest_list", { limit: 3 }) as Array<{ id: number }>;
    expect(first.map((g) => g.id)).toEqual([1, 2, 3]);
  });

  it("applies the limit after the filter", () => {
    const sim = makePark();
    for (let i = 0; i < 6; i++) {
      placeGuest(sim.world, { x: 8, y: 10 }, i % 2 === 0 ? GuestState.LOST : GuestState.WANDERING);
    }
    const lost = ok(sim, "guest_list", { state: "lost", limit: 2 }) as Array<{ id: number }>;
    expect(lost.map((g) => g.id)).toEqual([1, 3]);
  });

  it("skips guests who have gone", () => {
    const sim = populated();
    removeGuest(sim.world, 1);
    const ids = (ok(sim, "guest_list", {}) as Array<{ id: number }>).map((g) => g.id);
    expect(ids).toEqual([1, 3, 4, 5]);
  });

  it("refuses a limit outside 1..500 and a state it does not know", () => {
    const sim = makePark();
    for (const limit of [0, -1, 501, 1.5, "10"]) {
      expect(error(sim, "guest_list", { limit }), String(limit)).toMatch(/^limit /);
    }
    expect(error(sim, "guest_list", { state: "gone" })).toMatch(/^state /);
    expect(error(sim, "guest_list", { state: "sleeping" })).toMatch(/^state /);
  });

  it("is plain JSON that cannot be used to change the park", () => {
    const sim = populated();
    const list = ok(sim, "guest_list", {}) as Array<{ happiness: number; tile: { x: number } }>;
    expect(JSON.parse(JSON.stringify(list))).toEqual(list);
    const before = at(sim.world.guests.happiness, 0);
    (list[0] as { happiness: number }).happiness = 0;
    (list[0] as { tile: { x: number } }).tile.x = 99;
    expect(at(sim.world.guests.happiness, 0)).toBe(before);
    expect(ok(sim, "guest_get", { id: 1 })).toMatchObject({ tile: { x: 8 } });
  });
});

describe("guest_get", () => {
  it("returns one guest by id, the same as the list does", () => {
    const sim = populated();
    const list = ok(sim, "guest_list", {}) as Array<{ id: number }>;
    for (const guest of list) expect(ok(sim, "guest_get", { id: guest.id })).toEqual(guest);
  });

  it("finds a guest by id, not by slot", () => {
    const sim = populated();
    removeGuest(sim.world, 0);
    expect(ok(sim, "guest_get", { id: 3 })).toMatchObject({ id: 3, state: "lost" });
    expect(error(sim, "guest_get", { id: 1 })).toBe("No guest with id 1");
  });

  it("says when there is no such guest", () => {
    const sim = makePark();
    expect(error(sim, "guest_get", { id: 7 })).toBe("No guest with id 7");
    expect(error(populated(), "guest_get", { id: 6 })).toBe("No guest with id 6");
  });

  it("refuses an id that is not a positive whole number", () => {
    const sim = makePark();
    for (const id of [0, -3, 1.5, "1", null]) {
      expect(error(sim, "guest_get", { id }), String(id)).toMatch(/^id /);
    }
    expect(error(sim, "guest_get", {})).toMatch(/^id /);
  });
});

describe("guest_thoughts", () => {
  function thinking(): Sim {
    const sim = makePark();
    const thoughts = [
      THOUGHT.HUNGRY,
      THOUGHT.HUNGRY,
      THOUGHT.HUNGRY,
      THOUGHT.LOST,
      THOUGHT.TIRED,
      THOUGHT.LOST,
      THOUGHT.TIRED,
      THOUGHT.NONE,
      THOUGHT.NICE_VIEW,
    ];
    for (const thought of thoughts) {
      const slot = placeGuest(sim.world, { x: 8, y: 10 }, GuestState.WANDERING);
      sim.world.guests.thought[slot] = thought;
    }
    return sim;
  }

  it("counts what the guests are thinking, most common first, then by id", () => {
    expect(ok(thinking(), "guest_thoughts", {})).toEqual([
      { id: THOUGHT.HUNGRY, text: "I'm hungry", mood: -1, count: 3 },
      { id: THOUGHT.TIRED, text: "I'm tired", mood: -1, count: 2 },
      { id: THOUGHT.LOST, text: "I can't find my way", mood: -2, count: 2 },
      { id: THOUGHT.NICE_VIEW, text: "What a lovely view", mood: 1, count: 1 },
    ]);
  });

  it("leaves out guests with nothing on their mind", () => {
    const sim = makePark();
    placeGuest(sim.world, { x: 8, y: 10 }, GuestState.WANDERING);
    expect(ok(sim, "guest_thoughts", {})).toEqual([]);
  });

  it("takes a limit of 1..50, 20 by default", () => {
    const sim = thinking();
    expect(ok(sim, "guest_thoughts", { limit: 2 })).toHaveLength(2);
    expect(ok(sim, "guest_thoughts", { limit: 1 })).toEqual([
      { id: THOUGHT.HUNGRY, text: "I'm hungry", mood: -1, count: 3 },
    ]);
    expect(ok(sim, "guest_thoughts", { limit: 50 })).toHaveLength(4);
    for (const limit of [0, 51, 2.5]) {
      expect(error(sim, "guest_thoughts", { limit }), String(limit)).toMatch(/^limit /);
    }
  });

  it("does not count guests who have gone", () => {
    const sim = thinking();
    removeGuest(sim.world, 0);
    removeGuest(sim.world, 1);
    const result = ok(sim, "guest_thoughts", {}) as Array<{ id: number; count: number }>;
    // Two hungry guests went; one is left, so tired and lost (two each) lead.
    expect(result.map((t) => [t.id, t.count])).toEqual([
      [THOUGHT.TIRED, 2],
      [THOUGHT.LOST, 2],
      [THOUGHT.HUNGRY, 1],
      [THOUGHT.NICE_VIEW, 1],
    ]);
  });

  it("shows what the park is thinking after real play", () => {
    // A guest at the gate who cannot afford the fee goes away thinking so.
    const sim = makePark({ fee: 99_99 });
    const slot = placeGuest(sim.world, { x: 8, y: 23 }, GuestState.ENTERING);
    sim.world.guests.cash[slot] = 20_00;
    sim.step(1);
    expect(ok(sim, "guest_thoughts", {})).toEqual([
      { id: THOUGHT.TOO_EXPENSIVE, text: "This park is too expensive", mood: -2, count: 1 },
    ]);
  });
});

describe("the guest queries in the catalog", () => {
  it("are listed in the park category as queries", () => {
    const sim = makePark();
    const entries = ok(sim, "catalog_list", {}) as CatalogEntry[];
    for (const name of ["guest_list", "guest_get", "guest_thoughts"]) {
      expect(
        entries.find((e) => e.name === name),
        name,
      ).toMatchObject({
        category: "park",
        kind: "query",
        undoable: false,
      });
    }
    const list = entries.find((e) => e.name === "guest_list");
    expect(Object.keys(list?.inputSchema["properties"] as object)).toEqual(["limit", "state"]);
  });

  it("park_status counts the guests in the park", () => {
    const sim = populated();
    sim.step(1);
    expect(ok(sim, "park_status", {})).toMatchObject({
      guests: 4,
      guestsInPark: 4,
    });
  });
});
