import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Sim, createWorld } from "@coasterworks/sim";
import { serveStdio } from "../src/index.js";

function makeSim(): Sim {
  return new Sim(createWorld({ width: 16, height: 16, seed: 1, name: "Test Park" }));
}

function request(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

const INITIALIZE = request(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "raw", version: "0.0.0" },
});
const INITIALIZED = `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`;

/** A fake process: the server reads `stdin` and writes `stdout`. */
function pipes() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let text = "";
  stdout.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
  return {
    stdin,
    stdout,
    /** Every line written so far; each must be one JSON-RPC message. */
    lines: () =>
      text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as any),
    raw: () => text,
  };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(condition()).toBe(true);
}

describe("serveStdio", () => {
  it("answers newline-delimited JSON-RPC on stdout and writes nothing else", async () => {
    const { stdin, stdout, lines, raw } = pipes();
    const done = serveStdio(makeSim(), { stdin, stdout });

    stdin.write(INITIALIZE);
    await until(() => lines().length === 1);
    expect(lines()[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "coasterworks" } },
    });

    stdin.write(INITIALIZED);
    stdin.write(request(2, "tools/list", {}));
    stdin.write(request(3, "tools/call", { name: "park_status", arguments: {} }));
    await until(() => lines().length === 3);
    const byId = new Map(lines().map((m) => [m.id, m]));
    expect(byId.get(2).result.tools.map((t: { name: string }) => t.name)).toContain(
      "terrain_raise",
    );
    expect(JSON.parse(byId.get(3).result.content[0].text).result.name).toBe("Test Park");
    expect(raw().endsWith("\n")).toBe(true);

    stdin.end();
    await done;
  });

  it("stops when stdin ends, and lets go of the streams", async () => {
    const { stdin, stdout } = pipes();
    const done = serveStdio(makeSim(), { stdin, stdout });
    await until(() => stdin.listenerCount("data") === 1);
    stdin.end();
    await done;
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdin.listenerCount("end")).toBe(0);
    expect(stdin.listenerCount("error")).toBe(0);
  });

  it("still answers a slow call that stdin's end follows", async () => {
    const { stdin, stdout, lines } = pipes();
    const sim = makeSim();
    const done = serveStdio(sim, {
      stdin,
      stdout,
      onMutate: () => new Promise((resolve) => setTimeout(resolve, 40)),
    });
    stdin.write(INITIALIZE);
    stdin.write(INITIALIZED);
    stdin.write(
      request(2, "tools/call", {
        name: "terrain_raise",
        arguments: { x: 0, y: 0, w: 2, h: 2 },
      }),
    );
    stdin.end();
    await done;

    const answer = lines().find((m) => m.id === 2);
    expect(JSON.parse(answer.result.content[0].text)).toEqual({ ok: true, id: 1, cost: 45_000 });
    expect(sim.world.finance.cash).toBe(955_000);
  });

  it("stops when the signal aborts", async () => {
    const { stdin, stdout, lines } = pipes();
    const abort = new AbortController();
    const done = serveStdio(makeSim(), { stdin, stdout, signal: abort.signal });
    stdin.write(INITIALIZE);
    await until(() => lines().length === 1);

    abort.abort();
    await done;
    expect(stdin.listenerCount("data")).toBe(0);
    expect(abort.signal.aborted).toBe(true);
  });

  it("returns at once when the signal is already aborted", async () => {
    const { stdin, stdout } = pipes();
    await serveStdio(makeSim(), { stdin, stdout, signal: AbortSignal.abort() });
    expect(stdin.listenerCount("data")).toBe(0);
  });
});
