import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Sim, createWorld, deserializeWorld, hashWorld, serializeWorld } from "@coasterworks/sim";
import { createMcpServer, type McpServerOptions } from "../src/index.js";

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const RAISE = { x: 0, y: 0, w: 2, h: 2 };

let dir: string;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "coasterworks-mcp-"));
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await rm(dir, { recursive: true, force: true });
});

function makeSim(): Sim {
  return new Sim(createWorld({ width: 16, height: 16, seed: 1, name: "Test Park" }));
}

/** Connects an SDK client to a server for `sim` over an in-memory pipe. */
async function connect(sim: Sim, opts?: McpServerOptions) {
  const server = createMcpServer(sim, opts);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

/** The text of a tool result's one content block. */
function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe("text");
  return content[0]?.text ?? "";
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

async function call(client: Client, name: string, args?: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args ?? {} });
  return { raw: result, error: isError(result), json: JSON.parse(textOf(result)) as any };
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((t) => t.name);
}

describe("tools", () => {
  it("serves every command and query in the registry, plus undo and redo", async () => {
    const sim = makeSim();
    const names = await toolNames(await connect(sim));
    const registered = [...sim.registry.commands(), ...sim.registry.queries()].map((d) => d.name);
    expect([...names].sort()).toEqual([...registered, "undo", "redo"].sort());
    for (const name of ["terrain_raise", "park_status", "undo", "redo"]) {
      expect(names).toContain(name);
    }
  });

  it("names every tool in the form MCP clients accept", async () => {
    const names = await toolNames(await connect(makeSim(), { allowFiles: true }));
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) expect(name).toMatch(NAME);
  });

  it("leaves out the file tools unless allowFiles is set", async () => {
    const withoutFlag = await toolNames(await connect(makeSim()));
    expect(withoutFlag).not.toContain("save_write");
    expect(withoutFlag).not.toContain("save_load");
    const explicitlyOff = await toolNames(await connect(makeSim(), { allowFiles: false }));
    expect(explicitlyOff).not.toContain("save_write");

    const withFlag = await toolNames(await connect(makeSim(), { allowFiles: true }));
    expect(withFlag).toContain("save_write");
    expect(withFlag).toContain("save_load");
  });

  it("describes each tool from the registry, with the input schema of the command", async () => {
    const tools = (await (await connect(makeSim())).listTools()).tools;
    const raise = tools.find((t) => t.name === "terrain_raise");
    expect(raise?.title).toBe("Terrain raise");
    expect(raise?.description).toBeTypeOf("string");
    expect(raise?.description?.length).toBeGreaterThan(0);
    expect(raise?.inputSchema.type).toBe("object");
    expect(Object.keys(raise?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["x", "y", "w", "h"]),
    );
    expect(raise?.inputSchema.required).toEqual(expect.arrayContaining(["x", "y", "w", "h"]));
  });

  it("marks queries read-only, commands as changing the park, and sim_advance as not destructive", async () => {
    const tools = (await (await connect(makeSim())).listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("park_status")?.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.get("terrain_raise")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(byName.get("sim_advance")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(byName.get("undo")?.annotations).toMatchObject({ readOnlyHint: false });
  });

  it("names the server and version it was given", async () => {
    const client = await connect(makeSim(), { name: "park-test", version: "9.9.9" });
    expect(client.getServerVersion()).toMatchObject({ name: "park-test", version: "9.9.9" });
  });
});

describe("commands", () => {
  it("runs a command as the agent and charges for it", async () => {
    const sim = makeSim();
    const client = await connect(sim);

    const raised = await call(client, "terrain_raise", RAISE);
    expect(raised.error).toBe(false);
    expect(raised.json).toEqual({ ok: true, id: 1, cost: 45_000 });

    const status = await call(client, "park_status");
    expect(status.error).toBe(false);
    expect(status.json.ok).toBe(true);
    expect(status.json.result.cash).toBe(955_000);

    const log = sim.query("log_recent", { limit: 1 });
    expect(log).toMatchObject({ ok: true, result: [{ name: "terrain_raise", client: "agent" }] });
  });

  it("reports invalid input as an error that names the field, and changes nothing", async () => {
    const sim = makeSim();
    const client = await connect(sim);
    const before = sim.hash();

    const bad = await client.callTool({ name: "terrain_raise", arguments: { ...RAISE, x: -1 } });
    expect(isError(bad)).toBe(true);
    expect(textOf(bad)).toContain("x");
    expect(sim.hash()).toBe(before);
    expect(sim.world.log).toHaveLength(0);
  });

  it("reports a missing field as an error result", async () => {
    const sim = makeSim();
    const client = await connect(sim);
    const before = sim.hash();
    const result = await client.callTool({ name: "terrain_raise", arguments: { x: 0 } });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain("y");
    expect(sim.hash()).toBe(before);
  });

  it("returns the sim's refusal as readable JSON and changes nothing", async () => {
    const sim = makeSim();
    const client = await connect(sim);
    const before = sim.hash();

    const refused = await call(client, "terrain_raise", { x: 0, y: 0, w: 99, h: 99 });
    expect(refused.error).toBe(true);
    expect(refused.json).toEqual({ ok: false, error: "Area is outside the park" });
    expect(sim.hash()).toBe(before);
    expect(sim.world.log).toHaveLength(0);
  });

  it("reports an unknown tool as an error", async () => {
    const client = await connect(makeSim());
    const result = await client.callTool({ name: "nope", arguments: {} });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain("nope");
  });

  it("advances time through sim_advance", async () => {
    const sim = makeSim();
    const client = await connect(sim);
    const advanced = await call(client, "sim_advance", { days: 31 });
    expect(advanced.error).toBe(false);
    const status = await call(client, "park_status");
    expect(status.json.result.date).toBe("April 1, Year 1");
  });
});

describe("queries", () => {
  it("answers a query without changing the park or its log", async () => {
    const sim = makeSim();
    const client = await connect(sim);
    const before = sim.hash();
    const bounds = await call(client, "park_bounds");
    expect(bounds.json).toMatchObject({ ok: true, result: { width: 16, height: 16 } });
    expect(sim.hash()).toBe(before);
  });

  it("returns a failed query as an error result", async () => {
    const sim = makeSim();
    const client = await connect(sim);
    const off = await call(client, "terrain_get", { x: 10, y: 10, w: 20, h: 20 });
    expect(off.error).toBe(true);
    expect(off.json).toEqual({ ok: false, error: "Area is outside the park" });
  });
});

describe("undo and redo", () => {
  it("undo refunds the command and redo charges it again", async () => {
    const sim = makeSim();
    const client = await connect(sim);
    await call(client, "terrain_raise", RAISE);
    expect(sim.world.finance.cash).toBe(955_000);

    const undone = await call(client, "undo");
    expect(undone.error).toBe(false);
    expect(undone.json.ok).toBe(true);
    expect(sim.world.finance.cash).toBe(1_000_000);
    expect((await call(client, "park_status")).json.result.cash).toBe(1_000_000);

    const redone = await call(client, "redo");
    expect(redone.error).toBe(false);
    expect(sim.world.finance.cash).toBe(955_000);

    const log = sim.query("log_recent", { limit: 2 });
    expect(log).toMatchObject({ ok: true, result: [{ client: "agent" }, { client: "agent" }] });
  });

  it("reports nothing to undo or redo as an error and changes nothing", async () => {
    const sim = makeSim();
    const client = await connect(sim);
    const before = sim.hash();
    const undo = await call(client, "undo");
    expect(undo.error).toBe(true);
    expect(undo.json.ok).toBe(false);
    expect(undo.json.error).toBeTypeOf("string");
    const redo = await call(client, "redo");
    expect(redo.error).toBe(true);
    expect(sim.hash()).toBe(before);
  });
});

describe("park://status", () => {
  it("is listed and reads as the same JSON the park_status tool returns", async () => {
    const sim = makeSim();
    const client = await connect(sim);
    await call(client, "terrain_raise", RAISE);

    const listed = await client.listResources();
    expect(listed.resources.map((r) => r.uri)).toContain("park://status");

    const read = await client.readResource({ uri: "park://status" });
    expect(read.contents).toHaveLength(1);
    const [content] = read.contents;
    expect(content).toMatchObject({ uri: "park://status", mimeType: "application/json" });
    const fromResource = JSON.parse((content as { text: string }).text);
    const fromTool = (await call(client, "park_status")).json;
    expect(fromResource).toEqual(fromTool);
    expect(fromResource.result.cash).toBe(955_000);
  });
});

describe("onMutate", () => {
  it("runs after each command, undo and redo that succeeds, and not otherwise", async () => {
    const sim = makeSim();
    let calls = 0;
    const client = await connect(sim, { onMutate: () => void calls++ });

    await call(client, "park_status");
    await client.callTool({ name: "terrain_raise", arguments: { ...RAISE, x: -1 } });
    await call(client, "terrain_raise", { x: 0, y: 0, w: 99, h: 99 });
    await call(client, "undo");
    expect(calls).toBe(0);

    await call(client, "terrain_raise", RAISE);
    expect(calls).toBe(1);
    await call(client, "undo");
    expect(calls).toBe(2);
    await call(client, "redo");
    expect(calls).toBe(3);
  });

  it("is awaited, and sees the park as the call left it", async () => {
    const sim = makeSim();
    const seen: number[] = [];
    const client = await connect(sim, {
      onMutate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(sim.world.finance.cash);
      },
    });
    await call(client, "terrain_raise", RAISE);
    expect(seen).toEqual([955_000]);
  });

  it("reports a failure to save without hiding that the command ran", async () => {
    const sim = makeSim();
    const client = await connect(sim, {
      onMutate: () => {
        throw new Error("disk full");
      },
    });
    const raised = await call(client, "terrain_raise", RAISE);
    expect(raised.json).toMatchObject({ ok: true, cost: 45_000 });
    expect(raised.json.saveError).toContain("disk full");
    expect(sim.world.finance.cash).toBe(955_000);
  });
});

