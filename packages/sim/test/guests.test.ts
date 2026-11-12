import { describe, expect, it } from "vitest";
import {
  GUEST_CAP,
  GuestState,
  Rng,
  THOUGHT,
  THOUGHTS,
  createWorld,
  guestName,
  hashWorld,
  thoughtText,
  type World,
} from "../src/index.js";
import {
  compactGuests,
  forEachGuest,
  guestTile,
  moveToward,
  removeGuest,
  spawnGuest,
} from "../src/guests/guests.js";
import { guestRoutes } from "../src/guests/behavior.js";
import { FIRST_NAMES, LAST_NAMES } from "../src/guests/names.js";
import { GUEST_ARRAYS } from "../src/guests/types.js";
import { at, liveCount } from "./helpers/guests.js";

/** A 10 by 10 world with the entrance on the given edge tile. */
function worldWithEntrance(x: number, y: number, side: 0 | 1 | 2 | 3, seed = 3): World {
  const world = createWorld({ width: 10, height: 10, seed, name: "Spawn" });
  world.park.entrance = { x, y, side };
  return world;
}

function spawn(world: World): number {
  return spawnGuest(world, world.rngStreams.guests);
}

describe("the guest store", () => {
  it("starts empty, with every array the size of the cap", () => {
    const world = createWorld({ width: 4, height: 4, seed: 1, name: "t" });
    const g = world.guests;
    expect(GUEST_CAP).toBe(2000);
    expect(g.count).toBe(0);
    expect(g.nextGuestId).toBe(1);
    expect(g.freeCount).toBe(GUEST_CAP);
    expect(g.live).toBeInstanceOf(Uint8Array);
    expect(g.live).toHaveLength(GUEST_CAP);
    expect(g.free).toBeInstanceOf(Int32Array);
    expect(g.free).toHaveLength(GUEST_CAP);
    for (const [name, kind] of GUEST_ARRAYS) {
      const array = g[name];
      expect(array.constructor.name, name).toBe(kind);
      expect(array, name).toHaveLength(GUEST_CAP);
    }
  });

  it("types the arrays as the brief lays out", () => {
    const g = createWorld({ width: 4, height: 4, seed: 1, name: "t" }).guests;
    expect(g.id).toBeInstanceOf(Int32Array);
    expect(g.x).toBeInstanceOf(Int32Array);
    expect(g.tx).toBeInstanceOf(Int32Array);
    expect(g.dest).toBeInstanceOf(Int32Array);
    expect(g.state).toBeInstanceOf(Uint8Array);
    expect(g.happiness).toBeInstanceOf(Uint8Array);
    expect(g.nausea).toBeInstanceOf(Uint8Array);
    expect(g.cash).toBeInstanceOf(Int32Array);
    expect(g.color).toBeInstanceOf(Uint8Array);
    expect(g.name).toBeInstanceOf(Uint16Array);
    expect(g.thought).toBeInstanceOf(Uint8Array);
    expect(g.thoughtTick).toBeInstanceOf(Int32Array);
    expect(g.sinceAction).toBeInstanceOf(Int32Array);
    expect(g.lostTicks).toBeInstanceOf(Int32Array);
  });

  it("has its own rng stream, forked from the root at creation", () => {
    const world = createWorld({ width: 4, height: 4, seed: 99, name: "t" });
    const root = new Rng(99);
    expect(world.rngStreams.guests.state).toEqual(root.fork("guests").state);
    // The root itself was not advanced by forking.
    expect(world.rng.state).toEqual(root.state);
    // Two seeds give two streams.
    const other = createWorld({ width: 4, height: 4, seed: 100, name: "t" });
    expect(other.rngStreams.guests.state).not.toEqual(world.rngStreams.guests.state);
  });

  it("numbers the states as the brief does", () => {
    expect(GuestState).toEqual({
      ENTERING: 0,
      WANDERING: 1,
      HEADING: 2,
      LEAVING: 3,
      LOST: 4,
      GONE: 5,
    });
  });
});

