import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorld, hashWorld } from "@coasterworks/sim";
import { main, type CliIO } from "../src/index.js";
import { readPark, writePark } from "../src/io.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "coasterworks-cli-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `main` in-process with captured output. */
async function cli(...argv: string[]): Promise<Outcome> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
  const code = await main(argv, io);
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/** Parses stdout, which must be exactly one JSON value on one line. */
function parseOut(outcome: Outcome): any {
  expect(outcome.stdout.endsWith("\n")).toBe(true);
  expect(outcome.stdout.trimEnd()).not.toContain("\n");
  return JSON.parse(outcome.stdout);
}

/** Makes a small park in the temp dir and returns its path. */
async function makePark(name = "a.park"): Promise<string> {
  const file = join(dir, name);
  const made = await cli("new", "--out", file, "--width", "16", "--height", "16", "--seed", "1");
  expect(made.code).toBe(0);
  return file;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("new", () => {
  it("writes a park that inspect reads back", async () => {
    const file = join(dir, "t.park");
    const made = await cli(
      ...["new", "--out", file, "--width", "16", "--height", "12", "--seed", "7"],
      ...["--name", "Test Park"],
    );
    expect(made.code).toBe(0);
    expect(made.stderr).toBe("");
    expect(parseOut(made)).toMatchObject({
      name: "Test Park",
      width: 16,
      height: 12,
      date: "March 1, Year 1",
      cash: 10_000_00,
    });

    const inspected = await cli("inspect", file);
    expect(inspected.code).toBe(0);
    const { status, log } = parseOut(inspected);
    expect(status.date).toBe("March 1, Year 1");
    expect(status.name).toBe("Test Park");
    expect(log).toEqual([]);

    const world = await readPark(file);
    expect(world.meta.seed).toBe(7);
    expect(Number.isNaN(Date.parse(world.meta.created))).toBe(false);
  });

  it("defaults to a 64 by 64 park called New Park, and creates the parent directory", async () => {
    const file = join(dir, "nested", "deeper", "d.park");
    const made = await cli("new", "--out", file);
    expect(made.code).toBe(0);
    expect(parseOut(made)).toMatchObject({ name: "New Park", width: 64, height: 64 });
    expect(await exists(file)).toBe(true);
    expect((await readPark(file)).meta.seed).toBeTypeOf("number");
  });

  it.each([
    ["--width", "0", "--width must be an integer from 1 to 256"],
    ["--width", "257", "--width must be an integer from 1 to 256"],
    ["--width", "1.5", "--width must be an integer from 1 to 256"],
    ["--height", "abc", "--height must be an integer from 1 to 256"],
    ["--height", "", "--height must be an integer from 1 to 256"],
    ["--seed", "1.5", "--seed must be an integer"],
    ["--seed", "x", "--seed must be an integer"],
  ])("rejects %s %j with exit 1 and writes nothing", async (flag, value, message) => {
    const file = join(dir, "bad.park");
    const made = await cli("new", "--out", file, flag, value);
    expect(made.code).toBe(1);
    expect(made.stdout).toBe("");
    expect(made.stderr).toMatch(new RegExp(`^error: ${message}`));
    expect(made.stderr).not.toContain("Usage:");
    expect(await exists(file)).toBe(false);
  });

  it("is a usage error without --out", async () => {
    const made = await cli("new", "--width", "8");
    expect(made.code).toBe(2);
    expect(made.stdout).toBe("");
    expect(made.stderr).toMatch(/^error: missing required option --out/);
    expect(made.stderr).toContain("Usage:");
  });
});

describe("exec", () => {
  const raise = JSON.stringify({ x: 0, y: 0, w: 2, h: 2 });

  it("runs a command as agent, prints the result, and writes --out", async () => {
    const file = await makePark();
    const out = join(dir, "after.park");
    const done = await cli(
      ...["exec", "--save", file, "--command", "terrain_raise", "--input", raise],
      ...["--out", out],
    );
    expect(done.code).toBe(0);
    expect(done.stderr).toBe("");
    // 2x2 tiles touch 3x3 = 9 corners, $50 each.
    expect(parseOut(done)).toEqual({ ok: true, id: 1, cost: 45_000 });

    const { status, log } = parseOut(await cli("inspect", out));
    expect(status.cash).toBe(10_000_00 - 45_000);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ name: "terrain_raise", client: "agent", cost: 45_000 });
  });

  it("leaves the save alone when --out is not given", async () => {
    const file = await makePark();
    const before = await readFile(file);
    const done = await cli("exec", "--save", file, "--command", "terrain_raise", "--input", raise);
    expect(done.code).toBe(0);
    expect(parseOut(done).ok).toBe(true);
    expect(Buffer.compare(await readFile(file), before)).toBe(0);
  });

  it("can write over the save it read", async () => {
    const file = await makePark();
    const args = ["exec", "--save", file, "--command", "terrain_raise", "--input", raise];
    expect((await cli(...args, "--out", file)).code).toBe(0);
    expect(parseOut(await cli("inspect", file)).status.cash).toBe(10_000_00 - 45_000);
  });

  it("exits 1 and prints the error result when the input is bad", async () => {
    const file = await makePark();
    const out = join(dir, "never.park");
    const done = await cli(
      ...["exec", "--save", file, "--command", "terrain_raise", "--input", '{"x":0}'],
      ...["--out", out],
    );
    expect(done.code).toBe(1);
    const result = parseOut(done);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTypeOf("string");
    expect(done.stderr).toBe(`error: ${result.error}\n`);
    expect(await exists(out)).toBe(false);
  });

  it("exits 1 when the sim refuses the command", async () => {
    const file = await makePark();
    const outside = JSON.stringify({ x: 0, y: 0, w: 99, h: 99 });
    const done = await cli(
      "exec",
      "--save",
      file,
      "--command",
      "terrain_raise",
      "--input",
      outside,
    );
    expect(done.code).toBe(1);
    expect(parseOut(done)).toEqual({ ok: false, error: "Area is outside the park" });
  });

  it("exits 1 for an unknown command", async () => {
    const file = await makePark();
    const done = await cli("exec", "--save", file, "--command", "nope");
    expect(done.code).toBe(1);
    expect(parseOut(done)).toEqual({ ok: false, error: "Unknown command: nope" });
    expect(done.stderr).toBe("error: Unknown command: nope\n");
  });

  it("passes {} when --input is omitted", async () => {
    const file = await makePark();
    const done = await cli("exec", "--save", file, "--command", "terrain_raise");
    expect(done.code).toBe(1);
    expect(parseOut(done).ok).toBe(false);
    expect(done.stderr).not.toContain("JSON");
  });

  it("exits 1 with a clear message when --input is not JSON", async () => {
    const file = await makePark();
    const done = await cli("exec", "--save", file, "--command", "terrain_raise", "--input", "{x");
    expect(done.code).toBe(1);
    expect(done.stdout).toBe("");
    expect(done.stderr).toBe("error: --input is not valid JSON\n");
  });

  it("is a usage error without --save or --command", async () => {
    const noSave = await cli("exec", "--command", "terrain_raise");
    expect(noSave.code).toBe(2);
    expect(noSave.stderr).toMatch(/^error: missing required option --save/);
    const noCommand = await cli("exec", "--save", join(dir, "x.park"));
    expect(noCommand.code).toBe(2);
    expect(noCommand.stderr).toMatch(/^error: missing required option --command/);
  });
});

