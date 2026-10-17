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

/**
 * True when the global `localStorage` is a real `Storage`, which is what jsdom provides. Node 25
 * and later put a `localStorage` of their own on the global that gives `undefined` (and warns, the
 * first time it is read) unless it is started with `--localstorage-file`, and that hides jsdom's.
 * The warning is held back while this reads it, so the tests' output stays clean.
 */
function hasStorage(): boolean {
  const { emitWarning } = process;
  process.emitWarning = () => {};
  try {
    return globalThis.localStorage instanceof Storage;
  } catch {
    return false;
  } finally {
    process.emitWarning = emitWarning;
  }
}

// What the browser has and jsdom does not, for the components that need it: Radix and cmdk watch
// sizes with a ResizeObserver, a media query asks `matchMedia`, and cmdk scrolls the highlighted
// item into view. Tests that opt out of jsdom (`@vitest-environment node`) have no window at all.
if (typeof window !== "undefined") {
  // Only where there is no working one: a `localStorage` that jsdom provides is left as it is.
  if (!hasStorage()) vi.stubGlobal("localStorage", memoryStorage());

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
