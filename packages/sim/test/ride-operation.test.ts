import { typeById, type RideType } from "@coasterworks/content";
import { describe, expect, it } from "vitest";
import { Sim, createWorld, deserializeWorld, serializeWorld, type World } from "../src/index.js";
import { QUEUE_PATIENCE, sendGuestToRide } from "../src/guests/behavior.js";
import { findGuest, intensityPrefForId } from "../src/guests/guests.js";
import { THOUGHT } from "../src/guests/thoughts.js";
import { GuestState, NO_TILE } from "../src/guests/types.js";
import { QUEUE_PER_TILE, queueCapacity } from "../src/rides/queue.js";
import { findRide } from "../src/rides/rides.js";
import { MAX_ENTRY_FEE } from "../src/park/types.js";
import { RidePhase } from "../src/rides/types.js";
import { validateWorldInvariants } from "../src/save/invariants.js";
import { DAYS_PER_MONTH, TICKS_PER_DAY } from "../src/time.js";
import { at, placeGuest, run, stepUntil, tileIndexOf } from "./helpers/guests.js";
import {
  CAROUSEL,
  JOIN_TILE,
  QUEUE_LINE,
  RIDE_ENTRANCE,
  RIDE_EXIT,
  makeRidePark,
  rideOf,
  tileOf,
  wanderer,
} from "./helpers/rides.js";

const CAROUSEL_TYPE = typeById("carousel") as RideType;
const PRICE = CAROUSEL_TYPE.defaultPrice;
/** The middle of the carousel's footprint, in 1/32 tile. */
const CENTRE = {
  x: CAROUSEL.x * 32 + CAROUSEL_TYPE.footprint.w * 16,
  y: CAROUSEL.y * 32 + CAROUSEL_TYPE.footprint.h * 16,
};

function slotOf(world: World, id: number): number {
  const slot = findGuest(world, id);
  if (slot < 0) throw new Error(`guest ${id} has gone`);
  return slot;
}

function stateOf(world: World, id: number): number {
  return at(world.guests.state, slotOf(world, id));
}

/**
 * Puts a guest straight into ride 1's queue, at the back, standing on the queue tile its place
 * belongs on, as if it had walked there. Returns its id.
 */
function queueGuest(
  world: World,
  patch: { cash?: number; tile?: { x: number; y: number } } = {},
): number {
  const ride = rideOf(world);
  const position = ride.queue.length;
  const tile =
    patch.tile ??
    QUEUE_LINE[Math.min(QUEUE_LINE.length - 1, Math.floor(position / QUEUE_PER_TILE))];
  const slot = placeGuest(world, tile as { x: number; y: number }, GuestState.QUEUING, patch);
  world.guests.ride[slot] = ride.id;
  world.guests.dest[slot] = tileIndexOf(world, RIDE_ENTRANCE.x, RIDE_ENTRANCE.y);
  const id = at(world.guests.id, slot);
  ride.queue.push(id);
  return id;
}

/**
 * For a test that queues more guests than stand on one queue tile and wants a full ride: all of
 * them on the entrance tile, where `boardRide` takes guests from.
 */
const AT_ENTRANCE = { tile: RIDE_ENTRANCE };

function expectSound(world: World): void {
  expect(validateWorldInvariants(world)).toBeNull();
}

describe("a full load", () => {
  it("walks up a spread-out queue onto the platform and fills the ride", () => {
    const sim = makeRidePark();
    const { world } = sim;
    // Fourteen guests along the queue path, four a tile, as they would have walked in.
    for (let i = 0; i < 14; i++) queueGuest(world);
    let filled = 0;
    for (let t = 0; t < 600 && filled === 0; t++) {
      sim.step(1);
      if (rideOf(world).phase === RidePhase.RUNNING) filled = rideOf(world).riders.length;
    }
    expect(filled).toBe(CAROUSEL_TYPE.capacity);
    expect(rideOf(world).queue).toHaveLength(2);
    expectSound(world);
  });
});

