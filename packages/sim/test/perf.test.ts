import { typeById } from "@coasterworks/content";
import { describe, expect, it } from "vitest";
import { GUEST_CAP, GuestState, PATH_FOOT, Sim, createWorld } from "../src/index.js";
import { spawnGuest } from "../src/guests/guests.js";

/** Rides and stalls in the packed park: type, top-left tile, turn. */
const ATTRACTIONS = [
  { type: "carousel", x: 10, y: 10, rot: 0 },
  { type: "swing_tower", x: 40, y: 40, rot: 0 },
  { type: "big_wheel", x: 50, y: 8, rot: 0 },
  { type: "snack_stand", x: 20, y: 30, rot: 0 },
  { type: "drinks_stand", x: 44, y: 24, rot: 0 },
  { type: "restrooms", x: 28, y: 50, rot: 0 },
] as const;

/**
 * 2,000 guests on a 64 by 64 map that is path from edge to edge, the busiest park the sim allows
 * and the worst case for routing: every tile is walkable and every guest has somewhere to go.
 * Three rides and three stalls stand in it, open, on ground cleared of path, and the guests'
 * needs are spread over the whole range, so many of them go to the stalls and rides as well as
 * walking about. The gate is open, the rating is 0 (nobody else arrives) and the fee is nothing.
 */
function packedPark(): Sim {
  const world = createWorld({
    width: 64,
    height: 64,
    seed: 11,
    name: "Packed",
    cash: 1_000_000_00,
  });
  const sim = new Sim(world);
  world.terrain.path.fill(PATH_FOOT);
  // The entrance tile itself carries no path; the sim treats it as walkable all the same.
  world.terrain.path[63 * 64 + 32] = 0;
  world.park.entrance = { x: 32, y: 63, side: 2 };
  world.park.open = true;
  world.park.entryFee = 0;
  world.park.rating = 0;
  world.pathVersion++;
  for (const { type, x, y, rot } of ATTRACTIONS) {
    const kind = typeById(type)?.kind;
    const { w, h } = typeById(type)?.footprint ?? { w: 1, h: 1 };
    for (let ty = y; ty < y + h; ty++) world.terrain.path.fill(0, ty * 64 + x, ty * 64 + x + w);
    world.pathVersion++;
    const built = sim.execute(kind === "stall" ? "stall_build" : "ride_build", { type, x, y, rot });
    if (!built.ok) throw new Error(built.error);
  }
  for (const ride of world.rides) {
    const opened = sim.execute("ride_open", { id: ride.id });
    if (!opened.ok) throw new Error(opened.error);
  }

  const rng = world.rngStreams.guests;
  for (let i = 0; i < GUEST_CAP; i++) {
    const slot = spawnGuest(world, rng);
    // On a path tile: not on the ground cleared for a ride or stall.
    let x = rng.int(64);
    let y = rng.int(63);
    while (world.terrain.path[y * 64 + x] === 0) {
      x = rng.int(64);
      y = rng.int(63);
    }
    const g = world.guests;
    g.x[slot] = x * 32 + 16;
    g.y[slot] = y * 32 + 16;
    g.tx[slot] = x;
    g.ty[slot] = y;
    g.state[slot] = GuestState.WANDERING;
    g.dest[slot] = -1;
    g.hunger[slot] = rng.int(256);
    g.thirst[slot] = rng.int(256);
    g.bathroom[slot] = rng.int(256);
  }
  return sim;
}

const STALL_KINDS = ["snack_stand", "drinks_stand", "restrooms"] as const;
const RIDE_KINDS = ["carousel", "swing_tower", "big_wheel"] as const;

/**
 * The worst case for choosing: 2,000 hungry and thirsty guests on a 256 by 256 map that is path
 * from edge to edge, with 90 open stalls (30 of each kind, on a 10 by 9 grid 24 tiles apart) and
 * 20 open rides (a 5 by 4 grid 48 tiles apart), each on ground cleared of path. Every guest's
 * hunger and thirst is 160 or more, so on every turn it goes for a stall.
 */
