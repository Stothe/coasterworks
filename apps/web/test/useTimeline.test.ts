import type { EventMessage, LogEntryPublic } from "@coasterworks/protocol";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildTimeline, useTimeline } from "../src/state/useTimeline";

/** A log event, by default a player's raise of one tile. */
function event(id: number, over: Partial<LogEntryPublic> = {}): EventMessage {
  return {
    t: "event",
    kind: "log",
    entry: {
      id,
      tick: id * 10,
      client: "player",
      name: "terrain_raise",
      input: { x: 1, y: 2, w: 3, h: 4 },
      cost: 200,
      ...over,
    },
  };
}

const undo = (id: number, target: number, client: LogEntryPublic["client"] = "player") =>
  event(id, { name: "undo", input: { target }, cost: -200, client });
const redo = (id: number, target: number) => event(id, { name: "redo", input: { target } });

describe("buildTimeline: order and duplicates", () => {
  it("lists the newest entry first", () => {
    const entries = buildTimeline([event(1), event(2), event(3)]);
    expect(entries.map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it("puts events in id order whatever order they arrived in", () => {
    const entries = buildTimeline([event(3), event(1), event(2)]);
    expect(entries.map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it("yields one entry for two events with the same id, the later one", () => {
    const entries = buildTimeline([event(1), event(2, { cost: 1 }), event(2, { cost: 999 })]);
    expect(entries.map((e) => e.id)).toEqual([2, 1]);
    expect(entries[0]?.cost).toBe(999);
  });

  it("never repeats an id (Review Focus 4)", () => {
    const events = [event(5), event(4), event(5), event(4), event(6), event(5)];
    const ids = buildTimeline(events).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([6, 5, 4]);
  });

  it("is empty without events", () => {
    expect(buildTimeline([])).toEqual([]);
  });
});

describe("buildTimeline: what each entry says", () => {
  it("carries the tick, name, cost and input, and a humanized title", () => {
    const [entry] = buildTimeline([event(7, { tick: 345, cost: 800 })]);
    expect(entry).toMatchObject({
      id: 7,
      tick: 345,
      name: "terrain_raise",
      title: "Raise terrain",
      cost: 800,
      input: { x: 1, y: 2, w: 3, h: 4 },
      undone: false,
      isUndoMarker: false,
    });
  });

  it("falls back to the name in sentence case for a command with no friendlier title", () => {
    const [entry] = buildTimeline([event(1, { name: "park_close_gates" })]);
    expect(entry?.title).toBe("Park close gates");
  });

  it("labels the client: You, Agent, System, Replay", () => {
    const entries = buildTimeline([
      event(1, { client: "player" }),
      event(2, { client: "agent" }),
      event(3, { client: "system" }),
      event(4, { client: "replay" }),
    ]);
    expect(entries.map((e) => e.client)).toEqual(["Replay", "System", "Agent", "You"]);
  });

  it("has a rect when the input is an area of whole tiles", () => {
    const [entry] = buildTimeline([event(1, { input: { x: 4, y: 5, w: 2, h: 3, extra: "ok" } })]);
    expect(entry?.rect).toEqual({ x: 4, y: 5, w: 2, h: 3 });
  });

  it("has no rect for an input without one", () => {
    const inputs: unknown[] = [
      undefined,
      null,
      "text",
      42,
      {},
      { x: 1, y: 2 },
      { x: 1, y: 2, w: 3 },
      { x: 1.5, y: 2, w: 3, h: 4 },
      { x: "1", y: 2, w: 3, h: 4 },
    ];
    for (const input of inputs) {
      const entry = buildTimeline([event(1, { input })])[0];
      expect(entry).toBeDefined();
      expect(entry && "rect" in entry).toBe(false);
    }
  });
});

describe("buildTimeline: undo and redo", () => {
  it("marks the target of a later undo as undone", () => {
    const entries = buildTimeline([event(1), event(2), undo(3, 2)]);
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(byId.get(1)?.undone).toBe(false);
    expect(byId.get(2)?.undone).toBe(true);
    expect(byId.get(3)?.undone).toBe(false);
  });

  it("describes the undo itself as an undo marker of its target", () => {
    const [marker] = buildTimeline([event(1), undo(2, 1)]);
    expect(marker).toMatchObject({
      id: 2,
      name: "undo",
      isUndoMarker: true,
      title: "Undid Raise terrain",
      cost: -200,
    });
  });

  it("clears undone when a later redo re-targets the entry", () => {
    const entries = buildTimeline([event(1), undo(2, 1), redo(3, 1)]);
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(byId.get(1)?.undone).toBe(false);
    expect(byId.get(3)).toMatchObject({ isUndoMarker: true, title: "Redid Raise terrain" });
  });

  it("marks it undone again by an undo that follows the redo", () => {
    const entries = buildTimeline([event(1), undo(2, 1), redo(3, 1), undo(4, 1)]);
    expect(entries.find((e) => e.id === 1)?.undone).toBe(true);
  });

  it("does not let a redo of one entry clear another's undo", () => {
    const entries = buildTimeline([event(1), event(2), undo(3, 2), undo(4, 1), redo(5, 1)]);
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(byId.get(2)?.undone).toBe(true);
    expect(byId.get(1)?.undone).toBe(false);
  });

  it("ignores an undo that comes before the entry it names", () => {
    const entries = buildTimeline([undo(1, 2), event(2)]);
    expect(entries.find((e) => e.id === 2)?.undone).toBe(false);
  });

  it("falls back to Undo and Redo when the target is not in the window", () => {
    const entries = buildTimeline([undo(10, 3), redo(11, 3)]);
    expect(entries.map((e) => e.title)).toEqual(["Redo", "Undo"]);
    expect(entries.every((e) => e.isUndoMarker)).toBe(true);
  });

  it("falls back to Undo for an undo with no usable target", () => {
    const [marker] = buildTimeline([event(1, { name: "undo", input: {}, cost: 0 })]);
    expect(marker).toMatchObject({ title: "Undo", isUndoMarker: true });
  });

  it("keeps the client of an undo done by an agent", () => {
    const [marker] = buildTimeline([event(1), undo(2, 1, "agent")]);
    expect(marker?.client).toBe("Agent");
  });

  it("counts an entry the host already reports as undone", () => {
    const entries = buildTimeline([event(1, { undoneBy: 2 })]);
    expect(entries[0]?.undone).toBe(true);
  });
});

describe("useTimeline", () => {
  it("is the same list for the same events, and a new one when they change", () => {
    const events = [event(1), event(2)];
    const { result, rerender } = renderHook(({ list }) => useTimeline(list), {
      initialProps: { list: events },
    });
    const first = result.current;
    expect(first.map((e) => e.id)).toEqual([2, 1]);
    rerender({ list: events });
    expect(result.current).toBe(first);
    rerender({ list: [...events, event(3)] });
    expect(result.current.map((e) => e.id)).toEqual([3, 2, 1]);
  });
});
