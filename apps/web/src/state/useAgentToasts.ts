import type { EventMessage } from "@coasterworks/protocol";
import { useEffect, useRef } from "react";
import { humanizeName } from "../actions/registry";
import type { TileRect, TimelineEntry } from "./useTimeline";
import type { PushOptions, ToastUpdate } from "./useToasts";

/** Agent commands this soon after the first of a burst are told in the same message. */
export const AGENT_BATCH_MS = 1000;

/** What one agent command was, as a toast tells it. */
interface Told {
  title: string;
  rect?: TileRect;
}

/** The burst being told: its message, when it began, and what is in it. */
interface Batch {
  toast: number;
  startedAt: number;
  told: Told[];
}

export interface AgentToastsOptions {
  /** The host's log events, oldest first. */
  events: readonly EventMessage[];
  /** The timeline of `events`, which says what each one was and where. */
  timeline: readonly TimelineEntry[];
  /** The id of the newest event that was there before the page looked: not news. */
  seenThrough: number;
  push(text: string, options?: PushOptions): number;
  update(id: number, change: ToastUpdate): boolean;
  /** Looks at an area of the map. */
  focusRect(rect: TileRect): void;
  /** Opens the Timeline. */
  openTimeline(): void;
}

/** What pressing a message does, which is whatever the app does now and not when it was shown. */
type Handlers = Pick<AgentToastsOptions, "focusRect" | "openTimeline">;

/** What a burst of agent commands says, and what pressing it does. */
function describe(told: readonly Told[], handlers: { current: Handlers }): ToastUpdate {
  const only = told.length === 1 ? told[0] : undefined;
  if (only?.rect) {
    const { rect } = only;
    return {
      text: `Agent: ${only.title}`,
      action: { label: "Jump to the area", run: () => handlers.current.focusRect(rect) },
    };
  }
  return {
    text: only ? `Agent: ${only.title}` : `Agent: ${told.length} actions`,
    action: { label: "Open the Timeline", run: () => handlers.current.openTimeline() },
  };
}

/**
 * Tells the player what an agent is doing as it does it, in as few messages as it can. A command
 * gets a message; the commands that follow within a second of it are counted into that message
 * (`Agent: 6 actions`) instead of each getting one. Pressing it opens the Timeline, or, for a
 * single command that worked on an area, goes to the area.
 *
 * Events up to `seenThrough`, and the player's own, are not told.
 */
export function useAgentToasts(options: AgentToastsOptions): void {
  const { events, timeline, seenThrough, push, update, focusRect, openTimeline } = options;
  const seen = useRef(0);
  const batch = useRef<Batch | null>(null);
  const handlers = useRef<Handlers>({ focusRect, openTimeline });
  useEffect(() => {
    handlers.current = { focusRect, openTimeline };
  });

  useEffect(() => {
    seen.current = Math.max(seen.current, seenThrough);
    const entries = new Map(timeline.map((entry) => [entry.id, entry]));
    const fresh: Told[] = [];
    for (const { entry } of events) {
      if (entry.id <= seen.current) continue;
      seen.current = entry.id;
      if (entry.client !== "agent") continue;
      const found = entries.get(entry.id);
      const told: Told = { title: found?.title ?? humanizeName(entry.name) };
      if (found?.rect) told.rect = found.rect;
      fresh.push(told);
    }
    if (fresh.length === 0) return;

    const now = Date.now();
    const open = batch.current;
    // The burst's message is still up, so these join it.
    if (open && now - open.startedAt < AGENT_BATCH_MS) {
      open.told.push(...fresh);
      if (update(open.toast, describe(open.told, handlers))) return;
    }
    const message = describe(fresh, handlers);
    batch.current = {
      toast: push(message.text, message.action ? { action: message.action } : {}),
      startedAt: now,
      told: fresh,
    };
  }, [events, timeline, seenThrough, push, update]);
}
