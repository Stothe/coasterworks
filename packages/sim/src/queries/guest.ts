import { z } from "zod";
import { defineQuery } from "../commands/define.js";
import { findGuest, forEachGuest } from "../guests/guests.js";
import { THOUGHTS, thoughtText } from "../guests/thoughts.js";
import { guestName } from "../guests/names.js";
import { GuestState } from "../guests/types.js";
import { findRide } from "../rides/rides.js";
import type { World } from "../world/types.js";

/** What a guest is doing, in words, indexed by `GuestState` (entering is 0, gone is 5, buying 8). */
const STATE_NAMES = [
  "entering",
  "wandering",
  "heading",
  "leaving",
  "lost",
  "gone",
  "queuing",
  "riding",
  "buying",
] as const;

/** The states a list can be filtered by: all of them but "gone", which no live guest is in. */
const FILTER_STATES = [
  "entering",
  "wandering",
  "heading",
  "leaving",
  "lost",
  "queuing",
  "riding",
  "buying",
] as const;

/** What a guest is doing with the ride or stall in its `ride`. */
type RideDoing = "heading" | "queuing" | "riding" | "buying";

interface GuestView {
  id: number;
  name: string;
  x: number;
  y: number;
  tile: { x: number; y: number };
  state: string;
  happiness: number;
  energy: number;
  hunger: number;
  thirst: number;
  bathroom: number;
  nausea: number;
  cash: number;
  thought: { id: number; text: string } | null;
  ride: { id: number; name: string; doing: RideDoing } | null;
}

/** The ride or stall the guest in `slot` is heading for, queuing for, on, or buying at, or null. */
function rideViewOf(world: World, slot: number): GuestView["ride"] {
  const g = world.guests;
  const id = g.ride[slot] as number;
  if (id === 0) return null;
  const state = g.state[slot];
  const doing: RideDoing | null =
    state === GuestState.HEADING
      ? "heading"
      : state === GuestState.QUEUING
        ? "queuing"
        : state === GuestState.RIDING
          ? "riding"
          : state === GuestState.BUYING
            ? "buying"
            : null;
  const ride = findRide(world, id);
  if (doing === null || ride === undefined) return null;
  return { id, name: ride.name, doing };
}

/** A fresh plain-object description of the guest in `slot`. */
function viewOf(world: World, slot: number): GuestView {
  const g = world.guests;
  const x = g.x[slot] as number;
  const y = g.y[slot] as number;
  const thought = g.thought[slot] as number;
  return {
    id: g.id[slot] as number,
    name: guestName(g.name[slot] as number),
    x,
    y,
    tile: { x: x >> 5, y: y >> 5 },
    state: STATE_NAMES[g.state[slot] as number] ?? "gone",
    happiness: g.happiness[slot] as number,
    energy: g.energy[slot] as number,
    hunger: g.hunger[slot] as number,
    thirst: g.thirst[slot] as number,
    bathroom: g.bathroom[slot] as number,
    nausea: g.nausea[slot] as number,
    cash: g.cash[slot] as number,
    thought: thought === 0 ? null : { id: thought, text: thoughtText(thought) },
    ride: rideViewOf(world, slot),
  };
}

const GUEST_FIELDS =
  "`{ id, name, x, y, tile: { x, y }, state, happiness, energy, hunger, thirst, bathroom, nausea, cash, thought, ride }`. `x` and `y` are in 1/32 of a tile (the middle of tile t is t * 32 + 16) and `tile` is the tile they fall in, which is just off the map (-1 or the map's width or height) for a guest still coming in from the entrance. `state` is entering, wandering, heading, leaving, lost, queuing (in a ride's queue), riding, or buying (being served at a stall). Needs and moods run 0 to 255; `cash` is in cents; `thought` is the guest's last thought as `{ id, text }`, or null; `ride` is the ride or stall it is busy with as `{ id, name, doing }`, where `doing` is heading (on its way there), queuing, riding, or buying, or null when it is doing none of those.";

export const guestList = defineQuery({
  name: "guest_list",
  description: `Lists the guests in the park, oldest first, each as ${GUEST_FIELDS} Give \`limit\` (1 to 500, default 100) to cap how many, and \`state\` to list only guests in that state.`,
  category: "park",
  input: z.object({
    limit: z.int().min(1).max(500).default(100),
    state: z.enum(FILTER_STATES).optional(),
  }),
  run: (world, { limit, state }) => {
    const wanted = state === undefined ? -1 : STATE_NAMES.indexOf(state);
    const out: GuestView[] = [];
    forEachGuest(world, (slot) => {
      if (out.length >= limit) return;
      if (wanted !== -1 && world.guests.state[slot] !== wanted) return;
      out.push(viewOf(world, slot));
    });
    return out;
  },
});

export const guestGet = defineQuery({
  name: "guest_get",
  description: `Returns one guest by id, as ${GUEST_FIELDS} Fails if no guest in the park has that id (guests who have left are gone).`,
  category: "park",
  input: z.object({ id: z.int().min(1) }),
  run: (world, { id }) => {
    const slot = findGuest(world, id);
    if (slot < 0) throw new Error(`No guest with id ${id}`);
    return viewOf(world, slot);
  },
});

export const guestThoughts = defineQuery({
  name: "guest_thoughts",
  description:
    "Tells what the park is thinking: for each thought that at least one guest has as their last (not none), `{ id, text, mood, count }`, where `mood` runs from -2 (miserable) to 2 (delighted) and `count` is how many guests are thinking it. Most common first, then by id. Give `limit` (1 to 50, default 20) to cap how many thoughts are listed.",
  category: "park",
  input: z.object({ limit: z.int().min(1).max(50).default(20) }),
  run: (world, { limit }) => {
    const counts = new Array<number>(THOUGHTS.length).fill(0);
    forEachGuest(world, (slot) => {
      const thought = world.guests.thought[slot] as number;
      if (thought > 0 && thought < counts.length) counts[thought] = (counts[thought] as number) + 1;
    });
    return THOUGHTS.filter((thought) => (counts[thought.id] as number) > 0)
      .map((thought) => ({
        id: thought.id,
        text: thought.text,
        mood: thought.mood,
        count: counts[thought.id] as number,
      }))
      .sort((a, b) => b.count - a.count || a.id - b.id)
      .slice(0, limit);
  },
});
