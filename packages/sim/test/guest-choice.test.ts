import { typeById, type RideType, type StallType } from "@coasterworks/content";
import { describe, expect, it } from "vitest";
import { Sim, deserializeWorld, serializeWorld, type World } from "../src/index.js";
import {
  BATHROOM_SEEK_LEVEL,
  NEED_COMPLAIN_LEVEL,
  NEED_SEEK_LEVEL,
  WANDER_INTERVAL,
  LEAVE_IDLE_TICKS,
  bestRide,
  guestRoutes,
  nearestStall,
  sendGuestToRide,
  stallField,
} from "../src/guests/behavior.js";
import { UNREACHABLE } from "../src/paths/routing.js";
import { TICKS_PER_DAY } from "../src/time.js";
import { findGuest } from "../src/guests/guests.js";
import { THOUGHT } from "../src/guests/thoughts.js";
import { GuestState } from "../src/guests/types.js";
import { createSamplePark } from "../src/sample-park.js";
import { validateWorldInvariants } from "../src/save/invariants.js";
import { nextRating, openRideTypes } from "../src/systems/guests.js";
import { at, makePark, placeGuest, run, stepUntil, tileIndexOf } from "./helpers/guests.js";
import { rideOf } from "./helpers/rides.js";

const SNACK = typeById("snack_stand") as StallType;
const DRINKS = typeById("drinks_stand") as StallType;
const CAROUSEL = typeById("carousel") as RideType;
const SWING = typeById("swing_tower") as RideType;

/** An intensity preference byte that likes the carousel exactly. */
const LIKES_CAROUSEL = CAROUSEL.intensity / 4;

function slotOf(world: World, id: number): number {
  const slot = findGuest(world, id);
  if (slot < 0) throw new Error(`guest ${id} has gone`);
  return slot;
}

function expectSound(world: World): void {
  expect(validateWorldInvariants(world)).toBeNull();
}

/** Steps until the guest's next turn to choose (one tick before `decide` runs it). */
function untilTurn(sim: Sim, id: number): void {
  stepUntil(sim, () => (sim.world.tick + 1 + id) % WANDER_INTERVAL === 0, WANDER_INTERVAL);
}

/**
 * `makePark` (footpath along x = 8 from y = 4 to 22, entrance (8, 23)) with a snack stand (id 1)
 * at (9, 12) turned 1, so it serves to the west onto the footpath tile (8, 12).
 */
function stallPark(open = true): Sim {
  const sim = makePark();
  run(sim, "stall_build", { type: "snack_stand", x: 9, y: 12, rot: 1 });
  if (open) run(sim, "ride_open", { id: 1 });
  return sim;
}

/**
 * A hungry guest standing on the footpath at (8, 18): hunger 200 unless `patch` says otherwise, so
 * hungry enough to complain when there is nothing to eat. Returns its id.
 */
function hungryGuest(world: World, patch: { cash?: number; hunger?: number } = {}): number {
  const slot = placeGuest(world, { x: 8, y: 18 }, GuestState.WANDERING, {
    hunger: patch.hunger ?? 200,
    sinceAction: 0,
    cash: patch.cash ?? 50_00,
  });
  return at(world.guests.id, slot);
}

