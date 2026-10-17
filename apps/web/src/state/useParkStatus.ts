import type { SimClient } from "@coasterworks/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

/** What the sim's `park_status` query answers. Money is integer cents. */
export interface ParkStatus {
  name: string;
  tick: number;
  /** The game date, such as `March 1, Year 1`. */
  date: string;
  year: number;
  /** 0-based: March is 0. */
  month: number;
  day: number;
  cash: number;
  /** The cash when this month began, so `cash - monthStartCash` is the month's change. */
  monthStartCash: number;
  loan: number;
  guests: number;
  rating: number;
  width: number;
  height: number;
}

/** True for an answer with the parts the panels read; anything else is not worth showing. */
function isParkStatus(value: unknown): value is ParkStatus {
  if (typeof value !== "object" || value === null) return false;
  const given = value as Record<string, unknown>;
  return (
    typeof given["name"] === "string" &&
    typeof given["date"] === "string" &&
    typeof given["cash"] === "number" &&
    typeof given["monthStartCash"] === "number" &&
    typeof given["loan"] === "number"
  );
}

export interface UseParkStatusOptions {
  /** True while someone is looking. Nothing is asked while it is false. */
  active: boolean;
  /**
   * Anything that changes when the park has done something worth a fresh look, such as the id of
   * the newest event. The status is asked for once more each time it changes.
   */
  after?: number;
}

export interface UseParkStatus {
  /** The latest answer, or null before the first. It is kept while a later question fails. */
  status: ParkStatus | null;
  /** Asks now, for a caller that has just changed the park. */
  refresh(): void;
}

/** How often the status is asked for while someone is looking. */
export const PARK_STATUS_MS = 1000;

/**
 * How long after the last event the status is asked for. A burst of events, such as an agent's
 * commands or a brush drag, is one question once it has paused for this long, not one each.
 */
export const EVENT_DEBOUNCE_MS = 200;

/** What one client's questions are up to. A new one is made for each client, and on unmount. */
interface Flight {
  client: SimClient | null;
  /** A question has gone out and not come back. */
  busy: boolean;
  /** Another was wanted meanwhile: one more goes out when the one in flight is back. */
  again: boolean;
}

/**
 * The park's status for a panel that shows the money. A snapshot carries cash and loan but not
 * the month's starting cash, and asking is cheap, so while `active` this asks at once, then every
 * second, and once `after` has stopped changing for `EVENT_DEBOUNCE_MS`.
 *
 * At most one question is in flight, and any number wanted meanwhile are one more, asked when it
 * is back. So a burst cannot pile up round trips, and every answer that comes back is shown
 * rather than being thrown away by the next question. `refresh()` is not delayed: it asks now,
 * or as soon as the one in flight is back.
 */
export function useParkStatus(
  client: SimClient | null,
  { active, after }: UseParkStatusOptions,
): UseParkStatus {
  const [status, setStatus] = useState<ParkStatus | null>(null);
  const flight = useRef<Flight>({ client: null, busy: false, again: false });

  const load = useCallback(() => {
    if (!client) return;
    // Another client's questions are not this one's: it starts clean.
    if (flight.current.client !== client) {
      flight.current = { client, busy: false, again: false };
    }
    const mine = flight.current;
    if (mine.busy) {
      mine.again = true;
      return;
    }
    mine.busy = true;
    client
      .query<unknown>("park_status", {})
      .then(
        (answer) => {
          if (answer.ok && isParkStatus(answer.result) && flight.current === mine) {
            setStatus(answer.result);
          }
        },
        () => {
          // The connection is the host hook's to report; the next question tries again.
        },
      )
      .then(() => {
        mine.busy = false;
        // Not if the client went, or the panel did, while it was out: nobody is waiting.
        if (mine.again && flight.current === mine) {
          mine.again = false;
          load();
        }
      });
  }, [client]);

  // Asks now, and every second.
  useEffect(() => {
    if (!active || !client) return;
    load();
    const timer = setInterval(load, PARK_STATUS_MS);
    return () => clearInterval(timer);
  }, [active, client, load]);

  // A change in `after` is an event. The first of a burst starts the wait and each later one
  // starts it over, so the question goes out once the burst has paused.
  const seen = useRef(after);
  const waiting = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (seen.current === after) return;
    seen.current = after;
    if (!active || !client) return;
    clearTimeout(waiting.current);
    waiting.current = setTimeout(load, EVENT_DEBOUNCE_MS);
  }, [after, active, client, load]);
  // Nothing is asked for after the panel is shut, or the client is another.
  useEffect(() => () => clearTimeout(waiting.current), [active, client, load]);

  // On unmount, the answers still on their way are not wanted: forget the flight.
  useEffect(
    () => () => {
      flight.current = { client: null, busy: false, again: false };
    },
    [],
  );

  return { status, refresh: load };
}
