import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
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

  it("lists mcp, and says that run and exec leave the save alone without --out", async () => {
    const done = await cli("frobnicate");
    expect(done.stderr).toContain(
      "  mcp      --save <file> [--out <file>] [--http <port> --token <token>]",
    );
    expect(done.stderr).toContain("Without --out, run and exec do not modify the save.");
  });
});

describe("mcp usage", () => {
  it("is a usage error without --save", async () => {
    const done = await cli("mcp");
    expect(done.code).toBe(2);
    expect(done.stdout).toBe("");
    expect(done.stderr).toMatch(/^error: missing required option --save/);
    expect(done.stderr).toContain("Usage:");
  });

  it("is a usage error to give --http without --token, and writes nothing", async () => {
    const file = await makePark();
    const out = join(dir, "never.park");
    const done = await cli("mcp", "--save", file, "--http", "0", "--out", out);
    expect(done.code).toBe(2);
    expect(done.stdout).toBe("");
    expect(done.stderr).toMatch(/^error: --http needs --token/);
    expect(done.stderr).toContain("Usage:");
    expect(await exists(out)).toBe(false);
  });

  it("is a usage error to give --token without --http, or an empty --token", async () => {
    const file = await makePark();
    const noHttp = await cli("mcp", "--save", file, "--token", "t");
    expect(noHttp.code).toBe(2);
    expect(noHttp.stderr).toMatch(/^error: --token needs --http/);
    const empty = await cli("mcp", "--save", file, "--http", "0", "--token", "");
    expect(empty.code).toBe(2);
    expect(empty.stderr).toMatch(/^error: --token must not be empty/);
  });

  it("is a usage error for an unknown option or a stray argument", async () => {
    const file = await makePark();
    expect((await cli("mcp", "--save", file, "--bogus")).code).toBe(2);
    expect((await cli("mcp", "--save", file, "extra")).code).toBe(2);
  });

  it.each(["abc", "1.5", "70000", "65536"])("rejects --http %s with exit 1", async (port) => {
    const file = await makePark();
    const done = await cli("mcp", "--save", file, "--http", port, "--token", "t");
    expect(done.code).toBe(1);
    expect(done.stdout).toBe("");
    expect(done.stderr).toMatch(/^error: --http must be an integer from 0 to 65535/);
  });

  it("exits 1 when the park cannot be read", async () => {
    const missing = join(dir, "missing.park");
    const done = await cli("mcp", "--save", missing, "--http", "0", "--token", "t");
    expect(done.code).toBe(1);
    expect(done.stdout).toBe("");
    expect(done.stderr).toMatch(new RegExp(`^error: Cannot read park file ${missing}: `));
  });
});

/** Starts `mcp --http 0` in the background; `stop` aborts it, as SIGINT does, and waits for exit. */
async function startHttp(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const abort = new AbortController();
  let listening: (line: string) => void = () => {};
  const firstLine = new Promise<string>((resolve) => (listening = resolve));
  const io: CliIO = {
    stdout: (s) => {
      out.push(s);
      listening(out.join(""));
    },
    stderr: (s) => err.push(s),
    signal: abort.signal,
  };
  const done = main(["mcp", ...args], io);
  const printed = await Promise.race([
    firstLine,
    done.then((code) => {
      throw new Error(`mcp exited with ${code} before listening: ${err.join("")}`);
    }),
  ]);
  const info = JSON.parse(printed) as { url: string; port: number };
  return {
    info,
    async stop(): Promise<Outcome> {
      abort.abort();
      const code = await done;
      return { code, stdout: out.join(""), stderr: err.join("") };
    },
  };
}

async function httpClient(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  // The cast is for the SDK's optional `sessionId` against `exactOptionalPropertyTypes`.
  await client.connect(transport as Transport);
  return client;
}