describe("stalls", () => {
  it("a hungry guest walks to the open snack stand, is served once, pays once and is less hungry", () => {
    const sim = stallPark();
    const { world } = sim;
    // Hungry enough to look for food, and a snack takes it far enough under `NEED_SEEK_LEVEL`
    // that it is not hungry again within the 1,200 ticks this watches it for.
    const id = hungryGuest(world, { hunger: 120 });
    const stall = rideOf(world, 1);
    const service = stall.service as { x: number; y: number };
    expect(service).toEqual({ x: 8, y: 12 });

    untilTurn(sim, id);
    sim.step(1);
    expect(at(world.guests.state, slotOf(world, id))).toBe(GuestState.HEADING);
    expect(at(world.guests.ride, slotOf(world, id))).toBe(1);
    expect(ok(sim, id).ride).toEqual({ id: 1, name: "Snack Stand 1", doing: "heading" });

    stepUntil(sim, () => at(world.guests.state, slotOf(world, id)) === GuestState.BUYING, 400);
    const slot = slotOf(world, id);
    expect({ x: at(world.guests.x, slot) >> 5, y: at(world.guests.y, slot) >> 5 }).toEqual(service);
    expect(ok(sim, id).ride).toEqual({ id: 1, name: "Snack Stand 1", doing: "buying" });
    const cash = at(world.guests.cash, slot);
    const shops = world.park.income.shops;
    const position = [at(world.guests.x, slot), at(world.guests.y, slot)];

    // Stands still and pays nothing until it has been served.
    sim.step(SNACK.serveTicks - 1);
    expect(at(world.guests.state, slotOf(world, id))).toBe(GuestState.BUYING);
    expect(at(world.guests.cash, slotOf(world, id))).toBe(cash);
    expect([at(world.guests.x, slot), at(world.guests.y, slot)]).toEqual(position);
    expect(world.park.income.shops).toBe(shops);
    const hunger = at(world.guests.hunger, slotOf(world, id));
    const happiness = at(world.guests.happiness, slotOf(world, id));
    expectSound(world);

    sim.step(1);
    const after = slotOf(world, id);
    expect(at(world.guests.state, after)).toBe(GuestState.WANDERING);
    expect(at(world.guests.ride, after)).toBe(0);
    expect(at(world.guests.cash, after)).toBe(cash - stall.price);
    expect(at(world.guests.hunger, after)).toBeLessThanOrEqual(hunger - SNACK.amount + 1);
    expect(at(world.guests.happiness, after)).toBeGreaterThanOrEqual(happiness + 9);
    expect(at(world.guests.thought, after)).toBe(THOUGHT.GOOD_FOOD);
    expect(world.park.income.shops).toBe(shops + stall.price);
    expect(world.park.monthly.shops).toBe(shops + stall.price);
    expect(stall.stats).toMatchObject({
      customers: 1,
      income: stall.price,
      monthCustomers: 1,
      monthIncome: stall.price,
    });

    // No longer hungry enough to buy again.
    sim.step(1200);
    expect(stall.stats.customers).toBe(1);
    expect(world.park.income.shops).toBe(stall.price);
    expectSound(world);
  });

  it("with no open stall a hungry guest thinks there is nothing to eat and pays nothing", () => {
    const sim = stallPark(false);
    const { world } = sim;
    const id = hungryGuest(world);
    const cash = at(world.guests.cash, slotOf(world, id));
    untilTurn(sim, id);
    sim.step(1);
    const slot = slotOf(world, id);
    expect(at(world.guests.thought, slot)).toBe(THOUGHT.NOTHING_TO_EAT);
    expect(at(world.guests.ride, slot)).toBe(0);
    sim.step(WANDER_INTERVAL * 3);
    expect(at(world.guests.cash, slotOf(world, id))).toBe(cash);
    expect(world.park.income.shops).toBe(0);
    expect(at(world.guests.state, slotOf(world, id))).not.toBe(GuestState.BUYING);
  });

  it("does not think it again on every turn", () => {
    const sim = stallPark(false);
    const { world } = sim;
    const id = hungryGuest(world);
    untilTurn(sim, id);
    sim.step(1);
    const first = at(world.guests.thoughtTick, slotOf(world, id));
    // Its next turn, a guest walk later, is too soon to think it again.
    stepUntil(sim, () => world.tick >= first + WANDER_INTERVAL + 1, WANDER_INTERVAL + 2);
    expect(at(world.guests.thoughtTick, slotOf(world, id))).toBe(first);
  });

  it("looks for food from NEED_SEEK_LEVEL, but only complains of none from NEED_COMPLAIN_LEVEL", () => {
    expect(NEED_SEEK_LEVEL).toBeLessThan(NEED_COMPLAIN_LEVEL - 40);
    const sim = stallPark(false);
    const { world } = sim;
    const id = hungryGuest(world, { hunger: NEED_SEEK_LEVEL });
    untilTurn(sim, id);
    sim.step(1);
    // A little hungry, and no stall open: it carries on without a word.
    expect(at(world.guests.thought, slotOf(world, id))).not.toBe(THOUGHT.NOTHING_TO_EAT);
    expect(at(world.guests.ride, slotOf(world, id))).toBe(0);
    // With the stall open it goes for a snack: at its next turn, or a tile on if it is walking.
    run(sim, "ride_open", { id: 1 });
    stepUntil(sim, () => at(world.guests.ride, slotOf(world, id)) === 1, WANDER_INTERVAL);
    expect(at(world.guests.state, slotOf(world, id))).toBe(GuestState.HEADING);
  });

  it("looks for the toilets from BATHROOM_SEEK_LEVEL, and not before", () => {
    const sim = makePark();
    const { world } = sim;
    run(sim, "stall_build", { type: "restrooms", x: 9, y: 14, rot: 1 });
    run(sim, "ride_open", { id: 1 });
    const needs = { hunger: 0, thirst: 0, sinceAction: 0 };
    const ready = placeGuest(world, { x: 8, y: 18 }, GuestState.WANDERING, {
      ...needs,
      bathroom: BATHROOM_SEEK_LEVEL,
    });
    const readyId = at(world.guests.id, ready);
    untilTurn(sim, readyId);
    sim.step(1);
    expect(at(world.guests.ride, slotOf(world, readyId))).toBe(1);

    const sim2 = makePark();
    run(sim2, "stall_build", { type: "restrooms", x: 9, y: 14, rot: 1 });
    run(sim2, "ride_open", { id: 1 });
    const early = placeGuest(sim2.world, { x: 8, y: 18 }, GuestState.WANDERING, {
      ...needs,
      bathroom: BATHROOM_SEEK_LEVEL - 10,
    });
    const earlyId = at(sim2.world.guests.id, early);
    untilTurn(sim2, earlyId);
    sim2.step(1);
    expect(at(sim2.world.guests.ride, slotOf(sim2.world, earlyId))).toBe(0);
  });

  it("a guest walking about turns for a stall as soon as it needs one, and says nothing if none", () => {
    for (const open of [true, false]) {
      const sim = stallPark(open);
      const { world } = sim;
      // Walking up the path to (8, 4), past the stall's service tile at (8, 12).
      const slot = placeGuest(world, { x: 8, y: 20 }, GuestState.HEADING, {
        dest: tileIndexOf(world, 8, 4),
        hunger: 200,
        sinceAction: 0,
      });
      const id = at(world.guests.id, slot);
      sim.step(1);
      const now = slotOf(world, id);
      expect(at(world.guests.state, now)).toBe(GuestState.HEADING);
      if (open) {
        expect(at(world.guests.ride, now)).toBe(1);
        stepUntil(sim, () => at(world.guests.state, slotOf(world, id)) === GuestState.BUYING, 400);
      } else {
        // On its way it neither turns nor complains: that waits for its next turn to choose.
        expect(at(world.guests.ride, now)).toBe(0);
        expect(at(world.guests.thought, now)).toBe(0);
      }
      expectSound(world);
    }
  });

  it("goes for the most pressing need, to the nearest stall that meets it", () => {
    const sim = makePark();
    const { world } = sim;
    // Two drinks stands, at (8, 6) and (8, 16) on the path, and a snack stand next to the guest.
    run(sim, "stall_build", { type: "drinks_stand", x: 9, y: 6, rot: 1 });
    run(sim, "stall_build", { type: "drinks_stand", x: 9, y: 16, rot: 1 });
    run(sim, "stall_build", { type: "snack_stand", x: 9, y: 18, rot: 1 });
    for (const id of [1, 2, 3]) run(sim, "ride_open", { id });
    const slot = placeGuest(world, { x: 8, y: 18 }, GuestState.WANDERING, {
      hunger: NEED_SEEK_LEVEL,
      thirst: NEED_SEEK_LEVEL + 20,
    });
    const routes = guestRoutes(world);
    const here = tileIndexOf(world, 8, 18);
    expect(nearestStall(world, here, "thirst", routes)?.id).toBe(2);
    expect(nearestStall(world, here, "hunger", routes)?.id).toBe(3);
    expect(nearestStall(world, here, "bathroom", routes)).toBeUndefined();
    const id = at(world.guests.id, slot);
    untilTurn(sim, id);
    sim.step(1);
    expect(at(world.guests.ride, slotOf(world, id))).toBe(2);
    stepUntil(sim, () => at(world.guests.state, slotOf(world, id)) === GuestState.BUYING, 200);
    sim.step(DRINKS.serveTicks);
    expect(at(world.guests.thought, slotOf(world, id))).toBe(THOUGHT.REFRESHING);
    expect(rideOf(world, 2).stats.customers).toBe(1);
  });

  it("restrooms can be free, and a visit makes the guest feel better", () => {
    const sim = makePark();
    const { world } = sim;
    run(sim, "stall_build", { type: "restrooms", x: 9, y: 14, rot: 1 });
    run(sim, "ride_set_price", { id: 1, cents: 0 });
    run(sim, "ride_open", { id: 1 });
    const slot = placeGuest(world, { x: 8, y: 18 }, GuestState.WANDERING, {
      bathroom: 220,
      cash: 0,
    });
    const id = at(world.guests.id, slot);
    stepUntil(sim, () => at(world.guests.state, slotOf(world, id)) === GuestState.BUYING, 400);
    sim.step(160);
    const after = slotOf(world, id);
    expect(at(world.guests.thought, after)).toBe(THOUGHT.BETTER_NOW);
    expect(at(world.guests.bathroom, after)).toBeLessThan(220 - 150);
    expect(rideOf(world, 1).stats.customers).toBe(1);
    expect(rideOf(world, 1).stats.income).toBe(0);
  });

  for (const how of ["ride_demolish", "ride_close"] as const) {
    it(`${how} while a guest is buying lets it go without charging it`, () => {
      const sim = stallPark();
      const { world } = sim;
      const id = hungryGuest(world);
      const cash = at(world.guests.cash, slotOf(world, id));
      stepUntil(sim, () => at(world.guests.state, slotOf(world, id)) === GuestState.BUYING, 600);
      sim.step(5);
      run(sim, how, { id: 1 });
      const slot = slotOf(world, id);
      expect(at(world.guests.state, slot)).toBe(GuestState.WANDERING);
      expect(at(world.guests.ride, slot)).toBe(0);
      expectSound(world);
      sim.step(SNACK.serveTicks * 2);
      expect(at(world.guests.cash, slotOf(world, id))).toBe(cash);
      expect(world.park.income.shops).toBe(0);
      expectSound(world);
    });

    it(`${how} while a guest is on its way lets it go`, () => {
      const sim = stallPark();
      const { world } = sim;
      const id = hungryGuest(world);
      untilTurn(sim, id);
      sim.step(2);
      expect(at(world.guests.ride, slotOf(world, id))).toBe(1);
      run(sim, how, { id: 1 });
      expect(at(world.guests.ride, slotOf(world, id))).toBe(0);
      expectSound(world);
      sim.step(400);
      expect(world.park.income.shops).toBe(0);
      expectSound(world);
    });
  }

  it("a park saved while a guest is buying carries on exactly as one that was not", () => {
    const sim = stallPark();
    const { world } = sim;
    // As above: one snack, and not hungry again within the 2,000 ticks that follow.
    const id = hungryGuest(world, { hunger: 120 });
    stepUntil(sim, () => at(world.guests.state, slotOf(world, id)) === GuestState.BUYING, 600);
    sim.step(7);
    const twin = new Sim(deserializeWorld(serializeWorld(world)));
    expect(at(twin.world.guests.state, findGuest(twin.world, id))).toBe(GuestState.BUYING);
    sim.step(2000);
    twin.step(2000);
    expect(twin.hash()).toBe(sim.hash());
    expect(rideOf(twin.world, 1).stats.customers).toBe(1);
  });

  it("invariants refuse a guest buying at a ride, or at nothing, or heading for a ride that has gone", () => {
    const sim = stallPark();
    const { world } = sim;
    run(sim, "ride_build", { type: "carousel", x: 4, y: 5, rot: 0 });
    const slot = placeGuest(world, { x: 8, y: 12 }, GuestState.BUYING);
    world.guests.ride[slot] = 1;
    expectSound(world);
    world.guests.ride[slot] = 2;
    expect(validateWorldInvariants(world)).toMatch(/not a stall/);
    world.guests.ride[slot] = 0;
    expect(validateWorldInvariants(world)).toMatch(/buying with no ride/);
    world.guests.state[slot] = GuestState.HEADING;
    world.guests.ride[slot] = 9;
    expect(validateWorldInvariants(world)).toMatch(/heading for ride 9/);
    world.guests.ride[slot] = 2;
    expectSound(world);
  });

  it("undoing the stall's build while a guest is buying lets it go", () => {
    const sim = stallPark();
    const { world } = sim;
    const id = hungryGuest(world);
    stepUntil(sim, () => at(world.guests.state, slotOf(world, id)) === GuestState.BUYING, 600);
    expect(sim.undo().ok).toBe(true); // the open
    expect(sim.undo().ok).toBe(true); // the build
    expect(world.rides).toHaveLength(0);
    expect(at(world.guests.state, slotOf(world, id))).toBe(GuestState.WANDERING);
    expectSound(world);
  });
});

