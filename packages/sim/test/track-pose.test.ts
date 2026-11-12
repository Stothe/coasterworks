import {
  STEP,
  TILE,
  TRACK_PIECES,
  bankRoll,
  pieceById,
  pitchAngle,
  type TrackPiece,
} from "@coasterworks/content";
import { describe, expect, it } from "vitest";
import {
  SEG_BRAKE,
  SEG_LIFT,
  SEG_STATION,
  applyPiece,
  circuitCloses,
  endPose,
  localToWorld,
  pieceRefusal,
  pieceTiles,
  poseAtTile,
  posesEqual,
  samplePiece,
  sampleTrack,
  type Dir,
  type Pose,
  type Segment,
} from "../src/track/pose.js";

const DIRS: Dir[] = [0, 1, 2, 3];

/** A pose that `piece` can start from, entering tile (40, 40) at height 20 facing `dir`. */
function startFor(piece: TrackPiece, dir: Dir): Pose {
  return { ...poseAtTile(40, 40, dir, 20), pitch: piece.entry.pitch, bank: piece.entry.bank };
}

/** The sample a pose should produce: its position, heading and angles. */
function expectAtPose(seg: Segment, pose: Pose, label: string): void {
  expect(
    { x: seg.x, y: seg.y, z: seg.z, heading: seg.heading, pitch: seg.pitch, roll: seg.roll },
    label,
  ).toEqual({
    x: pose.x,
    y: pose.y,
    z: pose.z,
    heading: pose.dir * 1024,
    pitch: pitchAngle(pose.pitch),
    roll: bankRoll(pose.bank),
  });
}

function expectAllIntegers(segs: Segment[]): void {
  for (const seg of segs) {
    for (const [key, value] of Object.entries(seg)) {
      if (!Number.isInteger(value)) throw new Error(`${key} = ${value} is not an integer`);
    }
  }
}

/** Circular distance between two headings. */
function headingStep(a: number, b: number): number {
  const d = Math.abs(a - b) % 4096;
  return Math.min(d, 4096 - d);
}

describe("pose basics", () => {
  it("puts a tile's entry pose at the centre of the edge it crosses", () => {
    expect(poseAtTile(3, 5, 0, 2)).toEqual({ x: 3584, y: 6144, z: 512, dir: 0, pitch: 0, bank: 0 });
    expect(poseAtTile(3, 5, 1, 0)).toMatchObject({ x: 3072, y: 5632 });
    expect(poseAtTile(3, 5, 2, 0)).toMatchObject({ x: 3584, y: 5120 });
    expect(poseAtTile(3, 5, 3, 0)).toMatchObject({ x: 4096, y: 5632 });
  });

  it("maps forward and right to the world for each direction", () => {
    expect(localToWorld(0, 1, 2)).toEqual({ dx: 2, dy: -1 });
    expect(localToWorld(1, 1, 2)).toEqual({ dx: 1, dy: 2 });
    expect(localToWorld(2, 1, 2)).toEqual({ dx: -2, dy: 1 });
    expect(localToWorld(3, 1, 2)).toEqual({ dx: -1, dy: -2 });
  });

  it("refuses a piece whose entry does not match the track, with a reason", () => {
    const flat = poseAtTile(10, 10, 0, 5);
    expect(pieceRefusal(flat, pieceById("straight")!)).toBeNull();
    expect(pieceRefusal(flat, pieceById("gentle_up")!)).toMatch(/starts gently up.*runs flat/);
    expect(pieceRefusal(flat, pieceById("right_small_curve_banked")!)).toMatch(/banked/);
    expect(() => applyPiece(flat, "steep_up")).toThrow(RangeError);
    expect(() => applyPiece(flat, "no_such_piece")).toThrow(/Unknown track piece/);
    const up = applyPiece(flat, "flat_to_gentle_up");
    expect(pieceRefusal(up, pieceById("straight")!)).not.toBeNull();
    expect(pieceRefusal(up, pieceById("steep_up")!)).not.toBeNull(); // two levels at once
    expect(pieceRefusal(up, pieceById("gentle_to_steep_up")!)).toBeNull();
  });
});

