import { fnv1a64, hashString, hexHash } from "../hash.js";
import { GUEST_ARRAYS, GUEST_CAP, type GuestArray, type GuestStore } from "../guests/types.js";
import { copyParkState } from "../park/types.js";
import type { World } from "./types.js";

function bytesOf(array: GuestArray | Int16Array): Uint8Array {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

/**
 * The values of one guest array for the live guests, in slot order. A packed store has them in
 * its first `count` slots, so that part of the array is used as it is; a store with gaps has them
 * gathered into a new array. Either way the result does not depend on which slots the guests sit in.
 */
function liveValues(g: GuestStore, array: GuestArray): GuestArray {
  if (!g.fragmented) return array.subarray(0, g.count);
  const out = new (array.constructor as new (length: number) => GuestArray)(g.count);
  let n = 0;
  for (let slot = 0; slot < GUEST_CAP; slot++) {
    if (g.live[slot] === 1) out[n++] = array[slot] as number;
  }
  return out;
}

/**
 * Fingerprint of everything that determines the simulation's future: tick, terrain (heights,
 * surface, water, and paths), finance, the park's state, every live guest (the arrays in slot
 * order, so which slots they sit in does not matter) and the guest id counter, the root rng state
 * and the guests' stream, the log length, the id counter, the undo/redo stacks, and the world's
 * name and seed. `meta.created` is left out so the same park hashes the same whenever it was
 * created, and `pathVersion`, `routes`, and `waypoints` are left out because they are only caches
 * that restart empty on load.
 *
 * Two worlds that hash differently have diverged. Equal hashes mean equal covered state, up to
 * the usual 64-bit collision odds.
 */
export function hashWorld(world: World): string {
  const { meta, terrain, finance, guests } = world;
  // Key order is fixed, so the JSON text is a stable encoding of the scalar parts.
  const scalars = JSON.stringify({
    name: meta.name,
    seed: meta.seed,
    tick: world.tick,
    width: terrain.width,
    height: terrain.height,
    cash: finance.cash,
    loan: finance.loan,
    monthStartCash: finance.monthStart.cash,
    park: copyParkState(world.park),
    guestCount: guests.count,
    nextGuestId: guests.nextGuestId,
    rng: world.rng.state,
    guestRng: world.rngStreams.guests.state,
    logLength: world.log.length,
    nextId: world.nextId,
    undoStack: world.undoStack,
    redoStack: world.redoStack,
  });
  let hash = hashString(scalars);
  hash = fnv1a64(bytesOf(terrain.corners), hash);
  hash = fnv1a64(bytesOf(terrain.surface), hash);
  hash = fnv1a64(bytesOf(terrain.water), hash);
  hash = fnv1a64(bytesOf(terrain.path), hash);
  for (const [name] of GUEST_ARRAYS) {
    hash = fnv1a64(bytesOf(liveValues(guests, guests[name])), hash);
  }
  return hexHash(hash);
}
