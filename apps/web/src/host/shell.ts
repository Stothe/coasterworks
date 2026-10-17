/** The event the desktop shell's View > Classic View sends. */
export const CLASSIC_VIEW_EVENT = "coasterworks://classic-view";

/**
 * Calls `handler` whenever the desktop shell sends the event `name`, and returns a function that
 * stops listening. In a plain browser there is no shell, so this does nothing and Tauri's code is
 * never loaded: the import is dynamic, and only made when the shell has put its bridge on `window`.
 */
export function onShellEvent(name: string, handler: () => void): () => void {
  if (!("__TAURI_INTERNALS__" in globalThis)) return () => {};

  let stopped = false;
  let unlisten: (() => void) | undefined;
  import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen(name, () => {
        if (!stopped) handler();
      }),
    )
    .then((off) => {
      // Asked to stop while the listener was still being set up.
      if (stopped) off();
      else unlisten = off;
    })
    .catch((error: unknown) => {
      console.warn(`could not listen for ${name}:`, error);
    });

  return () => {
    stopped = true;
    unlisten?.();
    unlisten = undefined;
  };
}