describe("sendGuestToRide", () => {
  it("sends a wandering guest to the ride's entrance", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const slot = wanderer(world);
    expect(sendGuestToRide(world, slot, 1)).toBe(true);
    expect(at(world.guests.state, slot)).toBe(GuestState.HEADING);
    expect(at(world.guests.ride, slot)).toBe(1);
    expect(at(world.guests.dest, slot)).toBe(tileIndexOf(world, RIDE_ENTRANCE.x, RIDE_ENTRANCE.y));
  });

  it("refuses, changing nothing, for a closed ride, an unreachable entrance, or no ride", () => {
    const sim = makeRidePark({ openRide: false });
    const { world } = sim;
    const slot = wanderer(world);
    const before = world.guests.dest[slot];
    expect(sendGuestToRide(world, slot, 1)).toBe(false);
    expect(sendGuestToRide(world, slot, 99)).toBe(false);
    run(sim, "ride_open", { id: 1 });
    run(sim, "path_remove_tiles", { tiles: [{ x: 7, y: 10 }] });
    expect(sendGuestToRide(world, slot, 1)).toBe(false);
    expect(at(world.guests.state, slot)).toBe(GuestState.WANDERING);
    expect(at(world.guests.ride, slot)).toBe(0);
    expect(world.guests.dest[slot]).toBe(before);
  });

  it("refuses a guest that is not wandering or heading somewhere", () => {
    const sim = makeRidePark();
    const slot = placeGuest(sim.world, JOIN_TILE, GuestState.LEAVING, { dest: 0 });
    expect(sendGuestToRide(sim.world, slot, 1)).toBe(false);
  });
});

describe("riding a ride", () => {
  it("walks a guest into the queue, onto the ride, and off at the exit happier and queasier", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const slot = wanderer(world, JOIN_TILE, { cash: 10_00 });
    const id = at(world.guests.id, slot);
    const happiness = at(world.guests.happiness, slot);
    const nausea = at(world.guests.nausea, slot);
    sendGuestToRide(world, slot, 1);

    stepUntil(sim, () => stateOf(world, id) === GuestState.QUEUING, 40);
    expect(rideOf(world).queue).toEqual([id]);
    expect(tileOf(world, slotOf(world, id))).toEqual({ x: 7, y: 10 });

    stepUntil(sim, () => stateOf(world, id) === GuestState.RIDING, 200);
    const ride = rideOf(world);
    expect(ride.phase).toBe(RidePhase.LOADING);
    expect(ride.queue).toEqual([]);
    expect(ride.riders).toEqual([id]);
    const s = slotOf(world, id);
    expect([at(world.guests.x, s), at(world.guests.y, s)]).toEqual([CENTRE.x, CENTRE.y]);
    expect([at(world.guests.tx, s), at(world.guests.ty, s)]).toEqual([NO_TILE, NO_TILE]);
    expect(at(world.guests.cash, s)).toBe(10_00 - PRICE);
    expectSound(world);

    sim.step(CAROUSEL_TYPE.loadTicks);
    expect(rideOf(world).phase).toBe(RidePhase.RUNNING);
    sim.step(CAROUSEL_TYPE.cycleTicks);
    expect(rideOf(world).phase).toBe(RidePhase.UNLOADING);
    sim.step(1);
    expect(rideOf(world).phase).toBe(RidePhase.IDLE);
    expect(rideOf(world).riders).toEqual([]);

    const after = slotOf(world, id);
    expect(at(world.guests.state, after)).toBe(GuestState.WANDERING);
    expect(tileOf(world, after)).toEqual(RIDE_EXIT);
    expect(at(world.guests.ride, after)).toBe(0);
    expect(at(world.guests.lastRide, after)).toBe(1);
    expect(at(world.guests.thought, after)).toBe(THOUGHT.RIDE_FUN);
    expect(at(world.guests.happiness, after)).toBeGreaterThan(happiness);
    expect(at(world.guests.nausea, after)).toBe(nausea + Math.floor(CAROUSEL_TYPE.nausea / 10));
    expect(rideOf(world).stats).toMatchObject({ customers: 1, income: PRICE });
    expectSound(world);
  });

  it("keeps the queue strictly first come, first served", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const slot = wanderer(world);
      ids.push(at(world.guests.id, slot));
    }
    // Sent one after another, a few steps apart, from the same tile.
    for (const id of [ids[2], ids[0], ids[1]] as number[]) {
      sendGuestToRide(world, slotOf(world, id), 1);
      sim.step(8);
    }
    const order = [ids[2], ids[0], ids[1]];
    stepUntil(sim, () => rideOf(world).queue.length + rideOf(world).riders.length === 3, 100);
    // Each boards as it reaches the entrance; record the order they got on in.
    const boarded: number[] = [];
    stepUntil(
      sim,
      () => {
        for (const id of rideOf(world).riders) if (!boarded.includes(id)) boarded.push(id);
        return boarded.length === 3;
      },
      600,
    );
    expect(boarded).toEqual(order);
    expectSound(world);
  });

  it("boards no more than the ride's capacity, from the front, and the rest wait in order", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const ids = Array.from({ length: CAROUSEL_TYPE.capacity + 2 }, () =>
      queueGuest(world, AT_ENTRANCE),
    );
    expectSound(world);
    sim.step(1);
    const ride = rideOf(world);
    expect(ride.riders).toEqual(ids.slice(0, CAROUSEL_TYPE.capacity));
    expect(ride.queue).toEqual(ids.slice(CAROUSEL_TYPE.capacity));
    for (const id of ride.queue) expect(stateOf(world, id)).toBe(GuestState.QUEUING);
    expectSound(world);
  });

  it("turns away a guest who cannot pay, without charging it", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const poor = queueGuest(world, { cash: PRICE - 1 });
    const rich = queueGuest(world, { cash: 50_00 });
    const cash = world.finance.cash;
    sim.step(1);
    const p = slotOf(world, poor);
    expect(at(world.guests.state, p)).toBe(GuestState.WANDERING);
    expect(at(world.guests.cash, p)).toBe(PRICE - 1);
    expect(at(world.guests.thought, p)).toBe(THOUGHT.CANT_AFFORD_RIDE);
    expect(at(world.guests.ride, p)).toBe(0);
    // It will not choose the same ride again straight away.
    expect(at(world.guests.lastRide, p)).toBe(1);
    expect(rideOf(world).riders).toEqual([rich]);
    expect(rideOf(world).queue).toEqual([]);
    expect(world.finance.cash).toBe(cash + PRICE);
    expectSound(world);
  });

  it("takes the price from every guest it boards, into the park's books and the ride's stats", () => {
    const sim = makeRidePark();
    const { world } = sim;
    run(sim, "ride_set_price", { id: 1, cents: 1_50 });
    for (let i = 0; i < 5; i++) queueGuest(world, AT_ENTRANCE);
    const cash = world.finance.cash;
    sim.step(1);
    expect(rideOf(world).riders).toHaveLength(5);
    expect(world.park.income.rides).toBe(5 * 1_50);
    expect(world.park.monthly.rides).toBe(5 * 1_50);
    expect(world.finance.cash).toBe(cash + 5 * 1_50);
    expect(rideOf(world).stats).toMatchObject({
      customers: 5,
      income: 5 * 1_50,
      monthCustomers: 5,
      monthIncome: 5 * 1_50,
    });
  });

  it("does not load until the guest at the front stands on the entrance", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const slot = placeGuest(world, { x: 7, y: 10 }, GuestState.QUEUING);
    world.guests.ride[slot] = 1;
    const id = at(world.guests.id, slot);
    rideOf(world).queue.push(id);
    sim.step(1);
    expect(rideOf(world).phase).toBe(RidePhase.IDLE);
    // Four tiles to walk, 16 ticks a tile.
    stepUntil(sim, () => rideOf(world).phase === RidePhase.LOADING, 80);
    expect(rideOf(world).riders).toEqual([id]);
  });

  it("does not load while closed", () => {
    const sim = makeRidePark({ openRide: false });
    const { world } = sim;
    queueGuest(world);
    sim.step(5);
    expect(rideOf(world).phase).toBe(RidePhase.IDLE);
  });
});

