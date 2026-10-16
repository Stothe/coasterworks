import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Sources that would make the simulation depend on the host, the clock, or libm. */
const FORBIDDEN = [
  "Math.random",
  "Math.sin",
  "Math.cos",
  "Math.tan",
  "Date.now",
  "performance.now",
  "new Date(",
] as const;

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

function findViolations(source: string): string[] {
  return FORBIDDEN.filter((token) => source.includes(token));
}

describe("determinism lint", () => {
  it("detects every forbidden call in a source string", () => {
    for (const token of FORBIDDEN) {
      expect(findViolations(`const x = ${token};`)).toEqual([token]);
    }
    expect(findViolations("const x = Math.imul(a, b) >>> 0;")).toEqual([]);
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
      for (const token of findViolations(readFileSync(file, "utf8"))) {
        violations.push(`${name}: ${token}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
