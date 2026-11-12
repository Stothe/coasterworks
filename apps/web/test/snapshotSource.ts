import { emptyRideStatus } from "@coasterworks/protocol";
import type { DecodedSnapshot, GuestSection, SnapshotHeader } from "@coasterworks/protocol";
import type { SnapshotSource } from "../src/state/useSnapshot";

/** The guest section of a park nobody has entered. */
export function noGuests(): GuestSection {
  return {
    count: 0,
    id: new Int32Array(0),
    x: new Int32Array(0),
    y: new Int32Array(0),
    state: new Uint8Array(0),
    color: new Uint8Array(0),
    happiness: new Uint8Array(0),
  };
}

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
      pathVersion: 0,
      hasPaths: false,
      rideVersion: 0,
      hasRides: false,
      rideCount: 0,
      guestCount: 0,
      width: 16,
      height: 16,
      park: {
        name: "Queryland",
        open: false,
        entryFee: 10_00,
        entrance: null,
        rating: 500,
        guestsInPark: 0,
        totalAdmissions: 0,
      },
      ...over,
    },
    guests: noGuests(),
    rideStatus: emptyRideStatus(),
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
