import type { GuestSection } from "@coasterworks/protocol";

/**
 * Stand-in park content for the look-dev page: a path network, an entrance and a crowd walking
 * the paths, laid out for the 64 by 64 sample park. It exists so that paths, the gate and guests
 * can be judged before the sample park has any of its own. None of it comes from the sim.
 */

/** Guest positions are in these units, 32 to a tile, as in the sim's snapshots. */
const UNITS = 32;
/** Units a guest walks in one sim tick, and sim ticks in a second: the sim's own figures. */
const WALK_SPEED = 2;
const TICKS_PER_SECOND = 40;

const FOOTPATH = 1;
const QUEUE = 2;
/** The sim's `GuestState.HEADING`: walking to a tile it chose. */
const HEADING = 2;

export interface Demo {
  /** One byte per tile: 0 none, 1 footpath, 2 queue. */
  paths: Uint8Array;
  /** On the south edge. */
  entrance: { x: number; y: number; side: 2 };
  /**
   * The crowd as a snapshot would carry it. `advance` puts a new section here each time, with new
   * position arrays, and leaves the one before as it was: decoded snapshots arrive the same way,
   * and a renderer that keeps the previous section to move guests between the two relies on it.
   */
  guests: GuestSection;
  /** Walks every guest on for `seconds` of sim time and publishes the result as `guests`. */
  advance(seconds: number): void;
}

/** A repeatable generator of numbers in 0..1 (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), a | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Lays out the demo paths on a `width` by `height` map: an avenue north from the entrance to a
 * 3 by 3 plaza, a loop around the pond, a second loop east of it, a long branch west and up past
 * the foot of the hill, and two short queues. Tiles that fall off a smaller map are left out.
 */
function layPaths(width: number, height: number): Uint8Array {
  const paths = new Uint8Array(width * height);
  const set = (x: number, y: number, kind: number) => {
    if (x >= 0 && y >= 0 && x < width && y < height) paths[y * width + x] = kind;
  };
  /** A straight run of tiles from (x0, y0) to (x1, y1), ends included. */
  const run = (x0: number, y0: number, x1: number, y1: number, kind = FOOTPATH) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= steps; i++) {
      set(x0 + Math.sign(x1 - x0) * i, y0 + Math.sign(y1 - y0) * i, kind);
    }
  };

  // The avenue from the gate, and the plaza it opens into.
  run(32, height - 1, 32, 41);
  for (let y = 38; y <= 40; y++) run(31, y, 33, y);
  run(32, 37, 32, 35);
  // The loop around the pond and its beach.
  run(30, 34, 44, 34);
  run(44, 34, 44, 24);
  run(44, 24, 30, 24);
  run(30, 24, 30, 34);
  // A second loop to the east, off the plaza and back to the pond loop.
  run(34, 39, 50, 39);
  run(50, 39, 50, 29);
  run(50, 29, 45, 29);
  run(50, 29, 56, 29);
  // West from the pond loop and north past the foot of the hill.
  run(29, 30, 6, 30);
  run(6, 30, 6, 12);
  // Two queues, as if rides stood at their ends.
  run(56, 28, 56, 24, QUEUE);
  run(7, 12, 8, 12, QUEUE);
  run(8, 11, 8, 9, QUEUE);
  return paths;
}

/**
 * Creates the demo for a `width` by `height` map with `guestCount` guests. The same arguments
 * always give the same paths and the same crowd in the same places.
 */
export function createDemo(width: number, height: number, guestCount = 150, seed = 1): Demo {
  const paths = layPaths(width, height);
  const next = random(seed);
  const tiles: number[] = [];
  for (let i = 0; i < paths.length; i++) if (paths[i]) tiles.push(i);

  /** The path tiles next to tile `tile`, by edge. */
  const neighbors = (tile: number): number[] => {
    const x = tile % width;
    const y = (tile - x) / width;
    const out: number[] = [];
    if (x > 0 && paths[tile - 1]) out.push(tile - 1);
    if (x + 1 < width && paths[tile + 1]) out.push(tile + 1);
    if (y > 0 && paths[tile - width]) out.push(tile - width);
    if (y + 1 < height && paths[tile + width]) out.push(tile + width);
    return out;
  };
  /** Where a guest who came from `from` and stands on `at` goes next: on, not back, when it can. */
  const choose = (from: number, at: number): number => {
    const all = neighbors(at);
    const onward = all.filter((tile) => tile !== from);
    const options = onward.length > 0 ? onward : all;
    return options.length > 0 ? (options[Math.floor(next() * options.length)] as number) : at;
  };

  const count = tiles.length > 0 ? guestCount : 0;
  let guests: GuestSection = {
    count,
    id: new Int32Array(count),
    x: new Int32Array(count),
    y: new Int32Array(count),
    state: new Uint8Array(count).fill(HEADING),
    color: new Uint8Array(count),
    happiness: new Uint8Array(count),
  };
  // Each guest walks from the middle of one tile to the middle of the next.
  const from = new Int32Array(count);
  const to = new Int32Array(count);
  /** Units walked of the 32 between the two tiles. */
  const walked = new Float32Array(count);
  /** Where in the width of the path each guest keeps, in units either side of the middle. */
  const offsetX = new Int8Array(count);
  const offsetY = new Int8Array(count);

  for (let i = 0; i < count; i++) {
    guests.id[i] = i + 1;
    guests.color[i] = Math.floor(next() * 9);
    guests.happiness[i] = 150 + Math.floor(next() * 81);
    from[i] = tiles[Math.floor(next() * tiles.length)] as number;
    to[i] = choose(-1, from[i] as number);
    walked[i] = next() * UNITS;
    offsetX[i] = Math.floor(next() * 13) - 6;
    offsetY[i] = Math.floor(next() * 13) - 6;
  }

  function place(i: number): void {
    const a = from[i] as number;
    const b = to[i] as number;
    const k = (walked[i] as number) / UNITS;
    const ax = (a % width) * UNITS + UNITS / 2;
    const ay = Math.floor(a / width) * UNITS + UNITS / 2;
    const bx = (b % width) * UNITS + UNITS / 2;
    const by = Math.floor(b / width) * UNITS + UNITS / 2;
    guests.x[i] = Math.round(ax + (bx - ax) * k) + (offsetX[i] as number);
    guests.y[i] = Math.round(ay + (by - ay) * k) + (offsetY[i] as number);
  }

  function advance(seconds: number): void {
    const step = seconds * TICKS_PER_SECOND * WALK_SPEED;
    // A new section with new places; who the guests are does not change, so the rest is shared.
    guests = { ...guests, x: new Int32Array(count), y: new Int32Array(count) };
    demo.guests = guests;
    for (let i = 0; i < count; i++) {
      let left = (walked[i] as number) + step;
      while (left >= UNITS) {
        left -= UNITS;
        const arrived = to[i] as number;
        to[i] = choose(from[i] as number, arrived);
        from[i] = arrived;
      }
      walked[i] = left;
      place(i);
    }
  }

  for (let i = 0; i < count; i++) place(i);
  const demo: Demo = { paths, entrance: { x: 32, y: height - 1, side: 2 }, guests, advance };
  return demo;
}
