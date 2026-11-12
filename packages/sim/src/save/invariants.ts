import {
  STEP,
  familyById,
  pieceById,
  typeById,
  type CoasterFamily,
  type Rot,
  type TrackPiece,
} from "@coasterworks/content";
import { QUEUE_PATIENCE } from "../guests/behavior.js";
import { THOUGHTS } from "../guests/thoughts.js";
import {
  DEST_TURNED_AWAY,
  GUEST_CAP,
  GUEST_COLORS,
  GuestState,
  MAX_GUEST_STATE,
  NAME_COUNT,
  NO_TILE,
} from "../guests/types.js";
import { HISTORY_MONTHS, MAX_ENTRY_FEE, MAX_RATING, type ParkState } from "../park/types.js";
import { PATH_QUEUE, edgeSide } from "../paths/paths.js";
import { accessTiles, findRide, footprintRect } from "../rides/rides.js";
import {
  MAX_RIDE_ID,
  MAX_RIDE_NAME,
  MAX_RIDE_PHASE,
  MAX_RIDE_PRICE,
  RIDE_CAP,
  RidePhase,
  type RideRecord,
  type Tile,
} from "../rides/types.js";
import { MAX_PATH_SLOPE } from "../paths/paths.js";
import { inBounds, tileCorners } from "../terrain/terrain.js";
import {
  NOT_CLOSED,
  circuitRefusal,
  isJoinPose,
  placementRefusal,
  reservedTiles,
  stationAccess,
} from "../track/occupancy.js";
import { applyPiece, pieceRefusal, poseAtTile, posesEqual, type Dir } from "../track/pose.js";
import { FINE, TrainMode, buildLine } from "../track/physics.js";
import { MAX_TRACK_PIECES, type TrackRecord } from "../track/record.js";
import { MONTHS_PER_YEAR } from "../time.js";
import { MAX_HEIGHT, type World } from "../world/types.js";

/** Highest `Surface` value: grass, sand, dirt, rock, snow. */
const MAX_SURFACE = 4;

/**
 * Checks what the save schema cannot: the rules every world the sim builds obeys, which a damaged
 * or badly migrated save may not. Returns the first problem found, as a sentence, or null.
 *
 *   - every corner height is 0 to `MAX_HEIGHT`, every surface 0 to 4, every water level 0 to
 *     `MAX_HEIGHT`, every path value 0 to 2
 *   - the park's entrance, if it has one, is on the map and on its edge; the entry fee is 0 to
 *     $100.00, the rating 0 to 999, and the guest, admission, income, and expense counters are not
 *     negative; its history holds at most 12 months, each a year from 1, a month 0 to 7, and whole
 *     numbers of cents, with the income and costs not negative
 *   - every live guest has an id that is above 0, below `nextGuestId`, and used by no other guest;
 *     a state 0 to 7, a colour 0 to 8, a name and a thought that exist, cash, idle times, lost
 *     times, ride ids and queue times that are not negative (and a ride if it is queuing or riding),
 *     a queue time no more than `QUEUE_PATIENCE`; a position and a target tile on the map or one tile outside it
 *     (the entrance lane); and a destination that is a tile on the map or one of the two "walking
 *     out" markers
 *   - at most 255 rides and stalls, sorted by id, each id above 0, below `nextRideId` and used once,
 *     with `nextRideId` at most 65,536; each ride's type exists in the content and has the ride's
 *     kind, its rotation is 0 to 3, its price 0 to $20.00, its name 1 to 40 characters, its phase 0
 *     to 4 (4, testing, only for a coaster), and its counters and guest ids not negative; its
 *     entrance, exit and service tiles are the ones its type, position and rotation give; and the occupant layer holds exactly each
 *     ride's id on its footprint tiles (which are on the map and overlap no other ride's) and 0
 *     everywhere else; every guest id in a ride's queue or riders is a live guest, queuing (or
 *     riding) for that ride, listed in no other queue or ride, and every queuing (or riding) guest
 *     is in its ride's queue (or riders); a ride has at most its type's capacity of riders, and
 *     none while idle
 *   - a coaster (kind `coaster`) names a coaster family, has its entrance and exit beside its
 *     first station tile, marks no tiles, has no riders yet and is idle or testing; `tracks` holds
 *     one track per coaster, in id order, each of which replays piece by piece under the
 *     placement rules, with a test-run state that agrees with itself and its coaster (see
 *     `checkTracks` and `testRunRefusal`)
 *   - log ids start above 0, strictly increase, and are all below `nextId`
 *   - every id on the undo and redo stacks names a log entry, and no id is on the stacks twice,
 *     which covers an id on both
 *
 * A stack id is not required to name an entry with `undo` data. A command whose `apply` returns
 * nothing, such as `finance_take_loan`, is undoable and sits on the stack with no `undo` key.
 */