describe("spawnGuest", () => {
  // Side 0 is the north edge, 1 east, 2 south, 3 west. The guest starts one tile outside the map.
  it.each([
    ["north", { x: 5, y: 0, side: 0 as const }, { x: 5, y: -1 }],
    ["east", { x: 9, y: 4, side: 1 as const }, { x: 10, y: 4 }],
    ["south", { x: 3, y: 9, side: 2 as const }, { x: 3, y: 10 }],
    ["west", { x: 0, y: 6, side: 3 as const }, { x: -1, y: 6 }],
  ])("puts a guest in the off-map lane on the %s side", (_label, entrance, lane) => {
    const world = worldWithEntrance(entrance.x, entrance.y, entrance.side);
    const slot = spawn(world);
    expect(slot).toBe(0);
    const g = world.guests;
    expect(g.count).toBe(1);
    expect(at(g.live, slot)).toBe(1);
    expect(at(g.id, slot)).toBe(1);
    expect(g.nextGuestId).toBe(2);
    // In the middle of the lane tile, in 1/32 tile units.
    expect(at(g.x, slot)).toBe(lane.x * 32 + 16);
    expect(at(g.y, slot)).toBe(lane.y * 32 + 16);
    expect(guestTile(world, slot)).toEqual(lane);
    expect(at(g.state, slot)).toBe(GuestState.ENTERING);
    // It is heading for the entrance tile.
    expect(at(g.tx, slot)).toBe(entrance.x);
    expect(at(g.ty, slot)).toBe(entrance.y);
  });

  it("starts guests with needs in bands, some cash, a colour, and a name", () => {
    const world = worldWithEntrance(5, 0, 0);
    for (let i = 0; i < 300; i++) expect(spawn(world)).toBeGreaterThanOrEqual(0);
    const g = world.guests;
    const colors = new Set<number>();
    const names = new Set<number>();
    for (let slot = 0; slot < 300; slot++) {
      expect(at(g.hunger, slot)).toBeLessThan(80);
      expect(at(g.thirst, slot)).toBeLessThan(80);
      expect(at(g.bathroom, slot)).toBeLessThan(60);
      expect(at(g.energy, slot)).toBeGreaterThanOrEqual(160);
      expect(at(g.nausea, slot)).toBe(0);
      expect(at(g.happiness, slot)).toBeGreaterThanOrEqual(150);
      expect(at(g.happiness, slot)).toBeLessThanOrEqual(230);
      expect(at(g.cash, slot)).toBeGreaterThanOrEqual(20_00);
      expect(at(g.cash, slot)).toBeLessThanOrEqual(80_00);
      expect(at(g.color, slot)).toBeLessThanOrEqual(8);
      expect(at(g.name, slot)).toBeLessThan(64 * 32);
      expect(at(g.thought, slot)).toBe(0);
      expect(at(g.sinceAction, slot)).toBe(0);
      expect(at(g.lostTicks, slot)).toBe(0);
      // It is bound for the entrance tile, (5, 0): index 5 on a map 10 tiles wide.
      expect(at(g.dest, slot)).toBe(5);
      colors.add(at(g.color, slot));
      names.add(at(g.name, slot));
    }
    // Varied: the draws really are random.
    expect(colors.size).toBeGreaterThan(5);
    expect(names.size).toBeGreaterThan(100);
  });

  it("returns -1 with no entrance, and when the park is full", () => {
    const world = createWorld({ width: 10, height: 10, seed: 1, name: "t" });
    expect(spawn(world)).toBe(-1);
    expect(world.guests.count).toBe(0);
    expect(world.guests.nextGuestId).toBe(1);

    world.park.entrance = { x: 5, y: 0, side: 0 };
    for (let i = 0; i < GUEST_CAP; i++) expect(spawn(world)).toBe(i);
    expect(world.guests.count).toBe(GUEST_CAP);
    expect(spawn(world)).toBe(-1);
    expect(world.guests.count).toBe(GUEST_CAP);
    expect(world.guests.nextGuestId).toBe(GUEST_CAP + 1);
  });

  it("is deterministic: a seed gives the same guests, another seed different ones", () => {
    const build = (seed: number) => {
      const world = worldWithEntrance(5, 0, 0, seed);
      for (let i = 0; i < 50; i++) spawn(world);
      return world;
    };
    const a = build(7);
    const b = build(7);
    const c = build(8);
    for (const [name] of GUEST_ARRAYS) expect(b.guests[name], name).toEqual(a.guests[name]);
    expect(c.guests.cash).not.toEqual(a.guests.cash);
    expect(hashWorld(a)).toBe(hashWorld(b));
    expect(hashWorld(a)).not.toBe(hashWorld(c));
  });
});