describe("queue patience and length", () => {
  it("counts the ticks a guest queues, and at the limit it gives up and wanders", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const ids = Array.from({ length: CAROUSEL_TYPE.capacity + 1 }, () =>
      queueGuest(world, AT_ENTRANCE),
    );
    sim.step(1);
    const last = ids[ids.length - 1] as number;
    expect(rideOf(world).queue).toEqual([last]);
    const slot = slotOf(world, last);
    const ticks = at(world.guests.queueTicks, slot);
    expect(ticks).toBeGreaterThan(0);
    sim.step(10);
    expect(at(world.guests.queueTicks, slotOf(world, last))).toBe(ticks + 10);

    world.guests.queueTicks[slotOf(world, last)] = QUEUE_PATIENCE - 2;
    sim.step(1);
    expect(stateOf(world, last)).toBe(GuestState.QUEUING);
    sim.step(1);
    const s = slotOf(world, last);
    expect(at(world.guests.state, s)).toBe(GuestState.WANDERING);
    expect(at(world.guests.thought, s)).toBe(THOUGHT.QUEUE_TOO_LONG);
    expect(at(world.guests.ride, s)).toBe(0);
    expect(at(world.guests.lastRide, s)).toBe(0);
    expect(rideOf(world).queue).toEqual([]);
    expectSound(world);
  });

  it("has a guest who finds the queue full think it too long and wander off", () => {
    const sim = makeRidePark();
    const { world } = sim;
    // Running, so nobody boards while the newcomer walks over.
    rideOf(world).phase = RidePhase.RUNNING;
    const full = queueCapacity(world, rideOf(world));
    for (let i = 0; i < full; i++) queueGuest(world);
    const slot = wanderer(world);
    const id = at(world.guests.id, slot);
    expect(sendGuestToRide(world, slot, 1)).toBe(true);
    stepUntil(
      sim,
      () => at(world.guests.thought, slotOf(world, id)) === THOUGHT.QUEUE_TOO_LONG,
      40,
    );
    const s = slotOf(world, id);
    expect(at(world.guests.state, s)).toBe(GuestState.WANDERING);
    expect(at(world.guests.ride, s)).toBe(0);
    expect(rideOf(world).queue).toHaveLength(full);
    expect(rideOf(world).queue).not.toContain(id);
    expectSound(world);
  });
});

