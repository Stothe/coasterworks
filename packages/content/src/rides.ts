import { deepFreeze } from "./freeze.js";
import { RideTypeSchema, type RideType } from "./schema.js";

// Money is in cents, time in sim ticks (400 ticks = one game day). Entrance and exit are
// tile offsets from the footprint's top-left at rotation 0, x right, y down.

const rides: RideType[] = [
  {
    id: "carousel",
    kind: "ride",
    category: "gentle",
    name: "Carousel",
    description: "Painted horses rise and fall on a slow, turning platform.",
    footprint: { w: 3, h: 3 },
    entrance: { x: 1, y: 3 }, // south side, below the middle column
    exit: { x: 3, y: 1 }, // east side, beside the middle row
    cost: 120_000,
    runningCost: 3_000,
    defaultPrice: 100,
    capacity: 12,
    loadTicks: 60,
    cycleTicks: 400,
    excitement: 420,
    intensity: 180,
    nausea: 120,
    model: "carousel",
  },
  {
    id: "big_wheel",
    kind: "ride",
    category: "gentle",
    name: "Big Wheel",
    description: "A tall turning wheel with a wide view over the whole park.",
    footprint: { w: 2, h: 4 },
    entrance: { x: 0, y: 4 }, // south side, below the left column
    exit: { x: -1, y: 2 }, // west side, beside the third row
    cost: 280_000,
    runningCost: 5_000,
    defaultPrice: 200,
    capacity: 16,
    loadTicks: 80,
    cycleTicks: 700,
    excitement: 520,
    intensity: 260,
    nausea: 160,
    model: "big_wheel",
  },
  {
    id: "swing_tower",
    kind: "ride",
    category: "thrill",
    name: "Swing Tower",
    description: "Chair swings climb a tall column and spin out wide at the top.",
    footprint: { w: 3, h: 3 },
    entrance: { x: 1, y: -1 }, // north side, above the middle column
    exit: { x: -1, y: 1 }, // west side, beside the middle row
    cost: 360_000,
    runningCost: 7_000,
    defaultPrice: 250,
    capacity: 10,
    loadTicks: 70,
    cycleTicks: 500,
    excitement: 700,
    intensity: 720,
    nausea: 560,
    model: "swing_tower",
  },
];

export const RIDE_TYPES: readonly RideType[] = Object.freeze(
  rides.map((r) => deepFreeze(RideTypeSchema.parse(r))),
);
