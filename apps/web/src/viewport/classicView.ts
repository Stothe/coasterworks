/** What the page sends itself to ask the view to go back to the classic angle. */
export const CLASSIC_VIEW_REQUEST = "coasterworks:classic-view";

/** Asks the view to return to the first of the four classic angles (the Home key). */
export function requestClassicView(): void {
  window.dispatchEvent(new Event(CLASSIC_VIEW_REQUEST));
}

/** Calls `handler` whenever the view is asked to go classic. Returns the function that stops it. */
export function onClassicViewRequest(handler: () => void): () => void {
  window.addEventListener(CLASSIC_VIEW_REQUEST, handler);
  return () => window.removeEventListener(CLASSIC_VIEW_REQUEST, handler);
}
