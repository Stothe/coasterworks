import type { SimClient } from "@coasterworks/protocol";
import type { ShellConfig } from "./host/connect";

declare global {
  interface Window {
    /** Set once the page is connected to a sim, for the smoke test and for poking at from the console. */
    __coasterworks?: { ready: boolean; client: SimClient };
  }

  /** Set by the desktop shell's initialization script before the page's own scripts run. */
  var __COASTERWORKS__: ShellConfig | undefined;
}