describe("closing and demolishing with guests aboard", () => {
  it("closing lets the queue go and lets the riders finish their ride", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const ids = Array.from({ length: CAROUSEL_TYPE.capacity + 3 }, () =>
      queueGuest(world, AT_ENTRANCE),
    );
    sim.step(1);
    const riders = ids.slice(0, CAROUSEL_TYPE.capacity);
    const queuers = ids.slice(CAROUSEL_TYPE.capacity);
    run(sim, "ride_close", { id: 1 });
    expect(rideOf(world).queue).toEqual([]);
    for (const id of queuers) {
      const s = slotOf(world, id);
      expect(at(world.guests.state, s)).toBe(GuestState.WANDERING);
      expect(at(world.guests.ride, s)).toBe(0);
    }
    expect(rideOf(world).riders).toEqual(riders);
    expectSound(world);

    sim.step(CAROUSEL_TYPE.loadTicks + CAROUSEL_TYPE.cycleTicks + 1);
    expect(rideOf(world).phase).toBe(RidePhase.IDLE);
    expect(rideOf(world).riders).toEqual([]);
    for (const id of riders) expect(at(world.guests.lastRide, slotOf(world, id))).toBe(1);
    expectSound(world);
  });

  it("demolishing mid-ride puts the riders on the exit and lets the queue go", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const ids = Array.from({ length: CAROUSEL_TYPE.capacity + 2 }, () =>
      queueGuest(world, AT_ENTRANCE),
    );
    sim.step(CAROUSEL_TYPE.loadTicks + 10);
    expect(rideOf(world).phase).toBe(RidePhase.RUNNING);
    const count = world.guests.count;
    run(sim, "ride_demolish", { id: 1 });
    expect(world.rides).toEqual([]);
    expect(world.guests.count).toBe(count);
    for (const [i, id] of ids.entries()) {
      const s = slotOf(world, id);
      expect(at(world.guests.state, s)).toBe(GuestState.WANDERING);
      expect(at(world.guests.ride, s)).toBe(0);
      if (i < CAROUSEL_TYPE.capacity) expect(tileOf(world, s)).toEqual(RIDE_EXIT);
    }
    expectSound(world);
    sim.step(50);
    expectSound(world);
  });

  it("demolishing with no path on the exit puts the riders on the nearest path tile", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const ids = Array.from({ length: 3 }, () => queueGuest(world));
    sim.step(1);
    run(sim, "path_remove_tiles", { tiles: [RIDE_EXIT] });
    run(sim, "ride_demolish", { id: 1 });
    // The ring two tiles out from the footprint's middle (5, 6) first meets path at (5, 8).
    for (const id of ids) expect(tileOf(world, slotOf(world, id))).toEqual({ x: 5, y: 8 });
    expectSound(world);
  });

  it("undoing the demolish brings the ride back empty and idle, with its stats", () => {
    const sim = makeRidePark();
    const { world } = sim;
    for (let i = 0; i < 4; i++) queueGuest(world);
    sim.step(CAROUSEL_TYPE.loadTicks + 10);
    run(sim, "ride_demolish", { id: 1 });
    const undone = sim.undo();
    expect(undone.ok).toBe(true);
    const ride = rideOf(world);
    expect(ride).toMatchObject({
      id: 1,
      phase: RidePhase.IDLE,
      phaseTicks: 0,
      riders: [],
      queue: [],
    });
    expect(ride.stats).toMatchObject({ customers: 4, income: 4 * PRICE });
    expectSound(world);
    sim.step(100);
    expectSound(world);
  });

  it("guests heading for a ride that closes go back to wandering", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const slot = wanderer(world, { x: 8, y: 20 });
    const id = at(world.guests.id, slot);
    sendGuestToRide(world, slot, 1);
    sim.step(20);
    run(sim, "ride_close", { id: 1 });
    sim.step(40);
    expect(at(world.guests.ride, slotOf(world, id))).toBe(0);
    expect(rideOf(world).queue).toEqual([]);
  });
});

