import type { Rng } from "../rng.js";

/** Version of the save-file schema. Bump when the serialized world shape changes. */
export const SCHEMA_VERSION = 1;

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
  /** Root generator, seeded from `meta.seed`. Systems fork their own streams from it. */
  rng: Rng;
  log: LogEntry[];
  undoStack: number[];
  redoStack: number[];
  nextId: number;
}