/**
 * `makePark` with two carousels west of the footpath: id 1 at (4, 5), entrance (5, 8), joined to
 * the path at (8, 8), and id 2 at (4, 14), entrance (5, 17), joined at (8, 17). Both open.
 */
function twoCarousels(): Sim {
  const sim = makePark();
  run(sim, "ride_build", { type: "carousel", x: 4, y: 5, rot: 0 });
  run(sim, "ride_build", { type: "carousel", x: 4, y: 14, rot: 0 });
  run(sim, "path_build_tiles", {
    tiles: [
      { x: 5, y: 8 },
      { x: 6, y: 8 },
      { x: 7, y: 8 },
      { x: 5, y: 17 },
      { x: 6, y: 17 },
      { x: 7, y: 17 },
    ],
    kind: "foot",
  });
  run(sim, "ride_open", { id: 1 });
  run(sim, "ride_open", { id: 2 });
  return sim;
}

describe("choosing a ride", () => {
  it("prefers the nearer of two equal rides", () => {
    const sim = twoCarousels();
    const { world } = sim;
    const routes = guestRoutes(world);
    const near1 = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING);
    world.guests.intensityPref[near1] = LIKES_CAROUSEL;
    expect(bestRide(world, near1, tileIndexOf(world, 8, 10), routes)?.id).toBe(1);
    const near2 = placeGuest(world, { x: 8, y: 15 }, GuestState.WANDERING);
    world.guests.intensityPref[near2] = LIKES_CAROUSEL;
    expect(bestRide(world, near2, tileIndexOf(world, 8, 15), routes)?.id).toBe(2);
  });

  it("does not go straight back on the ride it has just been on", () => {
    const sim = twoCarousels();
    const { world } = sim;
    const routes = guestRoutes(world);
    const slot = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING);
    world.guests.intensityPref[slot] = LIKES_CAROUSEL;
    world.guests.lastRide[slot] = 1;
    expect(bestRide(world, slot, tileIndexOf(world, 8, 10), routes)?.id).toBe(2);
    world.guests.lastRide[slot] = 2;
    expect(bestRide(world, slot, tileIndexOf(world, 8, 10), routes)?.id).toBe(1);
  });

  it("skips closed rides, unreachable ones and full queues", () => {
    const sim = twoCarousels();
    const { world } = sim;
    const routes = guestRoutes(world);
    const slot = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING);
    world.guests.intensityPref[slot] = LIKES_CAROUSEL;
    const here = tileIndexOf(world, 8, 10);
    run(sim, "ride_close", { id: 1 });
    expect(bestRide(world, slot, here, routes)?.id).toBe(2);
    run(sim, "ride_open", { id: 1 });
    // A full queue (the platform of a path-only entrance is all there is).
    const queue = rideOf(world, 1).queue;
    for (let i = 0; i < CAROUSEL.capacity; i++) queue.push(1000 + i);
    expect(bestRide(world, slot, here, routes)?.id).toBe(2);
    queue.length = 0;
    run(sim, "path_remove", { x: 6, y: 17, w: 1, h: 1 });
    world.guests.lastRide[slot] = 1;
    expect(bestRide(world, slot, here, guestRoutes(world))).toBeUndefined();
  });

  it("only picks rides within its intensity window", () => {
    const sim = makePark();
    const { world } = sim;
    // A swing tower near the guest (entrance (5, 5), joined at (8, 5)) and a carousel far off.
    run(sim, "ride_build", { type: "swing_tower", x: 4, y: 6, rot: 0 });
    run(sim, "ride_build", { type: "carousel", x: 4, y: 14, rot: 0 });
    run(sim, "path_build_tiles", {
      tiles: [
        { x: 5, y: 5 },
        { x: 6, y: 5 },
        { x: 7, y: 5 },
        { x: 5, y: 17 },
        { x: 6, y: 17 },
        { x: 7, y: 17 },
      ],
      kind: "foot",
    });
    run(sim, "ride_open", { id: 1 });
    run(sim, "ride_open", { id: 2 });
    const routes = guestRoutes(world);
    const here = tileIndexOf(world, 8, 6);
    const slot = placeGuest(world, { x: 8, y: 6 }, GuestState.WANDERING);
    world.guests.intensityPref[slot] = LIKES_CAROUSEL;
    expect(bestRide(world, slot, here, routes)?.id).toBe(2);
    world.guests.intensityPref[slot] = SWING.intensity / 4;
    expect(bestRide(world, slot, here, routes)?.id).toBe(1);
    // Exactly 300 away is still in the window.
    world.guests.intensityPref[slot] = (SWING.intensity - 300) / 4;
    expect(bestRide(world, slot, here, routes)?.id).toBe(1);
    world.guests.intensityPref[slot] = (SWING.intensity - 304) / 4;
    expect(bestRide(world, slot, here, routes)?.id).toBe(2);
  });

  it("a guest made to queue for a ride too intense for it leaves the queue", () => {
    const sim = makePark();
    const { world } = sim;
    run(sim, "ride_build", { type: "swing_tower", x: 4, y: 6, rot: 0 });
    run(sim, "path_build_tiles", {
      tiles: [
        { x: 5, y: 5 },
        { x: 6, y: 5 },
        { x: 7, y: 5 },
      ],
      kind: "foot",
    });
    run(sim, "ride_open", { id: 1 });
    const slot = placeGuest(world, { x: 8, y: 9 }, GuestState.WANDERING, { cash: 50_00 });
    world.guests.intensityPref[slot] = LIKES_CAROUSEL;
    const id = at(world.guests.id, slot);
    expect(sendGuestToRide(world, slot, 1)).toBe(true);
    stepUntil(sim, () => at(world.guests.thought, slotOf(world, id)) === THOUGHT.TOO_INTENSE, 300);
    const after = slotOf(world, id);
    expect(at(world.guests.state, after)).toBe(GuestState.WANDERING);
    expect(at(world.guests.ride, after)).toBe(0);
    expect(rideOf(world, 1).queue).toEqual([]);
    expect(at(world.guests.cash, after)).toBe(50_00);
    expectSound(world);
  });

  it("wandering guests in a park with an open ride go on it", () => {
    const sim = twoCarousels();
    const { world } = sim;
    const ids: number[] = [];
    for (let i = 0; i < 12; i++) {
      const slot = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING, { cash: 50_00 });
      world.guests.intensityPref[slot] = LIKES_CAROUSEL;
      ids.push(at(world.guests.id, slot));
    }
    sim.step(WANDER_INTERVAL);
    const chose = ids.filter((id) => at(world.guests.ride, slotOf(world, id)) !== 0);
    // One draw in two: some go, some wander as before.
    expect(chose.length).toBeGreaterThan(0);
    expect(chose.length).toBeLessThan(ids.length);
    for (const id of chose) expect(at(world.guests.ride, slotOf(world, id))).toBe(1);
    expect(ok(sim, chose[0] as number).ride).toMatchObject({ id: 1, name: "Carousel 1" });
    sim.step(2000);
    expect(rideOf(world, 1).stats.customers).toBeGreaterThan(0);
    expect(world.park.income.rides).toBe(
      rideOf(world, 1).stats.income + rideOf(world, 2).stats.income,
    );
    expectSound(world);
  });
});

