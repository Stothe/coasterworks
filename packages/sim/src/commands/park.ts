import { z } from "zod";
import { sendGuestsHome } from "../guests/behavior.js";
import { MAX_ENTRY_FEE, type Entrance } from "../park/types.js";
import { PATH_NONE, edgeSide } from "../paths/paths.js";
import { inBounds, tileIndex } from "../terrain/terrain.js";
import { defineCommand } from "./define.js";
import { OUTSIDE_PARK } from "./terrain.js";

/** Cost in cents of placing the park entrance, each time: $500. */
export const ENTRANCE_COST = 500_00;

/** What `park_set_entrance` saves: the entrance it replaced, and the path value it covered. */
interface EntranceUndo {
  entrance: Entrance | null;
  /** The index of the entrance tile and the path value that was on it. */
  tile: [index: number, previous: number];
}

export const parkSetEntrance = defineCommand({
  name: "park_set_entrance",
  description:
    "Places the park entrance on a tile on the edge of the map, moving it if there is one already. The tile cannot have water or a ride. Any path on the tile is replaced. Costs $500 each time, and a move is not refunded.",
  category: "park",
  input: z.object({ x: z.int().min(0), y: z.int().min(0) }),
  undoable: true,
  cost: () => ENTRANCE_COST,
  validate: (world, { x, y }) => {
    const t = world.terrain;
    if (!inBounds(t, x, y)) return OUTSIDE_PARK;
    if (edgeSide(t, x, y) === -1) return "The entrance must be on the park edge";
    if ((t.water[tileIndex(t, x, y)] as number) > 0) return "Cannot build on water";
    if ((t.occupant[tileIndex(t, x, y)] as number) !== 0) return "Something is already here";
    return null;
  },
  apply: (world, { x, y }): EntranceUndo => {
    const t = world.terrain;
    const side = edgeSide(t, x, y);
    if (side === -1) throw new RangeError(`Tile (${x}, ${y}) is not on the map edge`);
    const index = tileIndex(t, x, y);
    const undo: EntranceUndo = {
      entrance: world.park.entrance === null ? null : { ...world.park.entrance },
      tile: [index, t.path[index] as number],
    };
    world.park.entrance = { x, y, side };
    t.path[index] = PATH_NONE;
    world.pathVersion++;
    return undo;
  },
  revert: (world, _input, undo: EntranceUndo) => {
    world.park.entrance = undo.entrance === null ? null : { ...undo.entrance };
    const [index, previous] = undo.tile;
    world.terrain.path[index] = previous;
    world.pathVersion++;
  },
});

export const parkSetEntryFee = defineCommand({
  name: "park_set_entry_fee",
  description: `Sets what each guest pays at the entrance, in cents: 0 to ${MAX_ENTRY_FEE} ($100.00). Free.`,
  category: "park",
  input: z.object({ cents: z.int().min(0).max(MAX_ENTRY_FEE) }),
  undoable: true,
  validate: () => null,
  apply: (world, { cents }) => {
    const previous = world.park.entryFee;
    world.park.entryFee = cents;
    return { previous };
  },
  revert: (world, _input, undo: { previous: number }) => {
    world.park.entryFee = undo.previous;
  },
});

export const parkOpen = defineCommand({
  name: "park_open",
  description:
    "Opens the park to guests. The park entrance must be placed first. Opening an open park changes nothing. Undoing an opening closes the park and sends the guests inside home.",
  category: "park",
  input: z.object({}),
  undoable: true,
  validate: (world) => (world.park.entrance === null ? "Place the park entrance first" : null),
  apply: (world) => {
    const previous = world.park.open;
    world.park.open = true;
    return { previous };
  },
  revert: (world, _input, undo: { previous: boolean }) => {
    world.park.open = undo.previous;
    // Undoing an opening closes the park the way `park_close` does: whoever came in goes home.
    if (!undo.previous) sendGuestsHome(world);
  },
});

export const parkClose = defineCommand({
  name: "park_close",
  description:
    "Closes the park: guests arriving at the gate are turned away, and every guest inside starts walking out to the entrance. Nobody is charged again on the way out, even if the park reopens. Reversing it only reopens the park; guests already sent home keep leaving. Closing a closed park only sends home any guests still inside.",
  category: "park",
  input: z.object({}),
  undoable: true,
  validate: () => null,
  apply: (world) => {
    const previous = world.park.open;
    world.park.open = false;
    sendGuestsHome(world);
    return { previous };
  },
  // Puts the flag back and nothing else: the guests it sent home keep on leaving.
  revert: (world, _input, undo: { previous: boolean }) => {
    world.park.open = undo.previous;
  },
});

export const parkRename = defineCommand({
  name: "park_rename",
  description: "Renames the park (1 to 40 characters). Free.",
  category: "park",
  input: z.object({ name: z.string().min(1).max(40) }),
  undoable: true,
  validate: () => null,
  apply: (world, { name }) => {
    const previous = world.park.name;
    world.park.name = name;
    return { previous };
  },
  revert: (world, _input, undo: { previous: string }) => {
    world.park.name = undo.previous;
  },
});