describe("mcp over HTTP", () => {
  const raise = { x: 0, y: 0, w: 2, h: 2 };

  it("prints its url as one line of JSON, lists the tools over HTTP, and stops on abort", async () => {
    const file = await makePark();
    const server = await startHttp("--save", file, "--http", "0", "--token", "tok");
    expect(server.info.port).toBeGreaterThan(0);
    expect(server.info.url).toBe(`http://127.0.0.1:${server.info.port}/mcp`);

    const client = await httpClient(server.info.url, "tok");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["terrain_raise", "park_status", "undo", "save_write", "save_load"]),
    );
    await client.close();

    const stopped = await server.stop();
    expect(stopped.code).toBe(0);
    expect(stopped.stderr).toBe("");
    expect(stopped.stdout).toBe(`${JSON.stringify(server.info)}\n`);
  });

  it("turns away a client with the wrong token", async () => {
    const file = await makePark();
    const server = await startHttp("--save", file, "--http", "0", "--token", "tok");
    await expect(httpClient(server.info.url, "nope")).rejects.toThrow();
    expect((await server.stop()).code).toBe(0);
  });

  it("writes --out after each command and on stop, and leaves --save alone", async () => {
    const file = await makePark();
    const before = await readFile(file);
    const out = join(dir, "served.park");
    const server = await startHttp("--save", file, "--out", out, "--http", "0", "--token", "tok");
    expect(await exists(out)).toBe(false);

    const client = await httpClient(server.info.url, "tok");
    await client.callTool({ name: "terrain_raise", arguments: raise });
    // Written before the call returned, not just at shutdown.
    expect((await readPark(out)).finance.cash).toBe(10_000_00 - 45_000);

    await client.callTool({ name: "undo", arguments: {} });
    expect((await readPark(out)).finance.cash).toBe(10_000_00);
    await client.callTool({ name: "redo", arguments: {} });
    await client.close();

    expect((await server.stop()).code).toBe(0);
    expect((await readPark(out)).finance.cash).toBe(10_000_00 - 45_000);
    expect(Buffer.compare(await readFile(file), before)).toBe(0);
    // No stray temp files from the atomic writes.
    expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("does not modify the save, and writes nothing, without --out", async () => {
    const file = await makePark();
    const before = await readFile(file);
    const server = await startHttp("--save", file, "--http", "0", "--token", "tok");
    const client = await httpClient(server.info.url, "tok");
    await client.callTool({ name: "terrain_raise", arguments: raise });
    await client.close();
    expect((await server.stop()).code).toBe(0);
    expect(Buffer.compare(await readFile(file), before)).toBe(0);
    expect(await readdir(dir)).toEqual(["a.park"]);
  });

  it("keeps the park when several calls write at once", async () => {
    const file = await makePark();
    const out = join(dir, "busy.park");
    const server = await startHttp("--save", file, "--out", out, "--http", "0", "--token", "tok");
    const client = await httpClient(server.info.url, "tok");
    const raises = Array.from({ length: 8 }, (_, i) =>
      client.callTool({ name: "terrain_raise", arguments: { x: i, y: 0, w: 1, h: 1 } }),
    );
    for (const result of await Promise.all(raises)) expect(result.isError).toBe(false);
    await client.close();
    expect((await server.stop()).code).toBe(0);
    expect((await readPark(out)).finance.cash).toBe(10_000_00 - 8 * 4 * 50_00);
    expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("exits 1 when it cannot listen", async () => {
    const file = await makePark();
    const first = await startHttp("--save", file, "--http", "0", "--token", "tok");
    const second = await cli(
      ...["mcp", "--save", file, "--http", String(first.info.port), "--token", "tok"],
    );
    expect(second.code).toBe(1);
    expect(second.stderr).toMatch(/^error: .*EADDRINUSE/);
    expect((await first.stop()).code).toBe(0);
  });
});

describe("park files", () => {
  it("writePark creates the parent directory and readPark round-trips the world", async () => {
    const world = createWorld({ width: 4, height: 4, seed: 3, name: "RT" });
    const file = join(dir, "x", "y", "rt.park");
    await writePark(file, world);
    expect(hashWorld(await readPark(file))).toBe(hashWorld(world));
  });

  it("writePark replaces an existing park whole and leaves no temp file behind", async () => {
    const file = join(dir, "again.park");
    await writePark(file, createWorld({ width: 4, height: 4, seed: 1, name: "One" }));
    const second = createWorld({ width: 8, height: 8, seed: 2, name: "Two" });
    await writePark(file, second);
    expect(hashWorld(await readPark(file))).toBe(hashWorld(second));
    expect(await readdir(dir)).toEqual(["again.park"]);
  });

  it("writePark cleans up its temp file and throws when it cannot finish", async () => {
    // A directory is in the way, so the final rename fails.
    const target = join(dir, "in-the-way");
    await mkdir(target);
    const world = createWorld({ width: 4, height: 4, seed: 1, name: "X" });
    await expect(writePark(target, world)).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["in-the-way"]);
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

describe("bin mcp", () => {
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

  const INITIALIZE = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "raw", version: "0.0.0" },
    },
  };
  const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
  const RAISE = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "terrain_raise", arguments: { x: 0, y: 0, w: 2, h: 2 } },
  };

  /** Spawns the built bin as `mcp ...` and collects what it writes. */
  function start(...args: string[]) {
    const child = spawn(process.execPath, [dist, "mcp", ...args], { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    return {
      child,
      exited,
      send: (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`),
      stdout: () => stdout,
      stderr: () => stderr,
      /** Waits for `count` complete lines on stdout. */
      async lines(count: number): Promise<any[]> {
        for (let i = 0; i < 400; i++) {
          const lines = stdout.split("\n").filter((line) => line !== "");
          if (lines.length >= count) return lines.map((line) => JSON.parse(line));
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`expected ${count} lines, got: ${stdout}\n${stderr}`);
      },
    };
  }

  it("speaks only JSON-RPC on stdout, writes --out, and exits 0 when stdin closes", async (ctx) => {
    if (!existsSync(dist)) ctx.skip(`${dist} is missing; run \`pnpm build\` to enable this test`);
    const file = await makePark();
    const out = join(dir, "stdio.park");
    const server = start("--save", file, "--out", out);

    server.send(INITIALIZE);
    server.send(INITIALIZED);
    server.send(RAISE);
    const [init, raised] = await server.lines(2);
    expect(init.result.serverInfo.name).toBe("coasterworks");
    expect(JSON.parse(raised.result.content[0].text)).toEqual({ ok: true, id: 1, cost: 45_000 });
    expect((await readPark(out)).finance.cash).toBe(10_000_00 - 45_000);

    server.child.stdin.end();
    expect(await server.exited).toBe(0);
    expect(server.stderr()).toBe("");
    // Every byte on stdout was a protocol message.
    for (const line of server
      .stdout()
      .split("\n")
      .filter((l) => l !== "")) {
      expect(JSON.parse(line).jsonrpc).toBe("2.0");
    }
  });

  it("answers a call that stdin's end follows straight away", async (ctx) => {
    if (!existsSync(dist)) ctx.skip(`${dist} is missing; run \`pnpm build\` to enable this test`);
    const file = await makePark();
    const out = join(dir, "oneshot.park");
    const server = start("--save", file, "--out", out);
    server.child.stdin.end(
      [INITIALIZE, INITIALIZED, RAISE].map((m) => `${JSON.stringify(m)}\n`).join(""),
    );
    expect(await server.exited).toBe(0);
    const answers = server
      .stdout()
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l));
    expect(answers.map((a) => a.id)).toEqual([1, 2]);
    expect((await readPark(out)).finance.cash).toBe(10_000_00 - 45_000);
  });

  it("does not modify the save without --out", async (ctx) => {
    if (!existsSync(dist)) ctx.skip(`${dist} is missing; run \`pnpm build\` to enable this test`);
    const file = await makePark();
    const before = await readFile(file);
    const server = start("--save", file);
    server.child.stdin.end(
      [INITIALIZE, INITIALIZED, RAISE].map((m) => `${JSON.stringify(m)}\n`).join(""),
    );
    expect(await server.exited).toBe(0);
    expect(Buffer.compare(await readFile(file), before)).toBe(0);
    expect(await readdir(dir)).toEqual(["a.park"]);
  });

  it("writes --out and exits 0 on SIGINT", async (ctx) => {
    if (!existsSync(dist)) ctx.skip(`${dist} is missing; run \`pnpm build\` to enable this test`);
    const file = await makePark();
    const out = join(dir, "sigint.park");
    const server = start("--save", file, "--out", out);
    server.send(INITIALIZE);
    await server.lines(1);
    expect(await exists(out)).toBe(false);

    server.child.kill("SIGINT");
    expect(await server.exited).toBe(0);
    expect(server.stderr()).toBe("");
    expect(hashWorld(await readPark(out))).toBe(hashWorld(await readPark(file)));
  });

  it("serves HTTP until SIGINT, then writes --out and exits 0", async (ctx) => {
    if (!existsSync(dist)) ctx.skip(`${dist} is missing; run \`pnpm build\` to enable this test`);
    const file = await makePark();
    const out = join(dir, "http.park");
    const server = start("--save", file, "--out", out, "--http", "0", "--token", "tok");
    const [info] = await server.lines(1);
    expect(info.url).toBe(`http://127.0.0.1:${info.port}/mcp`);

    const client = await httpClient(info.url, "tok");
    await client.callTool({ name: "terrain_raise", arguments: { x: 0, y: 0, w: 2, h: 2 } });
    await client.close();

    server.child.kill("SIGINT");
    expect(await server.exited).toBe(0);
    expect(server.stderr()).toBe("");
    expect((await readPark(out)).finance.cash).toBe(10_000_00 - 45_000);
  });
});
