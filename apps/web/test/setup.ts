import { vi } from "vitest";

// What the browser has and jsdom does not, for the components that need it: Radix and cmdk watch
// sizes with a ResizeObserver, a media query asks `matchMedia`, and cmdk scrolls the highlighted
// item into view. Tests that opt out of jsdom (`@vitest-environment node`) have no window at all.
if (typeof window !== "undefined") {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );

  if (typeof window.matchMedia !== "function") {
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }

  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
}
