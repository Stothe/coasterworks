import { TRACK_PIECES } from "@coasterworks/content";
import { z } from "zod";
import { appendRefusal, coasterOf, completeRefusal } from "../commands/coaster.js";
import { defineQuery } from "../commands/define.js";
import { checkCash } from "../commands/execute.js";
import { copyRide } from "../rides/types.js";
import { applyPiece, sampleTrack, type Pose } from "../track/pose.js";
import { copyTrack, pieceCost, trackCost } from "../track/record.js";

export const coasterGet = defineQuery({
  name: "coaster_get",
  description:
    "Describes one coaster by its ride id: `ride` (its ride record, as `ride_get` gives it), `track` { id, family, start, pieces, complete, tested, stats }, `poses` (the pose each piece starts at, then the end pose last, so one more than the pieces), `end` (where the track ends now), `complete`, `tested`, `canComplete` (null, or why `coaster_complete` would refuse), `length` (the sampled centre line, in 1/1024 tile) and `cost` (what its pieces cost together, in cents). A pose is { x, y, z, dir, pitch, bank }: x and y in 1/1024 tile (x east, y south), z in 1/256 height step (256 per step), dir 0 north to 3 west, pitch and bank levels -2 to 2.",
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
