import type { SimClient } from "@coasterworks/protocol";

declare global {
  interface Window {
    /** Set once the page is connected to a sim, for the smoke test and for poking at from the console. */
    __coasterworks?: { ready: boolean; client: SimClient };
  }
}
