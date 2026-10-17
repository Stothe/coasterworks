// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { buildActions, type UiActionDeps } from "../src/actions/registry";
import { KEYMAP, bindingFor, formatCombo, matchCombo, type KeyLike } from "../src/state/keys";

const key = (key: string, mods: Partial<Omit<KeyLike, "key">> = {}): KeyLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("matchCombo", () => {
  it("takes mod as Command on a Mac", () => {
    expect(matchCombo(key("z", { metaKey: true }), "mod+z", true)).toBe(true);
    expect(matchCombo(key("z", { ctrlKey: true }), "mod+z", true)).toBe(false);
    expect(matchCombo(key("z"), "mod+z", true)).toBe(false);
  });

  it("takes mod as Control elsewhere", () => {
    expect(matchCombo(key("z", { ctrlKey: true }), "mod+z", false)).toBe(true);
    expect(matchCombo(key("z", { metaKey: true }), "mod+z", false)).toBe(false);
  });

  it("tells mod+shift+z from mod+z on both", () => {
    const mac = key("z", { metaKey: true, shiftKey: true });
    expect(matchCombo(mac, "mod+shift+z", true)).toBe(true);
    expect(matchCombo(mac, "mod+z", true)).toBe(false);
    const other = key("z", { ctrlKey: true, shiftKey: true });
    expect(matchCombo(other, "mod+shift+z", false)).toBe(true);
    expect(matchCombo(other, "mod+z", false)).toBe(false);
    // Shift held makes the browser report a capital letter.
    expect(matchCombo(key("Z", { ctrlKey: true, shiftKey: true }), "mod+shift+z", false)).toBe(
      true,
    );
  });

  it("does not match a key with a modifier the combo does not name", () => {
    expect(matchCombo(key("1", { ctrlKey: true }), "1", false)).toBe(false);
    expect(matchCombo(key("1", { altKey: true }), "1", false)).toBe(false);
    expect(matchCombo(key("k", { ctrlKey: true, altKey: true }), "mod+k", false)).toBe(false);
    expect(matchCombo(key("1"), "1", false)).toBe(true);
  });

  it("names the special keys the way the keymap does", () => {
    expect(matchCombo(key("Escape"), "escape")).toBe(true);
    expect(matchCombo(key(" "), "space")).toBe(true);
    expect(matchCombo(key("Home"), "home")).toBe(true);
    expect(matchCombo(key("Enter"), "escape")).toBe(false);
  });

  it("matches symbols whatever shift does to them", () => {
    expect(matchCombo(key("?", { shiftKey: true }), "?")).toBe(true);
    expect(matchCombo(key("+", { shiftKey: true }), "+")).toBe(true);
    expect(matchCombo(key("+"), "+")).toBe(true);
    expect(matchCombo(key("-"), "-")).toBe(true);
    expect(matchCombo(key("="), "+")).toBe(false);
  });
});

describe("bindingFor", () => {
  /** An event aimed at an element of the given kind. */
  const aimed = (tagName: string, k: string, mods: Partial<KeyLike> = {}) =>
    ({ ...key(k, mods), target: { tagName } }) as unknown as KeyboardEvent;

  it("resolves a key to its action", () => {
    expect(bindingFor(aimed("DIV", "1"), false)?.actionId).toBe("ui.tool.terrain");
    expect(bindingFor(aimed("DIV", "k", { ctrlKey: true }), false)?.actionId).toBe("ui.commandBar");
    expect(bindingFor(aimed("DIV", "z", { ctrlKey: true, shiftKey: true }), false)?.actionId).toBe(
      "ui.redo",
    );
    expect(bindingFor(aimed("DIV", "q"), false)).toBeUndefined();
  });

  it("lets only Escape through while typing", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(bindingFor(aimed(tag, "1"), false), tag).toBeUndefined();
      expect(bindingFor(aimed(tag, " "), false), tag).toBeUndefined();
      expect(bindingFor(aimed(tag, "z", { ctrlKey: true }), false), tag).toBeUndefined();
      expect(bindingFor(aimed(tag, "k", { ctrlKey: true }), false), tag).toBeUndefined();
      expect(bindingFor(aimed(tag, "Escape"), false)?.actionId, tag).toBe("ui.cancel");
    }
  });

  it("leaves the keys to an open menu, as it does to a field, but Escape still gets through", () => {
    // A menu item is a div inside role="menu": Space and the arrow keys select and move there.
    const inMenu = (k: string, mods: Partial<KeyLike> = {}) =>
      ({
        ...key(k, mods),
        target: {
          tagName: "DIV",
          closest: (selector: string) => (selector === '[role="menu"]' ? {} : null),
        },
      }) as unknown as KeyboardEvent;
    expect(bindingFor(inMenu("1"), false)).toBeUndefined();
    expect(bindingFor(inMenu(" "), false)).toBeUndefined();
    expect(bindingFor(inMenu("r"), false)).toBeUndefined();
    expect(bindingFor(inMenu("z", { ctrlKey: true }), false)).toBeUndefined();
    expect(bindingFor(inMenu("Escape"), false)?.actionId).toBe("ui.cancel");
    // Outside a menu, the same element is just an element.
    expect(bindingFor(aimed("DIV", " "), false)?.actionId).toBe("ui.pause");
  });

  it("leaves Space to a focused button", () => {
    expect(bindingFor(aimed("BUTTON", " "), false)).toBeUndefined();
    expect(bindingFor(aimed("BUTTON", "1"), false)?.actionId).toBe("ui.tool.terrain");
  });
});