describe("file tools", () => {
  it("save_write writes a park file that loads to the same world", async () => {
    const sim = makeSim();
    const client = await connect(sim, { allowFiles: true });
    await call(client, "terrain_raise", RAISE);
    const file = join(dir, "nested", "out.park");

    const written = await call(client, "save_write", { path: file });
    expect(written.error).toBe(false);
    expect(written.json).toMatchObject({ ok: true, path: file });
    expect(hashWorld(deserializeWorld(await readFile(file)))).toBe(sim.hash());
  });

  it("save_load replaces the world, keeps the registry, and undo history comes with it", async () => {
    const source = makeSim();
    source.execute("terrain_raise", RAISE, "agent");
    const file = join(dir, "in.park");
    await writeFile(file, serializeWorld(source.world));

    const sim = makeSim();
    const registry = sim.registry;
    let mutations = 0;
    const client = await connect(sim, { allowFiles: true, onMutate: () => void mutations++ });
    const loaded = await call(client, "save_load", { path: file });
    expect(loaded.error).toBe(false);
    expect(loaded.json).toMatchObject({ ok: true, path: file });

    expect(sim.hash()).toBe(source.hash());
    expect(sim.registry).toBe(registry);
    expect(mutations).toBe(1);
    expect((await call(client, "park_status")).json.result.cash).toBe(955_000);
    expect((await call(client, "undo")).error).toBe(false);
    expect(sim.world.finance.cash).toBe(1_000_000);
  });

  it("save_load leaves the park alone when the file is missing or not a park", async () => {
    const sim = makeSim();
    let mutations = 0;
    const client = await connect(sim, { allowFiles: true, onMutate: () => void mutations++ });
    const before = sim.hash();

    const missing = join(dir, "missing.park");
    const gone = await call(client, "save_load", { path: missing });
    expect(gone.error).toBe(true);
    expect(gone.json.ok).toBe(false);
    expect(gone.json.error).toContain(missing);

    const junk = join(dir, "junk.park");
    await writeFile(junk, "not a save");
    const bad = await call(client, "save_load", { path: junk });
    expect(bad.error).toBe(true);
    expect(bad.json.error).toContain(junk);

    expect(sim.hash()).toBe(before);
    expect(mutations).toBe(0);
  });

  it("save_write reports a path it cannot write as an error", async () => {
    const sim = makeSim();
    const client = await connect(sim, { allowFiles: true });
    await mkdir(join(dir, "taken"));
    const result = await call(client, "save_write", { path: join(dir, "taken") });
    expect(result.error).toBe(true);
    expect(result.json.ok).toBe(false);
    expect(result.json.error).toContain("taken");
  });
});
