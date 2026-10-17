/** Which map edge the entrance is on: 0 north (y = 0), 1 east, 2 south, 3 west. */
export type EdgeSide = 0 | 1 | 2 | 3;

/** The entrance tile and the map edge it faces out of. */
export interface Entrance {
  x: number;
  y: number;
  side: EdgeSide;
}

/**
 * The park as a business: its name, whether it is open, what a visit costs, and the running
 * totals. Money is in integer cents. This is world state, so it is saved and covered by the hash.
 */
export interface ParkState {
  name: string;
  open: boolean;
  /** What a guest pays at the entrance, in cents. */
  entryFee: number;
  /** The one entrance, or null until the player places it. */
  entrance: Entrance | null;
  /** 0 to 999. */
  rating: number;
  guestsInPark: number;
  totalAdmissions: number;
  /** Money taken so far, in cents. */
  income: { entry: number; rides: number; shops: number };
  /** Money spent running the park so far, in cents. */
  expenses: { running: number; wages: number };
  /** The same figures for the current month, in cents. */
  monthly: { entry: number; rides: number; shops: number; running: number; wages: number };
}

/** The entry fee of a new park: $10.00. */
export const DEFAULT_ENTRY_FEE = 10_00;

/** Most the entry fee can be: $100.00. */
export const MAX_ENTRY_FEE = 100_00;

/** Highest park rating. */
export const MAX_RATING = 999;

/** The rating of a new park, halfway up the scale. */
export const DEFAULT_RATING = 500;

/** A new park: closed, no entrance, the default fee and rating, and nothing earned or spent. */
export function createParkState(name: string): ParkState {
  return {
    name,
    open: false,
    entryFee: DEFAULT_ENTRY_FEE,
    entrance: null,
    rating: DEFAULT_RATING,
    guestsInPark: 0,
    totalAdmissions: 0,
    income: { entry: 0, rides: 0, shops: 0 },
    expenses: { running: 0, wages: 0 },
    monthly: { entry: 0, rides: 0, shops: 0, running: 0, wages: 0 },
  };
}

/**
 * A deep copy of `park` with its keys in a fixed order, so the JSON text of the copy is a stable
 * encoding of it. The hash and the save both use it.
 */
export function copyParkState(park: ParkState): ParkState {
  const { entrance, income, expenses, monthly } = park;
  return {
    name: park.name,
    open: park.open,
    entryFee: park.entryFee,
    entrance: entrance === null ? null : { x: entrance.x, y: entrance.y, side: entrance.side },
    rating: park.rating,
    guestsInPark: park.guestsInPark,
    totalAdmissions: park.totalAdmissions,
    income: { entry: income.entry, rides: income.rides, shops: income.shops },
    expenses: { running: expenses.running, wages: expenses.wages },
    monthly: {
      entry: monthly.entry,
      rides: monthly.rides,
      shops: monthly.shops,
      running: monthly.running,
      wages: monthly.wages,
    },
  };
}