describe("every piece, at every direction", () => {
  for (const piece of TRACK_PIECES) {
    it(`${piece.id} starts and ends exactly on its poses`, () => {
      for (const dir of DIRS) {
        const start = startFor(piece, dir);
        const exit = applyPiece(start, piece);
        const segs = samplePiece(start, piece);
        expect(segs.length).toBe(piece.samples + 1);
        expectAtPose(segs[0]!, start, `${piece.id} entry dir ${dir}`);
        expectAtPose(segs[segs.length - 1]!, exit, `${piece.id} exit dir ${dir}`);
        expectAllIntegers(segs);

        // The exit is the declared delta turned to `dir`.
        const { dx, dy } = localToWorld(dir, piece.exit.forward, piece.exit.right);
        expect(exit).toEqual({
          x: start.x + dx,
          y: start.y + dy,
          z: start.z + piece.exit.dz * STEP,
          dir: (dir + piece.exit.dDir + 4) % 4,
          pitch: piece.exit.pitch,
          bank: piece.exit.bank,
        });
        // The exit sits on a tile edge centre at a whole step.
        expect(exit.z % STEP).toBe(0);
        const along = exit.dir % 2 === 0 ? exit.y : exit.x;
        const across = exit.dir % 2 === 0 ? exit.x : exit.y;
        expect(along % TILE).toBe(0);
        expect((across - TILE / 2) % TILE).toBe(0);

        // The declared length is the sampled chord length, at every direction.
        expect(segs[segs.length - 1]!.s).toBe(piece.length);
        // Samples are spaced near 1/8 tile.
        for (let i = 1; i < segs.length; i++) {
          const step = segs[i]!.s - segs[i - 1]!.s;
          expect(step, `${piece.id} sample ${i}`).toBeGreaterThanOrEqual(100);
          expect(step, `${piece.id} sample ${i}`).toBeLessThanOrEqual(160);
        }
        // Flags.
        const flags =
          (piece.flags.station ? SEG_STATION : 0) |
          (piece.flags.lift ? SEG_LIFT : 0) |
          (piece.flags.brake ? SEG_BRAKE : 0);
        for (const seg of segs) expect(seg.flags).toBe(flags);
      }
    });

    it(`${piece.id} stays inside its tiles and height bands`, () => {
      for (const dir of DIRS) {
        const start = startFor(piece, dir);
        const tiles = pieceTiles(start, piece);
        expect(tiles.length).toBe(piece.tiles.length);
        expect(new Set(tiles.map((t) => `${t.x},${t.y}`)).size).toBe(tiles.length);
        for (const seg of samplePiece(start, piece)) {
          const inside = tiles.some(
            (t) =>
              seg.x >= t.x * TILE &&
              seg.x <= (t.x + 1) * TILE &&
              seg.y >= t.y * TILE &&
              seg.y <= (t.y + 1) * TILE &&
              seg.z >= t.zLo * STEP &&
              seg.z <= t.zHi * STEP,
          );
          expect(inside, `${piece.id} dir ${dir} at ${seg.x},${seg.y},${seg.z}`).toBe(true);
        }
      }
    });

    it(`${piece.id} eases pitch and roll smoothly`, () => {
      const segs = samplePiece(startFor(piece, 1), piece);
      for (let i = 1; i < segs.length; i++) {
        const a = segs[i - 1]!;
        const b = segs[i]!;
        expect(Math.abs(b.pitch - a.pitch)).toBeLessThanOrEqual(64);
        expect(Math.abs(b.roll - a.roll)).toBeLessThanOrEqual(96);
        expect(headingStep(a.heading, b.heading)).toBeLessThanOrEqual(64);
        // Height moves one way only.
        expect(Math.sign(b.z - a.z) * Math.sign(piece.exit.dz)).toBeGreaterThanOrEqual(0);
      }
    });
  }
});

/** Pieces laid from `start`, checked to close on it exactly, sample by sample. */
function expectCloses(start: Pose, ids: string[]): Segment[] {
  expect(circuitCloses(start, ids)).toBe(true);
  expect(posesEqual(endPose(start, ids), start)).toBe(true);
  const segs = sampleTrack(start, ids);
  expectAtPose(segs[0]!, start, "first sample");
  expectAtPose(segs[segs.length - 1]!, start, "last sample");
  expectAllIntegers(segs);
  // The track length is the sum of the piece lengths.
  const total = ids.reduce((sum, id) => sum + pieceById(id)!.length, 0);
  expect(segs[segs.length - 1]!.s).toBe(total);
  return segs;
}

// Station side climbs 2 steps, the far side falls 2; banked semicircles at each end.
const OVAL = [
  "station",
  "station",
  "flat_to_gentle_up_lift",
  "gentle_up_to_flat_lift",
  "bank_right_in",
  "right_small_curve_banked",
  "right_small_curve_banked",
  "bank_right_out",
  "flat_to_gentle_down",
  "gentle_down_to_flat",
  "straight",
  "straight",
  "bank_right_in",
  "right_small_curve_banked",
  "right_small_curve_banked",
  "bank_right_out",
];

// A lift to 16 steps, a steep drop, a steep-banked large turn, a hill and brakes.
const HILLY = [
  "station",
  "station",
  "station",
  "flat_to_gentle_up_lift",
  "gentle_up_lift",
  "gentle_up_lift",
  "gentle_to_steep_up_lift",
  "steep_to_gentle_up_lift",
  "gentle_up_to_flat_lift", // +1 +2 +2 +3 +3 +1 = 12, nine tiles from the start
  "left_large_curve",
  "left_large_curve",
  "flat_to_gentle_down",
  "gentle_to_steep_down",
  "steep_down",
  "steep_to_gentle_down",
  "gentle_down_to_flat", // -1 -3 -4 -3 -1 = -12
  "straight",
  "straight",
  "straight",
  "straight",
  "straight",
  "straight",
  "bank_left_in",
  "bank_left_steepen",
  "left_large_curve_steep_banked",
  "left_large_curve_steep_banked",
  "bank_left_ease",
  "bank_left_out",
  "brakes",
  "brakes",
];

