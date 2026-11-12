import { createStore, useStore } from "zustand";

/** Where the pixel ratio cap is kept between visits. */
export const PIXEL_RATIO_KEY = "coasterworks.pixelRatioCap";
/** Where the graphics quality is kept between visits. */
export const QUALITY_KEY = "coasterworks.quality";
/** Where Show FPS is kept between visits. */
export const SHOW_FPS_KEY = "coasterworks.showFps";

/** The caps the settings offer, lowest first. */
export const PIXEL_RATIO_CAPS = [1, 1.5, 2] as const;
export type PixelRatioCap = (typeof PIXEL_RATIO_CAPS)[number];

/** The cap when none was chosen: the renderer's own. */
export const DEFAULT_PIXEL_RATIO_CAP: PixelRatioCap = 2;

/** The graphics qualities the settings offer: "auto" lets the renderer choose and adjust. */
export const GRAPHICS_QUALITIES = ["auto", "low", "medium", "high"] as const;
export type GraphicsQuality = (typeof GRAPHICS_QUALITIES)[number];

/** The quality when none was chosen. */
export const DEFAULT_GRAPHICS_QUALITY: GraphicsQuality = "auto";

/** What a settings read needs of `localStorage`; a missing one is a page with nowhere to look. */
type Reader = Pick<Storage, "getItem"> | undefined;

/** The browser's storage, or nothing where the page may not have it. */
function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // A browser that blocks site data throws on the access itself.
    return undefined;
  }
}

function read(storage: Reader, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    browserStorage()?.setItem(key, value);
  } catch {
    // The setting holds for this visit even where it cannot be kept for the next.
  }
}

/** The stored cap if it is one of the choices, else the default. */
export function readPixelRatioCap(storage: Reader): PixelRatioCap {
  const stored = Number(read(storage, PIXEL_RATIO_KEY));
  return PIXEL_RATIO_CAPS.find((cap) => cap === stored) ?? DEFAULT_PIXEL_RATIO_CAP;
}

/** The stored quality if it is one of the choices, else the default. */
export function readGraphicsQuality(storage: Reader): GraphicsQuality {
  const stored = read(storage, QUALITY_KEY);
  return GRAPHICS_QUALITIES.find((quality) => quality === stored) ?? DEFAULT_GRAPHICS_QUALITY;
}

/** True only if Show FPS was stored on. */
export function readShowFps(storage: Reader): boolean {
  return read(storage, SHOW_FPS_KEY) === "true";
}

export interface SettingsState {
  /**
   * The most the canvas's pixel ratio may be. The scene reads it when it is made, so a change
   * applies the next time the park loads.
   */
  pixelRatioCap: PixelRatioCap;
  /** How much the scene spends on its looks. A change applies at once, to the scene already up. */
  graphicsQuality: GraphicsQuality;
  /** Whether the frame rate is shown at the bottom left. */
  showFps: boolean;

  setPixelRatioCap(cap: PixelRatioCap): void;
  setGraphicsQuality(quality: GraphicsQuality): void;
  setShowFps(show: boolean): void;
}

/** The player's settings, which outlast the visit. Read from `localStorage` once, when this loads. */
export const settingsStore = createStore<SettingsState>()((set) => ({
  pixelRatioCap: readPixelRatioCap(browserStorage()),
  graphicsQuality: readGraphicsQuality(browserStorage()),
  showFps: readShowFps(browserStorage()),

  setPixelRatioCap: (cap) => {
    write(PIXEL_RATIO_KEY, String(cap));
    set({ pixelRatioCap: cap });
  },
  setGraphicsQuality: (quality) => {
    write(QUALITY_KEY, quality);
    set({ graphicsQuality: quality });
  },
  setShowFps: (show) => {
    write(SHOW_FPS_KEY, String(show));
    set({ showFps: show });
  },
}));

/** The settings as a React hook: `useSettings((state) => state.showFps)`. */
export function useSettings<T>(selector: (state: SettingsState) => T): T {
  return useStore(settingsStore, selector);
}
