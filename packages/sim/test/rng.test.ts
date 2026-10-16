import { describe, expect, it } from "vitest";
import { Rng } from "../src/index.js";

/** The first three draws of Rng(42). Recorded once and pinned: this sequence must never change. */
const SEED_42_TRIPLE = [660444221, 3652823732, 77672526];

function draw(rng: Rng, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(rng.next());
  return out;
}

describe("Rng.next", () => {
  it("produces a pinned sequence for seed 42", () => {
    const rng = new Rng(42);
    expect([rng.next(), rng.next(), rng.next()]).toEqual(SEED_42_TRIPLE);
  });

  it("matches the xoshiro128** reference for a known state", () => {
    // State [1, 2, 3, 4]: first output is rotl(2 * 5, 7) * 9 = 11520 (reference implementation).
    const rng = Rng.fromState([1, 2, 3, 4]);
    expect(rng.next()).toBe(11520);
  });

  it("yields identical sequences for two generators with the same seed", () => {
    expect(draw(new Rng(42), 1000)).toEqual(draw(new Rng(42), 1000));
  });

  it("yields different sequences for different seeds", () => {
    expect(draw(new Rng(1), 8)).not.toEqual(draw(new Rng(2), 8));
  });

  it("returns uint32 values", () => {
    for (const value of draw(new Rng(7), 5000)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("does not get stuck on seed 0", () => {
    const values = draw(new Rng(0), 16);
    expect(new Set(values).size).toBeGreaterThan(1);
  });

  it("rejects seeds that are not integers", () => {
    expect(() => new Rng(1.5)).toThrow(RangeError);
    expect(() => new Rng(Number.NaN)).toThrow(RangeError);
    expect(() => new Rng(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("Rng state", () => {
  it("continues identically from fromState(r.state)", () => {
    const original = new Rng(42);
    draw(original, 37);
    const resumed = Rng.fromState(original.state);
    expect(draw(resumed, 1000)).toEqual(draw(original, 1000));
  });

  it("reads state without advancing the generator", () => {
    const rng = new Rng(9);
    const before = rng.state;
    expect(rng.state).toEqual(before);
    rng.next();
    expect(rng.state).not.toEqual(before);
  });

  it("holds four uint32 words", () => {
    const state = new Rng(123).state;
    expect(state).toHaveLength(4);
    for (const word of state) {
      expect(Number.isInteger(word)).toBe(true);
      expect(word).toBeGreaterThanOrEqual(0);
      expect(word).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("does not let a restored generator alias the state it came from", () => {
    const source: [number, number, number, number] = [5, 6, 7, 8];
    const rng = Rng.fromState(source);
    source[0] = 99;
    expect(rng.state).toEqual([5, 6, 7, 8]);
  });

  it("rejects the all-zero state, which would emit zeros forever", () => {
    expect(() => Rng.fromState([0, 0, 0, 0])).toThrow(RangeError);
  });

  it("rejects state words that are not uint32 integers", () => {
    expect(() => Rng.fromState([1, 2, 3, -1])).toThrow(RangeError);
    expect(() => Rng.fromState([1, 2, 3, 2 ** 32])).toThrow(RangeError);
    expect(() => Rng.fromState([1, 2, 3, 0.5])).toThrow(RangeError);
    expect(() => Rng.fromState([1, 2, Number.NaN, 4])).toThrow(RangeError);
  });

  it("rejects state of the wrong length", () => {
    expect(() => Rng.fromState([1, 2, 3] as unknown as [number, number, number, number])).toThrow(
      RangeError,
    );
  });
});

describe("Rng.int", () => {
  it("yields every value 0..9 over 10,000 draws and nothing outside", () => {
    const rng = new Rng(42);
    const counts = new Array<number>(10).fill(0);
    for (let i = 0; i < 10_000; i++) {
      const value = rng.int(10);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(10);
      counts[value] = (counts[value] ?? 0) + 1;
    }
    for (const count of counts) {
      // Expected 1000 each (sd about 30). The bounds are loose; the sequence is fixed anyway.
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1200);
    }
  });

  it("returns 0 for n = 1", () => {
    const rng = new Rng(3);
    for (let i = 0; i < 100; i++) expect(rng.int(1)).toBe(0);
  });

  it("stays in range for the largest supported bounds", () => {
    const rng = new Rng(11);
    for (let i = 0; i < 1000; i++) {
      expect(rng.int(2 ** 31)).toBeLessThan(2 ** 31);
      expect(rng.int(2 ** 31 - 1)).toBeLessThan(2 ** 31 - 1);
    }
  });

  it("rejects draws that would bias the result instead of taking a modulo", () => {
    const n = 1_500_000_000; // 2^32 % n = 1_294_967_296, so draws >= 3_000_000_000 are rejected
    const limit = 3_000_000_000;
    let seed = 0;
    for (; seed < 1000; seed++) {
      if (new Rng(seed).next() >= limit) break;
    }
    expect(seed).toBeLessThan(1000);

    const probe = new Rng(seed);
    const rejected = probe.next();
    expect(rejected).toBeGreaterThanOrEqual(limit);
    const accepted = probe.next();
    expect(accepted).toBeLessThan(limit);

    const rng = new Rng(seed);
    expect(rng.int(n)).toBe(accepted % n);
    // It consumed exactly the rejected draw and the accepted draw.
    expect(rng.state).toEqual(probe.state);
  });

  it("consumes one draw per call when nothing is rejected", () => {
    const a = new Rng(5);
    const b = new Rng(5);
    a.int(8);
    b.next();
    expect(a.state).toEqual(b.state);
  });

  it("throws RangeError for 0, negatives, non-integers, and bounds beyond one 32-bit draw", () => {
    const rng = new Rng(1);
    const before = rng.state;
    for (const bad of [0, -1, -10, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 32 + 1]) {
      expect(() => rng.int(bad)).toThrow(RangeError);
    }
    expect(rng.state).toEqual(before);
  });
});

describe("Rng.chance", () => {
  it("never succeeds at 0/den and always succeeds at den/den", () => {
    const rng = new Rng(21);
    for (let i = 0; i < 500; i++) {
      expect(rng.chance(0, 7)).toBe(false);
      expect(rng.chance(7, 7)).toBe(true);
    }
  });

  it("succeeds about num/den of the time", () => {
    const rng = new Rng(21);
    let hits = 0;
    for (let i = 0; i < 10_000; i++) if (rng.chance(1, 4)) hits++;
    // Expected 2500, sd about 43.
    expect(hits).toBeGreaterThan(2250);
    expect(hits).toBeLessThan(2750);
  });

  it("consumes exactly one draw whatever the outcome", () => {
    const a = new Rng(8);
    const b = new Rng(8);
    a.chance(0, 5);
    a.chance(5, 5);
    a.chance(2, 5);
    b.next();
    b.next();
    b.next();
    expect(a.state).toEqual(b.state);
  });

  it("throws RangeError for a bad denominator or a numerator outside 0..den", () => {
    const rng = new Rng(1);
    expect(() => rng.chance(1, 0)).toThrow(RangeError);
    expect(() => rng.chance(1, -2)).toThrow(RangeError);
    expect(() => rng.chance(1, 2.5)).toThrow(RangeError);
    expect(() => rng.chance(-1, 4)).toThrow(RangeError);
    expect(() => rng.chance(5, 4)).toThrow(RangeError);
    expect(() => rng.chance(0.5, 4)).toThrow(RangeError);
    expect(() => rng.chance(Number.NaN, 4)).toThrow(RangeError);
  });
});

describe("Rng.fork", () => {
  it('produces a pinned sequence for Rng(42).fork("guests")', () => {
    // Recorded once and pinned, like the seed 42 triple: fork derivation must never change.
    expect(draw(new Rng(42).fork("guests"), 3)).toEqual([273206507, 895991688, 3783329532]);
  });

  it("gives different streams for different labels", () => {
    const parent = new Rng(42);
    expect(draw(parent.fork("guests"), 16)).not.toEqual(draw(parent.fork("rides"), 16));
  });

  it("is reproducible for the same parent state and label", () => {
    expect(draw(new Rng(42).fork("guests"), 100)).toEqual(draw(new Rng(42).fork("guests"), 100));
    const parent = new Rng(42);
    expect(draw(parent.fork("guests"), 100)).toEqual(draw(parent.fork("guests"), 100));
  });

  it("does not advance the parent", () => {
    const parent = new Rng(42);
    draw(parent, 5);
    const before = parent.state;
    parent.fork("guests");
    parent.fork("rides");
    expect(parent.state).toEqual(before);
    const control = new Rng(42);
    draw(control, 5);
    expect(draw(parent, 100)).toEqual(draw(control, 100));
  });

  it("differs from the parent stream and from forks of other parents", () => {
    const parent = new Rng(42);
    expect(draw(parent.fork("guests"), 16)).not.toEqual(draw(new Rng(42), 16));
    expect(draw(new Rng(1).fork("guests"), 16)).not.toEqual(draw(new Rng(2).fork("guests"), 16));
  });

  it("depends on every character of the label", () => {
    const parent = new Rng(42);
    const streams = ["", "a", "b", "ab", "ba", "guests", "guest", "guests "].map((label) =>
      draw(parent.fork(label), 4).join(","),
    );
    expect(new Set(streams).size).toBe(streams.length);
  });

  it("returns a valid generator that can itself be forked", () => {
    const child = new Rng(42).fork("park");
    const grandchild = child.fork("guests");
    expect(draw(grandchild, 8)).not.toEqual(draw(child.fork("rides"), 8));
    expect(Rng.fromState(child.state).next()).toBe(child.next());
  });
});