describe("closed circuits", () => {
  it("closes a circle of four small curves either way, at every start", () => {
    for (const dir of DIRS) {
      for (const tile of [
        [0, 0],
        [7, 3],
        [255, 255],
      ] as const) {
        const start = poseAtTile(tile[0], tile[1], dir, 7);
        expectCloses(start, Array(4).fill("right_small_curve"));
        expectCloses(start, Array(4).fill("left_small_curve"));
        expectCloses(start, Array(4).fill("right_large_curve"));
        expectCloses({ ...start, bank: -2 }, Array(4).fill("left_small_curve_steep_banked"));
        expectCloses({ ...start, bank: 1 }, Array(4).fill("right_large_curve_banked"));
      }
    }
  });

  it("closes an oval with a lift, slopes and banks, at every rotation", () => {
    for (const dir of DIRS) {
      const segs = expectCloses(poseAtTile(20, 30, dir, 4), OVAL);
      expect(segs.some((s) => s.flags & SEG_LIFT)).toBe(true);
      expect(segs.filter((s) => s.flags & SEG_STATION).length).toBeGreaterThan(0);
      expect(Math.max(...segs.map((s) => s.z))).toBe((4 + 2) * STEP);
      expect(Math.max(...segs.map((s) => s.roll))).toBe(bankRoll(1));
    }
  });

  it("closes a hilly circuit with steep drops and steep banking, at every rotation", () => {
    for (const dir of DIRS) {
      const start = poseAtTile(60, 60, dir, 2);
      const segs = expectCloses(start, HILLY);
      expect(Math.max(...segs.map((s) => s.z))).toBe((2 + 12) * STEP);
      expect(Math.max(...segs.map((s) => s.pitch))).toBe(pitchAngle(2));
      expect(Math.min(...segs.map((s) => s.pitch))).toBe(pitchAngle(-2));
      expect(Math.min(...segs.map((s) => s.roll))).toBe(bankRoll(-2));
      expect(segs.some((s) => s.flags & SEG_BRAKE)).toBe(true);
    }
  });

  it("joins pieces smoothly: no jumps in position, heading, pitch or roll", () => {
    const segs = sampleTrack(poseAtTile(60, 60, 2, 2), HILLY);
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1]!;
      const b = segs[i]!;
      expect(b.s - a.s).toBeGreaterThanOrEqual(100);
      expect(b.s - a.s).toBeLessThanOrEqual(160);
      expect(Math.abs(b.pitch - a.pitch)).toBeLessThanOrEqual(64);
      expect(Math.abs(b.roll - a.roll)).toBeLessThanOrEqual(96);
      expect(headingStep(a.heading, b.heading)).toBeLessThanOrEqual(64);
      expect(b.piece === a.piece || b.piece === a.piece + 1).toBe(true);
    }
    expect(segs[segs.length - 1]!.piece).toBe(HILLY.length - 1);
  });

  it("reports open and empty tracks as not closed", () => {
    const start = poseAtTile(10, 10, 0, 0);
    expect(circuitCloses(start, [])).toBe(false);
    expect(circuitCloses(start, ["station", "straight"])).toBe(false);
    expect(circuitCloses(start, Array(3).fill("right_small_curve"))).toBe(false);
    // Right size, wrong height.
    const level = OVAL.map((id) =>
      id.startsWith("flat_to_gentle_down") || id.startsWith("gentle_down") ? "straight" : id,
    );
    expect(circuitCloses(start, level)).toBe(false);
    expect(endPose(start, level)).toMatchObject({ x: start.x, y: start.y, z: start.z + 2 * STEP });
  });

  it("ends any sequence at the sum of its piece deltas", () => {
    // A fixed pseudo-random walk over the pieces that fit, checked against summed deltas.
    let seed = 12345;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    for (const dir of DIRS) {
      let pose = poseAtTile(128, 128, dir, 32);
      let x = pose.x;
      let y = pose.y;
      let z = pose.z;
      let d: number = dir;
      const ids: string[] = [];
      for (let k = 0; k < 200; k++) {
        const fits = TRACK_PIECES.filter((p) => pieceRefusal(pose, p) === null);
        const piece = fits[next() % fits.length]!;
        const { dx, dy } = localToWorld(d as Dir, piece.exit.forward, piece.exit.right);
        x += dx;
        y += dy;
        z += piece.exit.dz * STEP;
        d = (d + piece.exit.dDir + 4) % 4;
        pose = applyPiece(pose, piece);
        ids.push(piece.id);
        expect({ x: pose.x, y: pose.y, z: pose.z, dir: pose.dir }).toEqual({ x, y, z, dir: d });
      }
      const segs = sampleTrack(poseAtTile(128, 128, dir, 32), ids);
      expectAtPose(segs[segs.length - 1]!, pose, "end of the walk");
      expectAllIntegers(segs);
    }
  });
});
