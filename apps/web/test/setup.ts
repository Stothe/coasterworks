import { vi } from "vitest";

/** A `localStorage` that keeps its items in memory, for where the real one is not there. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

// What the browser has and jsdom does not, for the components that need it: Radix and cmdk watch
// sizes with a ResizeObserver, a media query asks `matchMedia`, and cmdk scrolls the highlighted
// item into view. Tests that opt out of jsdom (`@vitest-environment node`) have no window at all.
if (typeof window !== "undefined") {
  // Newer Node versions put a `localStorage` of their own on the global: it is a getter that warns
  // when it is read and gives nothing without `--localstorage-file`, and it hides jsdom's. The
  // descriptor is looked at without reading it.
  if (typeof Object.getOwnPropertyDescriptor(globalThis, "localStorage")?.get === "function") {
    vi.stubGlobal("localStorage", memoryStorage());
  }

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
