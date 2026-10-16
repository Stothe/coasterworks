import { describe, expect, it } from "vitest";
import { fnv1a64, hashString, hexHash } from "../src/index.js";

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;

describe("fnv1a64", () => {
  it("returns the FNV offset basis for empty input", () => {
    expect(fnv1a64(new Uint8Array([]))).toBe(FNV_OFFSET_BASIS);
  });

  it("matches published FNV-1a 64 test vectors", () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(fnv1a64(bytes("a"))).toBe(0xaf63dc4c8601ec8cn);
    expect(fnv1a64(bytes("foobar"))).toBe(0x85944171f73967e8n);
  });

  it("can continue a hash by passing the previous result as the seed", () => {
    const whole = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const chained = fnv1a64(whole.subarray(3), fnv1a64(whole.subarray(0, 3)));
    expect(chained).toBe(fnv1a64(whole));
  });

  it("uses the offset basis when no seed is given", () => {
    const data = new Uint8Array([9, 8, 7]);
    expect(fnv1a64(data)).toBe(fnv1a64(data, FNV_OFFSET_BASIS));
  });

  it("gives different results for different seeds and different bytes", () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(fnv1a64(data, 1n)).not.toBe(fnv1a64(data, 2n));
    expect(fnv1a64(new Uint8Array([1, 2, 3]))).not.toBe(fnv1a64(new Uint8Array([3, 2, 1])));
  });

  it("stays within 64 bits", () => {
    const big = new Uint8Array(4096).map((_, i) => (i * 31) & 0xff);
    const h = fnv1a64(big);
    expect(h).toBeGreaterThanOrEqual(0n);
    expect(h).toBeLessThan(1n << 64n);
  });
});

describe("hashString", () => {
  it('hashes "a" to the published FNV-1a 64 value', () => {
    expect(hashString("a")).toBe(0xaf63dc4c8601ec8cn);
  });

  it("hashes the empty string to the offset basis", () => {
    expect(hashString("")).toBe(FNV_OFFSET_BASIS);
  });

  it("hashes the UTF-8 encoding of the string, as TextEncoder produces it", () => {
    const samples = [
      "guests",
      "naïve café",
      "日本語のラベル",
      "ride 🎢 queue",
      "\u0000\u007f\u0080߿ࠀ￿",
      "lone high \ud800 surrogate",
      "lone low \udc00 surrogate",
      "swapped \udc00\ud800 pair",
      "trailing high \ud83d",
    ];
    for (const sample of samples) {
      expect(hashString(sample)).toBe(fnv1a64(new TextEncoder().encode(sample)));
    }
  });

  it("distinguishes similar strings", () => {
    expect(hashString("guests")).not.toBe(hashString("guest"));
    expect(hashString("ab")).not.toBe(hashString("ba"));
  });
});

describe("hexHash", () => {
  it("pads to 16 lowercase hex characters", () => {
    expect(hexHash(0n)).toBe("0000000000000000");
    expect(hexHash(0xabcn)).toBe("0000000000000abc");
    expect(hexHash(0xaf63dc4c8601ec8cn)).toBe("af63dc4c8601ec8c");
    expect(hexHash(0xffffffffffffffffn)).toBe("ffffffffffffffff");
  });

  it("always returns 16 characters for a real hash", () => {
    expect(hexHash(hashString("a"))).toHaveLength(16);
    expect(hexHash(fnv1a64(new Uint8Array([])))).toBe("cbf29ce484222325");
  });

  it("throws RangeError for values outside 64 bits", () => {
    expect(() => hexHash(-1n)).toThrow(RangeError);
    expect(() => hexHash(1n << 64n)).toThrow(RangeError);
  });
});
