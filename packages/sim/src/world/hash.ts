import { fnv1a64, hashString, hexHash } from "../hash.js";
import type { World } from "./types.js";

function bytesOf(array: Int16Array | Uint8Array): Uint8Array {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

/**
 * Fingerprint of everything that determines the simulation's future: tick, terrain, finance, the
 * root rng state, the log length, the id counter, the undo/redo stacks, and the world's name and
 * seed. `meta.created` is left out so the same park hashes the same whenever it was created.
 *
 * Two worlds that hash differently have diverged. Equal hashes mean equal covered state, up to
 * the usual 64-bit collision odds.
 */
export function hashWorld(world: World): string {
  const { meta, terrain, finance } = world;
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
    rng: world.rng.state,
    logLength: world.log.length,
    nextId: world.nextId,
    undoStack: world.undoStack,
    redoStack: world.redoStack,
  });
  let hash = hashString(scalars);
  hash = fnv1a64(bytesOf(terrain.corners), hash);
  hash = fnv1a64(bytesOf(terrain.surface), hash);
  hash = fnv1a64(bytesOf(terrain.water), hash);
  return hexHash(hash);
}