/** `guest_get` for guest `id`. */
function ok(sim: Sim, id: number): { ride: unknown; state: string } {
  const result = sim.query("guest_get", { id });
  if (!result.ok) throw new Error(result.error);
  return result.result as { ride: unknown; state: string };
}

describe("guest_get", () => {
  it("says which ride a guest is queuing for or riding, and null when none", () => {
    const sim = twoCarousels();
    const { world } = sim;
    const slot = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING, { cash: 50_00 });
    const id = at(world.guests.id, slot);
    expect(ok(sim, id).ride).toBeNull();
    expect(sendGuestToRide(world, slot, 1)).toBe(true);
    expect(ok(sim, id).ride).toEqual({ id: 1, name: "Carousel 1", doing: "heading" });
    stepUntil(sim, () => at(world.guests.state, slotOf(world, id)) === GuestState.QUEUING, 200);
    expect(ok(sim, id).ride).toEqual({ id: 1, name: "Carousel 1", doing: "queuing" });
    stepUntil(sim, () => at(world.guests.state, slotOf(world, id)) === GuestState.RIDING, 200);
    expect(ok(sim, id)).toMatchObject({
      state: "riding",
      ride: { id: 1, name: "Carousel 1", doing: "riding" },
    });
  });
});

describe("the rating", () => {
  it("gains a little for each different open ride type, up to a cap", () => {
    expect(nextRating(0, 1, 0)).toBe(0);
    expect(nextRating(0, 1, 0, 0)).toBe(0);
    // Target 30: a sixteenth of the way is 1.
    expect(nextRating(0, 1, 0, 3)).toBe(1);
    // Target 60, the cap.
    expect(nextRating(0, 1, 0, 6)).toBe(3);
    expect(nextRating(0, 1, 0, 9)).toBe(3);
  });

  it("counts open ride types, not rides, and not stalls", () => {
    const sim = twoCarousels();
    const { world } = sim;
    expect(openRideTypes(world)).toBe(1);
    run(sim, "ride_build", { type: "swing_tower", x: 2, y: 11, rot: 0 });
    run(sim, "stall_build", { type: "snack_stand", x: 9, y: 12, rot: 1 });
    run(sim, "ride_open", { id: 4 });
    expect(openRideTypes(world)).toBe(1);
    run(sim, "ride_open", { id: 3 });
    expect(openRideTypes(world)).toBe(2);
    run(sim, "ride_close", { id: 1 });
    run(sim, "ride_close", { id: 2 });
    expect(openRideTypes(world)).toBe(1);
  });
});