describe("run", () => {
  it("advances 31 days into April and prints the status", async () => {
    const file = await makePark();
    const done = await cli("run", "--save", file, "--days", "31");
    expect(done.code).toBe(0);
    expect(done.stderr).toBe("");
    expect(parseOut(done)).toMatchObject({ date: "April 1, Year 1", tick: 31 * 400 });
  });

  it("writes --out, and the log records the advance", async () => {
    const file = await makePark();
    const out = join(dir, "later.park");
    expect((await cli("run", "--save", file, "--days", "31", "--out", out)).code).toBe(0);

    const { status, log } = parseOut(await cli("inspect", out));
    expect(status.date).toBe("April 1, Year 1");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ name: "sim_advance", client: "system", input: { days: 31 } });

    // The source save is untouched.
    expect(parseOut(await cli("inspect", file)).status.date).toBe("March 1, Year 1");
  });

  it.each(["0", "3651", "1.5", "abc"])("rejects --days %s with exit 1", async (days) => {
    const file = await makePark();
    const done = await cli("run", "--save", file, "--days", days);
    expect(done.code).toBe(1);
    expect(done.stdout).toBe("");
    expect(done.stderr).toMatch(/^error: --days must be an integer from 1 to 3650/);
  });

  it("accepts the largest span", async () => {
    const file = await makePark();
    expect((await cli("run", "--save", file, "--days", "3650")).code).toBe(0);
  });

  it("is a usage error without --save or --days", async () => {
    const noDays = await cli("run", "--save", join(dir, "x.park"));
    expect(noDays.code).toBe(2);
    expect(noDays.stderr).toMatch(/^error: missing required option --days/);
    const noSave = await cli("run", "--days", "3");
    expect(noSave.code).toBe(2);
    expect(noSave.stderr).toMatch(/^error: missing required option --save/);
  });
});

