import { deepFreeze } from "./freeze.js";
import { StallTypeSchema, type StallType } from "./schema.js";

// Money is in cents, time in sim ticks (400 ticks = one game day). `front` is the side the
// service tile is on at rotation 0: 0 north, 1 east, 2 south, 3 west.

const stalls: StallType[] = [
  {
    id: "snack_stand",
    kind: "stall",
    category: "food",
    name: "Snack Stand",
    description: "Hot snacks handed over the counter to hungry guests.",
    footprint: { w: 1, h: 1 },
    front: 2, // serves to the south
    cost: 40_000,
    runningCost: 2_000,
    defaultPrice: 150,
    serveTicks: 80,
    meets: "hunger",
    amount: 100,
    model: "snack_stand",
  },
  {
    id: "drinks_stand",
    kind: "stall",
    category: "drink",
    name: "Drinks Stand",
    description: "Cold drinks poured fresh for thirsty guests.",
    footprint: { w: 1, h: 1 },
    front: 2, // serves to the south
    cost: 30_000,
    runningCost: 2_000,
    defaultPrice: 120,
    serveTicks: 60,
    meets: "thirst",
    amount: 110,
    model: "drinks_stand",
  },
  {
    id: "restrooms",
    kind: "stall",
    category: "facility",
    name: "Restrooms",
    description: "A clean little block where guests can freshen up.",
    footprint: { w: 1, h: 1 },
    front: 2, // door to the south
    cost: 60_000,
    runningCost: 4_000,
    defaultPrice: 25,
    serveTicks: 120,
    meets: "bathroom",
    amount: 160,
    model: "restrooms",
  },
];

export const STALL_TYPES: readonly StallType[] = Object.freeze(
  stalls.map((s) => deepFreeze(StallTypeSchema.parse(s))),
);