describe("removeGuest and forEachGuest", () => {
  it("frees the slot, counts the guest out, and hands the slot to the next arrival", () => {
    const world = worldWithEntrance(5, 0, 0);
    for (let i = 0; i < 4; i++) spawn(world);
    removeGuest(world, 1);
    expect(world.guests.count).toBe(3);
    expect(at(world.guests.live, 1)).toBe(0);
    expect(at(world.guests.state, 1)).toBe(GuestState.GONE);
    expect(liveCount(world)).toBe(3);
    // Removing it again does nothing.
    removeGuest(world, 1);
    expect(world.guests.count).toBe(3);
    // The next guest takes the freed slot but gets a new id.
    expect(spawn(world)).toBe(1);
    expect(at(world.guests.id, 1)).toBe(5);
    expect(world.guests.count).toBe(4);
  });

  it("visits live slots in slot order and copes with the callback removing one", () => {
    const world = worldWithEntrance(5, 0, 0);
    for (let i = 0; i < 6; i++) spawn(world);
    removeGuest(world, 2);
    const seen: number[] = [];
    forEachGuest(world, (slot) => {
      seen.push(slot);
      if (slot === 3) removeGuest(world, 4);
    });
    expect(seen).toEqual([0, 1, 3, 5]);
    expect(world.guests.count).toBe(4);
  });

  it("compacts: live guests keep their order and move down to fill the holes", () => {
    const world = worldWithEntrance(5, 0, 0);
    for (let i = 0; i < 5; i++) spawn(world);
    removeGuest(world, 1);
    removeGuest(world, 3);
    expect(world.guests.fragmented).toBe(true);
    compactGuests(world);
    const g = world.guests;
    expect(g.fragmented).toBe(false);
    expect(g.count).toBe(3);
    expect([0, 1, 2].map((slot) => at(g.id, slot))).toEqual([1, 3, 5]);
    expect([0, 1, 2, 3].map((slot) => at(g.live, slot))).toEqual([1, 1, 1, 0]);
    expect(liveCount(world)).toBe(3);
    // The next arrival goes on the end, in id order.
    expect(spawn(world)).toBe(3);
    expect(at(g.id, 3)).toBe(6);
    // Compacting a compact store changes nothing.
    const before = hashWorld(world);
    compactGuests(world);
    expect(hashWorld(world)).toBe(before);
  });
});

describe("guestTile", () => {
  it("is the tile a position falls in, rounding down", () => {
    const world = worldWithEntrance(5, 0, 0);
    const slot = spawn(world);
    const g = world.guests;
    const at32 = (x: number, y: number) => {
      g.x[slot] = x;
      g.y[slot] = y;
      return guestTile(world, slot);
    };
    expect(at32(0, 0)).toEqual({ x: 0, y: 0 });
    expect(at32(31, 31)).toEqual({ x: 0, y: 0 });
    expect(at32(32, 63)).toEqual({ x: 1, y: 1 });
    // Off the map to the north and west, the tile is -1, not 0.
    expect(at32(-1, -32)).toEqual({ x: -1, y: -1 });
    expect(at32(-16, -33)).toEqual({ x: -1, y: -2 });
  });
});

