import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GRAPHICS_QUALITIES,
  PIXEL_RATIO_KEY,
  QUALITY_KEY,
  SHOW_FPS_KEY,
  readGraphicsQuality,
  readPixelRatioCap,
  readShowFps,
  settingsStore,
} from "../src/state/settings";

const storage = (value: string | null) => ({ getItem: () => value });

beforeEach(() => {
  localStorage.clear();
  settingsStore.setState(settingsStore.getInitialState(), true);
});
afterEach(() => {
  localStorage.clear();
  settingsStore.setState(settingsStore.getInitialState(), true);
});

describe("the pixel ratio cap", () => {
  it("is stored under coasterworks.pixelRatioCap", () => {
    expect(PIXEL_RATIO_KEY).toBe("coasterworks.pixelRatioCap");
  });

  it("is read back as one of 1, 1.5 and 2", () => {
    expect(readPixelRatioCap(storage("1"))).toBe(1);
    expect(readPixelRatioCap(storage("1.5"))).toBe(1.5);
    expect(readPixelRatioCap(storage("2"))).toBe(2);
  });

  it("is 2 when nothing, or nothing valid, was stored", () => {
    expect(readPixelRatioCap(storage(null))).toBe(2);
    expect(readPixelRatioCap(storage("3"))).toBe(2);
    expect(readPixelRatioCap(storage("fast"))).toBe(2);
    expect(readPixelRatioCap(storage(""))).toBe(2);
    expect(readPixelRatioCap(undefined)).toBe(2);
  });

  it("is 2 when the browser will not let the page read storage", () => {
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(readPixelRatioCap(refusing)).toBe(2);
  });

  it("is written to localStorage when it is set", () => {
    settingsStore.getState().setPixelRatioCap(1.5);
    expect(settingsStore.getState().pixelRatioCap).toBe(1.5);
    expect(localStorage.getItem(PIXEL_RATIO_KEY)).toBe("1.5");
  });

  it("is still set when the browser will not let the page write storage", () => {
    const real = localStorage;
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("denied");
      },
    });
    try {
      settingsStore.getState().setPixelRatioCap(1);
      expect(settingsStore.getState().pixelRatioCap).toBe(1);
    } finally {
      vi.stubGlobal("localStorage", real);
    }
  });
});

describe("the graphics quality", () => {
  it("is stored under coasterworks.quality", () => {
    expect(QUALITY_KEY).toBe("coasterworks.quality");
  });

  it("offers Auto, Low, Medium and High, in that order", () => {
    expect([...GRAPHICS_QUALITIES]).toEqual(["auto", "low", "medium", "high"]);
  });

  it("is read back as one of the choices", () => {
    for (const quality of GRAPHICS_QUALITIES) {
      expect(readGraphicsQuality(storage(quality))).toBe(quality);
    }
  });

  it("is auto when nothing, or nothing valid, was stored", () => {
    expect(readGraphicsQuality(storage(null))).toBe("auto");
    expect(readGraphicsQuality(storage("ultra"))).toBe("auto");
    expect(readGraphicsQuality(storage("High"))).toBe("auto");
    expect(readGraphicsQuality(storage(""))).toBe("auto");
    expect(readGraphicsQuality(undefined)).toBe("auto");
  });

  it("is auto when the browser will not let the page read storage", () => {
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(readGraphicsQuality(refusing)).toBe("auto");
  });

  it("is written to localStorage when it is set", () => {
    expect(settingsStore.getState().graphicsQuality).toBe("auto");
    settingsStore.getState().setGraphicsQuality("high");
    expect(settingsStore.getState().graphicsQuality).toBe("high");
    expect(localStorage.getItem(QUALITY_KEY)).toBe("high");
  });

  it("is still set when the browser will not let the page write storage", () => {
    const real = localStorage;
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("denied");
      },
    });
    try {
      settingsStore.getState().setGraphicsQuality("low");
      expect(settingsStore.getState().graphicsQuality).toBe("low");
    } finally {
      vi.stubGlobal("localStorage", real);
    }
  });
});

describe("Show FPS", () => {
  it("is off unless it was stored on", () => {
    expect(readShowFps(storage(null))).toBe(false);
    expect(readShowFps(storage("false"))).toBe(false);
    expect(readShowFps(storage("true"))).toBe(true);
    expect(readShowFps(undefined)).toBe(false);
  });

  it("is written to localStorage when it is set", () => {
    settingsStore.getState().setShowFps(true);
    expect(settingsStore.getState().showFps).toBe(true);
    expect(localStorage.getItem(SHOW_FPS_KEY)).toBe("true");
    settingsStore.getState().setShowFps(false);
    expect(localStorage.getItem(SHOW_FPS_KEY)).toBe("false");
  });
});
