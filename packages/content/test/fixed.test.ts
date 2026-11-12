import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sinTableEntry } from "../scripts/gen-sin-table.js";
import { SIN_TABLE } from "../src/sin-table.js";
import {
  QUARTER_TURN,
  TRIG_ONE,
  TURN,
  divRound,
  iatan2,
  icos,
  isin,
  isqrt,
  mod,
} from "../src/index.js";

describe("sine table", () => {
  it("is exact at the quarter turns", () => {
    expect(isin(0)).toBe(0);
    expect(isin(1024)).toBe(TRIG_ONE);
    expect(isin(2048)).toBe(0);
    expect(isin(3072)).toBe(-TRIG_ONE);
    expect(icos(0)).toBe(TRIG_ONE);
    expect(icos(1024)).toBe(0);
    expect(icos(2048)).toBe(-TRIG_ONE);
    expect(icos(3072)).toBe(0);
    expect(isin(512)).toBe(11585); // round(2^14 / sqrt 2)
    expect(icos(512)).toBe(11585);
  });

  it("matches the generator's formula entry for entry", () => {
    expect(SIN_TABLE.length).toBe(QUARTER_TURN + 1);
    for (let i = 0; i <= QUARTER_TURN; i++)
      expect(SIN_TABLE[i], `entry ${i}`).toBe(sinTableEntry(i));
  });

  it("rises strictly through the quarter wave", () => {
    for (let i = 1; i <= QUARTER_TURN; i++) {
      expect(SIN_TABLE[i]!).toBeGreaterThanOrEqual(SIN_TABLE[i - 1]!);
    }
    expect(SIN_TABLE[1]!).toBeGreaterThan(0);
  });

  it("is symmetric over the whole turn and periodic", () => {
    for (let a = -TURN; a <= 2 * TURN; a++) {
      expect(isin(-a) + isin(a), `${a}`).toBe(0);
      expect(Object.is(isin(a), -0), `${a}`).toBe(false);
      expect(isin(2048 - a), `${a}`).toBe(isin(a));
      expect(isin(a + TURN), `${a}`).toBe(isin(a));
      expect(icos(a), `${a}`).toBe(isin(a + 1024));
      expect(icos(-a), `${a}`).toBe(icos(a));
      expect(Number.isInteger(isin(a))).toBe(true);
    }
  });

  it("keeps sin^2 + cos^2 within rounding of one", () => {
    for (let a = 0; a < TURN; a++) {
      const sum = isin(a) * isin(a) + icos(a) * icos(a);
      expect(Math.abs(sum - TRIG_ONE * TRIG_ONE)).toBeLessThanOrEqual(2 * TRIG_ONE);
    }
  });
});

describe("iatan2", () => {
  it("is exact on the axes and diagonals", () => {
    expect(iatan2(0, 0)).toBe(0);
    expect(iatan2(0, 5)).toBe(0);
    expect(iatan2(5, 5)).toBe(512);
    expect(iatan2(5, 0)).toBe(1024);
    expect(iatan2(5, -5)).toBe(1536);
    expect(iatan2(0, -5)).toBe(2048);
    expect(iatan2(-5, -5)).toBe(-1536);
    expect(iatan2(-5, 0)).toBe(-1024);
    expect(iatan2(-5, 5)).toBe(-512);
  });

  it("inverts the table at every angle", () => {
    for (let a = -2047; a <= 2048; a++) {
      expect(iatan2(isin(a) * 7, icos(a) * 7), `${a}`).toBe(a);
    }
  });

  it("is the table angle nearest the true angle", () => {
    for (const [y, x] of [
      [1, 2],
      [3, 1000],
      [999, 1],
      [-7, 3],
      [123456, -654321],
    ] as const) {
      const want = Math.round((Math.atan2(y, x) / (2 * Math.PI)) * TURN);
      expect(Math.abs(iatan2(y, x) - want), `${y}, ${x}`).toBeLessThanOrEqual(1);
    }
  });

  it("refuses non-integers and out-of-range values", () => {
    expect(() => iatan2(0.5, 1)).toThrow(RangeError);
    expect(() => iatan2(1, 2 ** 40)).toThrow(RangeError);
  });
});

describe("integer helpers", () => {
  it("rounds, wraps and roots exactly", () => {
    expect(divRound(7, 2)).toBe(4);
    expect(divRound(-7, 2)).toBe(-3);
    expect(divRound(10, 4)).toBe(3);
    expect(divRound(-10, 4)).toBe(-2);
    expect(divRound(9, 3)).toBe(3);
    expect(mod(-1, 4)).toBe(3);
    expect(Object.is(mod(-8, 4), 0)).toBe(true);
    expect(mod(9, 4)).toBe(1);
    for (let n = 0; n < 5000; n++) {
      const r = isqrt(n);
      expect(r * r <= n && (r + 1) * (r + 1) > n, `${n}`).toBe(true);
    }
    expect(isqrt(2 ** 50)).toBe(2 ** 25);
  });
});

describe("determinism lint for content", () => {
  // The same rule as packages/sim/test/lint-determinism.test.ts: the sim reads content, so
  // content code must not use engine-dependent math either.
  const FORBIDDEN =
    /\bMath\.(random|sin|cos|tan|asin|acos|atan2?|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot)\b|\*\*|\bDate\s*\(|\bnew Date\b|\bDate\.now\b|performance\.now/g;
  const dir = fileURLToPath(new URL("../src", import.meta.url));

  it("finds no engine-dependent math in packages/content/src", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const code = readFileSync(join(dir, file), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
      expect(
        [...code.matchAll(FORBIDDEN)].map((m) => m[0]),
        file,
      ).toEqual([]);
    }
  });
});
