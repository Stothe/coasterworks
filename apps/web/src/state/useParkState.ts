import { useMemo } from "react";
import { useSnapshot, type SnapshotSource } from "./useSnapshot";

/** The park's gate and guests as the latest snapshot has them. */
export interface ParkState {
  open: boolean;
  /** Integer cents. */
  entryFee: number;
  /** 0 to 999. */
  rating: number;
  guestsInPark: number;
  totalAdmissions: number;
  /** The entrance tile, or null while the park has none. */
  entrance: { x: number; y: number } | null;
}

/**
 * The park's open flag, entry fee, rating, guest counts and entrance, followed as they change, or
 * null before the first snapshot. Each is followed as a primitive of its own, so a panel renders
 * when one of them changes, not for every snapshot.
 */
export function useParkState(source: SnapshotSource): ParkState | null {
  const open = useSnapshot(source, (s) => s?.header.park.open);
  const entryFee = useSnapshot(source, (s) => s?.header.park.entryFee);
  const rating = useSnapshot(source, (s) => s?.header.park.rating);
  const guestsInPark = useSnapshot(source, (s) => s?.header.park.guestsInPark);
  const totalAdmissions = useSnapshot(source, (s) => s?.header.park.totalAdmissions);
  const entranceX = useSnapshot(source, (s) => s?.header.park.entrance?.x ?? -1);
  const entranceY = useSnapshot(source, (s) => s?.header.park.entrance?.y ?? -1);
  return useMemo(
    () =>
      open === undefined ||
      entryFee === undefined ||
      rating === undefined ||
      guestsInPark === undefined ||
      totalAdmissions === undefined
        ? null
        : {
            open,
            entryFee,
            rating,
            guestsInPark,
            totalAdmissions,
            entrance: entranceX < 0 ? null : { x: entranceX, y: entranceY },
          },
    [open, entryFee, rating, guestsInPark, totalAdmissions, entranceX, entranceY],
  );
}

/** The word for a park rating: what the pill and the overview say beside the number. */
export function ratingWord(rating: number): string {
  if (rating >= 800) return "Excellent";
  if (rating >= 600) return "Good";
  if (rating >= 400) return "Fair";
  if (rating >= 200) return "Poor";
  return "Very poor";
}

/** The tone of a rating's dot: good from 600, bad under 300, plain between. */
export function ratingTone(rating: number): "good" | "bad" | "plain" {
  if (rating >= 600) return "good";
  if (rating < 300) return "bad";
  return "plain";
}
