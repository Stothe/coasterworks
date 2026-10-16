import { z } from "zod";
import { defineQuery } from "../commands/define.js";
import { dateOf, formatDate } from "../time.js";
import { MAX_HEIGHT } from "../world/types.js";

/** The park at a glance: its name, the date, and the money. */
export const parkStatus = defineQuery({
  name: "park_status",
  description:
    "Describes the park: name, tick, calendar date, cash and loan in cents, and map size. Guest count and rating are 0 until guests exist.",
  category: "park",
  input: z.object({}),
  run: (world) => {
    const date = dateOf(world.tick);
    return {
      name: world.meta.name,
      tick: world.tick,
      date: formatDate(date),
      year: date.year,
      month: date.month,
      day: date.day,
      cash: world.finance.cash,
      loan: world.finance.loan,
      guests: 0,
      rating: 0,
      width: world.terrain.width,
      height: world.terrain.height,
    };
  },
});

/** How big the map is and how high the land can go. */
export const parkBounds = defineQuery({
  name: "park_bounds",
  description: `Returns the map size in tiles and the highest corner height (${MAX_HEIGHT}).`,
  category: "park",
  input: z.object({}),
  run: (world) => ({
    width: world.terrain.width,
    height: world.terrain.height,
    maxHeight: MAX_HEIGHT,
  }),
});
