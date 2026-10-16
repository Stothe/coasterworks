import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Sources that would make the simulation depend on the host, the clock, or the math library.
 * `Math.sqrt`, `floor`, `round`, `min`, `max`, `abs`, `imul`, `trunc`, and `sign` are exactly
 * specified by ECMAScript, so they are allowed; the rest of `Math` may differ between engines, or
 * between versions of one engine. `Date.now` is listed on its own because `\bDate\s*\(` needs a
 * parenthesis right after the name.
 */
const FORBIDDEN =
  /\bMath\.(random|sin|cos|tan|asin|acos|atan2?|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot)\b|\bDate\s*\(|\bnew Date\b|\bDate\.now\b|performance\.now/g;

/** Files exempt from the lint, as paths relative to `src` with forward slashes. */
const EXEMPT = new Set(["hash.ts"]);

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

function listTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files.sort();
}

/** Every forbidden source in `source`, as the text that matched. */
function findViolations(source: string): string[] {
  return [...source.matchAll(FORBIDDEN)].map((match) => match[0]);
}

describe("determinism lint", () => {
  it.each([
    ["Math.random()", "Math.random"],
    ["Math.sin(x)", "Math.sin"],
    ["Math.cos(x)", "Math.cos"],
    ["Math.tan(x)", "Math.tan"],
    ["Math.asin(x)", "Math.asin"],
    ["Math.acos(x)", "Math.acos"],
    ["Math.atan(x)", "Math.atan"],
    ["Math.atan2(y, x)", "Math.atan2"],
    ["Math.sinh(x)", "Math.sinh"],
    ["Math.cosh(x)", "Math.cosh"],
    ["Math.tanh(x)", "Math.tanh"],
    ["Math.asinh(x)", "Math.asinh"],
    ["Math.acosh(x)", "Math.acosh"],
    ["Math.atanh(x)", "Math.atanh"],
    ["Math.exp(x)", "Math.exp"],
    ["Math.expm1(x)", "Math.expm1"],
    ["Math.log(x)", "Math.log"],
    ["Math.log1p(x)", "Math.log1p"],
    ["Math.log2(x)", "Math.log2"],
    ["Math.log10(x)", "Math.log10"],
    ["Math.pow(2, n)", "Math.pow"],
    ["Math.cbrt(x)", "Math.cbrt"],
    ["Math.hypot(a, b)", "Math.hypot"],
    ["new Date()", "new Date"],
    ["new Date(0)", "new Date"],
    ["Date()", "Date("],
    ["Date ()", "Date ("],
    ["Date.now()", "Date.now"],
    ["performance.now()", "performance.now"],
  ])("flags %s", (call, match) => {
    expect(findViolations(`const x = ${call};`)).toEqual([match]);
  });

  it("reports every occurrence in a source, in order", () => {
    expect(findViolations("a = Math.pow(2, 3) + Math.sin(1);\nb = Date();")).toEqual([
      "Math.pow",
      "Math.sin",
      "Date(",
    ]);
  });

  it.each([
    "Math.sqrt(x)",
    "Math.floor(x)",
    "Math.round(x)",
    "Math.min(a, b)",
    "Math.max(a, b)",
    "Math.abs(x)",
    "Math.imul(a, b) >>> 0",
    "Math.trunc(x)",
    "Math.sign(x)",
    // Names that only contain a forbidden one, and `Date` used as a type or a prefix.
    "Math.powerOf(x)",
    "Math.logical(x)",
    "const d: Date | undefined = undefined",
    "updateDate(x)",
    "formatDate(dateOf(tick))",
    "isDate(x)",
    "newDate(x)",
    "performance.mark('x')",
  ])("allows %s", (source) => {
    expect(findViolations(`const x = ${source};`)).toEqual([]);
  });

  it("scans the real source tree", () => {
    const names = listTypeScriptFiles(SRC_DIR).map((f) =>
      relative(SRC_DIR, f).split(sep).join("/"),
    );
    expect(names).toContain("index.ts");
    expect(names).toContain("rng.ts");
    expect(names).toContain("hash.ts");
  });

  it("finds no forbidden calls in packages/sim/src (hash.ts excepted)", () => {
    const violations: string[] = [];
    for (const file of listTypeScriptFiles(SRC_DIR)) {
      const name = relative(SRC_DIR, file).split(sep).join("/");
      if (EXEMPT.has(name)) continue;
      for (const match of findViolations(readFileSync(file, "utf8"))) {
        violations.push(`${name}: ${match}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