export function validateWorldInvariants(world: World): string | null {
  const { terrain, log } = world;

  for (let i = 0; i < terrain.corners.length; i++) {
    const height = terrain.corners[i] as number;
    if (height < 0 || height > MAX_HEIGHT) {
      return `corner ${i} has height ${height}, outside 0 to ${MAX_HEIGHT}`;
    }
  }
  for (let i = 0; i < terrain.surface.length; i++) {
    const surface = terrain.surface[i] as number;
    if (surface > MAX_SURFACE)
      return `tile ${i} has surface ${surface}, outside 0 to ${MAX_SURFACE}`;
  }
  for (let i = 0; i < terrain.water.length; i++) {
    const level = terrain.water[i] as number;
    if (level > MAX_HEIGHT) return `tile ${i} has water level ${level}, outside 0 to ${MAX_HEIGHT}`;
  }

  for (let i = 0; i < terrain.path.length; i++) {
    const path = terrain.path[i] as number;
    if (path > PATH_QUEUE) return `tile ${i} has path ${path}, outside 0 to ${PATH_QUEUE}`;
  }

  const problem = parkProblem(world);
  if (problem !== null) return problem;

  const guestIssue = guestProblem(world);
  if (guestIssue !== null) return guestIssue;

  const rideIssue = rideProblem(world);
  if (rideIssue !== null) return rideIssue;

  const ids = new Set<number>();
  let previous = 0;
  for (const entry of log) {
    if (entry.id <= previous) {
      return `log id ${entry.id} does not come after ${previous}; ids start at 1 and increase`;
    }
    previous = entry.id;
    ids.add(entry.id);
  }
  if (previous >= world.nextId) return `log id ${previous} is not below nextId ${world.nextId}`;

  const stackOf = new Map<number, string>();
  for (const [name, stack] of [
    ["undo stack", world.undoStack],
    ["redo stack", world.redoStack],
  ] as const) {
    for (const id of stack) {
      if (!ids.has(id)) return `${name} id ${id} names no log entry`;
      const earlier = stackOf.get(id);
      if (earlier === name) return `${name} id ${id} appears more than once`;
      if (earlier !== undefined) return `id ${id} is on both the undo stack and the redo stack`;
      stackOf.set(id, name);
    }
  }
  return null;
}

/** The first thing wrong with the park state, as a sentence, or null. */
function parkProblem(world: World): string | null {
  const { park, terrain } = world;
  const { entrance } = park;
  if (entrance !== null) {
    if (!inBounds(terrain, entrance.x, entrance.y)) {
      return `entrance (${entrance.x}, ${entrance.y}) is outside the ${terrain.width}x${terrain.height} map`;
    }
    if (edgeSide(terrain, entrance.x, entrance.y) === -1) {
      return `entrance (${entrance.x}, ${entrance.y}) is not on the map edge`;
    }
  }
  if (park.entryFee < 0 || park.entryFee > MAX_ENTRY_FEE) {
    return `entry fee ${park.entryFee} is outside 0 to ${MAX_ENTRY_FEE}`;
  }
  if (park.rating < 0 || park.rating > MAX_RATING) {
    return `rating ${park.rating} is outside 0 to ${MAX_RATING}`;
  }
  const counters: Array<[string, number]> = [
    ["guestsInPark", park.guestsInPark],
    ["totalAdmissions", park.totalAdmissions],
    ...Object.entries(park.income).map(([k, v]): [string, number] => [`income.${k}`, v]),
    ...Object.entries(park.expenses).map(([k, v]): [string, number] => [`expenses.${k}`, v]),
    ...Object.entries(park.monthly).map(([k, v]): [string, number] => [`monthly.${k}`, v]),
  ];
  for (const [label, value] of counters) {
    if (value < 0) return `${label} is ${value}, which is below 0`;
  }
  return historyProblem(park.history);
}

