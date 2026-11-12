import { z } from "zod";

// Content types are plain data: the sim reads them, nothing here runs at tick time.
// Every number is an integer. Money is in cents, time in sim ticks (400 ticks = one game day).

const int = z.number().int();
const rating = int.min(0).max(999);
const snakeCase = z.string().regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, "id must be snake_case");
const footprint = z.object({ w: int.min(1), h: int.min(1) }).strict();
const offset = z.object({ x: int, y: int }).strict();

type Offset = { x: number; y: number };
type Footprint = { w: number; h: number };

/** True when the offset lies outside the footprint and shares an edge with it (not a diagonal). */
export function isEdgeAdjacentOutside(o: Offset, f: Footprint): boolean {
  const withinX = o.x >= 0 && o.x < f.w;
  const withinY = o.y >= 0 && o.y < f.h;
  const besideX = o.x === -1 || o.x === f.w;
  const besideY = o.y === -1 || o.y === f.h;
  return (withinX && besideY) || (withinY && besideX);
}

export const RideTypeSchema = z
  .object({
    id: snakeCase,
    kind: z.literal("ride"),
    category: z.enum(["gentle", "thrill"]),
    name: z.string().min(1),
    description: z.string().min(1),
    footprint,
    /** Offsets from the footprint's top-left at rotation 0: outside the footprint, edge-adjacent. */
    entrance: offset,
    exit: offset,
    /** Cents. */
    cost: int.min(0),
    /** Cents per month. */
    runningCost: int.min(0),
    /** Cents. */
    defaultPrice: int.min(0).max(20_00),
    /** Riders per cycle. */
    capacity: int.min(1),
    loadTicks: int.min(1),
    cycleTicks: int.min(1),
    excitement: rating,
    intensity: rating,
    nausea: rating,
    /** Recipe id used by the renderer. */
    model: z.string().min(1),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.model !== t.id) {
      ctx.addIssue({ code: "custom", path: ["model"], message: "model must be the type's id" });
    }
    for (const key of ["entrance", "exit"] as const) {
      if (!isEdgeAdjacentOutside(t[key], t.footprint)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} must lie outside the footprint and share an edge with it`,
        });
      }
    }
    if (t.entrance.x === t.exit.x && t.entrance.y === t.exit.y) {
      ctx.addIssue({ code: "custom", path: ["exit"], message: "entrance and exit must differ" });
    }
  });

export const StallTypeSchema = z
  .object({
    id: snakeCase,
    kind: z.literal("stall"),
    category: z.enum(["food", "drink", "facility"]),
    name: z.string().min(1),
    description: z.string().min(1),
    footprint: z.object({ w: z.literal(1), h: z.literal(1) }).strict(),
    /** Side the service tile is on at rotation 0: 0 north (y-1), 1 east (x+1), 2 south (y+1), 3 west (x-1). */
    front: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    cost: int.min(0),
    runningCost: int.min(0),
    defaultPrice: int.min(0).max(20_00),
    serveTicks: int.min(1),
    meets: z.enum(["hunger", "thirst", "bathroom"]),
    /** How much the need is reduced by. */
    amount: int.min(1),
    model: z.string().min(1),
  })
  .strict()
  .refine((t) => t.model === t.id, { path: ["model"], message: "model must be the type's id" });

export type RideType = z.infer<typeof RideTypeSchema>;
export type StallType = z.infer<typeof StallTypeSchema>;
export type ContentType = RideType | StallType;

// ---- Coaster track pieces and families -------------------------------------------------------
//
// Geometry is in the fixed-point units of `fixed.ts`: lengths in 1/1024 tile, heights in whole
// height steps where noted, angles in 1/4096 turn. A piece is described in its own frame: it
// starts at the centre of a tile edge facing "forward"; "right" is a quarter turn clockwise from
// forward (seen from above). Pitch levels: -2 steep down, -1 gentle down, 0 flat, 1 gentle up,
// 2 steep up. Bank levels: -2 steep left, -1 gentle left, 0 none, 1 gentle right, 2 steep right.

const pitchLevel = int.min(-2).max(2);
const bankLevel = int.min(-2).max(2);
const flag = z.boolean();

export const PIECE_KINDS = [
  "station",
  "straight",
  "curve_small",
  "curve_large",
  "slope",
  "bank",
  "lift",
  "brake",
] as const;

/** Radius of the small and large quarter-turn curves, in 1/1024 tile (1.5 and 2.5 tiles). */
export const SMALL_CURVE_RADIUS = 1536;
export const LARGE_CURVE_RADIUS = 2560;
/** Height steps a track climbs per tile at each pitch level, -2..2. */
export const PITCH_RISE: readonly number[] = Object.freeze([-4, -2, 0, 2, 4]);

/** Height steps climbed per tile at pitch `level` (-2..2). */
export function pitchRise(level: number): number {
  const rise = PITCH_RISE[level + 2];
  if (rise === undefined) throw new RangeError(`Pitch level must be -2..2, got ${level}`);
  return rise;
}

const pieceTile = z
  .object({
    /** Tile index forward of the entry edge: tile f covers forward f..f+1 tiles. */
    f: int.min(0),
    /** Tile index to the right: tile r covers right r-1/2..r+1/2 tiles. */
    r: int,
    /** Height band the centre line passes through on this tile, in steps above the entry. */
    zLo: int,
    zHi: int,
  })
  .strict();

export const TrackPieceSchema = z
  .object({
    id: snakeCase,
    name: z.string().min(1),
    kind: z.enum(PIECE_KINDS),
    /** Pitch and bank the track must have where this piece starts. */
    entry: z.object({ pitch: pitchLevel, bank: bankLevel }).strict(),
    exit: z
      .object({
        /** Distance moved forward and right, in 1/1024 tile, in the piece's own frame. */
        forward: int.min(1),
        right: int,
        /** Height change in whole steps. */
        dz: int,
        /** Quarter turns: -1 left, 0 none, 1 right. */
        dDir: int.min(-1).max(1),
        pitch: pitchLevel,
        bank: bankLevel,
      })
      .strict(),
    /** How the centre line runs: a straight line (with eased pitch and roll) or a circular arc. */
    shape: z.enum(["straight", "arc"]),
    flags: z.object({ station: flag, lift: flag, brake: flag }).strict(),
    /** Samples along the piece (spacing near 1/8 tile); the sim samples i = 0..samples. */
    samples: int.min(1).max(64),
    /** Length of the sampled centre line, in 1/1024 tile: the sum of its chords. */
    length: int.min(1),
    /** Tiles the piece covers, for occupancy. */
    tiles: z.array(pieceTile).min(1),
  })
  .strict()
  .superRefine((p, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const { entry, exit } = p;
    if (Math.abs(exit.pitch - entry.pitch) > 1) {
      issue(["exit", "pitch"], "pitch may change by one level per piece");
    }
    if (Math.abs(exit.bank - entry.bank) > 1) {
      issue(["exit", "bank"], "bank may change by one level per piece");
    }
    const sloped = entry.pitch !== 0 || exit.pitch !== 0;
    const banked = entry.bank !== 0 || exit.bank !== 0;
    if (sloped && banked) issue(["exit", "bank"], "sloped pieces cannot be banked");
    if (p.shape === "straight") {
      if (exit.right !== 0 || exit.dDir !== 0) issue(["exit"], "a straight piece cannot turn");
      if (exit.forward % 1024 !== 0) issue(["exit", "forward"], "must be whole tiles");
      const tiles = exit.forward / 1024;
      if (2 * exit.dz !== (pitchRise(entry.pitch) + pitchRise(exit.pitch)) * tiles) {
        issue(["exit", "dz"], "height change must match the pitch at both ends");
      }
    } else {
      const radius = exit.forward;
      if (radius !== SMALL_CURVE_RADIUS && radius !== LARGE_CURVE_RADIUS) {
        issue(["exit", "forward"], "an arc's radius must be a small or large curve");
      }
      if (Math.abs(exit.right) !== radius) issue(["exit", "right"], "an arc turns a quarter");
      if (exit.dDir !== Math.sign(exit.right) || exit.dDir === 0) {
        issue(["exit", "dDir"], "an arc turns toward its exit side");
      }
      if (sloped || exit.dz !== 0) issue(["exit", "pitch"], "curves are flat");
      if (entry.bank !== exit.bank) issue(["exit", "bank"], "a curve keeps its bank");
      if (entry.bank !== 0 && Math.sign(entry.bank) !== exit.dDir) {
        issue(["entry", "bank"], "a curve banks into the turn");
      }
      const want = radius === SMALL_CURVE_RADIUS ? "curve_small" : "curve_large";
      if (p.kind !== want) issue(["kind"], `an arc of this radius is ${want}`);
    }
    if (p.shape === "straight" && entry.bank !== 0 && entry.bank === exit.bank) {
      issue(["exit", "bank"], "banked straights are not in the piece set");
    }
    if (p.flags.station || p.flags.brake) {
      if (sloped || banked || p.shape !== "straight") {
        issue(["flags"], "stations and brakes are flat, unbanked straights");
      }
    }
    if (p.flags.lift && !(entry.pitch > 0 || exit.pitch > 0)) {
      issue(["flags", "lift"], "a lift chain needs an up-slope");
    }
    if (p.flags.station && p.kind !== "station") issue(["kind"], "station pieces are station");
    if (p.flags.brake && p.kind !== "brake") issue(["kind"], "brake pieces are brake");
    if (p.flags.lift && p.kind !== "lift") issue(["kind"], "lift pieces are lift");
    const flagged = p.flags.station || p.flags.brake || p.flags.lift;
    if (p.shape === "straight" && !flagged) {
      const want = sloped ? "slope" : banked ? "bank" : "straight";
      if (p.kind !== want) issue(["kind"], `this piece is ${want}`);
    }
    if (!p.tiles.some((t) => t.f === 0 && t.r === 0)) {
      issue(["tiles"], "a piece covers the tile in front of its entry");
    }
    for (const [i, t] of p.tiles.entries()) {
      if (t.zLo > t.zHi) issue(["tiles", i], "zLo must not exceed zHi");
    }
  });

export const CoasterFamilySchema = z
  .object({
    id: snakeCase,
    kind: z.literal("coaster"),
    name: z.string().min(1),
    description: z.string().min(1),
    limits: z
      .object({
        /** Steepest pitch level allowed, 1 gentle or 2 steep. */
        maxPitch: int.min(1).max(2),
        /** Strongest bank level allowed, 0 none, 1 gentle (about 30 degrees), 2 steep (60). */
        maxBank: int.min(0).max(2),
        curves: z
          .array(z.enum(["small", "large"]))
          .min(1)
          .refine((c) => new Set(c).size === c.length, "curve sizes must not repeat"),
        lift: flag,
      })
      .strict(),
    /**
     * Physics constants. Speeds are in 1/1024 tile per tick; accelerations in 1/65536 tile per
     * tick squared (a tile is taken as 3 m and a second is 40 ticks, so gravity is about 134).
     * Air drag decelerates by `drag * speed^2 / 2^20` in the acceleration unit.
     */
    physics: z
      .object({
        gravity: int.min(1),
        rollingFriction: int.min(0),
        drag: int.min(0),
        liftSpeed: int.min(1),
        brakeSpeed: int.min(1),
        stationSpeed: int.min(1),
        /** Rough-ride factor used by the ratings, 0 smooth to 100 very rough. */
        roughness: int.min(0).max(100),
      })
      .strict(),
    train: z
      .object({
        minCars: int.min(1),
        maxCars: int.min(1),
        defaultCars: int.min(1),
        ridersPerCar: int.min(1),
        /** Car length along the track, in 1/1024 tile. */
        carLength: int.min(1),
      })
      .strict()
      .refine((t) => t.minCars <= t.defaultCars && t.defaultCars <= t.maxCars, {
        message: "default cars must lie between min and max",
      }),
    /** Cents per piece, by piece kind. */
    pieceCost: z.object(Object.fromEntries(PIECE_KINDS.map((k) => [k, int.min(0)]))).strict(),
    /** Cents per piece per month. */
    runningCostPerPiece: int.min(0),
    /** Cents. */
    defaultPrice: int.min(0).max(20_00),
    supportStyle: z.enum(["steel_column", "wooden_bent"]),
    /** Recipe ids used by the renderer. */
    models: z.object({ track: snakeCase, car: snakeCase, support: snakeCase }).strict(),
  })
  .strict();

export type TrackPiece = z.infer<typeof TrackPieceSchema>;
export type PieceKind = (typeof PIECE_KINDS)[number];
export type CoasterFamily = Omit<z.infer<typeof CoasterFamilySchema>, "pieceCost"> & {
  pieceCost: Record<PieceKind, number>;
};