describe("closing the park", () => {
  it("sends the queue home and the riders home once their ride ends", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const ids = Array.from({ length: CAROUSEL_TYPE.capacity + 2 }, () =>
      queueGuest(world, AT_ENTRANCE),
    );
    const heading = wanderer(world, { x: 8, y: 20 });
    const headingId = at(world.guests.id, heading);
    sendGuestToRide(world, heading, 1);
    sim.step(1);
    run(sim, "park_close", {});
    expect(rideOf(world).queue).toEqual([]);
    for (const id of [...ids.slice(CAROUSEL_TYPE.capacity), headingId]) {
      const s = slotOf(world, id);
      expect(at(world.guests.state, s)).toBe(GuestState.LEAVING);
      expect(at(world.guests.ride, s)).toBe(0);
    }
    for (const id of ids.slice(0, CAROUSEL_TYPE.capacity)) {
      expect(stateOf(world, id)).toBe(GuestState.RIDING);
    }
    expectSound(world);
    sim.step(CAROUSEL_TYPE.loadTicks + CAROUSEL_TYPE.cycleTicks + 1);
    for (const id of ids.slice(0, CAROUSEL_TYPE.capacity)) {
      const s = findGuest(world, id);
      if (s >= 0) expect(at(world.guests.state, s)).toBe(GuestState.LEAVING);
    }
    expectSound(world);
  });
});

describe("saving mid-cycle", () => {
  it("reloads to a park that carries on exactly as the unsaved one does", () => {
    const sim = makeRidePark({ rating: 600 });
    const { world } = sim;
    const ids: number[] = [];
    for (let i = 0; i < 16; i++) {
      const slot = wanderer(world, { x: 8, y: 6 + (i % 14) }, { cash: 30_00 });
      ids.push(at(world.guests.id, slot));
      sendGuestToRide(world, slot, 1);
    }
    stepUntil(
      sim,
      () => rideOf(world).phase === RidePhase.RUNNING && rideOf(world).queue.length > 0,
      600,
    );
    sim.step(37);
    expect(rideOf(world).phase).toBe(RidePhase.RUNNING);
    expect(rideOf(world).queue.length).toBeGreaterThan(0);

    const twin = new Sim(deserializeWorld(serializeWorld(world)));
    expect(twin.hash()).toBe(sim.hash());
    sim.step(2_000);
    twin.step(2_000);
    expect(twin.hash()).toBe(sim.hash());
    // The ride really did run in that time.
    expect(rideOf(world).stats.customers).toBeGreaterThanOrEqual(16);
    expectSound(world);
  });
});

describe("running costs", () => {
  it("come to exactly the type's running cost over a month, a day at a time", () => {
    const sim = makeRidePark();
    const { world } = sim;
    run(sim, "stall_build", { type: "snack_stand", x: 10, y: 6, rot: 3 });
    const stall = typeById("snack_stand");
    const monthly = CAROUSEL_TYPE.runningCost + (stall?.runningCost ?? 0);
    const cash = world.finance.cash;
    sim.step(TICKS_PER_DAY);
    expect(rideOf(world).stats.runningCost).toBe(
      Math.floor(CAROUSEL_TYPE.runningCost / DAYS_PER_MONTH),
    );
    sim.step(TICKS_PER_DAY * (DAYS_PER_MONTH - 1) - 1);
    expect(world.park.history).toEqual([]);
    sim.step(1);
    expect(rideOf(world).stats.runningCost).toBe(CAROUSEL_TYPE.runningCost);
    expect(rideOf(world, 2).stats.runningCost).toBe(stall?.runningCost);
    expect(world.park.expenses.running).toBe(monthly);
    expect(world.park.history).toHaveLength(1);
    expect(world.park.history[0]?.running).toBe(monthly);
    expect(world.park.monthly.running).toBe(0);
    // Guests may have come in meanwhile, and ridden or bought; the park has no loan.
    const { income } = world.park;
    expect(world.finance.cash).toBe(cash - monthly + income.entry + income.rides + income.shops);
    sim.step(TICKS_PER_DAY * DAYS_PER_MONTH);
    expect(world.park.history[1]?.running).toBe(monthly);
  });

  it("clear a ride's month stats when the month closes", () => {
    // At the highest fee nobody else comes in to ride over the month.
    const sim = makeRidePark({ fee: MAX_ENTRY_FEE });
    const { world } = sim;
    queueGuest(world);
    sim.step(1);
    expect(rideOf(world).stats.monthCustomers).toBe(1);
    sim.step(TICKS_PER_DAY * DAYS_PER_MONTH);
    expect(rideOf(world).stats).toMatchObject({
      customers: 1,
      income: PRICE,
      monthCustomers: 0,
      monthIncome: 0,
    });
  });
});

