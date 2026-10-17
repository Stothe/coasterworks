import type { Speed } from "@coasterworks/protocol";
import { DOCK_TOOLS } from "../actions/types";

/** The play speeds, slowest first. Pause is not one of them. */
export const PLAY_SPEEDS = [1, 2, 4, 8] as const satisfies readonly Speed[];

/** True when a key press is aimed at a text field, which keeps its keys. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return (
    el.isContentEditable ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT"
  );
}

/** True when a key press is aimed at a button, which Space presses. */
export function isButton(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && typeof el.tagName === "string" && el.tagName === "BUTTON";
}

/**
 * The speed one step faster (`direction` 1) or slower (-1) along 1x, 2x, 4x, 8x, stopping at the
 * ends. From a pause it steps from `resume`, the speed the pause interrupted.
 */
export function stepSpeed(current: Speed, resume: Speed, direction: 1 | -1): Speed {
  const from = current === 0 ? resume : current;
  const at = Math.max(
    0,
    PLAY_SPEEDS.findIndex((speed) => speed === from),
  );
  return PLAY_SPEEDS[Math.min(PLAY_SPEEDS.length - 1, Math.max(0, at + direction))] ?? 1;
}

/** One key (or chord) and the action it runs. */
export interface KeyBinding {
  /**
   * Modifiers and a key joined by `+`, in lower case: `mod+shift+z`, `escape`, `space`, `1`, `?`.
   * `mod` is Command on a Mac and Control elsewhere.
   */
  combo: string;
  /** The id of an action in the registry. */
  actionId: string;
  /** `always` works in a text field too; the default, `notTyping`, leaves the keys to the field. */
  when?: "always" | "notTyping";
}

/**
 * Every key of the interface, in one table. The app listens once and runs whatever action the key
 * names, so a key here and the shortcut an action shows in the command bar stay one thing.
 */
export const KEYMAP: readonly KeyBinding[] = [
  { combo: "escape", actionId: "ui.cancel", when: "always" },
  { combo: "mod+k", actionId: "ui.commandBar" },
  { combo: "mod+shift+z", actionId: "ui.redo" },
  { combo: "mod+z", actionId: "ui.undo" },
  { combo: "mod+y", actionId: "ui.redo" },
  { combo: "space", actionId: "ui.pause" },
  { combo: "+", actionId: "ui.speed.up" },
  { combo: "=", actionId: "ui.speed.up" },
  { combo: "-", actionId: "ui.speed.down" },
  { combo: "_", actionId: "ui.speed.down" },
  ...DOCK_TOOLS.map((tool, index) => ({ combo: String(index + 1), actionId: `ui.tool.${tool}` })),
  { combo: "?", actionId: "ui.help" },
  { combo: "home", actionId: "ui.classicView" },
];

/** The parts of a key event a combo is matched against. */
export type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

/** True on a Mac (and its phones), where `mod` is Command. Read at the time, not once. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  // `platform` is deprecated but every browser still has it, and it follows the machine. The newer
  // `userAgentData` follows the user agent string, which a test browser overrides.
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.platform || nav.userAgentData?.platform || "");
}

interface ParsedCombo {
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

const parsed = new Map<string, ParsedCombo>();

function parse(combo: string): ParsedCombo {
  const known = parsed.get(combo);
  if (known) return known;
  // The key is the last part; `+` itself is a key, so "+" and "shift++" end in it.
  const key = combo.endsWith("+") ? "+" : (combo.split("+").pop() ?? "");
  const names = combo.slice(0, combo.length - key.length).split("+");
  const result: ParsedCombo = {
    key,
    mod: names.includes("mod"),
    ctrl: names.includes("ctrl"),
    meta: names.includes("meta"),
    alt: names.includes("alt"),
    shift: names.includes("shift"),
  };
  parsed.set(combo, result);
  return result;
}

/** `Escape` is `escape`, a space is `space`, `Z` is `z`. */
function keyName(key: string): string {
  return key === " " ? "space" : key.toLowerCase();
}

/**
 * True when a key event is exactly `combo`: its key, and no modifier the combo does not name. Shift
 * is the exception for a symbol (`?` and `+` are typed with it on most keyboards), which it only
 * changes into itself.
 */
export function matchCombo(event: KeyLike, combo: string, mac: boolean = isMac()): boolean {
  const want = parse(combo);
  if (keyName(event.key) !== want.key) return false;
  if (event.ctrlKey !== (want.ctrl || (want.mod && !mac))) return false;
  if (event.metaKey !== (want.meta || (want.mod && mac))) return false;
  if (event.altKey !== want.alt) return false;
  const isSymbol = want.key.length === 1 && !/[a-z0-9]/.test(want.key);
  return isSymbol || event.shiftKey === want.shift;
}

/**
 * The binding a key press runs, or undefined if it is none or the press belongs to something else:
 * a text field keeps every key but Escape, and a focused button keeps Space (it presses the button).
 */
export function bindingFor(event: KeyboardEvent, mac: boolean = isMac()): KeyBinding | undefined {
  const typing = isTyping(event.target);
  return KEYMAP.find(
    (binding) =>
      (!typing || binding.when === "always") &&
      matchCombo(event, binding.combo, mac) &&
      !(binding.combo === "space" && isButton(event.target)),
  );
}