describe("inspect", () => {
  it("prints the status and the 20 most recent log entries, newest first", async () => {
    let file = await makePark();
    for (let i = 0; i < 22; i++) {
      const next = join(dir, `step-${i}.park`);
      const done = await cli(
        ...["exec", "--save", file, "--command", "terrain_raise"],
        ...["--input", JSON.stringify({ x: i % 16, y: 0, w: 1, h: 1 }), "--out", next],
      );
      expect(done.code).toBe(0);
      file = next;
    }
    const { status, log } = parseOut(await cli("inspect", file));
    expect(status.cash).toBe(10_000_00 - 22 * 4 * 50_00);
    expect(log).toHaveLength(20);
    expect(log[0].id).toBe(22);
    expect(log[19].id).toBe(3);
  });

  it("exits 1 when the file is missing", async () => {
    const file = join(dir, "missing.park");
    const done = await cli("inspect", file);
    expect(done.code).toBe(1);
    expect(done.stdout).toBe("");
    expect(done.stderr).toMatch(new RegExp(`^error: Cannot read park file ${file}: .+\n$`));
  });

  it("exits 1 when the file is not a park", async () => {
    const file = join(dir, "junk.park");
    await writeFile(file, "this is not a save");
    const done = await cli("inspect", file);
    expect(done.code).toBe(1);
    expect(done.stderr).toMatch(new RegExp(`^error: Cannot read park file ${file}: .+\n$`));
  });

  it("is a usage error unless given exactly one file", async () => {
    expect((await cli("inspect")).code).toBe(2);
    const many = await cli("inspect", "a.park", "b.park");
    expect(many.code).toBe(2);
    expect(many.stderr).toContain("Usage:");
  });
});

describe("usage", () => {
  it("prints usage to stderr and exits 2 for an unknown subcommand", async () => {
    const done = await cli("frobnicate");
    expect(done.code).toBe(2);
    expect(done.stdout).toBe("");
    expect(done.stderr).toMatch(/^error: unknown subcommand: frobnicate\n/);
    expect(done.stderr).toContain("Usage:");
  });

  it("does not mistake an Object.prototype name for a subcommand", async () => {
    expect((await cli("constructor")).code).toBe(2);
    expect((await cli("toString")).code).toBe(2);
  });

  it("prints usage and exits 2 with no subcommand", async () => {
    const done = await cli();
    expect(done.code).toBe(2);
    expect(done.stdout).toBe("");
    expect(done.stderr).toContain("Usage:");
  });

  it("exits 2 for an unknown option or a missing option value", async () => {
    const unknown = await cli("new", "--out", join(dir, "u.park"), "--bogus", "1");
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/^error: .*--bogus/);
    expect(unknown.stderr).toContain("Usage:");
    const noValue = await cli("new", "--out");
    expect(noValue.code).toBe(2);
    expect(noValue.stderr).toContain("Usage:");
  });

  it("reserves mcp for a later task", async () => {
    const done = await cli("mcp", "--save", join(dir, "m.park"));
    expect(done.code).toBe(1);
    expect(done.stdout).toBe("");
    expect(done.stderr).toBe("error: mcp is not available yet\n");
  });
});

describe("park files", () => {
  it("writePark creates the parent directory and readPark round-trips the world", async () => {
    const world = createWorld({ width: 4, height: 4, seed: 3, name: "RT" });
    const file = join(dir, "x", "y", "rt.park");
    await writePark(file, world);
    expect(hashWorld(await readPark(file))).toBe(hashWorld(world));
  });

  it("readPark names the file when it is missing or damaged", async () => {
    const missing = join(dir, "nope.park");
    await expect(readPark(missing)).rejects.toThrow(`Cannot read park file ${missing}: `);
    const junk = join(dir, "junk.park");
    await writeFile(junk, "junk");
    await expect(readPark(junk)).rejects.toThrow(`Cannot read park file ${junk}: `);
  });
});

describe("bin", () => {
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

  function spawnBin(entry: string, ...args: string[]) {
    return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8" });
  }

  it("runs when executed directly", (ctx) => {
    if (!existsSync(dist)) ctx.skip(`${dist} is missing; run \`pnpm build\` to enable this test`);
    const file = join(dir, "bin.park");
    const made = spawnBin(dist, "new", "--out", file);
    expect(made.status).toBe(0);
    expect(JSON.parse(made.stdout)).toMatchObject({ name: "New Park", date: "March 1, Year 1" });
    expect(existsSync(file)).toBe(true);

    const bad = spawnBin(dist, "nope");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("Usage:");
  });

  it("runs when started through a symlink, as an installed bin is", async (ctx) => {
    if (!existsSync(dist)) ctx.skip(`${dist} is missing; run \`pnpm build\` to enable this test`);
    await mkdir(join(dir, "bin"));
    const link = join(dir, "bin", "coasterworks");
    await symlink(dist, link);
    const file = join(dir, "linked.park");
    const made = spawnBin(link, "new", "--out", file);
    expect(made.status).toBe(0);
    expect(JSON.parse(made.stdout).name).toBe("New Park");
  });
});
