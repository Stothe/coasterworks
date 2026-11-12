import { ALL_TYPES, typeById } from "@coasterworks/content";
import { z } from "zod";
import { defineQuery } from "../commands/define.js";
import { findRide, rideFootprint } from "../rides/rides.js";
import { copyRide } from "../rides/types.js";

/** A plain JSON copy of a content type, so nothing handed out points at the frozen data. */
function copyType<T>(type: T): T {
  return JSON.parse(JSON.stringify(type)) as T;
}

export const rideList = defineQuery({
  name: "ride_list",
  description:
    "Lists every ride and stall in id order: { id, type (the content type id), kind (`ride` or `stall`), name, x, y (top-left footprint tile), rot (quarter turns clockwise), open, price (cents), queueLength (guests queuing), riders (guests on it) }.",
  category: "ride",
  input: z.object({}),
  run: (world) =>
    world.rides.map((ride) => ({
      id: ride.id,
      type: ride.type,
      kind: ride.kind,
      name: ride.name,
      x: ride.x,
      y: ride.y,
      rot: ride.rot,
      open: ride.open,
      price: ride.price,
      queueLength: ride.queue.length,
      riders: ride.riders.length,
    })),
});

export const rideGet = defineQuery({
  name: "ride_get",
  description:
    "Describes one ride or stall by id: its whole record (id, type, kind, name, x, y, rot, open, price in cents; `entrance` and `exit` tiles for a ride or the `service` tile for a stall, each { x, y } or null; `phase` 0 idle, 1 loading, 2 running, 3 unloading, and `phaseTicks`; the guest ids in `riders` and in `queue`, front first; and `stats` { customers, income, runningCost, monthCustomers, monthIncome }, money in cents), plus `footprint` { x, y, w, h }, the tiles it stands on, and `content`, its content type (as `content_list` gives it).",
  category: "ride",
  input: z.object({ id: z.int() }),
  run: (world, { id }) => {
    const ride = findRide(world, id);
    if (ride === undefined) throw new Error(`No ride with id ${id}`);
    const type = typeById(ride.type);
    return {
      ...copyRide(ride),
      footprint: rideFootprint(ride),
      content: type === undefined ? null : copyType(type),
    };
  },
});

export const contentList = defineQuery({
  name: "content_list",
  description:
    "Lists the ride and stall types that can be built, rides first, or only one `kind` (`ride` or `stall`). Each gives its `id` (what `ride_build` and `stall_build` take), `kind`, `category` (gentle or thrill for rides; food, drink or facility for stalls), `name`, `description`, `footprint` { w, h } at rotation 0, `cost` to build and `runningCost` per month and `defaultPrice`, all in cents. A ride also gives `entrance` and `exit` as tile offsets from its top-left at rotation 0, `capacity` (riders per cycle), `loadTicks` and `cycleTicks`, and its ratings `excitement`, `intensity` and `nausea` (0 to 999); a stall gives `front` (the side its service tile is on at rotation 0: 0 north, 1 east, 2 south, 3 west), `serveTicks`, the need it `meets` (hunger, thirst or bathroom) and the `amount` it takes off it.",
  category: "ride",
  input: z.object({ kind: z.enum(["ride", "stall"]).optional() }),
  run: (_world, { kind }) =>
    ALL_TYPES.filter((type) => kind === undefined || type.kind === kind).map(copyType),
});