describe("invariants", () => {
  it("refuse a queue naming a guest that is not queuing for that ride", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const id = queueGuest(world);
    expectSound(world);
    world.guests.ride[slotOf(world, id)] = 2;
    expect(validateWorldInvariants(world)).toMatch(/guest/);
    world.guests.ride[slotOf(world, id)] = 1;
    world.guests.state[slotOf(world, id)] = GuestState.WANDERING;
    expect(validateWorldInvariants(world)).toMatch(/guest/);
  });

  it("refuse a guest listed twice, a missing guest, and too many riders", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const id = queueGuest(world);
    rideOf(world).queue.push(id);
    expect(validateWorldInvariants(world)).toMatch(/twice|more than once/);
    rideOf(world).queue = [id, 9_999];
    expect(validateWorldInvariants(world)).toMatch(/9999/);
    rideOf(world).queue = [];
    world.guests.state[slotOf(world, id)] = GuestState.RIDING;
    rideOf(world).riders = Array.from({ length: CAROUSEL_TYPE.capacity + 1 }, () => id);
    expect(validateWorldInvariants(world)).not.toBeNull();
  });

  it("refuse riders on an idle ride", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const id = queueGuest(world);
    sim.step(1);
    expectSound(world);
    expect(rideOf(world).riders).toEqual([id]);
    rideOf(world).phase = RidePhase.IDLE;
    expect(validateWorldInvariants(world)).toMatch(/idle/);
  });

  it("refuse a queue time past the guests' patience", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const id = queueGuest(world);
    world.guests.queueTicks[slotOf(world, id)] = QUEUE_PATIENCE;
    expectSound(world);
    world.guests.queueTicks[slotOf(world, id)] = QUEUE_PATIENCE + 1;
    expect(validateWorldInvariants(world)).toMatch(/queueTicks/);
  });

  it("refuse a queuing or riding guest its ride does not list", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const id = queueGuest(world);
    rideOf(world).queue = [];
    expect(validateWorldInvariants(world)).toMatch(/not in its queue/);
    world.guests.state[slotOf(world, id)] = GuestState.RIDING;
    expect(validateWorldInvariants(world)).toMatch(/not among its riders/);
    world.guests.ride[slotOf(world, id)] = 9;
    expect(validateWorldInvariants(world)).toMatch(/not among its riders/);
  });
});

describe("a break in the queue line", () => {
  it("sends the guests cut off out of the queue, and the ride keeps boarding the rest", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const front = queueGuest(world, { tile: { x: 5, y: 9 } });
    const onGap = queueGuest(world, { tile: { x: 6, y: 10 } });
    const beyond = queueGuest(world, { tile: { x: 7, y: 10 } });
    expectSound(world);
    run(sim, "path_remove_tiles", { tiles: [{ x: 6, y: 10 }] });
    sim.step(2);
    expectSound(world);
    // Standing where the path was: no path under it, so it is lost.
    const g = slotOf(world, onGap);
    expect(at(world.guests.state, g)).toBe(GuestState.LOST);
    expect(at(world.guests.ride, g)).toBe(0);
    expect(at(world.guests.queueTicks, g)).toBe(0);
    // On queue path that no longer reaches the entrance: it wanders off.
    const b = slotOf(world, beyond);
    expect(at(world.guests.state, b)).toBe(GuestState.WANDERING);
    expect(at(world.guests.ride, b)).toBe(0);
    expect(at(world.guests.queueTicks, b)).toBe(0);
    expect(rideOf(world).queue).toEqual([front]);

    stepUntil(sim, () => stateOf(world, front) === GuestState.RIDING, 40);
    expect(rideOf(world).riders).toEqual([front]);
    expect(rideOf(world).queue).toEqual([]);
    expectSound(world);
  });

  it("does the same when an undo takes a queue tile away", () => {
    const sim = makeRidePark();
    const { world } = sim;
    run(sim, "path_build_tiles", { tiles: [{ x: 5, y: 11 }], kind: "queue" });
    const front = queueGuest(world, { tile: { x: 5, y: 9 } });
    const tail = queueGuest(world, { tile: { x: 5, y: 11 } });
    expect(sim.undo().ok).toBe(true);
    sim.step(2);
    expect(stateOf(world, tail)).toBe(GuestState.LOST);
    expect(rideOf(world).queue).toEqual([front]);
    expectSound(world);
  });
});

