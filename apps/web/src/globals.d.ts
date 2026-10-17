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
    };
  }

  /** Set by the desktop shell's initialization script before the page's own scripts run. */
  var __COASTERWORKS__: ShellConfig | undefined;
}
