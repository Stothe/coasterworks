import type { DecodedSnapshot, SnapshotHeader } from "@coasterworks/protocol";
import type { SnapshotSource } from "../src/state/useSnapshot";

/** A snapshot of a running park at its start, with `over` changed. */
export function snapshotOf(over: Partial<SnapshotHeader> = {}): DecodedSnapshot {
  return {
    header: {
      tick: 0,
      speed: 1,
      halted: false,
      cash: 1_000_000,
      loan: 0,
      monthStartCash: 1_000_000,
      date: "March 1, Year 1",
      terrainVersion: 0,
      hasTerrain: false,
      width: 16,
      height: 16,
      ...over,
    },
  };
}

/** A source that is told of a snapshot the way the host hook is: `push` makes the next one. */
export interface TestSource extends SnapshotSource {
  snapshot: DecodedSnapshot | null;
  /** Makes the snapshot that follows the current one, with `over` changed, and tells listeners. */
  push(over: Partial<SnapshotHeader>): void;
  /** How many listeners are waiting for a snapshot. */
  listeners(): number;
}

export function makeSource(over: Partial<SnapshotHeader> | null = {}): TestSource {
  const heard = new Set<() => void>();
  const source: TestSource = {
    snapshot: over === null ? null : snapshotOf(over),
    subscribeSnapshot(listener) {
      heard.add(listener);
      return () => {
        heard.delete(listener);
      };
    },
    push(next) {
      source.snapshot = snapshotOf({ ...source.snapshot?.header, ...next });
      for (const listener of [...heard]) listener();
    },
    listeners: () => heard.size,
  };
  return source;
}
