import type { DecodedSnapshot } from "@coasterworks/protocol";
import { useSyncExternalStore } from "react";

/**
 * Where the latest snapshot can be read. The host sends one every 50 ms while the sim runs, so a
 * render does not follow each: `snapshot` is read when asked for, and a component that shows part
 * of it subscribes to that part with `useSnapshot`.
 */
export interface SnapshotSource {
  /** The latest snapshot the host sent, or null before the first. */
  readonly snapshot: DecodedSnapshot | null;
  /**
   * Calls `listener` after each snapshot, and returns the way to stop. A source whose snapshot never
   * changes, such as a fixed state in a test, has none.
   */
  readonly subscribeSnapshot?: (listener: () => void) => () => void;
}

const subscribeNothing = () => () => {};

/**
 * What `select` makes of the latest snapshot, which changes the component only when that changes:
 * select a number, a string or an object that lives as long as the snapshot, not one made anew.
 * With no snapshot yet `select` is given null.
 */
export function useSnapshot<T>(
  source: SnapshotSource,
  select: (snapshot: DecodedSnapshot | null) => T,
): T {
  return useSyncExternalStore(source.subscribeSnapshot ?? subscribeNothing, () =>
    select(source.snapshot),
  );
}
