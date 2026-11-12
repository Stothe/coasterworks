import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

// Look development leaves switches behind that change what players see: a shader painting shadows
// red, URL parameters that turn passes off, a global holding the renderer. None of them may ship.
describe("the renderer's sources", () => {
  const files = sources(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

  it("hold no debugging leftovers", () => {
    const found: string[] = [];
    for (const { path, text } of files) {
      text.split("\n").forEach((line, i) => {
        if (
          /\bDEBUG\b|DEBUG-TEMP|console\.(log|debug)\(|globalThis as Record<string, unknown>\)\.__/.test(
            line,
          )
        )
          found.push(`${path.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("read nothing from the page's address", () => {
    const found = files
      .filter(({ text }) => /location\??\.search|URLSearchParams/.test(text))
      .map(({ path }) => path.slice(SRC.length + 1));
    expect(found).toEqual([]);
  });
});
