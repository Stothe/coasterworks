import { z } from "zod";
import { defineQuery } from "../commands/define.js";
import { dateOf, formatDate } from "../time.js";
import { MAX_HEIGHT } from "../world/types.js";

/** The park at a glance: its name, the date, the money, and whether it is open. */
export const parkStatus = defineQuery({
  name: "park_status",
  description:
    "Describes the park: name, tick, calendar date, cash and loan in cents, and map size. `month` is 0-based (March = 0). `monthStartCash` is the cash when the month began, in cents, so `cash - monthStartCash` is the month's change. Also whether the park is `open`, the `entryFee` in cents, the `entrance` ({ x, y, side } with side 0 north, 1 east, 2 south, 3 west, or null if not placed), the `rating` (0 to 999), `guestsInPark` (and `guests`, the same number), `totalAdmissions`, and the takings in cents: `income` { entry, rides, shops } and `expenses` { running, wages } so far, and `monthly` { entry, rides, shops, running, wages } for this month.",
  category: "park",
  input: z.object({}),
  run: (world) => {
    const date = dateOf(world.tick);
    const { park } = world;
    return {
      name: park.name,
      tick: world.tick,
      date: formatDate(date),
      year: date.year,
      month: date.month,
      day: date.day,
      cash: world.finance.cash,
      monthStartCash: world.finance.monthStart.cash,
      loan: world.finance.loan,
      guests: park.guestsInPark,
      rating: park.rating,
      width: world.terrain.width,
      height: world.terrain.height,
      open: park.open,
      entryFee: park.entryFee,
      entrance: park.entrance === null ? null : { ...park.entrance },
      guestsInPark: park.guestsInPark,
      totalAdmissions: park.totalAdmissions,
      income: { ...park.income },
      expenses: { ...park.expenses },
      monthly: { ...park.monthly },
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
