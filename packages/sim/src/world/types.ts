import type { StallFields } from "../guests/behavior.js";
import type { GuestStore, Waypoints } from "../guests/types.js";
import type { ParkState } from "../park/types.js";
import type { RouteCache } from "../paths/routing.js";
import type { QueueCache } from "../rides/queue.js";
import type { RideRecord } from "../rides/types.js";
import type { Rng } from "../rng.js";

/** Version of the save-file schema. Bump when the serialized world shape changes. */
export const SCHEMA_VERSION = 6;

/** Highest corner height. Heights are integers in half-unit steps, 0..MAX_HEIGHT. */
export const MAX_HEIGHT = 63;

/** Largest map, in tiles per side. */
export const MAX_MAP = 256;

/** Ground surface: grass, sand, dirt, rock, snow. */
export type Surface = 0 | 1 | 2 | 3 | 4;

/** A rectangle of tiles. Its corners are (x..x+w) by (y..y+h), inclusive. */
export type Rect = { x: number; y: number; w: number; h: number };

export interface Terrain {
  /** Tiles along x. */
  width: number;
  /** Tiles along y. */
  height: number;
  /** Corner heights, row-major over a (width + 1) by (height + 1) grid. */
  corners: Int16Array;
  /** Surface per tile, row-major over width by height. */
  surface: Uint8Array;
  /** Water level per tile, row-major over width by height. 0 means no water. */
  water: Uint8Array;
  /** Path per tile, row-major over width by height: 0 none, 1 footpath, 2 queue. */
  path: Uint8Array;
  /**
   * Which ride or stall stands on each tile, row-major over width by height: 0 none, else the
   * ride's id. Only footprint tiles are marked, not a ride's entrance, exit or service tile.
   */
  occupant: Uint16Array;
}

export interface Finance {
  /** Cash in integer cents. */
  cash: number;
  /** Outstanding loan in integer cents. */
  loan: number;
  /** Snapshot taken at the start of the current month. */
  monthStart: { cash: number };
}

export type ClientKind = "player" | "agent" | "replay" | "system";

export interface LogEntry {
  id: number;
  tick: number;
  client: ClientKind;
  name: string;
  input: unknown;
  /** Cost in integer cents. */
  cost: number;
  undo?: unknown;
  undoneBy?: number;
}

export interface World {
  meta: {
    schemaVersion: number;
    name: string;
    seed: number;
    /** ISO timestamp supplied by whoever creates the world. The sim never reads or generates it. */
    created: string;
  };
  tick: number;
  terrain: Terrain;
  finance: Finance;
  /** The park as a business: name, entrance, open or closed, fee, rating, and the takings. */
  park: ParkState;
  /** Everyone in the park, as parallel arrays. See `GuestStore`. */
  guests: GuestStore;
  /** Every ride and stall in the park, sorted by id. */
  rides: RideRecord[];
  /** The id the next ride or stall built gets. Ids start at 1, only go up, and are never reused. */
  nextRideId: number;
  /**
   * Counts changes to the rides (every ride command's apply and revert), so a cache or a client
   * knows when its copy is stale. Runtime only, like `pathVersion`.
   */
  rideVersion: number;
  /**
   * Counts changes to the path layer and the entrance, so a cache built from them knows when it is
   * stale. Runtime only: it is not saved or hashed, and starts at 0 when a world is created or
   * loaded.
   */
  pathVersion: number;
  /**
   * The route cache the guests walk by, made by the guest system the first time it runs. Runtime
   * only: it is not saved or hashed, and a loaded world starts without one.
   */
  routes?: RouteCache | undefined;
  /** The path tiles guests choose walks from. Runtime only, like `routes`. */
  waypoints?: Waypoints | undefined;
  /** Each ride's queue tiles, rebuilt when the paths or rides change. Runtime only, like `routes`. */
  queues?: QueueCache | undefined;
  /** Each need's distance field to its nearest open stall. Runtime only, like `routes`. */
  stallFields?: StallFields | undefined;
  /** Root generator, seeded from `meta.seed`. Systems fork their own streams from it. */
  rng: Rng;
  /**
   * One stream for each system that needs randomness, forked from the root generator when the
   * world is created and saved with the world, so a system's draws never depend on another's.
   */
  rngStreams: { guests: Rng };
  log: LogEntry[];
  undoStack: number[];
  redoStack: number[];
  nextId: number;
}