describe("moveToward", () => {
  function walker(from: { x: number; y: number }, to: { x: number; y: number }) {
    const world = worldWithEntrance(5, 0, 0);
    const slot = spawn(world);
    const g = world.guests;
    g.x[slot] = from.x * 32 + 16;
    g.y[slot] = from.y * 32 + 16;
    g.tx[slot] = to.x;
    g.ty[slot] = to.y;
    return { world, slot, pos: () => [at(g.x, slot), at(g.y, slot)] };
  }

  it("steps 2 units a tick towards the middle of the target tile, and stops there", () => {
    const { world, slot, pos } = walker({ x: 2, y: 2 }, { x: 3, y: 2 });
    moveToward(world, slot);
    expect(pos()).toEqual([2 * 32 + 16 + 2, 2 * 32 + 16]);
    for (let i = 0; i < 15; i++) moveToward(world, slot);
    expect(pos()).toEqual([3 * 32 + 16, 2 * 32 + 16]);
    moveToward(world, slot);
    expect(pos()).toEqual([3 * 32 + 16, 2 * 32 + 16]);
  });

  it("goes along x first, then y, so guests walk the middles of tiles", () => {
    const { world, slot, pos } = walker({ x: 2, y: 2 }, { x: 4, y: 3 });
    for (let i = 0; i < 32; i++) moveToward(world, slot);
    expect(pos()).toEqual([4 * 32 + 16, 2 * 32 + 16]);
    for (let i = 0; i < 16; i++) moveToward(world, slot);
    expect(pos()).toEqual([4 * 32 + 16, 3 * 32 + 16]);
  });

  it("walks west and north too", () => {
    const { world, slot, pos } = walker({ x: 5, y: 5 }, { x: 4, y: 4 });
    for (let i = 0; i < 32; i++) moveToward(world, slot);
    expect(pos()).toEqual([4 * 32 + 16, 4 * 32 + 16]);
  });

  it("snaps to the middle when it is within one step, and uses the rest of the step on y", () => {
    const { world, slot, pos } = walker({ x: 2, y: 2 }, { x: 3, y: 3 });
    world.guests.x[slot] = 3 * 32 + 16 - 1;
    moveToward(world, slot);
    // One unit to finish x, the other unit of the step goes down y.
    expect(pos()).toEqual([3 * 32 + 16, 2 * 32 + 16 + 1]);
  });

  it("takes a speed", () => {
    const { world, slot, pos } = walker({ x: 2, y: 2 }, { x: 3, y: 2 });
    moveToward(world, slot, 5);
    expect(pos()).toEqual([2 * 32 + 16 + 5, 2 * 32 + 16]);
    moveToward(world, slot, 100);
    expect(pos()).toEqual([3 * 32 + 16, 2 * 32 + 16]);
  });

  it("walks from the off-map lane onto the map", () => {
    const { world, slot } = walker({ x: 5, y: -1 }, { x: 5, y: 0 });
    for (let i = 0; i < 16; i++) moveToward(world, slot);
    expect(world.guests.y[slot]).toBe(16);
    expect(guestTile(world, slot)).toEqual({ x: 5, y: 0 });
  });

  it("does not move a guest with no target", () => {
    const { world, slot, pos } = walker({ x: 2, y: 2 }, { x: -1, y: -1 });
    moveToward(world, slot);
    expect(pos()).toEqual([2 * 32 + 16, 2 * 32 + 16]);
  });
});

describe("guest names", () => {
  it("has 64 first names and 32 last names, all different", () => {
    expect(FIRST_NAMES).toHaveLength(64);
    expect(LAST_NAMES).toHaveLength(32);
    expect(new Set(FIRST_NAMES).size).toBe(64);
    expect(new Set(LAST_NAMES).size).toBe(32);
    for (const name of [...FIRST_NAMES, ...LAST_NAMES]) expect(name).toMatch(/^[A-Z][a-z]+$/);
  });

  it("packs first * 32 + last into a code", () => {
    expect(guestName(0)).toBe(`${FIRST_NAMES[0]} ${LAST_NAMES[0]}`);
    expect(guestName(1)).toBe(`${FIRST_NAMES[0]} ${LAST_NAMES[1]}`);
    expect(guestName(32)).toBe(`${FIRST_NAMES[1]} ${LAST_NAMES[0]}`);
    expect(guestName(63 * 32 + 31)).toBe(`${FIRST_NAMES[63]} ${LAST_NAMES[31]}`);
  });

  it("refuses a code that is not a name", () => {
    for (const code of [-1, 2048, 1.5, Number.NaN]) {
      expect(() => guestName(code)).toThrow(RangeError);
    }
  });
});

