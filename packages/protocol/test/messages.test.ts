import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  parseHostMessage,
  type ClientMessage,
  type HostMessage,
  type LogEntryPublic,
} from "../src/index.js";

const CLIENT_MESSAGES: ClientMessage[] = [
  { t: "hello", protocol: PROTOCOL_VERSION },
  { t: "command", id: 1, name: "terrain_raise", input: { x: 0, y: 0, w: 2, h: 2 } },
  { t: "query", id: 2, name: "park_status", input: {} },
  { t: "undo", id: 3 },
  { t: "redo", id: 4 },
  { t: "speed", id: 5, speed: 8 },
  { t: "snapshot", id: 6 },
];

const ENTRY: LogEntryPublic = {
  id: 1,
  tick: 0,
  client: "player",
  name: "terrain_raise",
  input: { x: 0 },
  cost: 800,
};

const HOST_MESSAGES: HostMessage[] = [
  { t: "welcome", protocol: 1, width: 16, height: 16, name: "Park", speed: 1, halted: false },
  { t: "welcome", protocol: 1, width: 16, height: 16, name: "Park", speed: 0, halted: true },
  { t: "result", id: 1, result: { ok: true, id: 7, cost: 800 } },
  { t: "result", id: 2, result: { ok: false, error: "Nothing to undo" } },
  { t: "result", id: 3, result: { ok: true, result: { name: "Park", tick: 0 } } },
  { t: "result", id: 4, result: { ok: true } },
  { t: "event", kind: "log", entry: ENTRY },
  { t: "event", kind: "log", entry: { ...ENTRY, client: "agent", undoneBy: 9 } },
  { t: "error", message: "Expected hello" },
  { t: "error", id: 3, message: "Unknown command: nope" },
];

describe("client messages", () => {
  it.each(CLIENT_MESSAGES.map((message) => [message.t, message] as const))(
    "round-trips %s",
    (_t, message) => {
      expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
    },
  );

  it("accepts every speed and nothing else", () => {
    for (const speed of [0, 1, 2, 4, 8]) {
      expect(parseClientMessage(JSON.stringify({ t: "speed", id: 1, speed }))).toEqual({
        t: "speed",
        id: 1,
        speed,
      });
    }
    for (const speed of [3, 16, -1, 1.5, "1", null]) {
      expect(parseClientMessage(JSON.stringify({ t: "speed", id: 1, speed }))).toHaveProperty(
        "error",
      );
    }
  });

  it("accepts a command or query with no input, which is how an undefined input arrives", () => {
    expect(parseClientMessage('{"t":"command","id":1,"name":"sim_pause"}')).toEqual({
      t: "command",
      id: 1,
      name: "sim_pause",
    });
    expect(parseClientMessage('{"t":"query","id":2,"name":"park_status"}')).toHaveProperty(
      "t",
      "query",
    );
  });

  it("returns an error for text that is not JSON", () => {
    expect(parseClientMessage("{")).toEqual({ error: "Message is not valid JSON" });
    expect(parseClientMessage("")).toHaveProperty("error");
  });

  it("returns an error for JSON that is not an object", () => {
    for (const text of ["null", "5", '"hello"', "[]", "true"]) {
      expect(parseClientMessage(text)).toEqual({ error: "Message must be a JSON object" });
    }
  });

  it("returns an error for a missing or unknown t", () => {
    expect(parseClientMessage("{}")).toEqual({ error: "Message needs a string field t" });
    expect(parseClientMessage('{"t":5}')).toEqual({ error: "Message needs a string field t" });
    expect(parseClientMessage('{"t":"dance"}')).toEqual({ error: "Unknown message type: dance" });
  });

  it("does not accept a host message as a client message", () => {
    expect(parseClientMessage('{"t":"welcome","protocol":1}')).toHaveProperty("error");
  });

  it("returns an error for a command without an id", () => {
    const parsed = parseClientMessage('{"t":"command","name":"terrain_raise","input":{}}');
    expect(parsed).toEqual({ error: "Invalid command message at id" });
  });

  it("returns an error for an id that is not a positive integer", () => {
    for (const id of [0, -1, 1.5, "1", null]) {
      const parsed = parseClientMessage(JSON.stringify({ t: "undo", id }));
      expect(parsed).toHaveProperty("error");
      expect(parsed).not.toHaveProperty("id");
    }
  });

  it("carries the id of a bad request so the sender can be told which one failed", () => {
    expect(parseClientMessage('{"t":"command","id":7}')).toEqual({
      error: "Invalid command message at name",
      id: 7,
    });
    expect(parseClientMessage('{"t":"dance","id":9}')).toEqual({
      error: "Unknown message type: dance",
      id: 9,
    });
  });

  it("does not echo a long message type in full", () => {
    const parsed = parseClientMessage(JSON.stringify({ t: "x".repeat(500) }));
    expect("error" in parsed && parsed.error.length).toBeLessThan(100);
  });

  it("needs a protocol number in hello", () => {
    expect(parseClientMessage('{"t":"hello"}')).toHaveProperty("error");
    expect(parseClientMessage('{"t":"hello","protocol":"1"}')).toHaveProperty("error");
  });
});

describe("host messages", () => {
  it.each(HOST_MESSAGES.map((message, i) => [`${message.t} #${i}`, message] as const))(
    "round-trips %s",
    (_name, message) => {
      expect(parseHostMessage(JSON.stringify(message))).toEqual(message);
    },
  );

  it("returns an error for bad text, unknown types, and client messages", () => {
    expect(parseHostMessage("{")).toHaveProperty("error");
    expect(parseHostMessage('{"t":"dance"}')).toEqual({ error: "Unknown message type: dance" });
    expect(parseHostMessage('{"t":"undo","id":1}')).toHaveProperty("error");
  });

  it("needs a boolean halted in a welcome", () => {
    const welcome = { t: "welcome", protocol: 1, width: 16, height: 16, name: "Park", speed: 1 };
    expect(parseHostMessage(JSON.stringify(welcome))).toEqual({
      error: "Invalid welcome message at halted",
    });
    expect(parseHostMessage(JSON.stringify({ ...welcome, halted: "no" }))).toHaveProperty("error");
  });

  it("returns an error for a result with no id or a malformed outcome", () => {
    expect(parseHostMessage('{"t":"result","result":{"ok":true}}')).toHaveProperty("error");
    expect(parseHostMessage('{"t":"result","id":1,"result":{"ok":false}}')).toHaveProperty("error");
    expect(parseHostMessage('{"t":"result","id":1}')).toHaveProperty("error");
  });

  it("leaves the undo data of a log entry off an event", () => {
    const text = JSON.stringify({
      t: "event",
      kind: "log",
      entry: { ...ENTRY, undo: { heights: [1] } },
    });
    const parsed = parseHostMessage(text);
    expect(parsed).toHaveProperty("entry");
    expect((parsed as { entry: object }).entry).not.toHaveProperty("undo");
  });

  it("tells an exec result, a query result and an ack apart without losing fields", () => {
    const exec = parseHostMessage('{"t":"result","id":1,"result":{"ok":true,"id":4,"cost":50}}');
    expect(exec).toEqual({ t: "result", id: 1, result: { ok: true, id: 4, cost: 50 } });
    const query = parseHostMessage('{"t":"result","id":1,"result":{"ok":true,"result":null}}');
    expect(query).toEqual({ t: "result", id: 1, result: { ok: true, result: null } });
  });
});