/** The first thing wrong with the months of history, as a sentence, or null. */
function historyProblem(history: ParkState["history"]): string | null {
  if (history.length > HISTORY_MONTHS) {
    return `history holds ${history.length} months, more than ${HISTORY_MONTHS}`;
  }
  for (const [i, record] of history.entries()) {
    for (const [key, value] of Object.entries(record)) {
      if (!Number.isInteger(value)) {
        return `history[${i}].${key} is ${value}, which is not a whole number`;
      }
    }
    if (record.year < 1) return `history[${i}].year is ${record.year}, which is below 1`;
    if (record.month < 0 || record.month >= MONTHS_PER_YEAR) {
      return `history[${i}].month is ${record.month}, outside 0 to ${MONTHS_PER_YEAR - 1}`;
    }
    for (const key of ["entry", "rides", "shops", "running", "wages"] as const) {
      if (record[key] < 0) return `history[${i}].${key} is ${record[key]}, which is below 0`;
    }
  }
  return null;
}

/** The first thing wrong with the guests, as a sentence, or null. */
function guestProblem(world: World): string | null {
  const g = world.guests;
  const { width, height } = world.terrain;
  if (g.count < 0 || g.count > GUEST_CAP)
    return `guest count ${g.count} is outside 0 to ${GUEST_CAP}`;
  if (g.nextGuestId < 1) return `nextGuestId ${g.nextGuestId} is below 1`;

  const tiles = width * height;
  const seen = new Set<number>();
  let live = 0;
  for (let slot = 0; slot < GUEST_CAP; slot++) {
    if (g.live[slot] !== 1) continue;
    live++;
    const id = g.id[slot] as number;
    if (id < 1) return `guest id ${id} is not above 0`;
    if (id >= g.nextGuestId) return `guest id ${id} is not below nextGuestId ${g.nextGuestId}`;
    if (seen.has(id)) return `guest id ${id} is used by two guests`;
    seen.add(id);

    const label = `guest ${id}`;
    const state = g.state[slot] as number;
    if (state > MAX_GUEST_STATE)
      return `${label} has state ${state}, outside 0 to ${MAX_GUEST_STATE}`;
    const color = g.color[slot] as number;
    if (color >= GUEST_COLORS)
      return `${label} has color ${color}, outside 0 to ${GUEST_COLORS - 1}`;
    const name = g.name[slot] as number;
    if (name >= NAME_COUNT) return `${label} has name ${name}, outside 0 to ${NAME_COUNT - 1}`;
    const thought = g.thought[slot] as number;
    if (thought >= THOUGHTS.length) return `${label} has thought ${thought}, which does not exist`;
    if ((g.cash[slot] as number) < 0) return `${label} has cash ${g.cash[slot]}, which is below 0`;
    if ((g.sinceAction[slot] as number) < 0) {
      return `${label} has sinceAction ${g.sinceAction[slot]}, which is below 0`;
    }
    if ((g.thoughtTick[slot] as number) < 0) {
      return `${label} has thoughtTick ${g.thoughtTick[slot]}, which is below 0`;
    }
    for (const key of ["lostTicks", "ride", "lastRide", "queueTicks"] as const) {
      const value = g[key][slot] as number;
      if (value < 0) return `${label} has ${key} ${value}, which is below 0`;
    }
    if ((g.queueTicks[slot] as number) > QUEUE_PATIENCE) {
      return `${label} has queueTicks ${g.queueTicks[slot]}, more than the patience of ${QUEUE_PATIENCE}`;
    }
    if (
      (state === GuestState.QUEUING ||
        state === GuestState.RIDING ||
        state === GuestState.BUYING) &&
      g.ride[slot] === 0
    ) {
      const what =
        state === GuestState.QUEUING
          ? "queuing"
          : state === GuestState.RIDING
            ? "riding"
            : "buying";
      return `${label} is ${what} with no ride`;
    }

    // A guest is on the map or one tile outside it, where the entrance lane is.
    const tileX = (g.x[slot] as number) >> 5;
    const tileY = (g.y[slot] as number) >> 5;
    if (tileX < -1 || tileX > width || tileY < -1 || tileY > height) {
      return `${label} has position (${g.x[slot]}, ${g.y[slot]}), too far off the ${width}x${height} map`;
    }
    const tx = g.tx[slot] as number;
    const ty = g.ty[slot] as number;
    if (!(tx === NO_TILE && ty === NO_TILE) && (tx < -1 || tx > width || ty < -1 || ty > height)) {
      return `${label} has target (${tx}, ${ty}), too far off the ${width}x${height} map`;
    }
    const dest = g.dest[slot] as number;
    if (dest < DEST_TURNED_AWAY || dest >= tiles) {
      return `${label} has destination ${dest}, which is not a tile of the ${width}x${height} map`;
    }
  }
  if (live !== g.count) return `guest count ${g.count} does not match the ${live} live guests`;
  return null;
}

