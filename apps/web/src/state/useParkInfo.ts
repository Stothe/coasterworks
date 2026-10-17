import { useMemo } from "react";
import { useSnapshot, type SnapshotSource } from "./useSnapshot";

/** What the park's panels show of the park, all of it from the host's welcome and snapshots. */
export interface ParkInfo {
  /** The park's name, once the host has welcomed the page. */
  name: string | undefined;
  /** The game date, such as `March 1, Year 1`. */
  date: string;
  /** Integer cents. */
  cash: number;
  /** Integer cents. */
  loan: number;
  /** Integer cents: the cash when the month began, so `cash - monthStartCash` is its change. */
  monthStartCash: number;
}

/**
 * The park's name, date, cash, loan and month's starting cash, followed as they change, or null
 * before the first snapshot. Each is followed on its own, so a panel renders when one of the five
 * changes and not for every snapshot.
 */
export function useParkInfo(source: SnapshotSource, name: string | undefined): ParkInfo | null {
  const date = useSnapshot(source, (snapshot) => snapshot?.header.date);
  const cash = useSnapshot(source, (snapshot) => snapshot?.header.cash);
  const loan = useSnapshot(source, (snapshot) => snapshot?.header.loan);
  const monthStartCash = useSnapshot(source, (snapshot) => snapshot?.header.monthStartCash);
  return useMemo(
    () =>
      date === undefined || cash === undefined || loan === undefined || monthStartCash === undefined
        ? null
        : { name, date, cash, loan, monthStartCash },
    [name, date, cash, loan, monthStartCash],
  );
}