describe("need fields", () => {
  it("give every tile its nearest open stall for a need and the steps to it, the lower id on a tie", () => {
    const sim = makePark();
    const { world } = sim;
    // Drinks stands serving onto (8, 6) and (8, 16), and a snack stand onto (8, 18).
    run(sim, "stall_build", { type: "drinks_stand", x: 9, y: 6, rot: 1 });
    run(sim, "stall_build", { type: "drinks_stand", x: 9, y: 16, rot: 1 });
    run(sim, "stall_build", { type: "snack_stand", x: 9, y: 18, rot: 1 });
    for (const id of [1, 2, 3]) run(sim, "ride_open", { id });
    guestRoutes(world);
    const thirst = stallField(world, "thirst");
    const tile = (y: number) => tileIndexOf(world, 8, y);
    expect([at(thirst.dist, tile(6)), at(thirst.owner, tile(6))]).toEqual([0, 1]);
    expect([at(thirst.dist, tile(16)), at(thirst.owner, tile(16))]).toEqual([0, 2]);
    expect([at(thirst.dist, tile(20)), at(thirst.owner, tile(20))]).toEqual([4, 2]);
    // (8, 11) is five steps from each: the lower id, seeded first, claims it.
    expect([at(thirst.dist, tile(11)), at(thirst.owner, tile(11))]).toEqual([5, 1]);
    expect([at(thirst.dist, tile(12)), at(thirst.owner, tile(12))]).toEqual([4, 2]);
    // Off the paths, nothing.
    expect(at(thirst.dist, tileIndexOf(world, 2, 2))).toBe(UNREACHABLE);
    expect(at(thirst.owner, tileIndexOf(world, 2, 2))).toBe(0);
    const hunger = stallField(world, "hunger");
    expect([at(hunger.dist, tile(4)), at(hunger.owner, tile(4))]).toEqual([14, 3]);
    expect(at(stallField(world, "bathroom").dist, tile(18))).toBe(UNREACHABLE);
    // The same field until the rides or paths change; closing a stall takes it out.
    expect(stallField(world, "thirst")).toBe(thirst);
    run(sim, "ride_close", { id: 1 });
    const closed = stallField(world, "thirst");
    expect(closed).not.toBe(thirst);
    expect([at(closed.dist, tile(11)), at(closed.owner, tile(11))]).toEqual([5, 2]);
  });

  it("let a guest choose a stall or a ride without a distance field for each", () => {
    const sim = twoCarousels();
    const { world } = sim;
    run(sim, "stall_build", { type: "snack_stand", x: 9, y: 12, rot: 1 });
    run(sim, "stall_build", { type: "snack_stand", x: 9, y: 20, rot: 1 });
    run(sim, "ride_open", { id: 3 });
    run(sim, "ride_open", { id: 4 });
    const routes = guestRoutes(world);
    const slot = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING, { cash: 50_00 });
    world.guests.intensityPref[slot] = LIKES_CAROUSEL;
    const here = tileIndexOf(world, 8, 10);
    expect(nearestStall(world, here, "hunger", routes)?.id).toBe(3);
    expect(bestRide(world, slot, here, routes)?.id).toBe(1);
    for (const ride of world.rides) {
      const tile = ride.kind === "ride" ? ride.entrance : ride.service;
      if (tile === null) throw new Error("no access tile");
      expect(routes.has(tileIndexOf(world, tile.x, tile.y))).toBe(false);
    }
  });

  it("lead a guest on its way to a stall to a nearer one that opens on the way, and it buys there", () => {
    const sim = stallPark();
    const { world } = sim;
    const id = hungryGuest(world);
    untilTurn(sim, id);
    sim.step(1);
    expect(at(world.guests.ride, slotOf(world, id))).toBe(1);
    // A second snack stand, serving onto (8, 15), between the guest and the first.
    run(sim, "stall_build", { type: "snack_stand", x: 9, y: 15, rot: 1 });
    run(sim, "ride_open", { id: 2 });
    stepUntil(sim, () => at(world.guests.state, slotOf(world, id)) === GuestState.BUYING, 400);
    const slot = slotOf(world, id);
    expect(at(world.guests.ride, slot)).toBe(2);
    expect({ x: at(world.guests.x, slot) >> 5, y: at(world.guests.y, slot) >> 5 }).toEqual({
      x: 8,
      y: 15,
    });
    expectSound(world);
    sim.step(SNACK.serveTicks);
    expect(rideOf(world, 2).stats.customers).toBe(1);
    expect(rideOf(world, 1).stats.customers).toBe(0);
  });
});