function sameTile(a: Tile | null, b: Tile | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y;
}

function showTile(tile: Tile | null): string {
  return tile === null ? "none" : `(${tile.x}, ${tile.y})`;
}

/** The first thing wrong with the rides or the occupant layer, as a sentence, or null. */
function rideProblem(world: World): string | null {
  const { rides, nextRideId, terrain } = world;
  if (!Number.isInteger(nextRideId) || nextRideId < 1 || nextRideId > MAX_RIDE_ID + 1) {
    return `nextRideId ${nextRideId} is outside 1 to ${MAX_RIDE_ID + 1}`;
  }
  if (rides.length > RIDE_CAP) return `${rides.length} rides, more than ${RIDE_CAP}`;

  const expected = new Uint16Array(terrain.width * terrain.height);
  const g = world.guests;
  const slotOf = new Map<number, number>();
  for (let slot = 0; slot < GUEST_CAP; slot++) {
    if (g.live[slot] === 1) slotOf.set(g.id[slot] as number, slot);
  }
  const listed = new Set<number>();
  let previous = 0;
  for (const ride of rides) {
    const { id } = ride;
    if (!Number.isInteger(id) || id <= previous) {
      return `ride id ${id} does not come after ${previous}; ids start at 1 and increase`;
    }
    if (id >= nextRideId) return `ride id ${id} is not below nextRideId ${nextRideId}`;
    previous = id;

    const label = `ride ${id}`;
    const coaster = ride.kind === "coaster";
    const type = coaster ? familyById(ride.type) : typeById(ride.type);
    if (type === undefined) return `${label} has unknown type ${ride.type}`;
    if (ride.kind !== type.kind) {
      return `${label} has kind ${ride.kind} but its type ${type.id} is a ${type.kind}`;
    }
    if (![0, 1, 2, 3].includes(ride.rot))
      return `${label} has rotation ${ride.rot}, outside 0 to 3`;
    if (!Number.isInteger(ride.price) || ride.price < 0 || ride.price > MAX_RIDE_PRICE) {
      return `${label} has price ${ride.price}, outside 0 to ${MAX_RIDE_PRICE}`;
    }
    if (ride.name.length < 1 || ride.name.length > MAX_RIDE_NAME) {
      return `${label} has a name of ${ride.name.length} characters, outside 1 to ${MAX_RIDE_NAME}`;
    }
    if (!Number.isInteger(ride.phase) || ride.phase < 0 || ride.phase > MAX_RIDE_PHASE) {
      return `${label} has phase ${ride.phase}, outside 0 to ${MAX_RIDE_PHASE}`;
    }
    const counters: Array<[string, number]> = [
      ["phaseTicks", ride.phaseTicks],
      ...Object.entries(ride.stats).map(([k, v]): [string, number] => [`stats.${k}`, v]),
    ];
    for (const [key, value] of counters) {
      if (!Number.isInteger(value) || value < 0) return `${label} has ${key} ${value}, below 0`;
    }
    for (const [list, state, what] of [
      [ride.queue, GuestState.QUEUING, "queuing"],
      [ride.riders, GuestState.RIDING, "riding"],
    ] as const) {
      for (const guest of list) {
        if (!Number.isInteger(guest) || guest < 1) return `${label} lists guest id ${guest}`;
        if (listed.has(guest)) return `${label} lists guest ${guest}, who is listed more than once`;
        listed.add(guest);
        const slot = slotOf.get(guest);
        if (slot === undefined) return `${label} lists guest ${guest}, who is not in the park`;
        if (g.state[slot] !== state || g.ride[slot] !== id) {
          return `${label} lists guest ${guest} as ${what}, but that guest is not ${what} for it`;
        }
      }
    }
    if (ride.phase === RidePhase.TESTING && ride.kind !== "coaster") {
      return `${label} has phase ${ride.phase} (testing), which only a coaster has`;
    }
    if (ride.phase === RidePhase.IDLE && ride.riders.length > 0) {
      return `${label} is idle with ${ride.riders.length} riders`;
    }
    if (type.kind === "ride" && ride.riders.length > type.capacity) {
      return `${label} has ${ride.riders.length} riders, more than its capacity of ${type.capacity}`;
    }

    if (type.kind === "coaster") {
      // A coaster marks no tiles; its track is checked below, with the others.
      const access = stationAccess(ride.x, ride.y, ride.rot as Dir);
      const tiles = { entrance: access.entrance, exit: access.exit, service: null };
      for (const key of ["entrance", "exit", "service"] as const) {
        if (!sameTile(ride[key], tiles[key])) {
          return `${label} has ${key} ${showTile(ride[key])}, expected ${showTile(tiles[key])}`;
        }
      }
      if (ride.riders.length > 0) {
        return `${label} is a coaster with riders, whose trains carry none yet`;
      }
      if (ride.phase !== RidePhase.IDLE && ride.phase !== RidePhase.TESTING) {
        return `${label} is a coaster in phase ${ride.phase}, not idle or testing`;
      }
      continue;
    }

    const rot = ride.rot as Rot;
    const tiles = accessTiles(type, ride.x, ride.y, rot);
    for (const key of ["entrance", "exit", "service"] as const) {
      if (!sameTile(ride[key], tiles[key])) {
        return `${label} has ${key} ${showTile(ride[key])}, expected ${showTile(tiles[key])}`;
      }
    }

    const rect = footprintRect(type, ride.x, ride.y, rot);
    if (!inBounds(terrain, rect.x, rect.y, rect.w, rect.h)) {
      return `${label} at (${ride.x}, ${ride.y}) is not on the ${terrain.width}x${terrain.height} map`;
    }
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const index = y * terrain.width + x;
        const other = expected[index] as number;
        if (other !== 0) return `${label} overlaps ride ${other} at (${x}, ${y})`;
        expected[index] = id;
      }
    }
  }

  // Every guest queuing or riding is listed by its ride; the lists checked the other way above.
  for (const [id, slot] of slotOf) {
    const state = g.state[slot];
    if (state === GuestState.QUEUING && !listed.has(id)) {
      return `guest ${id} is queuing for ride ${g.ride[slot]} but is not in its queue`;
    }
    if (state === GuestState.RIDING && !listed.has(id)) {
      return `guest ${id} is riding ride ${g.ride[slot]} but is not among its riders`;
    }
    const rideId = g.ride[slot] as number;
    if (state === GuestState.BUYING && findRide(world, rideId)?.kind !== "stall") {
      return `guest ${id} is buying at ${rideId}, which is not a stall in the park`;
    }
    if (state === GuestState.HEADING && rideId !== 0 && findRide(world, rideId) === undefined) {
      return `guest ${id} is heading for ride ${rideId}, which is not in the park`;
    }
  }

  for (let i = 0; i < expected.length; i++) {
    const actual = terrain.occupant[i] as number;
    if (actual !== expected[i]) {
      return `tile ${i} has occupant ${actual}, but the rides put ${expected[i]} there`;
    }
  }
  return checkTracks(world);
}

