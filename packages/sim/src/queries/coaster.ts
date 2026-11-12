import { TRACK_PIECES } from "@coasterworks/content";
import { z } from "zod";
import {
  ALREADY_REACHED,
  MAX_FIT_POINTS,
  appendRefusal,
  coasterOf,
  completeRefusal,
  fitPointSchema,
  planExtend,
  planFromPoints,
} from "../commands/coaster.js";
import { defineQuery } from "../commands/define.js";
import { checkCash } from "../commands/execute.js";
import { copyRide } from "../rides/types.js";
import { applyPiece, sampleTrack, type Pose } from "../track/pose.js";
import { copyTrack, pieceCost, trackCost } from "../track/record.js";

export const coasterGet = defineQuery({
  name: "coaster_get",
  description:
    "Describes one coaster by its ride id: `ride` (its ride record, as `ride_get` gives it), `track` { id, family, start, pieces, complete, tested, stats, failure, train, test }, `poses` (the pose each piece starts at, then the end pose last, so one more than the pieces), `end` (where the track ends now), `complete`, `tested`, `canComplete` (null, or why `coaster_complete` would refuse), `length` (the sampled centre line, in 1/1024 tile) and `cost` (what its pieces cost together, in cents). A pose is { x, y, z, dir, pitch, bank }: x and y in 1/1024 tile (x east, y south), z in 1/256 height step (256 per step), dir 0 north to 3 west, pitch and bank levels -2 to 2. After a passed `ride_test`, `track.stats` is { length (1/1024 tile), rideTime (ticks, 40 a second), maxSpeed (1/1024 tile per tick; a tile is 3 m, so 100 is about 11.7 m/s), maxDrop (1/1024 tile, 256 to a height step), drops, airtime (ticks below 0.2 g), maxVerticalG, minVerticalG and maxLateralG (1/100 g; 100 is sitting still) }, null until one passes; `track.failure` is why the last test failed, or null. `track.train` is null while the train is at rest on the platform, else { mode (1 leaving, 2 running, 3 coming in, 4 rolling back after a stall, 5 stopped out on the track), travelled (its front from the platform, 1/65536 tile), speed (1/65536 tile per tick), ticks, modeTicks }; `track.test` is what a test run under way has measured so far, or null.",
  category: "ride",
  input: z.object({ id: z.int() }),
  run: (world, { id }) => {
    const found = coasterOf(world, id);
    if (typeof found === "string") throw new Error(found);
    const { ride, track } = found;
    const poses: Pose[] = [track.start];
    for (const piece of track.pieces) poses.push(applyPiece(poses[poses.length - 1]!, piece));
    const samples = sampleTrack(track.start, track.pieces);
    return {
      ride: copyRide(ride),
      track: copyTrack(track),
      poses: poses.map((p) => ({ ...p })),
      end: { ...poses[poses.length - 1]! },
      complete: track.complete,
      tested: track.tested,
      canComplete: track.complete ? null : completeRefusal(world, id),
      length: samples[samples.length - 1]?.s ?? 0,
      cost: trackCost(track),
    };
  },
});

export const coasterPieceOptions = defineQuery({
  name: "coaster_piece_options",
  description:
    "Says, for every track piece in `track_pieces_list` order, whether `coaster_add_piece` would take it at the end of this coaster's track now: [{ piece, ok, reason (why not, as the command would say it, or null), cost (cents) }]. A piece the park cannot pay for is refused with the cash message.",
  category: "ride",
  input: z.object({ id: z.int() }),
  run: (world, { id }) => {
    const found = coasterOf(world, id);
    if (typeof found === "string") throw new Error(found);
    const { track } = found;
    return TRACK_PIECES.map((piece) => {
      const cost = pieceCost(track.family, piece.id);
      const reason = appendRefusal(world, id, piece.id) ?? checkCash(world, cost);
      return { piece: piece.id, ok: reason === null, reason, cost };
    });
  },
});

export const trackPiecesList = defineQuery({
  name: "track_pieces_list",
  description:
    "Lists every coaster track piece: { id (what `coaster_add_piece` takes), name, kind (station, straight, curve_small, curve_large, slope, bank, lift or brake: a family's `pieceCost` is by kind), entry { pitch, bank } the track must end on for it to follow, exit { forward, right (1/1024 tile, in the piece's own frame), dz (height steps), dDir (quarter turns, +1 right), pitch, bank }, shape, flags { station, lift, brake }, samples, length (1/1024 tile), tiles [{ f, r, zLo, zHi }] it covers }. Pitch levels run -2 steep down to 2 steep up; bank levels -2 steep left to 2 steep right.",
  category: "ride",
  input: z.object({}),
  run: () => TRACK_PIECES.map((piece) => JSON.parse(JSON.stringify(piece)) as unknown),
});

export const coasterFitPreview = defineQuery({
  name: "coaster_fit_preview",
  description: `Shows what fitting track through points would lay, without building anything (what the builder's draw mode shows, red where a point fails). Give either \`family\` (a new coaster: points[0] is its station spot, exactly as \`coaster_build_from_points\` takes it) or \`id\` (an incomplete coaster: the points are fitted one after another from where its track ends; with one point and no \`close\` this is exactly what \`coaster_extend_to\` lays, while otherwise each stretch also looks ahead to the next point (or the close), so it can differ from extending to them one at a time, which never looks ahead), plus \`points\` [{ x, y, height? }] (at most ${MAX_FIT_POINTS}) and optionally \`close\` (fit back onto the station and check the circuit as \`coaster_complete\` would). Returns { pieces (for a family the whole track, station included; for an id the pieces it would add), points [{ ok, reason (null, or why not), pieces (how many pieces its stretch has) }] one per point, close ({ ok, reason, pieces } or null), ok, error (the first failure as the command would give it, or null), cost (cents), begin ({ x, y, dir } of the station for a family, else null) }. After the first failing point every later point reports "Fix the point before this one". A point the track already passes over with its last piece is ok with no pieces and the reason "${ALREADY_REACHED}" (which \`coaster_extend_to\` refuses with).`,
  category: "ride",
  input: z.object({
    family: z.string().optional(),
    id: z.int().optional(),
    points: z.array(fitPointSchema).min(1).max(MAX_FIT_POINTS),
    close: z.boolean().optional(),
  }),
  run: (world, input) => {
    if ((input.family === undefined) === (input.id === undefined)) {
      throw new Error("Give either a family (a new coaster) or the id of a coaster");
    }
    const close = input.close === true;
    const plan =
      input.family !== undefined
        ? planFromPoints(world, input.family, input.points, close)
        : planExtend(world, input.id as number, input.points, close);
    return {
      pieces: plan.pieces,
      points: plan.points,
      close: plan.close,
      ok: plan.error === null,
      error: plan.error,
      cost: plan.cost,
      begin: plan.begin,
    };
  },
});
