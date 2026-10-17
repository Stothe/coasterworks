import { GUEST_ARRAYS, GUEST_CAP } from "../guests/types.js";
import { createParkState } from "../park/types.js";
import { Rng } from "../rng.js";
import { MAX_MAP, SCHEMA_VERSION } from "../world/types.js";
import { toBase64 } from "./base64.js";
import { CORRUPT_MESSAGE, SaveError } from "./error.js";

/** Upgrades a document by one schema version. */
export type Migration = (doc: unknown) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A usable map side, or the schema check later will say what is wrong with it. */
function isDimension(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_MAP;
}

/**
 * Schema 1 to 2: parks gained a path layer and a park state. The path layer starts empty and the
 * park starts closed with the default fee and rating, named after the world. A map with unusable
 * dimensions gets no path layer, so the schema check refuses the document with the reason.
 */
const migrateV1ToV2: Migration = (doc) => {
  if (!isRecord(doc) || !isRecord(doc.terrain) || !isRecord(doc.meta)) {
    throw new SaveError(CORRUPT_MESSAGE);
  }
  const { width, height } = doc.terrain;
  const terrain =
    isDimension(width) && isDimension(height)
      ? {
          ...doc.terrain,
          path: { $t: "Uint8Array", $b64: toBase64(new Uint8Array(width * height)) },
        }
      : doc.terrain;
  const name = typeof doc.meta.name === "string" ? doc.meta.name : "";
  // A new park as schema 2 had it, without the history that came in schema 4 (the step from 3 adds
  // it), so this step stays what it was whatever the park state grows into.
  const { history: _history, ...park } = createParkState(name);
  return { ...doc, terrain, park };
};

/**
 * Schema 2 to 3: parks gained guests. The store starts empty, with the first guest to come
 * numbered 1, and the guests get a random stream of their own, forked off the root generator the
 * way `createWorld` forks it, so a migrated park draws the same guests a new one would. A document
 * with no usable root generator is refused as corrupt.
 */
const migrateV2ToV3: Migration = (doc) => {
  if (!isRecord(doc)) throw new SaveError(CORRUPT_MESSAGE);
  let guestStream: number[];
  try {
    guestStream = [
      ...Rng.fromState(doc.rng as [number, number, number, number]).fork("guests").state,
    ];
  } catch (error) {
    throw new SaveError(CORRUPT_MESSAGE, { cause: error });
  }
  const guests: Record<string, unknown> = { count: 0, nextGuestId: 1 };
  // The arrays schema 3 had; `lostTicks` came in schema 4, and the step from 3 adds it.
  for (const [name, kind] of GUEST_ARRAYS) {
    if (name !== "lostTicks") guests[name] = { $t: kind, $b64: "" };
  }
  return { ...doc, guests, rngStreams: { guests: guestStream } };
};

/**
 * Schema 3 to 4: the park gained a history of finished months, and each guest a count of the ticks
 * it has spent lost. The history starts empty (the books of earlier months were never kept) and
 * every guest starts with a count of zero, so the new array is as long as the guest list is. A
 * document whose park, guest section, or guest count is unusable is refused as corrupt.
 */
const migrateV3ToV4: Migration = (doc) => {
  if (!isRecord(doc) || !isRecord(doc.park) || !isRecord(doc.guests)) {
    throw new SaveError(CORRUPT_MESSAGE);
  }
  const { count } = doc.guests;
  if (!Number.isInteger(count) || (count as number) < 0 || (count as number) > GUEST_CAP) {
    throw new SaveError(CORRUPT_MESSAGE);
  }
  const lostTicks = { $t: "Int32Array", $b64: toBase64(new Uint8Array((count as number) * 4)) };
  return {
    ...doc,
    park: { ...doc.park, history: [] },
    guests: { ...doc.guests, lostTicks },
  };
};

/**
 * Migrations keyed by the schema version they upgrade FROM, so `MIGRATIONS[1]` turns a schema 1
 * document into a schema 2 one. When `SCHEMA_VERSION` goes up, add the entry for the version it
 * left behind.
 */
export const MIGRATIONS: Record<number, Migration> = {
  1: migrateV1ToV2,
  2: migrateV2ToV3,
  3: migrateV3ToV4,
};

/** The document's schema version. Throws `SaveError` if it has none. */
export function schemaVersionOf(doc: unknown): number {
  if (!isRecord(doc) || !Number.isInteger(doc.schemaVersion)) {
    throw new SaveError(CORRUPT_MESSAGE);
  }
  return doc.schemaVersion as number;
}

/**
 * Brings a save document up to `SCHEMA_VERSION` by running each migration from the document's
 * version onwards, in order, and setting `schemaVersion` after each step. A document already at
 * (or past) the current version is returned as it is. Throws `SaveError` if a version in the way
 * has no migration, or if a migration throws (a `SaveError` it throws itself is passed on as it
 * is). `migrations` is a parameter so tests can inject their own.
 */
export function migrate(doc: unknown, migrations: Record<number, Migration> = MIGRATIONS): unknown {
  let version = schemaVersionOf(doc);
  let current = doc;
  while (version < SCHEMA_VERSION) {
    const step = migrations[version];
    if (step === undefined) {
      throw new SaveError(`No migration from schema ${version} to ${version + 1}`);
    }
    let next: unknown;
    try {
      next = step(current);
    } catch (error) {
      if (error instanceof SaveError) throw error;
      throw new SaveError(CORRUPT_MESSAGE, { cause: error });
    }
    if (!isRecord(next)) throw new SaveError(CORRUPT_MESSAGE);
    version++;
    current = { ...next, schemaVersion: version };
  }
  return current;
}
