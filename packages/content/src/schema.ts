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
    defaultPrice: int.min(0),
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
    defaultPrice: int.min(0),
    serveTicks: int.min(1),
    meets: z.enum(["hunger", "thirst", "bathroom"]),
    /** How much the need is reduced by. */
    amount: int.min(1),
    model: z.string().min(1),
  })
  .strict();

export type RideType = z.infer<typeof RideTypeSchema>;
export type StallType = z.infer<typeof StallTypeSchema>;
export type ContentType = RideType | StallType;
