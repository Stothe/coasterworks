import { typeById, type ContentType, type Rot } from "@coasterworks/content";
import { z } from "zod";
import {
  addRide,
  canPlaceRide,
  checkRideId,
  findRide,
  newRide,
  removeRide,
} from "../rides/rides.js";
import { ejectGuests, releaseQueue } from "../rides/operation.js";
import {
  MAX_RIDE_NAME,
  MAX_RIDE_PRICE,
  RIDE_CAP,
  copyRide,
  type RideRecord,
} from "../rides/types.js";
import { MAX_MAP, type World } from "../world/types.js";
import { TICKS_PER_DAY, DAYS_PER_MONTH } from "../time.js";
import { defineCommand } from "./define.js";
import { checkCash, formatMoney } from "./execute.js";

const placeSchema = z.object({
  type: z.string(),
  x: z.int().min(0).max(MAX_MAP),
  y: z.int().min(0).max(MAX_MAP),
  rot: z.int().min(0).max(3),
});

type PlaceInput = z.infer<typeof placeSchema>;

const idSchema = z.object({ id: z.int().min(1) });

/** The content type a build names, or the reason it cannot be built as `kind`. */
function typeFor(kind: "ride" | "stall", id: string): ContentType | string {
  const type = typeById(id);
  if (type === undefined) return `Unknown ${kind} type: ${id}`;
  if (type.kind !== kind) return `Not a ${kind}: ${id}`;
  return type;
}

/** The ride with `id`, which validation has made sure exists. */
function rideOf(world: World, id: number): RideRecord {
  const ride = findRide(world, id);
  if (ride === undefined) throw new RangeError(`No ride with id ${id}`);
  return ride;
}

/** What a build saves: the id it took, which a revert hands back. */
interface BuildUndo {
  id: number;
}

/** `ride_build` and `stall_build` differ only in their kind and their words. */
function buildCommand(kind: "ride" | "stall") {
  const isRide = kind === "ride";
  return defineCommand({
    name: isRide ? "ride_build" : "stall_build",
    description: isRide
      ? `Builds a ride (a \`content_list\` type of kind \`ride\`, such as \`carousel\`) with the top-left tile of its footprint at (x, y), turned \`rot\` quarter turns clockwise (0 to 3; turns 1 and 3 swap the footprint's width and height). Costs the type's \`cost\` in cents. The ride starts closed, at the type's default price, named like "Carousel 1"; \`ride_get\` gives its id, entrance and exit tiles, which guests reach by path. Refused if any footprint, entrance or exit tile is off the map or on its outer ring of tiles, if the footprint has water, is not flat, or covers a path, the park entrance, another ride, or another ride's entrance or exit, if the entrance or exit tile is on another ride or water, or if ${RIDE_CAP} rides and stalls already stand.`
      : `Builds a stall (a \`content_list\` type of kind \`stall\`, such as \`snack_stand\`) on the tile (x, y), turned \`rot\` quarter turns clockwise (0 to 3), which turns the side its service tile is on. Costs the type's \`cost\` in cents. The stall starts closed, at the type's default price, named like "Snack Stand 1"; guests are served from its service tile (see \`ride_get\`), which a path should reach. Refused if the tile or its service tile is off the map or on its outer ring, if the tile has water, is not flat, or holds a path, the park entrance, another ride, or another ride's entrance, exit or service tile, if the service tile is on a ride or water, or if ${RIDE_CAP} rides and stalls already stand.`,
    category: isRide ? "ride" : "shop",
    input: placeSchema,
    undoable: true,
    cost: (_world, input: PlaceInput) => {
      const type = typeFor(kind, input.type);
      return typeof type === "string" ? 0 : type.cost;
    },
    validate: (world, input: PlaceInput) => {
      const type = typeFor(kind, input.type);
      if (typeof type === "string") return type;
      return canPlaceRide(world, type, input.x, input.y, input.rot as Rot);
    },
    apply: (world, input: PlaceInput): BuildUndo => {
      const type = typeFor(kind, input.type);
      if (typeof type === "string") throw new RangeError(type);
      const id = world.nextRideId++;
      addRide(world, newRide(world, id, type, input.x, input.y, input.rot as Rot));
      world.rideVersion++;
      return { id };
    },
    // Guests may have queued for or boarded the ride since it was built; they are let go first,
    // as when it is demolished.
    revert: (world, _input, undo: BuildUndo) => {
      const ride = findRide(world, undo.id);
      if (ride !== undefined) ejectGuests(world, ride);
      removeRide(world, undo.id);
      world.nextRideId = undo.id;
      world.rideVersion++;
    },
  });
}

export const rideBuild = buildCommand("ride");
export const stallBuild = buildCommand("stall");

/** What a demolish saves: the whole record, to put back as it was, and the refund it paid. */
interface DemolishUndo {
  ride: RideRecord;
  refund: number;
  /** The month it was demolished in, counted from the start of the game (see `monthOf`). */
  month: number;
}