describe("guests short of money", () => {
  it("a guest that cannot afford the nearest stall thinks so once, and does not walk to it", () => {
    const sim = stallPark();
    const { world } = sim;
    const id = hungryGuest(world, { cash: 10 });
    untilTurn(sim, id);
    sim.step(1);
    let slot = slotOf(world, id);
    expect(at(world.guests.thought, slot)).toBe(THOUGHT.CANT_AFFORD_RIDE);
    expect(at(world.guests.ride, slot)).toBe(0);
    const first = at(world.guests.thoughtTick, slot);
    // Its next turns that day: no stall, and no second thought about it.
    for (let turn = 0; turn < 2; turn++) {
      untilTurn(sim, id);
      sim.step(1);
      slot = slotOf(world, id);
      expect(at(world.guests.ride, slot)).toBe(0);
      expect(at(world.guests.thoughtTick, slot)).toBe(first);
    }
    // A day later it looks again, and thinks it again.
    stepUntil(sim, () => at(world.guests.thoughtTick, slotOf(world, id)) !== first, TICKS_PER_DAY);
    expect(at(world.guests.thought, slotOf(world, id))).toBe(THOUGHT.CANT_AFFORD_RIDE);
    expect(at(world.guests.thoughtTick, slotOf(world, id))).toBeGreaterThanOrEqual(
      first + TICKS_PER_DAY,
    );
    expect(at(world.guests.cash, slotOf(world, id))).toBe(10);
    expect(world.park.income.shops).toBe(0);
    expectSound(world);
  });

  it("a guest whose stall puts its price up on the way is served nothing, charged nothing, and still hungry", () => {
    const sim = stallPark();
    const { world } = sim;
    const id = hungryGuest(world, { cash: 10 });
    run(sim, "ride_set_price", { id: 1, cents: 0 });
    untilTurn(sim, id);
    sim.step(1);
    expect(at(world.guests.ride, slotOf(world, id))).toBe(1);
    run(sim, "ride_set_price", { id: 1, cents: 150 });
    stepUntil(sim, () => at(world.guests.state, slotOf(world, id)) === GuestState.BUYING, 600);
    const hunger = at(world.guests.hunger, slotOf(world, id));
    sim.step(SNACK.serveTicks);
    const slot = slotOf(world, id);
    expect(at(world.guests.state, slot)).toBe(GuestState.WANDERING);
    expect(at(world.guests.cash, slot)).toBe(10);
    expect(at(world.guests.thought, slot)).toBe(THOUGHT.CANT_AFFORD_RIDE);
    expect(at(world.guests.hunger, slot)).toBeGreaterThanOrEqual(hunger);
    expect(world.park.income.shops).toBe(0);
    expect(rideOf(world, 1).stats.customers).toBe(0);
  });

  it("a guest that keeps failing to afford its stall still goes home when it has been idle too long", () => {
    // Only the tile beside the gate has a path, and the snack stand serves onto it: the guest has
    // nowhere else to walk.
    const sim = makePark();
    const { world } = sim;
    run(sim, "path_remove", { x: 8, y: 4, w: 1, h: 18 });
    run(sim, "stall_build", { type: "snack_stand", x: 9, y: 22, rot: 1 });
    run(sim, "ride_open", { id: 1 });
    const slot = placeGuest(world, { x: 8, y: 22 }, GuestState.WANDERING, {
      hunger: 200,
      thirst: 0,
      energy: 255,
      happiness: 200,
      cash: 10,
      sinceAction: 0,
    });
    const id = at(world.guests.id, slot);
    stepUntil(
      sim,
      () => {
        const s = findGuest(world, id);
        return s < 0 || at(world.guests.state, s) === GuestState.LEAVING;
      },
      LEAVE_IDLE_TICKS + 2 * WANDER_INTERVAL,
    );
    // It went on idleness, not because it ran out of energy or spirits, and it never paid.
    const left = findGuest(world, id);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(at(world.guests.thought, left)).toBe(THOUGHT.GOING_HOME);
    expect(at(world.guests.cash, left)).toBe(10);
    expect(at(world.guests.energy, left)).toBeGreaterThanOrEqual(30);
    expect(at(world.guests.happiness, left)).toBeGreaterThanOrEqual(60);
  });

  it("does not choose a ride it cannot afford", () => {
    const sim = twoCarousels();
    const { world } = sim;
    const routes = guestRoutes(world);
    const slot = placeGuest(world, { x: 8, y: 10 }, GuestState.WANDERING, { cash: 1_00 });
    world.guests.intensityPref[slot] = LIKES_CAROUSEL;
    const here = tileIndexOf(world, 8, 10);
    expect(bestRide(world, slot, here, routes)?.id).toBe(1);
    run(sim, "ride_set_price", { id: 1, cents: 1_01 });
    expect(bestRide(world, slot, here, routes)?.id).toBe(2);
    run(sim, "ride_set_price", { id: 2, cents: 2_00 });
    expect(bestRide(world, slot, here, routes)).toBeUndefined();
  });
});

