import { hashString } from "./hash.js";

/** The four uint32 words of an xoshiro128** generator. */
export type RngState = readonly [number, number, number, number];

const TWO_POW_32 = 0x100000000;
const GOLDEN_GAMMA = 0x9e3779b9;

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** The splitmix32 output function. It is a bijection on uint32 values. */
function splitmix32(counter: number): number {
  let t = Math.imul(counter ^ (counter >>> 16), 0x21f0aaad);
  t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
  return (t ^ (t >>> 15)) >>> 0;
}

/** Expands a uint32 seed into four state words with a splitmix32 stream. */
function seedWords(seed: number): [number, number, number, number] {
  let counter = seed >>> 0;
  const next = (): number => {
    counter = (counter + GOLDEN_GAMMA) >>> 0;
    return splitmix32(counter);
  };
  return [next(), next(), next(), next()];
}

/**
 * Runs the splitmix32 initialisation over four existing words. Each word is absorbed into the
 * running counter before it is mixed, so every output word depends on all earlier input words.
 * The whole map is a bijection on four-word states.
 */
function remixWords(
  w0: number,
  w1: number,
  w2: number,
  w3: number,
): [number, number, number, number] {
  let counter = 0;
  const absorb = (word: number): number => {
    counter = (((counter ^ word) >>> 0) + GOLDEN_GAMMA) >>> 0;
    return splitmix32(counter);
  };
  return [absorb(w0), absorb(w1), absorb(w2), absorb(w3)];
}

/**
 * Seeded xoshiro128** generator. Uses only integer arithmetic, so a given seed yields the same
 * sequence on every platform. All draws are explicit method calls; there is no hidden global state.
 */
export class Rng {
  #s0: number;
  #s1: number;
  #s2: number;
  #s3: number;

  /** Creates a generator from an integer seed. Seeds are reduced modulo 2^32. */
  constructor(seed: number) {
    if (!Number.isInteger(seed)) {
      throw new RangeError(`Rng seed must be an integer, got ${seed}`);
    }
    [this.#s0, this.#s1, this.#s2, this.#s3] = seedWords(seed);
  }

  /** The current state, as a fresh tuple. Pass it to `Rng.fromState` to resume the stream. */
  get state(): RngState {
    return [this.#s0, this.#s1, this.#s2, this.#s3];
  }

  /** Restores a generator from a state previously read from `state`. */
  static fromState(s: RngState): Rng {
    if (s.length !== 4) {
      throw new RangeError(`Rng state must have 4 words, got ${s.length}`);
    }
    for (const word of s) {
      if (!isUint32(word)) {
        throw new RangeError(`Rng state words must be uint32 integers, got ${word}`);
      }
    }
    if (s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 0) {
      throw new RangeError("Rng state must not be all zero");
    }
    const rng = new Rng(0);
    rng.#s0 = s[0];
    rng.#s1 = s[1];
    rng.#s2 = s[2];
    rng.#s3 = s[3];
    return rng;
  }

  /** Advances the generator and returns a uint32. */
  next(): number {
    const result = Math.imul(rotl(Math.imul(this.#s1, 5), 7), 9) >>> 0;
    const t = this.#s1 << 9;
    const s2 = this.#s2 ^ this.#s0;
    const s3 = this.#s3 ^ this.#s1;
    this.#s1 = (this.#s1 ^ s2) >>> 0;
    this.#s0 = (this.#s0 ^ s3) >>> 0;
    this.#s2 = (s2 ^ t) >>> 0;
    this.#s3 = rotl(s3, 11);
    return result;
  }

  /**
   * Returns an integer in `0..n-1`, uniformly. Draws that would skew the result (the tail of the
   * 32-bit range that does not fill a whole multiple of `n`) are rejected and redrawn.
   * Throws `RangeError` unless `n` is an integer in `1..2^32`.
   */
  int(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > TWO_POW_32) {
      throw new RangeError(`Rng.int expects an integer in 1..2^32, got ${n}`);
    }
    const limit = TWO_POW_32 - (TWO_POW_32 % n);
    for (;;) {
      const x = this.next();
      if (x < limit) return x % n;
    }
  }

  /**
   * Returns true with probability `num / den`. Always consumes exactly one draw.
   * Throws `RangeError` unless `den` is an integer in `1..2^32` and `num` is an integer in `0..den`.
   */
  chance(num: number, den: number): boolean {
    if (!Number.isInteger(num) || num < 0 || !(num <= den)) {
      throw new RangeError(`Rng.chance expects integers with 0 <= num <= den, got ${num}/${den}`);
    }
    return this.int(den) < num;
  }

  /**
   * Derives an independent stream for `label`, such as one stream per simulation system. The
   * result depends on this generator's current state and on the label; this generator is not
   * advanced. To keep a system's stream stable, fork from a generator whose state is fixed at that
   * point (for example, straight after seeding) rather than from one that other code is drawing from.
   */
  fork(label: string): Rng {
    const hash = hashString(label);
    const lo = Number(BigInt.asUintN(32, hash));
    const hi = Number(hash >> 32n);
    return Rng.fromState(
      remixWords((this.#s0 ^ lo) >>> 0, (this.#s1 ^ hi) >>> 0, this.#s2, this.#s3),
    );
  }
}
