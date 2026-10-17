import type { Action } from "../actions/types";
import { KEYMAP, formatCombo, isMac } from "../state/keys";
import { uiStore, useUiStore } from "../state/uiStore";
import { IconButton, Kbd } from "./kit";

export interface HelpOverlayProps {
  /** Every action by id: the overlay names each key by its action's title. */
  byId: ReadonlyMap<string, Action>;
}

/** The sections of the map, in the order they are shown, and which actions each holds. */
const GROUPS: ReadonlyArray<{ title: string; has(actionId: string): boolean }> = [
  { title: "Tools", has: (id) => id.startsWith("ui.tool.") },
  { title: "Terrain", has: (id) => id.startsWith("ui.terrain.") || id.startsWith("ui.brush.") },
  { title: "Camera", has: (id) => id === "ui.classicView" },
  { title: "Speed", has: (id) => id === "ui.pause" || id.startsWith("ui.speed.") },
  { title: "History", has: (id) => id === "ui.undo" || id === "ui.redo" },
  { title: "Panels", has: (id) => ["ui.help", "ui.commandBar", "ui.cancel"].includes(id) },
];

/**
 * Actions the map reads better with in this order than in the map's own, which names Redo's chord
 * before Undo's. The rest keep the map's order, after these.
 */
const FIRST = ["ui.undo", "ui.redo", "ui.commandBar", "ui.help", "ui.cancel"];

const rank = (actionId: string) => {
  const at = FIRST.indexOf(actionId);
  return at < 0 ? FIRST.length : at;
};

/** A key the groups do not know still shows, so the map is never listed short. */
const OTHER = "Other";

interface Shortcut {
  actionId: string;
  title: string;
  combos: string[];
}

/** The map's keys by action, in the order the map first names each, split into sections. */
function sections(
  byId: ReadonlyMap<string, Action>,
): Array<{ title: string; shortcuts: Shortcut[] }> {
  const byAction = new Map<string, Shortcut>();
  for (const { actionId, combo } of KEYMAP) {
    const known = byAction.get(actionId);
    if (known) known.combos.push(combo);
    else
      byAction.set(actionId, {
        actionId,
        title: byId.get(actionId)?.title ?? actionId,
        combos: [combo],
      });
  }
  // Array.prototype.sort is stable, so what is not in FIRST stays in the map's order.
  const all = [...byAction.values()].sort((a, b) => rank(a.actionId) - rank(b.actionId));
  const listed = GROUPS.map(({ title, has }) => ({
    title,
    shortcuts: all.filter((shortcut) => has(shortcut.actionId)),
  }));
  const rest = all.filter(({ actionId }) => !GROUPS.some(({ has }) => has(actionId)));
  return [...listed, { title: OTHER, shortcuts: rest }].filter(
    ({ shortcuts }) => shortcuts.length > 0,
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The keyboard map: every key of `KEYMAP` by what it does. A layer over the park, not a dialog the
 * park waits behind: `?` or Esc puts it away, and so does a click outside it. It reads the store, so
 * the key that opens it and the action in the command bar are the same thing.
 */
export function HelpOverlay({ byId }: HelpOverlayProps) {
  const open = useUiStore((state) => state.helpOpen);
  if (!open) return null;
  const mac = isMac();
  return (
    <div
      data-testid="help-backdrop"
      onClick={(e) => {
        // Only a click on the backdrop itself is a click outside the map.
        if (e.target === e.currentTarget) uiStore.getState().toggleHelp();
      }}
      className="pointer-events-auto absolute inset-0 z-40 grid place-items-center bg-scrim p-4"
    >
      <section
        role="dialog"
        aria-label="Keyboard shortcuts"
        className="glass flex max-h-full w-[44rem] max-w-full animate-enter flex-col"
      >
        <header className="flex min-h-10 items-center gap-2 border-b border-line py-1 pr-1.5 pl-3">
          <h2 className="flex-1 text-sm font-semibold">Keyboard shortcuts</h2>
          <span className="text-xs text-muted">Esc or ? to close</span>
          <IconButton
            label="Close shortcuts"
            icon={<CloseIcon />}
            onClick={() => uiStore.getState().toggleHelp()}
          />
        </header>
        <div className="grid min-h-0 gap-x-8 gap-y-4 overflow-auto p-4 sm:grid-cols-2">
          {sections(byId).map(({ title, shortcuts }) => (
            <section key={title} aria-label={title}>
              <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
                {title}
              </h3>
              <ul className="flex flex-col">
                {shortcuts.map(({ actionId, title: name, combos }) => (
                  <li key={actionId} className="flex min-h-8 items-center gap-3 text-sm">
                    <span className="flex-1">{name}</span>
                    <span className="flex gap-1">
                      {combos.map((combo) => (
                        <Kbd key={combo}>{formatCombo(combo, mac)}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}