describe("parks without rides", () => {
  // Hashes recorded before guests could choose rides and stalls: a park with none behaves exactly
  // as it did. The D3 need tuning (seek levels 80 and 56, complaints at 160, turning for a stall on
  // the way) left them as they were on purpose, since needs only ever act through a stall, so these
  // also guard that the tuning is inert without rides: re-pinning them means a park without rides
  // or stalls now plays differently, which has to be meant.
  it("carry on exactly as before", () => {
    const a = makePark({ rating: 900, seed: 5 });
    a.step(8000);
    expect(a.hash()).toBe("f017af815e91b56e");
    // The sample park as it was before it had rides and stalls of its own.
    const b = new Sim(createSamplePark(42, { withRides: false }));
    b.step(8000);
    expect(b.hash()).toBe("d201eb6af3f0249e");
  });
});

describe("parks with rides but no stalls", () => {
  // Recorded with the build before the D3 need tuning (seek level 160 for every need, and a
  // complaint whenever a need found no stall): a guest's lower seek levels and turning for a stall
  // on its way change nothing in a park that has nowhere to buy, so its guests think, feel and rate
  // the park exactly as before.
  it("carry on exactly as before the need tuning", () => {
    const sim = new Sim(createSamplePark(42));
    for (const stall of sim.world.rides.filter((r) => r.kind === "stall")) {
      expect(sim.execute("ride_demolish", { id: stall.id }, "system").ok).toBe(true);
    }
    expect(sim.world.rides.some((r) => r.kind === "ride" && r.open)).toBe(true);
    sim.step(8000);
    expect(sim.hash()).toBe("f58dd634dfc24f99");
  });
});
