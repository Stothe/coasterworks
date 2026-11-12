import {
  QUARTER_TURN,
  STEP,
  TILE,
  TRIG_ONE,
  TURN,
  bankRoll,
  divRound,
  iatan2,
  icos,
  isin,
  isqrt,
  mod,
  pieceById,
  pitchAngle,
  pitchRise,
  type TrackPiece,
} from "@coasterworks/content";

// Track geometry: poses where pieces join, and the sampled centre line a train runs along.
// Integer math only, in the units of `@coasterworks/content`'s `fixed.ts`: positions in 1/1024
// tile (a height step is 256), angles in 1/4096 turn. x grows east, y south, z up; directions
// are 0 north, 1 east, 2 south, 3 west.

export type Dir = 0 | 1 | 2 | 3;

/**
 * Where a piece starts or ends: the centre of a tile edge at a whole height step. `x`, `y`, `z`
 * are fixed-point; `pitch` and `bank` are levels -2..2 (see `TrackPieceSchema`).
 */
export interface Pose {
  x: number;
  y: number;
  z: number;
  dir: Dir;
  pitch: number;
  bank: number;
}

/** Segment flag bits. */
export const SEG_STATION = 1;
export const SEG_LIFT = 2;
export const SEG_BRAKE = 4;

/** One sample of the centre line. Every field is an integer. */
export interface Segment {
  x: number;
  y: number;
  z: number;
  /** Clockwise from north, 0..4095. */
  heading: number;
  /** Up positive, -1024..1024. */
  pitch: number;
  /** Right side down positive. */
  roll: number;
  /** Horizontal curvature, right turns positive: 2^14 / radius in tiles. 0 on straights. */
  curvature: number;
  /** Distance along the track from the first sample, in 1/1024 tile (sum of chords). */
  s: number;
  /** Index of the piece this sample belongs to (a join belongs to the piece it ends). */
  piece: number;
  /** `SEG_STATION | SEG_LIFT | SEG_BRAKE` bits of that piece. */
  flags: number;
}

/** World offset of a move `forward`, `right` in the frame of a track facing `dir`. */
export function localToWorld(dir: Dir, forward: number, right: number): { dx: number; dy: number } {
  switch (dir) {
    case 0:
      return { dx: right, dy: -forward };
    case 1:
      return { dx: forward, dy: right };
    case 2:
      return { dx: -right, dy: forward };
    case 3:
      return { dx: -forward, dy: -right };
  }
}

/** The pose entering tile (`tx`, `ty`) facing `dir`, at `height` steps, flat and unbanked. */
export function poseAtTile(tx: number, ty: number, dir: Dir, height: number): Pose {
  const back = localToWorld(dir, -TILE / 2, 0);
  return {
    x: tx * TILE + TILE / 2 + back.dx,
    y: ty * TILE + TILE / 2 + back.dy,
    z: height * STEP,
    dir,
    pitch: 0,
    bank: 0,
  };
}

/** True when two poses are exactly the same. */
export function posesEqual(a: Pose, b: Pose): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.z === b.z &&
    a.dir === b.dir &&
    a.pitch === b.pitch &&
    a.bank === b.bank
  );
}

function resolve(piece: TrackPiece | string): TrackPiece {
  if (typeof piece !== "string") return piece;
  const found = pieceById(piece);
  if (!found) throw new RangeError(`Unknown track piece "${piece}"`);
  return found;
}

const PITCH_WORDS = ["steeply down", "gently down", "flat", "gently up", "steeply up"];
const BANK_WORDS = ["steeply left", "gently left", "level", "gently right", "steeply right"];

/** Why `piece` cannot follow track ending at `pose`; null when it can. */
export function pieceRefusal(pose: Pose, piece: TrackPiece): string | null {
  if (piece.entry.pitch !== pose.pitch) {
    return `This piece starts ${PITCH_WORDS[piece.entry.pitch + 2]}, but the track runs ${PITCH_WORDS[pose.pitch + 2]}.`;
  }
  if (piece.entry.bank !== pose.bank) {
    return `This piece starts banked ${BANK_WORDS[piece.entry.bank + 2]}, but the track is banked ${BANK_WORDS[pose.bank + 2]}.`;
  }
  return null;
}

/** The pose at the end of `piece` laid from `pose`. Throws if the piece cannot follow it. */
export function applyPiece(pose: Pose, piece: TrackPiece | string): Pose {
  const p = resolve(piece);
  const refusal = pieceRefusal(pose, p);
  if (refusal) throw new RangeError(`${p.id}: ${refusal}`);
  const { dx, dy } = localToWorld(pose.dir, p.exit.forward, p.exit.right);
  return {
    x: pose.x + dx,
    y: pose.y + dy,
    z: pose.z + p.exit.dz * STEP,
    dir: mod(pose.dir + p.exit.dDir, 4) as Dir,
    pitch: p.exit.pitch,
    bank: p.exit.bank,
  };
}

/** The pose at the end of `pieces` laid one after another from `start`. */
export function endPose(start: Pose, pieces: readonly (TrackPiece | string)[]): Pose {
  let pose = start;
  for (const piece of pieces) pose = applyPiece(pose, piece);
  return pose;
}

/** True when `pieces` laid from `start` end exactly on `start`. */
export function circuitCloses(start: Pose, pieces: readonly (TrackPiece | string)[]): boolean {
  if (pieces.length === 0) return false;
  return posesEqual(endPose(start, pieces), start);
}