describe("boarding at the entrance", () => {
  it("boards only guests standing on the entrance tile, from the front, stopping at the first who is not", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const first = queueGuest(world, { tile: RIDE_ENTRANCE });
    const second = queueGuest(world, { tile: { x: 5, y: 9 } });
    const third = queueGuest(world, { tile: RIDE_ENTRANCE });
    sim.step(1);
    expect(rideOf(world).riders).toEqual([first]);
    expect(rideOf(world).queue).toEqual([second, third]);
    expect(stateOf(world, second)).toBe(GuestState.QUEUING);
    expect(stateOf(world, third)).toBe(GuestState.QUEUING);
    expectSound(world);
  });

  it("lets a broke guest at the front step out without costing anyone a seat", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const poor = queueGuest(world, { cash: PRICE - 1, tile: RIDE_ENTRANCE });
    const rich = Array.from({ length: CAROUSEL_TYPE.capacity }, () =>
      queueGuest(world, { cash: 50_00, tile: RIDE_ENTRANCE }),
    );
    sim.step(1);
    expect(stateOf(world, poor)).toBe(GuestState.WANDERING);
    expect(rideOf(world).riders).toEqual(rich);
    expect(rideOf(world).queue).toEqual([]);
    expectSound(world);
  });
});

describe("unloading onto an exit with no path", () => {
  it("puts the riders on the nearest path tile, as demolishing does", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const id = queueGuest(world);
    sim.step(1);
    expect(stateOf(world, id)).toBe(GuestState.RIDING);
    run(sim, "path_remove_tiles", { tiles: [RIDE_EXIT] });
    sim.step(CAROUSEL_TYPE.loadTicks + CAROUSEL_TYPE.cycleTicks + 1);
    const s = slotOf(world, id);
    expect(at(world.guests.state, s)).toBe(GuestState.WANDERING);
    expect(tileOf(world, s)).toEqual({ x: 5, y: 8 });
    expect(at(world.guests.lastRide, s)).toBe(1);
    expectSound(world);
  });

  it("leaves a rider lost when there is no path anywhere near", () => {
    const sim = makeRidePark();
    const { world } = sim;
    const id = queueGuest(world);
    sim.step(1);
    // No path anywhere, and no park entrance (which guests can stand on) either.
    world.terrain.path.fill(0);
    world.park.entrance = null;
    world.pathVersion++;
    sim.step(CAROUSEL_TYPE.loadTicks + CAROUSEL_TYPE.cycleTicks + 1);
    const s = slotOf(world, id);
    expect(at(world.guests.state, s)).toBe(GuestState.LOST);
    expect(at(world.guests.ride, s)).toBe(0);
    expectSound(world);
  });
});

describe("a ride that goes", () => {
  it("is forgotten by guests who rode it or were heading for it, so a new ride with its id is not mistaken for it", () => {
    const sim = makeRidePark();
    const { world } = sim;
    run(sim, "ride_build", { type: "carousel", x: 10, y: 12, rot: 0 });
    const rode = wanderer(world, { x: 8, y: 14 });
    world.guests.lastRide[rode] = 2;
    const heading = wanderer(world, { x: 8, y: 16 });
    world.guests.state[heading] = GuestState.HEADING;
    world.guests.ride[heading] = 2;
    world.guests.dest[heading] = tileIndexOf(world, 8, 4);
    const other = wanderer(world, { x: 8, y: 18 });
    world.guests.lastRide[other] = 1;
    expect(sim.undo().ok).toBe(true);
    expect(world.nextRideId).toBe(2);
    expect(at(world.guests.lastRide, rode)).toBe(0);
    expect(at(world.guests.ride, heading)).toBe(0);
    expect(at(world.guests.state, heading)).toBe(GuestState.WANDERING);
    expect(at(world.guests.lastRide, other)).toBe(1);
    expectSound(world);

    run(sim, "ride_demolish", { id: 1 });
    expect(at(world.guests.lastRide, other)).toBe(0);
    expectSound(world);
  });
});

