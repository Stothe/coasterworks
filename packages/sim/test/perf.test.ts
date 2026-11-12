import { describe, expect, it } from "vitest";
import { GUEST_CAP, GuestState, PATH_FOOT, Sim, createWorld } from "../src/index.js";
import { spawnGuest } from "../src/guests/guests.js";

/**
 * 2,000 guests on a 64 by 64 map that is path from edge to edge, the busiest park the sim allows
 * and the worst case for routing: every tile is walkable and every guest has somewhere to go.
 * The gate is open, the rating is 0 (nobody else arrives) and the fee is nothing.
 */
function packedPark(): Sim {
  const world = createWorld({ width: 64, height: 64, seed: 11, name: "Packed" });
  const sim = new Sim(world);
  world.terrain.path.fill(PATH_FOOT);
  // The entrance tile itself carries no path; the sim treats it as walkable all the same.
  world.terrain.path[63 * 64 + 32] = 0;
  world.park.entrance = { x: 32, y: 63, side: 2 };
  world.park.open = true;
  world.park.entryFee = 0;
  world.park.rating = 0;
  world.pathVersion++;

  const rng = world.rngStreams.guests;
  for (let i = 0; i < GUEST_CAP; i++) {
    const slot = spawnGuest(world, rng);
    const x = rng.int(64);
    const y = rng.int(63);
    const g = world.guests;
    g.x[slot] = x * 32 + 16;
    g.y[slot] = y * 32 + 16;
    g.tx[slot] = x;
    g.ty[slot] = y;
    g.state[slot] = GuestState.WANDERING;
    g.dest[slot] = -1;
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
});
