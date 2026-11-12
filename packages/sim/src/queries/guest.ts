import { z } from "zod";
import { defineQuery } from "../commands/define.js";
import { findGuest, forEachGuest } from "../guests/guests.js";
import { THOUGHTS, thoughtText } from "../guests/thoughts.js";
import { guestName } from "../guests/names.js";
import type { World } from "../world/types.js";

/** What a guest is doing, in words, indexed by `GuestState` (entering is 0, gone is 5). */
const STATE_NAMES = ["entering", "wandering", "heading", "leaving", "lost", "gone"] as const;

/** The states a list can be filtered by: all of them but "gone", which no live guest is in. */
const FILTER_STATES = ["entering", "wandering", "heading", "leaving", "lost"] as const;

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
  };
}

const GUEST_FIELDS =
  "`{ id, name, x, y, tile: { x, y }, state, happiness, energy, hunger, thirst, bathroom, nausea, cash, thought }`. `x` and `y` are in 1/32 of a tile (the middle of tile t is t * 32 + 16) and `tile` is the tile they fall in, which is just off the map (-1 or the map's width or height) for a guest still coming in from the entrance. `state` is entering, wandering, heading, leaving, or lost. Needs and moods run 0 to 255; `cash` is in cents; `thought` is the guest's last thought as `{ id, text }`, or null.";

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
