import type { EventMessage } from "@coasterworks/protocol";
import { useCallback, useMemo, useState } from "react";

export interface Notifications {
  /** Agent events since the notifications were last cleared. */
  count: number;
  /** The player has looked: the count starts again from nothing. */
  clear(): void;
}

/**
 * What the bell counts: the commands an agent has run since the player last opened it. The
 * player's own commands are not news to them, and neither is anything in the Timeline from before
 * the page looked.
 *
 * `events` are the host's log events, oldest first. `seenThrough` is the id of the newest event
 * that is already known and so never counts, such as the last of the history loaded when the
 * connection was made.
 */
export function useNotifications(events: readonly EventMessage[], seenThrough = 0): Notifications {
  // The newest event the player has looked at, by id: an agent event after it is unread.
  const [looked, setLooked] = useState(0);
  const seen = Math.max(looked, seenThrough);
  const newest = events.at(-1)?.entry.id ?? 0;

  const count = useMemo(
    () => events.filter(({ entry }) => entry.client === "agent" && entry.id > seen).length,
    [events, seen],
  );

  const clear = useCallback(() => setLooked(newest), [newest]);

  return { count, clear };
}