function crowdedBigPark(): Sim {
  const size = 256;
  const world = createWorld({ width: size, height: size, seed: 12, name: "Big", cash: 1e11 });
  const sim = new Sim(world);
  const path = world.terrain.path;
  path.fill(PATH_FOOT);
  path[(size - 1) * size + 128] = 0;
  world.park.entrance = { x: 128, y: size - 1, side: 2 };
  world.park.open = true;
  world.park.entryFee = 0;
  world.park.rating = 0;
  const builds: { type: string; x: number; y: number }[] = [];
  for (let j = 0; j < 9; j++) {
    for (let i = 0; i < 10; i++) {
      builds.push({ type: STALL_KINDS[(i + j) % 3] as string, x: 10 + 24 * i, y: 10 + 24 * j });
    }
  }
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 5; i++) {
      builds.push({ type: RIDE_KINDS[(i + j) % 3] as string, x: 22 + 48 * i, y: 22 + 48 * j });
    }
  }
  for (const { type, x, y } of builds) {
    const content = typeById(type);
    const { w, h } = content?.footprint ?? { w: 1, h: 1 };
    for (let ty = y; ty < y + h; ty++) path.fill(0, ty * size + x, ty * size + x + w);
    world.pathVersion++;
    const kind = content?.kind === "stall" ? "stall_build" : "ride_build";
    const built = sim.execute(kind, { type, x, y, rot: 0 });
    if (!built.ok) throw new Error(built.error);
  }
  for (const ride of world.rides) {
    const opened = sim.execute("ride_open", { id: ride.id });
    if (!opened.ok) throw new Error(opened.error);
  }
  const rng = world.rngStreams.guests;
  for (let i = 0; i < GUEST_CAP; i++) {
    const slot = spawnGuest(world, rng);
    let x = rng.int(size);
    let y = rng.int(size - 1);
    while (path[y * size + x] === 0) {
      x = rng.int(size);
      y = rng.int(size - 1);
    }
    const g = world.guests;
    g.x[slot] = x * 32 + 16;
    g.y[slot] = y * 32 + 16;
    g.tx[slot] = x;
    g.ty[slot] = y;
    g.state[slot] = GuestState.WANDERING;
    g.dest[slot] = -1;
    g.hunger[slot] = 160 + rng.int(96);
    g.thirst[slot] = 160 + rng.int(96);
    g.cash[slot] = 100_00;
  }
  return sim;
}

describe("guest performance", () => {
  it("ticks 2,000 guests for 100 ticks in under 500 ms", () => {
    const sim = packedPark();
    // Let the routes and the first waves of decisions warm up, then time a stretch.
    sim.step(20);
    const start = performance.now();
    sim.step(100);
    const elapsed = performance.now() - start;
    expect(sim.world.guests.count).toBe(GUEST_CAP);
    // They are doing things: most are walking.
    let heading = 0;
    for (let slot = 0; slot < GUEST_CAP; slot++) {
      if (sim.world.guests.state[slot] === GuestState.HEADING) heading++;
    }
    expect(heading).toBeGreaterThan(200);
    expect(elapsed).toBeLessThan(500);
    // And, given a little longer, riding every ride and buying at every stall.
    sim.step(400);
    for (const ride of sim.world.rides) expect(ride.stats.customers).toBeGreaterThan(0);
  });

  // Run with PERF=1: the stricter budget is a benchmark, not something every CI machine can promise.
  it.skipIf(process.env["PERF"] !== "1")("ticks 2,000 guests for 1,000 ticks in under 2 s", () => {
    const sim = packedPark();
    sim.step(20);
    const start = performance.now();
    sim.step(1000);
    const elapsed = performance.now() - start;
    console.log(`2,000 guests, 1,000 ticks: ${elapsed.toFixed(0)} ms`);
    expect(sim.world.guests.count).toBe(GUEST_CAP);
    expect(elapsed).toBeLessThan(2000);
  });

  it.skipIf(process.env["PERF"] !== "1")(
    "ticks 2,000 hungry guests among 90 stalls and 20 rides on a 256 by 256 map at 2 ms a tick",
    () => {
      const sim = crowdedBigPark();
      // Long enough for the first guests to have been served and to be choosing rides as well.
      sim.step(800);
      const ticks = 200;
      const start = performance.now();
      sim.step(ticks);
      const perTick = (performance.now() - start) / ticks;
      console.log(`2,000 guests, 90 stalls, 20 rides, 256x256: ${perTick.toFixed(2)} ms a tick`);
      let served = 0;
      for (const ride of sim.world.rides) if (ride.kind === "stall") served += ride.stats.customers;
      expect(sim.world.guests.count).toBe(GUEST_CAP);
      expect(served).toBeGreaterThan(0);
      expect(perTick).toBeLessThan(2);
    },
  );
});
