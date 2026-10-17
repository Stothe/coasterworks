import type { EventMessage } from "@coasterworks/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface Notifications {
  /** Agent events and errors since the notifications were last cleared. */
  count: number;
  /** The player has looked: the count starts again from nothing. */
  clear(): void;
}

/**
 * What the bell counts: the commands an agent has run and the errors the host has reported, since
 * the player last opened it. The player's own commands are not news to them.
 *
 * `events` are the host's log events, oldest first. `error` is the host error worth telling, if
 * any; a new message counts once, so an error that is still there on the next render does not
 * count again.
 */
export function useNotifications(events: readonly EventMessage[], error?: string): Notifications {
  // The newest event the player has already seen, by id: an agent event after it is unread.
  const [seenThrough, setSeenThrough] = useState(0);
  const [errors, setErrors] = useState(0);
  const lastError = useRef<string | undefined>(undefined);
  const newest = events.at(-1)?.entry.id ?? 0;

  const agent = useMemo(
    () => events.filter(({ entry }) => entry.client === "agent" && entry.id > seenThrough).length,
    [events, seenThrough],
  );

  useEffect(() => {
    if (error !== undefined && error !== lastError.current) setErrors((now) => now + 1);
    lastError.current = error;
  }, [error]);

  const clear = useCallback(() => {
    setSeenThrough(newest);
    setErrors(0);
  }, [newest]);

  return { count: agent + errors, clear };
}
