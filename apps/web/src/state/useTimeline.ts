import type { EventMessage, LogEntryPublic } from "@coasterworks/protocol";
import { useMemo } from "react";
import { humanizeName } from "../actions/registry";

/** An area of tiles: where a command like `terrain_raise` worked. */
export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Who did it, as the timeline names them. */
export type ClientLabel = "You" | "Agent" | "System" | "Replay";

/** One line of the timeline: a command in the park's log, as the player reads it. */
export interface TimelineEntry {
  /** The log entry's id, which no other entry of the timeline has. */
  id: number;
  tick: number;
  client: ClientLabel;
  /** The command's name, such as `terrain_raise`. */
  name: string;
  /** What to call it: `Raise terrain`, or `Undid Raise terrain` for the undo of one. */
  title: string;
  /** Integer cents the command charged; negative for a refund. */
  cost: number;
  input: unknown;
  /** The area the command worked on, if its input names one. */
  rect?: TileRect;
  /** True when a later undo took it back and no redo has done it again. */
  undone: boolean;
  /** True for the `undo` and `redo` entries themselves. */
  isUndoMarker: boolean;
}

const CLIENTS: Readonly<Record<LogEntryPublic["client"], ClientLabel>> = {
  player: "You",
  agent: "Agent",
  system: "System",
  replay: "Replay",
};

const isInteger = (value: unknown): value is number => Number.isInteger(value);

/** The area an input names with whole-number `x`, `y`, `w` and `h`, or nothing. */
function rectOf(input: unknown): TileRect | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const { x, y, w, h } = input as Record<string, unknown>;
  return isInteger(x) && isInteger(y) && isInteger(w) && isInteger(h) ? { x, y, w, h } : undefined;
}

/** The id an `undo` or `redo` names as its `target`, or nothing. */
function targetOf(input: unknown): number | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const { target } = input as Record<string, unknown>;
  return isInteger(target) ? target : undefined;
}

/** What to call an entry: its command, or for an undo or redo, what it undid or redid. */
function titleOf(entry: LogEntryPublic, byId: ReadonlyMap<number, LogEntryPublic>): string {
  const own = humanizeName(entry.name);
  if (entry.name !== "undo" && entry.name !== "redo") return own;
  const id = targetOf(entry.input);
  const target = id === undefined ? undefined : byId.get(id);
  return target ? `${entry.name === "undo" ? "Undid" : "Redid"} ${humanizeName(target.name)}` : own;
}

/** Which entries are undone, from the walk through the log in id order. */
function undoneIds(ordered: readonly LogEntryPublic[]): Set<number> {
  const undone = new Set<number>();
  for (const entry of ordered) {
    // The host may already say so of an entry it sent again after the undo.
    if (entry.undoneBy !== undefined) undone.add(entry.id);
    const target = targetOf(entry.input);
    // An undo or redo can only be of something before it.
    if (target === undefined || target >= entry.id) continue;
    if (entry.name === "undo") undone.add(target);
    else if (entry.name === "redo") undone.delete(target);
  }
  return undone;
}

/**
 * The timeline of a list of log events, newest first. An id that comes twice is one entry, the
 * later one. An entry is undone when a later `undo` names it and no `redo` after that does.
 */
export function buildTimeline(events: readonly EventMessage[]): TimelineEntry[] {
  const byId = new Map<number, LogEntryPublic>();
  for (const { entry } of events) byId.set(entry.id, entry);
  const ordered = [...byId.values()].sort((a, b) => a.id - b.id);
  const undone = undoneIds(ordered);

  const entries = ordered.map((entry): TimelineEntry => {
    const timeline: TimelineEntry = {
      id: entry.id,
      tick: entry.tick,
      client: CLIENTS[entry.client],
      name: entry.name,
      title: titleOf(entry, byId),
      cost: entry.cost,
      input: entry.input,
      undone: undone.has(entry.id),
      isUndoMarker: entry.name === "undo" || entry.name === "redo",
    };
    const rect = rectOf(entry.input);
    if (rect) timeline.rect = rect;
    return timeline;
  });
  return entries.reverse();
}

/** The timeline of the host's log events, made again only when they change. */
export function useTimeline(events: readonly EventMessage[]): TimelineEntry[] {
  return useMemo(() => buildTimeline(events), [events]);
}