function flagBits(p: TrackPiece): number {
  return (
    (p.flags.station ? SEG_STATION : 0) |
    (p.flags.lift ? SEG_LIFT : 0) |
    (p.flags.brake ? SEG_BRAKE : 0)
  );
}

/** A tile a piece covers, with the height band (in whole steps) its centre line passes through. */
export interface PieceTile {
  x: number;
  y: number;
  zLo: number;
  zHi: number;
}

/** The world tiles `piece` laid from `pose` covers. `pose.z` must be a whole step. */
export function pieceTiles(pose: Pose, piece: TrackPiece | string): PieceTile[] {
  const p = resolve(piece);
  if (pose.z % STEP !== 0) throw new RangeError("A piece must start on a whole height step");
  const base = pose.z / STEP;
  return p.tiles.map((t) => {
    // The tile's centre: half a tile forward of its entry line, `r` tiles to the right.
    const { dx, dy } = localToWorld(pose.dir, t.f * TILE + TILE / 2, t.r * TILE);
    return {
      x: Math.floor((pose.x + dx) / TILE),
      y: Math.floor((pose.y + dy) / TILE),
      zLo: base + t.zLo,
      zHi: base + t.zHi,
    };
  });
}

/** Smoothstep 3t^2 - 2t^3 at t = i / n, as a numerator over n^3. */
function easeNum(i: number, n: number): number {
  return 3 * i * i * n - 2 * i * i * i;
}

/**
 * The centre line of `piece` laid from `pose`, at samples i = 0..piece.samples. The first sample
 * is exactly the entry pose and the last exactly the exit pose. `s` starts at 0 and `piece` is 0.
 */
export function samplePiece(pose: Pose, piece: TrackPiece | string): Segment[] {
  const p = resolve(piece);
  const exit = applyPiece(pose, p);
  const n = p.samples;
  const flags = flagBits(p);
  const out: Segment[] = [];
  const n3 = n * n * n;
  const baseHeading = pose.dir * QUARTER_TURN;
  let prev: { x: number; y: number; z: number } | null = null;
  let s = 0;
  for (let i = 0; i <= n; i++) {
    let f: number;
    let r: number;
    let z: number;
    let heading: number;
    let pitch: number;
    let roll: number;
    let curvature: number;
    if (p.shape === "straight") {
      const rise0 = pitchRise(p.entry.pitch);
      const rise1 = pitchRise(p.exit.pitch);
      const tiles = p.exit.forward / TILE;
      f = divRound(p.exit.forward * i, n);
      r = 0;
      // Height is the integral of the eased slope: tiles * (r0 t + (r1 - r0)(t^3 - t^4 / 2)).
      const zNum =
        STEP * tiles * (2 * rise0 * i * n3 + (rise1 - rise0) * (2 * i * i * i * n - i * i * i * i));
      z = pose.z + divRound(zNum, 2 * n3 * n);
      heading = baseHeading;
      pitch = iatan2((rise0 * n3 + (rise1 - rise0) * easeNum(i, n)) * STEP, n3 * TILE);
      const roll0 = bankRoll(p.entry.bank);
      roll = roll0 + divRound((bankRoll(p.exit.bank) - roll0) * easeNum(i, n), n3);
      curvature = 0;
    } else {
      const radius = p.exit.forward;
      const turn = p.exit.dDir;
      const theta = divRound(QUARTER_TURN * i, n);
      f = divRound(radius * isin(theta), TRIG_ONE);
      r = turn * (radius - divRound(radius * icos(theta), TRIG_ONE));
      z = pose.z;
      heading = mod(baseHeading + turn * theta, TURN);
      pitch = pitchAngle(0);
      roll = bankRoll(p.entry.bank);
      curvature = turn * divRound(TRIG_ONE * TILE, radius);
    }
    const { dx, dy } = localToWorld(pose.dir, f, r);
    const x = pose.x + dx;
    const y = pose.y + dy;
    if (prev) {
      const cx = x - prev.x;
      const cy = y - prev.y;
      const cz = z - prev.z;
      s += isqrt(cx * cx + cy * cy + cz * cz);
    }
    prev = { x, y, z };
    out.push({ x, y, z, heading, pitch, roll, curvature, s, piece: 0, flags });
  }
  const last = out[n]!;
  if (last.x !== exit.x || last.y !== exit.y || last.z !== exit.z) {
    throw new Error(`${p.id}: sampled end does not meet the exit pose`);
  }
  return out;
}

/**
 * The centre line of `pieces` laid from `start`: the first piece's samples, then each further
 * piece's samples without its first (which repeats the join). `s` runs on across pieces.
 */
export function sampleTrack(start: Pose, pieces: readonly (TrackPiece | string)[]): Segment[] {
  const out: Segment[] = [];
  let pose = start;
  let s = 0;
  for (const [index, piece] of pieces.entries()) {
    const samples = samplePiece(pose, piece);
    for (let i = index === 0 ? 0 : 1; i < samples.length; i++) {
      const seg = samples[i]!;
      out.push({ ...seg, s: s + seg.s, piece: index });
    }
    s += samples[samples.length - 1]!.s;
    pose = applyPiece(pose, piece);
  }
  return out;
}