/**
 * Why coaster `ride`'s entrance or exit tile could not be one, as `coaster_begin` checks it (on
 * the map off its outer ring, no water, no ride or stall, not the park entrance, no steeper than
 * a path may be), or null. Other track over it is refused by the track replay.
 */
function accessRefusal(world: World, ride: RideRecord): string | null {
  const t = world.terrain;
  const entrance = world.park.entrance;
  for (const key of ["entrance", "exit"] as const) {
    const tile = ride[key];
    if (tile === null) return `${key} is missing`;
    const at = showTile(tile);
    if (tile.x < 1 || tile.y < 1 || tile.x > t.width - 2 || tile.y > t.height - 2) {
      return `${key} ${at} is off the map or on its outer ring`;
    }
    const index = tile.y * t.width + tile.x;
    if ((t.water[index] as number) > 0) return `${key} ${at} is under water`;
    if ((t.occupant[index] as number) !== 0) return `${key} ${at} is on a ride or stall`;
    if (entrance !== null && entrance.x === tile.x && entrance.y === tile.y) {
      return `${key} ${at} is the park entrance`;
    }
    const corners = tileCorners(t, tile.x, tile.y);
    if (Math.max(...corners) - Math.min(...corners) > MAX_PATH_SLOPE) {
      return `${key} ${at} is too steep for a path`;
    }
  }
  return null;
}