describe("KEYMAP", () => {
  const deps: UiActionDeps = {
    startPlacement: vi.fn(),
    openForm: vi.fn(),
    execute: vi.fn(),
    ui: {
      pause: vi.fn(),
      setSpeed: vi.fn(),
      stepSpeed: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
      classicView: vi.fn(),
      setTool: vi.fn(),
      openInspector: vi.fn(),
      help: vi.fn(),
      commandBar: vi.fn(),
      cancel: vi.fn(),
      terrain: vi.fn(),
      brush: vi.fn(),
    },
  };
  const ids = new Set(buildActions([], deps).map((action) => action.id));

  it("names only actions that exist", () => {
    for (const { combo, actionId } of KEYMAP) expect(ids.has(actionId), combo).toBe(true);
  });

  it("has no combo twice", () => {
    const combos = KEYMAP.map((binding) => binding.combo);
    expect(new Set(combos).size).toBe(combos.length);
  });

  it("covers the keys of the interface", () => {
    const by = (combo: string) => KEYMAP.find((binding) => binding.combo === combo)?.actionId;
    expect(by("mod+k")).toBe("ui.commandBar");
    expect(by("mod+z")).toBe("ui.undo");
    expect(by("mod+shift+z")).toBe("ui.redo");
    expect(by("escape")).toBe("ui.cancel");
    expect(by("space")).toBe("ui.pause");
    expect(by("+")).toBe("ui.speed.up");
    expect(by("-")).toBe("ui.speed.down");
    expect(by("?")).toBe("ui.help");
    expect(by("home")).toBe("ui.classicView");
    expect(["1", "2", "3", "4", "5", "6", "7"].map(by)).toEqual([
      "ui.tool.terrain",
      "ui.tool.path",
      "ui.tool.ride",
      "ui.tool.scenery",
      "ui.tool.shop",
      "ui.tool.staff",
      "ui.tool.park",
    ]);
  });

  it("puts the terrain verbs and the brush on their keys", () => {
    const by = (combo: string) => KEYMAP.find((binding) => binding.combo === combo)?.actionId;
    expect(["r", "l", "v", "m", "w", "u"].map(by)).toEqual([
      "ui.terrain.raise",
      "ui.terrain.lower",
      "ui.terrain.level",
      "ui.terrain.smooth",
      "ui.terrain.water",
      "ui.terrain.surface",
    ]);
    expect(by("[")).toBe("ui.brush.smaller");
    expect(by("]")).toBe("ui.brush.larger");
  });

  it("leaves the terrain keys to a text field", () => {
    const typed = { ...key("w"), target: { tagName: "INPUT" } } as unknown as KeyboardEvent;
    expect(bindingFor(typed, false)).toBeUndefined();
    const brush = { ...key("]"), target: { tagName: "INPUT" } } as unknown as KeyboardEvent;
    expect(bindingFor(brush, false)).toBeUndefined();
    const free = { ...key("w"), target: { tagName: "DIV" } } as unknown as KeyboardEvent;
    expect(bindingFor(free, false)?.actionId).toBe("ui.terrain.water");
  });

  it("lets only Escape work while typing", () => {
    const always = KEYMAP.filter((binding) => binding.when === "always");
    expect(always.map((binding) => binding.combo)).toEqual(["escape"]);
  });
});

describe("formatCombo", () => {
  it("writes mod as Ctrl on a PC and Command on a Mac", () => {
    expect(formatCombo("mod+k", false)).toBe("Ctrl+K");
    expect(formatCombo("mod+k", true)).toBe("⌘K");
  });

  it("writes shift with it: Ctrl+Shift+Z, and ⇧⌘Z", () => {
    expect(formatCombo("mod+shift+z", false)).toBe("Ctrl+Shift+Z");
    expect(formatCombo("mod+shift+z", true)).toBe("⇧⌘Z");
  });

  it("names the modifiers it is given: alt, ctrl and meta", () => {
    expect(formatCombo("alt+x", false)).toBe("Alt+X");
    expect(formatCombo("alt+x", true)).toBe("⌥X");
    expect(formatCombo("ctrl+x", true)).toBe("⌃X");
    expect(formatCombo("meta+x", false)).toBe("Win+X");
    expect(formatCombo("meta+x", true)).toBe("⌘X");
  });

  it("names the keys that are not a character", () => {
    expect(formatCombo("escape", false)).toBe("Esc");
    expect(formatCombo("space", false)).toBe("Space");
    expect(formatCombo("home", false)).toBe("Home");
  });

  it("shows a letter in capitals and a symbol as it is, including +", () => {
    expect(formatCombo("r", false)).toBe("R");
    expect(formatCombo("1", false)).toBe("1");
    expect(formatCombo("?", false)).toBe("?");
    expect(formatCombo("[", false)).toBe("[");
    expect(formatCombo("+", false)).toBe("+");
    expect(formatCombo("+", true)).toBe("+");
  });

  it("has something to show for every combo of the map", () => {
    for (const { combo } of KEYMAP) {
      expect(formatCombo(combo, false).length, combo).toBeGreaterThan(0);
      expect(formatCombo(combo, true).length, combo).toBeGreaterThan(0);
    }
  });
});