describe("a long randomized run", () => {
  it("keeps every invariant while guests ride and the player builds, breaks and undoes", () => {
    const sim = makeRidePark({ rating: 700 });
    const { world } = sim;
    // A second carousel east of the main path, its queue and exit joined to it.
    run(sim, "ride_build", { type: "carousel", x: 10, y: 12, rot: 0 });
    expect([rideOf(world, 2).entrance, rideOf(world, 2).exit]).toEqual([
      { x: 11, y: 15 },
      { x: 13, y: 13 },
    ]);
    const queue2 = [
      { x: 11, y: 15 },
      { x: 11, y: 16 },
      { x: 10, y: 16 },
      { x: 9, y: 16 },
    ];
    run(sim, "path_build_tiles", { tiles: queue2, kind: "queue" });
    const exit2 = [13, 12, 11].map((y) => ({ x: 13, y }));
    for (let x = 12; x >= 9; x--) exit2.push({ x, y: 11 });
    run(sim, "path_build_tiles", { tiles: exit2, kind: "foot" });
    run(sim, "ride_open", { id: 2 });

    // A small fixed-seed generator of the test's own, so the run is the same every time.
    let seed = 12345;
    const roll = (n: number) => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    // Commands the run itself has done and not undone, so undo never takes the park apart.
    let done = 0;
    const tryRun = (name: string, input: unknown) => {
      if (sim.execute(name, input).ok) done++;
    };
    const cuts = [
      { x: 5, y: 9 },
      { x: 10, y: 16 },
    ];
    let queued = 0;
    let rode = 0;
    for (let tick = 1; tick <= 20_000; tick++) {
      sim.step(1);
      if (tick % 7 === 0) {
        for (let slot = 0; slot < world.guests.live.length; slot++) {
          if (world.guests.live[slot] === 1 && roll(3) === 0) {
            sendGuestToRide(world, slot, 1 + roll(2));
          }
        }
      }
      if (tick % 61 === 0) {
        const id = 1 + roll(2);
        const cut = cuts[roll(2)] as { x: number; y: number };
        switch (roll(10)) {
          case 0:
            tryRun("ride_close", { id });
            break;
          case 1:
            tryRun("ride_demolish", { id });
            break;
          case 2:
          case 3:
            if (done > 0 && sim.undo().ok) done--;
            break;
          case 4:
            tryRun("path_remove_tiles", { tiles: [cut] });
            break;
          case 5:
          case 6:
            tryRun("path_build_tiles", { tiles: [cut], kind: "queue" });
            break;
          case 7:
            tryRun("ride_set_price", { id, cents: roll(4) * 1_00 });
            break;
          default:
            tryRun("ride_open", { id });
        }
      }
      for (const ride of world.rides) {
        queued += ride.queue.length;
        rode += ride.riders.length;
      }
      if (tick % 500 === 0) {
        expectSound(world);
        expect(validateWorldInvariants(deserializeWorld(serializeWorld(world)))).toBeNull();
      }
    }
    // The run did exercise the queues and the rides.
    expect(queued).toBeGreaterThan(20_000);
    expect(rode).toBeGreaterThan(20_000);
  });
});

describe("findRide", () => {
  it("finds every ride by id in the sorted list, and nothing for an id with no ride", () => {
    const sim = makeRidePark();
    const { world } = sim;
    run(sim, "stall_build", { type: "snack_stand", x: 10, y: 6, rot: 3 });
    run(sim, "stall_build", { type: "snack_stand", x: 10, y: 9, rot: 3 });
    run(sim, "stall_build", { type: "snack_stand", x: 10, y: 12, rot: 3 });
    run(sim, "ride_demolish", { id: 3 });
    const ids = world.rides.map((r) => r.id);
    expect(ids).toEqual([1, 2, 4]);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    for (const ride of world.rides) expect(findRide(world, ride.id)).toBe(ride);
    for (const id of [0, 3, 5, 99]) expect(findRide(world, id)).toBeUndefined();
    expect(findRide(createWorld({ width: 8, height: 8, seed: 1, name: "E", cash: 0 }), 1)).toBe(
      undefined,
    );
  });
});

describe("intensity preference", () => {
  it("is in the 40 to 200 band for every new guest, worked out from its id", () => {
    const sim = makeRidePark();
    for (let i = 0; i < 50; i++) {
      const slot = wanderer(sim.world);
      const pref = at(sim.world.guests.intensityPref, slot);
      expect(pref).toBeGreaterThanOrEqual(40);
      expect(pref).toBeLessThanOrEqual(200);
      expect(pref).toBe(intensityPrefForId(at(sim.world.guests.id, slot)));
    }
    const derived = Array.from({ length: 200 }, (_, i) => intensityPrefForId(i + 1));
    for (const pref of derived) {
      expect(pref).toBeGreaterThanOrEqual(40);
      expect(pref).toBeLessThanOrEqual(200);
    }
    expect(new Set(derived).size).toBeGreaterThan(50);
    expect(intensityPrefForId(17)).toBe(intensityPrefForId(17));
  });
});