/**
 * The coaster tracks: sorted by id, one for each coaster ride and none for anything else, of the
 * ride's family, starting where pieces join on the tile and facing the way the ride says, every
 * piece a known one, and each track, replayed piece by piece from its start, taken by the same
 * placement rules the commands use against the world without it (`placementRefusal`, with a track
 * index rebuilt from the tracks rather than trusted). Its first station tile is level ground with
 * the track at its height, and its entrance and exit tiles are on the map off its outer ring, dry,
 * clear of rides and stalls and the park entrance, and no steeper than a path may be, as
 * `coaster_begin` requires. A complete track is a circuit `coaster_complete` takes (it closes on
 * its start, has one station run of the right length, and a lift or no climb above its station).
 */
function checkTracks(world: World): string | null {
  const coasters = world.rides.filter((ride) => ride.kind === "coaster");
  if (coasters.length !== world.tracks.length) {
    return `${world.tracks.length} tracks for ${coasters.length} coasters`;
  }
  // Each track's shape on its own first, so that the index can be built from them all.
  for (const [i, track] of world.tracks.entries()) {
    const ride = coasters[i] as RideRecord;
    const label = `track ${track.id}`;
    if (track.id !== ride.id) return `${label} does not match coaster ${ride.id}`;
    if (track.family !== ride.type) {
      return `${label} is of family ${track.family} but its coaster is a ${ride.type}`;
    }
    if (familyById(track.family) === undefined) {
      return `${label} has unknown family ${track.family}`;
    }
    if (track.pieces.length < 1 || track.pieces.length > MAX_TRACK_PIECES) {
      return `${label} has ${track.pieces.length} pieces, outside 1 to ${MAX_TRACK_PIECES}`;
    }
    const { start } = track;
    if (!isJoinPose(start) || start.pitch !== 0 || start.bank !== 0) {
      return `${label} does not start flat on the middle of a tile edge at a whole step`;
    }
    const expected = poseAtTile(ride.x, ride.y, ride.rot as Dir, start.z / STEP);
    if (!posesEqual(start, expected)) {
      return `${label} does not start on its coaster's tile (${ride.x}, ${ride.y}) facing ${ride.rot}`;
    }
    if (track.pieces[0] !== "station") return `${label} does not begin with a station piece`;
    if (!inBounds(world.terrain, ride.x, ride.y)) {
      return `${label} starts on tile (${ride.x}, ${ride.y}), off the map`;
    }
    const corners = tileCorners(world.terrain, ride.x, ride.y);
    const ground = Math.max(...corners);
    if (Math.min(...corners) !== ground) {
      return `${label} starts on tile (${ride.x}, ${ride.y}), which is not flat`;
    }
    if (start.z !== ground * STEP) {
      return `${label} starts at height ${start.z / STEP}, not on the ground at ${ground}`;
    }
    const access = accessRefusal(world, ride);
    if (access !== null) return `coaster ${ride.id}'s ${access}`;
    let pose = start;
    for (const [n, id] of track.pieces.entries()) {
      const piece = pieceById(id);
      if (piece === undefined) return `${label} piece ${n} is unknown: ${id}`;
      const mismatch = pieceRefusal(pose, piece);
      if (mismatch !== null) return `${label} piece ${n} (${id}) does not follow: ${mismatch}`;
      pose = applyPiece(pose, piece);
      if (pose.z < 0) return `${label} piece ${n} (${id}) goes below height 0`;
    }
  }
  // Rebuilt here and not taken from the world, which may hold an index made before a change.
  world.trackIndex = undefined;
  const reserved = reservedTiles(world);
  for (const [i, track] of world.tracks.entries()) {
    const ride = coasters[i] as RideRecord;
    const label = `track ${track.id}`;
    const family = familyById(track.family) as CoasterFamily;
    const { start } = track;
    let pose = start;
    // The pieces laid so far, grown one at a time (not sliced per piece) so a replay is linear.
    const laid: string[] = [];
    for (const [n, id] of track.pieces.entries()) {
      const piece = pieceById(id) as TrackPiece;
      const ctx = { rideId: track.id, family, start, pieces: laid, pose, reserved };
      const refused = placementRefusal(world, ctx, piece);
      if (refused !== null) return `${label} piece ${n} (${id}) does not fit: ${refused}`;
      laid.push(id);
      pose = applyPiece(pose, piece);
    }
    if (track.complete) {
      const circuit = circuitRefusal(start, track.pieces);
      if (circuit === NOT_CLOSED) return `${label} is complete but does not close`;
      if (circuit !== null) return `${label} is complete but not a circuit: ${circuit}`;
    }
    if (track.tested && !track.complete) return `${label} is tested but not complete`;
    if (ride.open && !track.tested) return `coaster ${ride.id} is open but has not been tested`;
    const run = testRunRefusal(track, ride);
    if (run !== null) return `${label} ${run}`;
  }
  return null;
}

