import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { crc32 } from "../src/save/crc32.js";

describe("crc32", () => {
  it("is 0 for no bytes", () => {
    expect(crc32(new Uint8Array([]))).toBe(0);
  });

  it("matches the standard check value for '123456789'", () => {
    expect(crc32(strToU8("123456789"))).toBe(0xcbf43926);
  });

  it("matches the known value for the quick brown fox", () => {
    expect(crc32(strToU8("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });

  it("returns an unsigned 32-bit number, even when the top bit is set", () => {
    const value = crc32(strToU8("123456789"));
    expect(value).toBeGreaterThan(0x7fffffff);
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBe(value >>> 0);
  });

  it("covers every byte value, and sees a change in any one byte", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const base = crc32(all);
    for (let i = 0; i < all.length; i++) {
      const changed = Uint8Array.from(all);
      changed[i] = (changed[i] as number) ^ 1;
      expect(crc32(changed), `byte ${i}`).not.toBe(base);
    }
  });

  it("reads only the bytes of a subarray view, not the buffer behind it", () => {
    const backing = strToU8("xx123456789yy");
    expect(crc32(backing.subarray(2, 11))).toBe(0xcbf43926);
  });
});
