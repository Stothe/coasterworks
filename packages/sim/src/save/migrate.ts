import { SCHEMA_VERSION } from "../world/types.js";
import { CORRUPT_MESSAGE, SaveError } from "./error.js";

/** Upgrades a document by one schema version. */
export type Migration = (doc: unknown) => unknown;

/**
 * Migrations keyed by the schema version they upgrade FROM, so `MIGRATIONS[1]` turns a schema 1
 * document into a schema 2 one. Empty while schema 1 is the only version there is. When
 * `SCHEMA_VERSION` goes up, add the entry for the version it left behind.
 */
export const MIGRATIONS: Record<number, Migration> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
 * has no migration. `migrations` is a parameter so tests can inject their own.
 */
export function migrate(doc: unknown, migrations: Record<number, Migration> = MIGRATIONS): unknown {
  let version = schemaVersionOf(doc);
  let current = doc;
  while (version < SCHEMA_VERSION) {
    const step = migrations[version];
    if (step === undefined) {
      throw new SaveError(`No migration from schema ${version} to ${version + 1}`);
    }
    const next = step(current);
    if (!isRecord(next)) throw new SaveError(CORRUPT_MESSAGE);
    version++;
    current = { ...next, schemaVersion: version };
  }
  return current;
}