/**
 * The test-run state of a track: it has stats exactly when it is tested, and a failure only when
 * it is not; a train out of the station only on a complete circuit, in a known mode, at most a
 * circuit from the platform either way; a test under way exactly while its coaster is TESTING,
 * with the train moving (not STOPPED) and the coaster closed; and a train that is moving only
 * on a test (trains carry no riders yet).
 */
function testRunRefusal(track: TrackRecord, ride: RideRecord): string | null {
  if (track.tested !== (track.stats !== null)) {
    return track.tested ? "is tested but has no stats" : "has stats but is not tested";
  }
  if (track.failure !== null && (track.tested || track.failure.length === 0)) {
    return "has a failed test but is tested";
  }
  if (track.stats !== null) {
    for (const [key, value] of Object.entries(track.stats)) {
      if (key === "minVerticalG" || key === "maxVerticalG") continue;
      if (value < 0) return `has stats.${key} ${value}, below 0`;
    }
  }
  const { train, test } = track;
  if (train !== null) {
    if (!track.complete) return "has a train out but is not complete";
    if (
      !Number.isInteger(train.mode) ||
      train.mode < TrainMode.DEPART ||
      train.mode > TrainMode.STOPPED
    ) {
      return `has a train in mode ${train.mode}`;
    }
    if (train.ticks < 0 || train.modeTicks < 0) return "has a train with negative ticks";
    const length = buildLine(track.start, track.pieces).length * FINE;
    if (Math.abs(train.travelled) > length) return "has a train more than a circuit away";
    if (train.mode === TrainMode.STOPPED) {
      if (train.speed !== 0) return "has a stopped train that is moving";
      if (test !== null) return "has a test under way with its train stopped";
    } else if (test === null) {
      return "has a train moving with no test under way";
    }
  }
  if ((test !== null) !== (ride.phase === RidePhase.TESTING)) {
    return test !== null
      ? "has a test under way but its coaster is not testing"
      : "is testing with no test under way";
  }
  if (test !== null) {
    if (train === null) return "has a test under way with no train";
    if (ride.open) return "has a test under way but its coaster is open";
    if (track.tested || track.failure !== null) return "has a test under way and a result";
  }
  return null;
}
