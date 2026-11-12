import type { SimClient } from "@coasterworks/protocol";
import type { ShellConfig } from "./host/connect";
import type { Placement, Tool } from "./state/uiStore";

declare global {
  interface Window {
    /**
     * Set once the page is connected to a sim, for the end-to-end tests and for poking at from the
     * console. `uiState()` is what the player has in hand, from the interface's own store.
     */
    __coasterworks?: {
      ready: boolean;
      client: SimClient;
      uiState(): { tool: Tool; placement: Placement | null };
      /**
       * A point in the window where a guest is drawn, or null if none is in view or guests are
       * still moving on screen (a pause takes a moment to reach the drawing).
       */
      findGuest(): { clientX: number; clientY: number; id: number } | null;
    };
  }

  /** Set by the desktop shell's initialization script before the page's own scripts run. */
  var __COASTERWORKS__: ShellConfig | undefined;
}