describe("thoughts", () => {
  it("lists them by id, with plain-English text and a mood from -2 to 2", () => {
    expect(THOUGHTS.length).toBeLessThanOrEqual(32);
    THOUGHTS.forEach((thought, index) => {
      expect(thought.id).toBe(index);
      expect([-2, -1, 0, 1, 2]).toContain(thought.mood);
      expect(thoughtText(index)).toBe(thought.text);
    });
    expect(THOUGHTS[0]).toEqual({ id: 0, text: "", mood: 0 });
    for (const thought of THOUGHTS.slice(1)) expect(thought.text).toMatch(/^[A-Z].+[a-z!.]$/);
  });

  it("numbers the ones the guests use as the ruling does", () => {
    expect(THOUGHT).toEqual({
      NONE: 0,
      GREAT_PARK: 1,
      TOO_EXPENSIVE: 2,
      HUNGRY: 3,
      THIRSTY: 4,
      TIRED: 5,
      NEED_TOILET: 6,
      LOST: 7,
      CROWDED: 8,
      NICE_VIEW: 9,
      GOING_HOME: 10,
      PARK_CLOSED: 11,
    });
    expect(thoughtText(THOUGHT.HUNGRY)).toBe("I'm hungry");
    expect(thoughtText(THOUGHT.TOO_EXPENSIVE)).toBe("This park is too expensive");
    expect(thoughtText(THOUGHT.LOST)).toBe("I can't find my way");
    expect(thoughtText(THOUGHT.GOING_HOME)).toBe("I'm going home");
  });

  it("gives no text to an id that is reserved but unused", () => {
    expect(thoughtText(31)).toBe("");
    expect(thoughtText(200)).toBe("");
  });
});

describe("hashWorld and guests", () => {
  it("changes when a guest does", () => {
    const world = worldWithEntrance(5, 0, 0);
    spawn(world);
    const before = hashWorld(world);
    world.guests.hunger[0] = (at(world.guests.hunger, 0) + 1) & 255;
    expect(hashWorld(world)).not.toBe(before);
  });

  it.each(GUEST_ARRAYS.map(([name]) => name))("changes when a guest's %s does", (name) => {
    const world = worldWithEntrance(5, 0, 0);
    spawn(world);
    const before = hashWorld(world);
    world.guests[name][0] = (at(world.guests[name], 0) + 1) & 127;
    expect(hashWorld(world)).not.toBe(before);
  });

  it("ignores the route cache and the waypoints, which only speed things up", () => {
    const world = worldWithEntrance(5, 0, 0);
    spawn(world);
    const before = hashWorld(world);
    guestRoutes(world);
    expect(world.routes).toBeDefined();
    expect(world.waypoints).toBeDefined();
    expect(hashWorld(world)).toBe(before);
  });

  it("changes with the guests' stream and the id counter", () => {
    const world = worldWithEntrance(5, 0, 0);
    const before = hashWorld(world);
    world.rngStreams.guests.next();
    const afterDraw = hashWorld(world);
    expect(afterDraw).not.toBe(before);
    world.guests.nextGuestId++;
    expect(hashWorld(world)).not.toBe(afterDraw);
  });

  it("covers live guests only, whichever slots they sit in", () => {
    const a = worldWithEntrance(5, 0, 0);
    const b = worldWithEntrance(5, 0, 0);
    for (let i = 0; i < 4; i++) {
      spawn(a);
      spawn(b);
    }
    // Make `b` fragmented and `a` compact with the same three guests left.
    removeGuest(a, 1);
    removeGuest(b, 1);
    compactGuests(a);
    expect(b.guests.fragmented).toBe(true);
    expect(hashWorld(b)).toBe(hashWorld(a));
    // Stale data in a dead slot does not matter.
    b.guests.cash[1] = 12345;
    expect(hashWorld(b)).toBe(hashWorld(a));
  });
});