/** The month tick `tick` is in, counted from 0 at the start of the game (year * months + month). */
function monthOf(tick: number): number {
  return Math.floor(tick / (TICKS_PER_DAY * DAYS_PER_MONTH));
}

export const rideDemolish = defineCommand({
  name: "ride_demolish",
  description:
    "Demolishes a ride or stall by id and frees its tiles. Guests queuing for it step out of the queue and wander; guests on it are let off at once at its exit (or, if the exit has no path, on the nearest path tile), without finishing the ride. Guests buying at a stall, or on their way to it, wander off unserved and are not charged. Refunds half of what the type cost to build, rounded down to the cent, straight into cash (the command's own cost is 0). Undoing it puts the ride back as it was, with the same id, name, price and stats (this month's takings and customers start from nothing if the month has changed since), but empty and idle (the guests it let go stay where they are), and takes the refund back, so the undo is refused if the park no longer has that much cash.",
  category: "ride",
  input: idSchema,
  undoable: true,
  validate: (world, { id }) => checkRideId(world, id),
  // The undo data records nothing about guests: the ride is emptied (queue let go, riders put on the
  // exit) and its cycle reset before it is copied, so an undo restores it empty and idle.
  apply: (world, { id }): DemolishUndo => {
    const standing = findRide(world, id);
    if (standing !== undefined) ejectGuests(world, standing);
    const ride = removeRide(world, id);
    const type = typeById(ride.type);
    const refund = type === undefined ? 0 : Math.floor(type.cost / 2);
    world.finance.cash += refund;
    world.rideVersion++;
    return { ride: copyRide(ride), refund, month: monthOf(world.tick) };
  },
  // Undone in a later month, the ride's month figures belong to a month whose books have closed.
  revert: (world, _input, undo: DemolishUndo) => {
    const ride = copyRide(undo.ride);
    if (monthOf(world.tick) !== undo.month) {
      ride.stats.monthIncome = 0;
      ride.stats.monthCustomers = 0;
    }
    addRide(world, ride);
    world.finance.cash -= undo.refund;
    world.rideVersion++;
  },
  validateRevert: (world, _input, undo: DemolishUndo) => checkCash(world, undo.refund),
});

/** `ride_open` and `ride_close` set the open flag to `open`. */
function openCommand(open: boolean) {
  return defineCommand({
    name: open ? "ride_open" : "ride_close",
    description: open
      ? "Opens a ride or stall by id to guests. Opening an open ride changes nothing. Free."
      : "Closes a ride or stall by id to guests: guests queuing for it step out of the queue and wander, and guests on it finish the ride they are on. At a stall, guests being served or on their way to it wander off unserved and are not charged. Closing a closed ride changes nothing. Free. Undoing it reopens the ride but does not bring the queue back.",
    category: "ride",
    input: idSchema,
    undoable: true,
    validate: (world, { id }) => checkRideId(world, id),
    apply: (world, { id }) => {
      const ride = rideOf(world, id);
      const previous = ride.open;
      ride.open = open;
      if (!open) releaseQueue(world, ride);
      world.rideVersion++;
      return { previous };
    },
    revert: (world, { id }, undo: { previous: boolean }) => {
      const ride = rideOf(world, id);
      ride.open = undo.previous;
      // Undoing an opening closes the ride the way `ride_close` does.
      if (!undo.previous) releaseQueue(world, ride);
      world.rideVersion++;
    },
  });
}

export const rideOpen = openCommand(true);
export const rideClose = openCommand(false);

export const rideSetPrice = defineCommand({
  name: "ride_set_price",
  description: `Sets what a guest pays for one go on a ride, or for one item or visit at a stall, by id, in cents: 0 to ${MAX_RIDE_PRICE} (${formatMoney(MAX_RIDE_PRICE)}). Free.`,
  category: "ride",
  input: z.object({ id: z.int().min(1), cents: z.int().min(0).max(MAX_RIDE_PRICE) }),
  undoable: true,
  validate: (world, { id }) => checkRideId(world, id),
  apply: (world, { id, cents }) => {
    const ride = rideOf(world, id);
    const previous = ride.price;
    ride.price = cents;
    world.rideVersion++;
    return { previous };
  },
  revert: (world, { id }, undo: { previous: number }) => {
    rideOf(world, id).price = undo.previous;
    world.rideVersion++;
  },
});

export const rideRename = defineCommand({
  name: "ride_rename",
  description: `Renames a ride or stall by id (1 to ${MAX_RIDE_NAME} characters). Free.`,
  category: "ride",
  input: z.object({ id: z.int().min(1), name: z.string().min(1).max(MAX_RIDE_NAME) }),
  undoable: true,
  validate: (world, { id }) => checkRideId(world, id),
  apply: (world, { id, name }) => {
    const ride = rideOf(world, id);
    const previous = ride.name;
    ride.name = name;
    world.rideVersion++;
    return { previous };
  },
  revert: (world, { id }, undo: { previous: string }) => {
    rideOf(world, id).name = undo.previous;
    world.rideVersion++;
  },
});
