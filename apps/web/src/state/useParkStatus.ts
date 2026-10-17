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
 * The park's status for a panel that shows the money. A snapshot carries cash and loan but not
 * the month's starting cash, and asking is cheap, so while `active` this asks at once, then every
 * second, and again after each change in `after`. An older answer never replaces a newer one.
 */
export function useParkStatus(
  client: SimClient | null,
  { active, after }: UseParkStatusOptions,
): UseParkStatus {
  const [status, setStatus] = useState<ParkStatus | null>(null);
  // Which question the latest is. An answer to any other is out of date.
  const latest = useRef(0);

  const load = useCallback(() => {
    if (!client) return;
    const mine = ++latest.current;
    client.query<unknown>("park_status", {}).then(
      (answer) => {
        if (!answer.ok || !isParkStatus(answer.result)) return;
        if (mine === latest.current) setStatus(answer.result);
      },
      () => {
        // The connection is the host hook's to report; the next question tries again.
      },
    );
  }, [client]);

  // `after` is only here to start this over: a new event asks at once and gives a full second
  // before the next question.
  useEffect(() => {
    if (!active || !client) return;
    load();
    const timer = setInterval(load, PARK_STATUS_MS);
    return () => clearInterval(timer);
  }, [active, client, load, after]);

  return { status, refresh: load };
}
